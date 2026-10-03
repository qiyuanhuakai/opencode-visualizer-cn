/**
 * dsh web message bridge (plan Todo 19; dsh web 0.2.0-rc.2, docs/dsh.md §8).
 *
 * Factory shape mirrors `useKimiWebMessageBridge.ts`, but the dsh control
 * plane needs two streams hung at once and one unforgiving rule:
 *
 *   1. **Dual attach.** The bridge opens the mux `$events` logical stream
 *      (ready → emit / waterfall / cancel, docs §8.1) and attaches to the
 *      `session/follow` stream the bootstrap pipeline opened (snapshot +
 *      incremental items, docs §8.2). Follow frames are normalized by the
 *      landed Todo 18 normalizer and applied as ops onto the shared message
 *      facade — the shared `MessageInfo`/`MessagePart` contracts are never
 *      restructured here (memory #801).
 *   2. **No waterfall frame is ever silently dropped.** A `waterfall` frame
 *      blocks the agent's turn until it is answered over
 *      `POST /dsh/$events/result` (docs/dsh.md:368), so:
 *        - `approval/request` is surfaced to the permission UI surface and
 *          answered with the user's outcome;
 *        - `user-questions/request` (no question UI exists) and a
 *          capability-degraded approval close are answered with the
 *          safe-rejection outcome (review blocker #7 — recording and
 *          dropping the frame would hang the turn forever);
 *        - an unknown waterfall event is answered the same way.
 *      The answer body is the FULL client-request envelope with
 *      `payload.args = {clientId, eventId, outcome}` (protocol correction:
 *      `{args:{…}}` is the envelope payload, not the whole HTTP body).
 *
 * Reconnect semantics follow the replay boundary contract (task 7) through
 * the per-session sync state machine (`dshSyncStateMachine.ts`, Todo 23):
 *
 *   live → degraded (connection lost: heartbeat miss / close 1001) →
 *   rebuilding (transport reconnected, streams re-opened per R9) → live
 *
 *   - R1/R2: a snapshot is authoritative full state; the superseded part
 *     set is explicitly cleared through the shared facade's existing
 *     `removeMessage` API and the snapshot re-applied (upsert by identity),
 *     `cursor` is the single watermark, and already-applied seqs are never
 *     replayed;
 *   - R4: reconnect recovery is snapshot-only. `session/page` is exposed as
 *     the history-only window fill (R5/R6: `throughSeq` ≤ cursor, `beforeSeq`
 *     open upper bound) and is NEVER used to fill a reconnect gap;
 *   - R9: on reconnect the bridge waits for each stream's own first frame
 *     (ready / snapshot); frames admitted meanwhile are buffered and applied
 *     in arrival order, seq-gated against the snapshot;
 *   - R10: `clientId` is per-connection — a dropped connection voids it and
 *     the next ready frame replaces it, so a stale clientId is never answered
 *     with (and an answer queued for the dead connection is dropped, not
 *     flushed with a foreign id);
 *   - R11: `$events` never replays the disconnect window, so pending
 *     approvals are dropped with the connection and re-derived from the
 *     session's authoritative state through `reconcileApprovals`;
 *   - R13: follow streams are downlink-only — half-close is `cancel`, and
 *     this bridge has no uplink `end` path at all;
 *   - R14: binary / invalid-json frames are fatal — the session goes
 *     `detached` and nothing is re-opened;
 *   - R15: frames admitted into a terminal session are silently dropped;
 *   - R16: a host `error` frame kills a stream — recovery is a FRESH open
 *     (new streamId, same connection), never a retry of the dead one.
 *
 * Popup side effects (Todo 24's `onToolPart` / `onLiveReasoning` /
 * `onLiveSubagent`) fire ONLY for live frames; snapshot rebuilds, history
 * loads and replays route through `onReconcilePart`, which may close an
 * existing window but never opens one.
 */

import { shallowReactive } from 'vue';

import { createDshNormalizer } from '../backends/dsh/normalize';
import { readDshModelRef } from '../backends/dsh/modelSelection';
import type { DshNormalizeResult, DshNormalizer } from '../backends/dsh/ops';
import {
  isDshEventsFrame,
  type DshEventsWaterfallFrame,
  type DshJsonValue,
  type DshSessionAddress,
} from '../backends/dsh/types';
import { createDshRpcClient, deriveDshBridgeHttpUrl } from '../utils/dshRpc';
import { DshMuxError } from '../utils/dshMux';
import type { MessageInfo, MessagePart } from '../types/sse';
import {
  createDshSessionSyncState,
  dshFollowFrameSeq,
  type DshSessionSyncState,
} from './dshSyncStateMachine';
import type {
  DshApprovalRequest,
  DshBridgeSessionState,
  DshBridgeStreamHandle,
  DshCompletion,
  DshFrameOrigin,
  DshHistoryFillResult,
  DshMessageBridge,
  DshMessageBridgeOptions,
  DshSessionUsage,
  DshSyncState,
  DshWaterfallOutcome,
} from './dshMessageBridgeTypes';

/** The logical `$events` stream endpoint on the mux (upstream name, docs §8.1). */
const EVENTS_ENDPOINT = '$events';
/** The follow endpoint, also used for the R16 fresh re-open. */
const FOLLOW_ENDPOINT = 'session/follow';
/** The answer route: `POST <bridge>/dsh/$events/result` (docs §7.1 special endpoints). */
const EVENTS_RESULT_NAMESPACE = '$events';
const EVENTS_RESULT_METHOD = 'result';

/** Guard so a long-lived session cannot grow the answered-set without bound. */
const MAX_ANSWERED_EVENT_IDS = 1024;

/**
 * Stream-drop codes that must NOT be recovered from: binary / invalid-json
 * frames are protocol violations the client itself caused (R14 — retrying
 * only replays the violation), and a local cancel or disposal is deliberate.
 */
const TERMINAL_DROP_CODES = new Set(['binary-frame', 'invalid-json', 'disposed', 'stream-cancelled']);

const USER_QUESTIONS_REJECTION =
  'dsh: user-questions/request has no question UI in this client; the request was declined so the turn is not left hanging';
const UNKNOWN_WATERFALL_REJECTION_PREFIX =
  'dsh: unsupported waterfall event';
const DEGRADED_APPROVAL_REJECTION =
  'dsh: approval UI is unavailable (capability degraded); the request was declined so the turn is not left hanging';
const STOP_REJECTION =
  'dsh: the bridge was disposed before the approval was answered; the request was declined so the turn is not left hanging';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}

/** The safe terminal outcome: decline the request without failing the session. */
function safeRejection(message: string): DshWaterfallOutcome {
  return {
    kind: 'rejected',
    error: {
      name: 'DshWaterfallRejected',
      message,
      code: 'DSH_WATERFALL_SAFE_REJECTION',
    },
  };
}

/** Accepts the bridge HTTP prefix directly, or derives it from the ws form. */
function resolveBridgeHttpPrefix(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (/^wss?:\/\//iu.test(trimmed)) return deriveDshBridgeHttpUrl(trimmed);
  return trimmed;
}

/** The mux error code of a stream drop, when the drop carries one. */
function dropCodeOf(error: unknown): string | undefined {
  return error instanceof DshMuxError ? error.code : undefined;
}

/** The declared snapshot cursor (R2: == max(records.seq)); -1 when absent. */
function snapshotCursorOf(value: Record<string, unknown>): number {
  const cursor = value.cursor;
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : -1;
}

/** The snapshot header version — the epoch substitute for dsh. */
function snapshotVersionOf(value: Record<string, unknown>): number | undefined {
  const header = isRecord(value.header) ? value.header : {};
  const version = header.version;
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined;
}

function dshTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function dshModelLabel(provider: unknown, model: unknown): string | undefined {
  const providerName = typeof provider === 'string' ? provider.trim() : '';
  const modelName = typeof model === 'string' ? model.trim() : '';
  if (providerName && modelName) return `${providerName}/${modelName}`;
  return modelName || undefined;
}

/**
 * Token usage the follow snapshot's `projections.values` carries. The model
 * comes from `modelSelection.next` (falling back to `lastUsed`); a malformed
 * projection yields no usage at all rather than a fabricated zero state.
 */
function dshUsageFromSnapshot(value: Record<string, unknown>): DshSessionUsage | undefined {
  const projections = isRecord(value.projections) ? value.projections : undefined;
  const values = isRecord(projections?.values) ? projections.values : undefined;
  if (!values) return undefined;
  const tokenUsage = isRecord(values.tokenUsage) ? values.tokenUsage : undefined;
  const modelSelection = isRecord(values.modelSelection) ? values.modelSelection : undefined;
  const next = isRecord(modelSelection?.next) ? modelSelection.next : undefined;
  const lastUsed = isRecord(modelSelection?.lastUsed) ? modelSelection.lastUsed : undefined;
  const model =
    dshModelLabel(next?.provider, next?.model) ?? dshModelLabel(lastUsed?.provider, lastUsed?.model);
  const usage: DshSessionUsage = {
    ...(dshTokenCount(tokenUsage?.uncachedInputTokens) !== undefined
      ? { uncachedInputTokens: dshTokenCount(tokenUsage?.uncachedInputTokens) }
      : {}),
    ...(dshTokenCount(tokenUsage?.outputTokens) !== undefined
      ? { outputTokens: dshTokenCount(tokenUsage?.outputTokens) }
      : {}),
    ...(dshTokenCount(tokenUsage?.cacheReadTokens) !== undefined
      ? { cacheReadTokens: dshTokenCount(tokenUsage?.cacheReadTokens) }
      : {}),
    ...(dshTokenCount(tokenUsage?.cacheWriteTokens) !== undefined
      ? { cacheWriteTokens: dshTokenCount(tokenUsage?.cacheWriteTokens) }
      : {}),
    ...(model !== undefined ? { model } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function useDshMessageBridge(options: DshMessageBridgeOptions): DshMessageBridge {
  const resultClient = createDshRpcClient({
    baseUrl: resolveBridgeHttpPrefix(options.rpc.baseUrl),
    getBridgeToken: options.rpc.getBridgeToken,
    fetcher: options.rpc.fetcher,
  });

  const messages = new Map<string, MessageInfo>();
  const normalizers = new Map<string, DshNormalizer>();
  const sessionAddresses = new Map<string, DshSessionAddress>();
  const sessionStates = shallowReactive(new Map<string, DshBridgeSessionState>());
  /** Which session a live follow stream delivers (learned from its snapshot). */
  const streamSessions = new Map<DshBridgeStreamHandle, string>();
  const followSubscriptions = new Map<DshBridgeStreamHandle, () => void>();
  const followRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const approvals = new Map<string, DshApprovalRequest>();
  const approvalListeners = new Set<(request: DshApprovalRequest) => void>();
  const answeredEventIds = new Set<string>();
  /** Terminal answers held back while no connection clientId is available. */
  const queuedResponses: Array<{ eventId: string; outcome: DshWaterfallOutcome }> = [];
  const unsubscribers: Array<() => void> = [];

  /** Per-session sync state machines (Todo 23; the transition table lives in the module). */
  const syncs = new Map<string, DshSessionSyncState>();
  /** Message ids this bridge applied per session — the R1 superseded set. */
  const ownedMessages = new Map<string, Set<string>>();
  /** Sessions with a fresh follow open awaiting its first frame (R16/gap recovery). */
  const pendingFollowOpens = new Set<string>();

  let eventsHandle: DshBridgeStreamHandle | undefined;
  const followHandles: DshBridgeStreamHandle[] = [];
  let clientId: string | undefined;
  let primarySessionId: string | undefined;
  let stopped = false;

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  function normalizerFor(sessionId: string): DshNormalizer {
    let normalizer = normalizers.get(sessionId);
    if (!normalizer) {
      normalizer = createDshNormalizer({ address: sessionAddresses.get(sessionId) ?? { kind: 'session', sessionId } });
      normalizers.set(sessionId, normalizer);
    }
    return normalizer;
  }

  function syncFor(sessionId: string): DshSessionSyncState {
    let sync = syncs.get(sessionId);
    if (!sync) {
      sync = createDshSessionSyncState();
      syncs.set(sessionId, sync);
    }
    return sync;
  }

  function setSync(sessionId: string, sync: DshSyncState): void {
    const previous = sessionStates.get(sessionId);
    sessionStates.set(sessionId, { ...previous, sessionId, sync });
    options.onSyncStateChange?.(sessionId, sync);
  }

  function mergeSession(sessionId: string, patch: Partial<DshBridgeSessionState>): void {
    const previous = sessionStates.get(sessionId);
    sessionStates.set(sessionId, {
      ...(previous ?? { sessionId, sync: { kind: 'detached' as const } }),
      ...patch,
      sessionId,
    });
  }

  /** Publish the machine's phase as the bridge-visible sync state. */
  function publishSync(sessionId: string): void {
    const sync = syncs.get(sessionId);
    if (sync === undefined) return;
    const cursor = sync.cursor();
    const phase = sync.phase();
    if (phase === 'degraded') setSync(sessionId, { kind: 'degraded', cursor });
    else if (phase === 'rebuilding') setSync(sessionId, { kind: 'rebuilding', cursor });
    else if (phase === 'detached') setSync(sessionId, { kind: 'detached' });
    else setSync(sessionId, { kind: 'live', cursor });
  }

  function completionOf(kind: string, code?: string, message?: string): DshCompletion {
    return {
      kind,
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Op application (Todo 18 ops → shared message facade + popup surfaces)
  // -------------------------------------------------------------------------

  function ownMessage(sessionId: string, messageId: string): void {
    let ids = ownedMessages.get(sessionId);
    if (!ids) {
      ids = new Set();
      ownedMessages.set(sessionId, ids);
    }
    ids.add(messageId);
  }

  /**
   * R1 authoritative switch: the snapshot IS the session state, so the part
   * set it supersedes is explicitly cleared through the shared facade's
   * existing `removeMessage` API (the `useMessages` contract itself is never
   * touched) before the snapshot is re-applied.
   */
  function clearOwnedMessages(sessionId: string): void {
    const owned = ownedMessages.get(sessionId);
    if (owned === undefined || owned.size === 0) return;
    for (const messageId of owned) {
      options.msg.removeMessage?.(messageId);
      messages.delete(messageId);
    }
    owned.clear();
  }

  function applyPartOp(part: MessagePart, origin: DshFrameOrigin, sessionId: string): void {
    options.msg.updatePart(part);
    const info = messages.get(part.messageID);
    if (origin === 'live') {
      // Precedence matters: a child session's tool/reasoning part must reach the
      // subagent surface, so the session-mismatch check comes before the type checks.
      const address = sessionAddresses.get(part.sessionID);
      const isChild = address ? address.kind === 'subagent' : part.sessionID !== (primarySessionId ?? sessionId);
      if (part.type === 'subtask' || isChild) {
        if (info) options.onLiveSubagent?.(info, part);
        return;
      }
      if (part.type === 'tool') {
        options.onToolPart?.(part);
        return;
      }
      if (part.type === 'reasoning' && info) {
        options.onLiveReasoning?.(info, part);
      }
      return;
    }
    // Replay / snapshot rebuild / history load: close-only, never open.
    options.onReconcilePart?.(info, part);
  }

  function applyResult(
    result: DshNormalizeResult,
    origin: DshFrameOrigin,
    sessionId: string,
    authoritative: boolean,
  ): void {
    for (const op of result.ops) {
      if (op.kind === 'message') {
        messages.set(op.message.id, op.message);
        ownMessage(sessionId, op.message.id);
        options.msg.updateMessage(op.message);
        continue;
      }
      if (op.kind === 'part') {
        applyPartOp(op.part, origin, sessionId);
        continue;
      }
      if (op.kind === 'turn') {
        // Busy/completion come from authoritative frames only: a live frame
        // and a follow snapshot are authoritative; a history page window is
        // a partial view that must not fabricate transient UI state.
        if (!authoritative) {
          options.onSessionEvent?.(op, { origin, sessionId });
          continue;
        }
        if (op.phase === 'started') {
          mergeSession(sessionId, { busy: true, presetLocked: true });
        } else {
          mergeSession(sessionId, {
            busy: false,
            completion: op.reason
              ? completionOf(op.reason.kind, op.reason.code, op.reason.message)
              : undefined,
          });
        }
      }
      if (op.kind === 'model-selection' && authoritative) mergeSession(sessionId, { modelSelection: op.selection });
      if (op.kind === 'policy' && op.policy === 'permission-preset' && authoritative) mergeSession(sessionId, { permissionPreset: op.value });
      if (op.kind === 'request' && op.phase === 'context' && authoritative) {
        const previous = sessionStates.get(sessionId)?.usage;
        const model = dshModelLabel(op.provider, op.model);
        mergeSession(sessionId, {
          usage: {
            ...previous,
            ...(model !== undefined && previous?.model === undefined ? { model } : {}),
            ...(op.contextWindow !== undefined ? { contextWindow: op.contextWindow } : {}),
          },
        });
      }
      options.onSessionEvent?.(op, { origin, sessionId });
    }
  }

  // -------------------------------------------------------------------------
  // session/follow stream
  // -------------------------------------------------------------------------

  function handleFollowFrame(handle: DshBridgeStreamHandle, value: DshJsonValue | undefined): void {
    if (stopped || !followHandles.includes(handle) || !isRecord(value)) return;

    if (value.type === 'snapshot') {
      const header = isRecord(value.header) ? value.header : {};
      const sessionId =
        typeof header.id === 'string' && header.id.length > 0
          ? header.id
          : streamSessions.get(handle);
      if (sessionId === undefined) return;
      streamSessions.set(handle, sessionId);
      if (primarySessionId === undefined) primarySessionId = sessionId;
      applyFollowSnapshot(sessionId, value, handle);
      return;
    }

    const sessionId = streamSessions.get(handle) ?? primarySessionId;
    if (sessionId === undefined) return;
    admitFollowFrame(sessionId, value);
  }

  /**
   * R1: the snapshot is authoritative full state — reset the seq gate, clear
   * the superseded part set, re-apply every record (upsert by identity), then
   * drain the frames buffered during degraded/rebuilding in arrival order.
   * A late snapshot (cursor behind the watermark) is dropped instead of
   * overwriting newer state.
   */
  function applyFollowSnapshot(sessionId: string, value: Record<string, unknown>, handle: DshBridgeStreamHandle): void {
    const sync = syncFor(sessionId);
    const plan = sync.planSnapshot({
      cursor: snapshotCursorOf(value),
      version: snapshotVersionOf(value),
    });
    if (plan.action === 'drop-stale') {
      publishSync(sessionId);
      return;
    }

    clearFollowRetry(sessionId);
    cancelFollowHandles(sessionId, handle);

    sync.beginSnapshotApply();
    publishSync(sessionId);
    clearOwnedMessages(sessionId);
    const normalizer = normalizerFor(sessionId);
    normalizer.reset();
    const result = normalizer.ingest(value);
    applyResult(result, 'snapshot-rebuild', sessionId, true);
    const projections = isRecord(value.projections) && isRecord(value.projections.values) ? value.projections.values : {};
    const boundary = isRecord(projections.turnBoundary) ? projections.turnBoundary : undefined;
    const header = isRecord(value.header) ? value.header : {};
    const preset = projections.agentPreset ?? header.agentPreset;
    const modelSelection = isRecord(projections.modelSelection) ? projections.modelSelection : {};
    const permissions = isRecord(projections.permissions) ? projections.permissions : {};
    mergeSession(sessionId, {
      permissionPreset: typeof permissions.currentValue === 'string' ? permissions.currentValue : sessionStates.get(sessionId)?.permissionPreset,
      modelSelection: readDshModelRef(modelSelection.next ?? modelSelection.lastUsed),
      agentPreset: typeof preset === 'string' ? preset : undefined,
      planGoalRevision: (sessionStates.get(sessionId)?.planGoalRevision ?? 0) + 1,
      presetLocked: boundary !== undefined
        ? (boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined) || (typeof boundary.lastTurn === 'number' && boundary.lastTurn > 0)
        : sessionStates.get(sessionId)?.presetLocked,
    });
    const snapshotUsage = dshUsageFromSnapshot(value);
    if (snapshotUsage) {
      mergeSession(sessionId, {
        usage: { ...sessionStates.get(sessionId)?.usage, ...snapshotUsage },
      });
    }
    // The normalizer's applied watermark is the honest cursor (R2: equal to
    // the declared one on the wire); a malformed declaration cannot inflate it.
    sync.commitSnapshot(normalizer.cursor(), snapshotVersionOf(value));
    pendingFollowOpens.delete(sessionId);
    publishSync(sessionId);

    const buffered = plan.buffered;
    for (let index = 0; index < buffered.length; index += 1) {
      const decision = sync.admitFrame(buffered[index]);
      if (decision.action === 'apply') {
        const drained = normalizer.ingest(buffered[index]);
        applyResult(drained, 'live', sessionId, true);
        sync.noteApplied(dshFollowFrameSeq(buffered[index]));
        continue;
      }
      if (decision.action === 'gap') {
        // A gap inside the drained frames: keep the rest buffered and ask
        // for a fresh authoritative state instead of skipping seqs.
        sync.bufferFrames(buffered.slice(index + 1));
        publishSync(sessionId);
        followRetryTimers.set(sessionId, setTimeout(() => {
          followRetryTimers.delete(sessionId);
          reopenFollow(sessionId);
        }, 1000));
        return;
      }
      // 'drop': the snapshot already covered this seq (no duplication).
    }
    publishSync(sessionId);
    reconcileAfterRebuild(sessionId);
  }

  /**
   * Live/joining follow frame admission. The state machine decides: apply
   * (in-order seq, volatile delta, or the first frame of a mid-stream join),
   * buffer (degraded/rebuilding), drop (duplicate, late, terminal) or gap
   * (missing seqs → rebuild from authority, never a silent skip).
   */
  function admitFollowFrame(sessionId: string, value: DshJsonValue): void {
    const sync = syncFor(sessionId);
    const decision = sync.admitFrame(value);
    if (decision.action === 'drop' || decision.action === 'buffer') return;
    if (decision.action === 'gap') {
      publishSync(sessionId);
      reopenFollow(sessionId);
      return;
    }
    const normalizer = normalizerFor(sessionId);
    const result = normalizer.ingest(value);
    applyResult(result, 'live', sessionId, true);
    if (isRecord(value) && isRecord(value.event) && ['plan/mode', 'goal/change', 'command/done'].includes(String(value.event.type))) {
      mergeSession(sessionId, { planGoalRevision: (sessionStates.get(sessionId)?.planGoalRevision ?? 0) + 1 });
    }
    if (isRecord(value) && isRecord(value.event) && value.event.type === 'agent-preset/selected' && isRecord(value.event.data) && typeof value.event.data.agentPreset === 'string') {
      mergeSession(sessionId, { agentPreset: value.event.data.agentPreset });
    }
    sync.noteApplied(dshFollowFrameSeq(value));
    publishSync(sessionId);
  }

  /**
   * R16/gap recovery: open a FRESH follow stream (new streamId, same
   * connection — measured legal, never a 1008) and wait for its snapshot.
   * The mux re-opens in-flight streams by itself on a socket reconnect (Todo
   * 5); this path covers streams that settled and are therefore gone.
   */
  function reopenFollow(sessionId: string): void {
    if (stopped || pendingFollowOpens.has(sessionId)) return;
    pendingFollowOpens.add(sessionId);
    const handle = options.mux.open(FOLLOW_ENDPOINT, {
      args: { request: { address: sessionAddresses.get(sessionId) ?? { kind: 'session', sessionId }, assistantStream: true } },
    });
    registerFollow(handle, sessionId);
  }

  function clearFollowRetry(sessionId: string): void {
    const timer = followRetryTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    followRetryTimers.delete(sessionId);
  }

  function cancelFollowHandles(sessionId: string, keep?: DshBridgeStreamHandle): void {
    for (let index = followHandles.length - 1; index >= 0; index -= 1) {
      const handle = followHandles[index];
      if (!handle || handle === keep || streamSessions.get(handle) !== sessionId) continue;
      followHandles.splice(index, 1);
      streamSessions.delete(handle);
      followSubscriptions.get(handle)?.();
      followSubscriptions.delete(handle);
      handle.cancel();
    }
  }

  function registerFollow(handle: DshBridgeStreamHandle, sessionId?: string): void {
    if (stopped) {
      handle.cancel();
      return;
    }
    followHandles.push(handle);
    if (sessionId !== undefined) {
      streamSessions.set(handle, sessionId);
      // A join-time binding is the primary session (the bootstrap entry):
      // without it the no-argument accessors would stay blind until a
      // reconnect re-taught the session from a snapshot.
      if (primarySessionId === undefined) primarySessionId = sessionId;
      // The bootstrap consumed this stream's snapshot, so the machine must be
      // created here: an absent publication reads as `detached` (the fallback
      // below) and `dshIsServerTerminal` refuses the first send with
      // `server-terminal`. A published phase is never clobbered — a re-opened
      // stream must stay in `rebuilding`/`degraded`.
      if (sessionStates.get(sessionId) === undefined) {
        syncFor(sessionId);
        publishSync(sessionId);
      }
    }
    watchFollowStream(handle, sessionId);
    followSubscriptions.set(handle, handle.onItem((value) => handleFollowFrame(handle, value)));
  }

  /**
   * Attach a live `session/follow` stream. The first authoritative frame
   * rebinds the stream's session; every later snapshot (reconnect) is applied
   * as authoritative full state (R1).
   *
   * The optional binding carries the session ID or complete subagent address: the bootstrap pipeline
   * consumes the stream's first (snapshot) frame itself, so without it the
   * bridge would drop live records until a reconnect re-taught the session.
   * Omitting it keeps the snapshot-learned binding (the landed behavior).
   */
  function attachFollow(handle: DshBridgeStreamHandle, binding?: string | DshSessionAddress, snapshot?: DshJsonValue): void {
    const address = typeof binding === 'string' ? { kind: 'session' as const, sessionId: binding } : binding;
    const sessionId = address?.kind === 'subagent' ? address.childSessionId : address?.sessionId;
    if (address && sessionId) sessionAddresses.set(sessionId, address);
    if (address?.kind === 'session') primarySessionId = address.sessionId;
    registerFollow(handle, sessionId);
    if (snapshot !== undefined) handleFollowFrame(handle, snapshot);
  }

  function watchFollowStream(handle: DshBridgeStreamHandle, sessionId?: string): void {
    if (handle.promise === undefined) return;
    handle.promise.catch((error: unknown) => {
      const id = sessionId ?? streamSessions.get(handle);
      if (id === undefined || stopped || !followHandles.includes(handle)) return;
      const code = dropCodeOf(error);
      if (code !== undefined && TERMINAL_DROP_CODES.has(code)) {
        // Fatal protocol violation (R14) or a deliberate teardown: terminal.
        pendingFollowOpens.delete(id);
        syncFor(id).markTerminal();
        publishSync(id);
        return;
      }
      if (code === 'stream-error' || code === 'host-cancelled') {
        // R16: the stream is dead — rebuild with a fresh open.
        syncFor(id).forceRebuild();
        publishSync(id);
        reopenFollow(id);
        return;
      }
      // The transport died (connection-failed / unclassified): the mux owns
      // the backoff reconnect, so the session degrades until the re-opened
      // stream delivers its snapshot.
      pendingFollowOpens.delete(id);
      markSessionLost(id);
    });
  }

  // -------------------------------------------------------------------------
  // $events stream
  // -------------------------------------------------------------------------

  function handleEventsFrame(value: DshJsonValue | undefined): void {
    if (stopped) return;
    // Guard: the 31-event whitelist plus shape validation — unknown or
    // malformed frames are ignored, never fatal.
    if (!isDshEventsFrame(value)) return;
    switch (value.type) {
      case 'ready':
        // R10: clientId is per-connection; this connection's value replaces
        // any cached one (and answers held back while none was known flush).
        clientId = value.clientId;
        options.onEventsReady?.(value.clientId);
        flushQueuedResponses();
        return;
      case 'emit':
        if (value.event === 'goal/activation-changed') {
          const change = value.args[0];
          if (isRecord(change) && typeof change.sessionId === 'string') {
            mergeSession(change.sessionId, { planGoalRevision: (sessionStates.get(change.sessionId)?.planGoalRevision ?? 0) + 1 });
          }
        }
        options.onEventsEmit?.(value.event, value.args);
        return;
      case 'waterfall':
        routeWaterfall(value);
        return;
      case 'cancel':
        cancelApproval(value.eventId);
        return;
    }
  }

  function routeWaterfall(frame: DshEventsWaterfallFrame): void {
    if (frame.event === 'approval/request') {
      surfaceApproval({
        eventId: frame.eventId,
        agentId: frame.agentId,
        sessionId: primarySessionId ?? '',
        request: frame.request,
      });
      return;
    }
    // user-questions/request: there is no question UI, and an unknown
    // waterfall event is still a blocking request. Both get the terminal
    // safe rejection — never a silent record-and-drop (docs/dsh.md:368).
    const message = frame.event === 'user-questions/request'
      ? USER_QUESTIONS_REJECTION
      : `${UNKNOWN_WATERFALL_REJECTION_PREFIX} ${frame.event}; the request was declined so the turn is not left hanging`;
    void respond(frame.eventId, safeRejection(message));
  }

  function startEventsStream(): void {
    const handle = options.mux.open(EVENTS_ENDPOINT, { args: {} });
    eventsHandle = handle;
    watchEventsStream(handle);
    unsubscribers.push(handle.onItem((value) => handleEventsFrame(value)));
  }

  function watchEventsStream(handle: DshBridgeStreamHandle): void {
    if (handle.promise === undefined) return;
    handle.promise.catch((error: unknown) => {
      // R10: any stream drop voids the connection's clientId until a fresh
      // ready frame re-establishes it.
      clientId = undefined;
      if (stopped) return;
      const code = dropCodeOf(error);
      if (code === 'stream-error' || code === 'host-cancelled') {
        // R16: the stream is dead — rebuild with a fresh open.
        eventsHandle = undefined;
        startEventsStream();
        return;
      }
      if (code !== undefined && TERMINAL_DROP_CODES.has(code)) return;
      // The transport died with the stream: the connection is gone.
      voidConnectionClientId();
      const lostSessions = [...syncs.keys()];
      for (const sessionId of lostSessions) markSessionLost(sessionId);
    });
  }

  // -------------------------------------------------------------------------
  // Waterfall answers (POST /dsh/$events/result)
  // -------------------------------------------------------------------------

  function markAnswered(eventId: string): void {
    if (answeredEventIds.has(eventId)) return;
    answeredEventIds.add(eventId);
    if (answeredEventIds.size > MAX_ANSWERED_EVENT_IDS) {
      const oldest = answeredEventIds.values().next();
      if (!oldest.done) answeredEventIds.delete(oldest.value);
    }
  }

  async function sendResult(
    answerClientId: string,
    eventId: string,
    outcome: DshWaterfallOutcome,
  ): Promise<void> {
    try {
      await resultClient.call(EVENTS_RESULT_NAMESPACE, EVENTS_RESULT_METHOD, {
        clientId: answerClientId,
        eventId,
        outcome: outcome as unknown as DshJsonValue,
      });
    } catch (error) {
      // The request stays pending upstream; surfacing the failure keeps the
      // upper layer from believing the turn resumed.
      options.onWaterfallResponseError?.(eventId, error);
    }
  }

  async function respond(eventId: string, outcome: DshWaterfallOutcome): Promise<void> {
    if (answeredEventIds.has(eventId)) return;
    markAnswered(eventId);
    approvals.delete(eventId);
    const currentClientId = clientId;
    if (currentClientId === undefined) {
      queuedResponses.push({ eventId, outcome });
      return;
    }
    await sendResult(currentClientId, eventId, outcome);
  }

  function flushQueuedResponses(): void {
    const currentClientId = clientId;
    if (currentClientId === undefined) return;
    const held = queuedResponses.splice(0, queuedResponses.length);
    for (const entry of held) void sendResult(currentClientId, entry.eventId, entry.outcome);
  }

  /**
   * The connection is gone: the per-connection clientId is void (R10), and so
   * is everything that depended on it. Answers still queued for the dead
   * connection are dropped and un-marked (they were never delivered, and a
   * re-derived approval must be answerable on the new connection); pending
   * approvals came from the dead `$events` broadcast and are re-derived from
   * the session's authoritative state after the reconnect snapshot (R11).
   */
  function voidConnectionClientId(): void {
    clientId = undefined;
    const held = queuedResponses.splice(0, queuedResponses.length);
    for (const entry of held) answeredEventIds.delete(entry.eventId);
    approvals.clear();
  }

  function surfaceApproval(request: DshApprovalRequest): void {
    if (stopped) return;
    if (answeredEventIds.has(request.eventId) || approvals.has(request.eventId)) return;
    approvals.set(request.eventId, request);
    options.onApprovalRequest?.(request);
    for (const listener of [...approvalListeners]) listener(request);
  }

  function subscribeApprovals(listener: (request: DshApprovalRequest) => void): () => void {
    approvalListeners.add(listener);
    return () => approvalListeners.delete(listener);
  }

  function cancelApproval(eventId: string): void {
    approvals.delete(eventId);
    // The host cancelled the request: a later answer would target a request
    // nobody is waiting for anymore.
    markAnswered(eventId);
  }

  // -------------------------------------------------------------------------
  // Reconnect state machine transitions (Todo 23)
  // -------------------------------------------------------------------------

  function handleConnectionLost(): void {
    if (stopped) return;
    voidConnectionClientId();
    const lostSessions = [...syncs.keys()];
    for (const sessionId of lostSessions) markSessionLost(sessionId);
  }

  function handleReconnectReady(): void {
    if (stopped) return;
    const degradedSessions = [...syncs.keys()];
    for (const sessionId of degradedSessions) {
      const sync = syncs.get(sessionId);
      if (sync === undefined || sync.phase() !== 'degraded') continue;
      sync.markAwaitingSnapshot();
      publishSync(sessionId);
    }
  }

  /**
   * live | rebuilding → degraded for one session: the transport is down, so
   * the busy flag is cleared instead of being falsely preserved (the
   * reconnect snapshot re-derives it from the authoritative turn records).
   */
  function markSessionLost(sessionId: string): void {
    if (stopped) return;
    const sync = syncs.get(sessionId);
    if (sync === undefined || sync.phase() === 'detached') return;
    sync.markConnectionLost();
    publishSync(sessionId);
    mergeSession(sessionId, { busy: false });
  }

  /**
   * R11 re-derivation: `$events` never replays the disconnect window, so the
   * pending-approval state is re-derived from the session's authoritative
   * state (the injected hook reads the follow snapshot records/projections).
   * A synchronous hook is applied synchronously; a promise is awaited behind
   * the session's generation fence, so a commit from a superseded attempt
   * (backend switch, newer snapshot) is dropped.
   */
  function reconcileAfterRebuild(sessionId: string): void {
    const derive = options.reconcileApprovals;
    if (derive === undefined || stopped) return;
    const sync = syncs.get(sessionId);
    const generation = sync?.generation() ?? -1;
    const requests = derive(sessionId);
    if (isPromiseLike(requests)) {
      void Promise.resolve(requests).then((list) => {
        if (stopped) return;
        if (sync !== undefined && !sync.isCurrent(generation)) return;
        for (const request of list) surfaceApproval(request);
      });
      return;
    }
    for (const request of requests) surfaceApproval(request);
  }

  // -------------------------------------------------------------------------
  // session/page history windows (R5/R6 — history only, never reconnect fill)
  // -------------------------------------------------------------------------

  /**
   * Fill one history window BELOW the watermark with `session/page`
   * (R5/R6: `throughSeq` ≤ cursor, `beforeSeq` open upper bound, default
   * `cursor + 1`). Records apply through the replay path (close-only
   * callbacks, no busy re-derivation) and the normalizer's seq gate makes the
   * merge idempotent. Reconnect recovery NEVER goes through here (R4): the
   * reconnect snapshot is full state.
   */
  async function fillHistoryWindow(
    sessionId: string,
    window: { beforeSeq?: number; throughSeq?: number } = {},
  ): Promise<DshHistoryFillResult> {
    const sync = syncs.get(sessionId);
    if (sync === undefined) return { ok: false, reason: 'no-watermark' };
    const plan = sync.planHistoryPage({ sessionId, ...window });
    if (!plan.ok) return plan;
    const fetchPage = options.fetchPage;
    if (fetchPage === undefined) return { ok: false, reason: 'no-page-source' };
    const generation = sync.generation();
    const address = sessionAddresses.get(sessionId);
    const page = await fetchPage({ ...plan.request, ...(address?.kind === 'subagent' ? { address } : {}) });
    if (stopped) return { ok: false, reason: 'stale' };
    if (!sync.isCurrent(generation)) return { ok: false, reason: 'stale' };
    const normalizer = normalizerFor(sessionId);
    const before = normalizer.stats();
    const result = normalizer.ingest({ records: page.records });
    applyResult(result, 'snapshot-rebuild', sessionId, false);
    const after = normalizer.stats();
    return {
      ok: true,
      request: plan.request,
      applied: after.appliedRecordCount - before.appliedRecordCount,
      duplicates: after.duplicateRecordCount - before.duplicateRecordCount,
    };
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  function resolveApproval(eventId: string, outcome: DshWaterfallOutcome): void {
    void respond(eventId, outcome);
  }

  function rejectApproval(eventId: string, message?: string): void {
    void respond(eventId, safeRejection(message ?? DEGRADED_APPROVAL_REJECTION));
  }

  function rejectAllApprovals(message?: string): void {
    const text = message ?? DEGRADED_APPROVAL_REJECTION;
    const pending = [...approvals.keys()];
    for (const eventId of pending) void respond(eventId, safeRejection(text));
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const sessionId of followRetryTimers.keys()) clearFollowRetry(sessionId);
    // Never leave a pending waterfall unanswered, even while disposing.
    const pending = [...approvals.keys()];
    for (const eventId of pending) void respond(eventId, safeRejection(STOP_REJECTION));
    approvalListeners.clear();
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const unsubscribe of followSubscriptions.values()) unsubscribe();
    followSubscriptions.clear();
    for (const handle of followHandles) handle.cancel();
    followHandles.length = 0;
    eventsHandle?.cancel();
    eventsHandle = undefined;
    for (const sessionId of sessionStates.keys()) setSync(sessionId, { kind: 'detached' });
    for (const sync of syncs.values()) sync.markTerminal();
    pendingFollowOpens.clear();
  }

  // The mux owns the transport reconnect (Todo 5: backoff + stream re-open);
  // these hooks only tell the state machine WHEN the window opens (R9).
  if (options.mux.onConnectionLost) {
    unsubscribers.push(options.mux.onConnectionLost(() => handleConnectionLost()));
  }
  if (options.mux.onReconnectReady) {
    unsubscribers.push(options.mux.onReconnectReady(() => handleReconnectReady()));
  }

  startEventsStream();

  return {
    attachFollow,
    detachFollow(sessionId) {
      syncs.get(sessionId)?.markTerminal();
      clearFollowRetry(sessionId);
      cancelFollowHandles(sessionId);
      syncs.delete(sessionId);
      normalizers.delete(sessionId);
      sessionStates.delete(sessionId);
      sessionAddresses.delete(sessionId);
      pendingFollowOpens.delete(sessionId);
      if (primarySessionId === sessionId) primarySessionId = undefined;
    },
    applyHistory(entries: unknown[]) {
      if (stopped) return;
      // Pre-normalized snapshot/history entries are loaded verbatim: no
      // popups, no re-normalization, no op application.
      options.msg.loadHistory(entries);
    },
    fillHistoryWindow,
    resolveApproval,
    rejectApproval,
    rejectAllApprovals,
    subscribeApprovals,
    pendingApprovals: () => [...approvals.values()],
    clientId: () => clientId,
    sessionIds: () => [...normalizers.keys()],
    syncState: (sessionId?: string): DshSyncState => {
      const id = sessionId ?? primarySessionId;
      if (id === undefined) return { kind: 'detached' };
      return sessionStates.get(id)?.sync ?? { kind: 'detached' };
    },
    cursor: (sessionId?: string): number => {
      const id = sessionId ?? primarySessionId;
      if (id === undefined) return -1;
      return normalizers.get(id)?.cursor() ?? -1;
    },
    sessionState: (sessionId?: string): DshBridgeSessionState | undefined => {
      const id = sessionId ?? primarySessionId;
      return id === undefined ? undefined : sessionStates.get(id);
    },
    stop,
  };
}
