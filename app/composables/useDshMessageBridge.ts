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
 * Reconnect semantics follow the replay boundary contract (task 7):
 *   - R1/R2: a snapshot is authoritative full state; the seq gate is reset
 *     and the snapshot re-applied (upsert by identity), `cursor` is the
 *     single watermark;
 *   - R10: `clientId` is per-connection — a dropped socket voids it and the
 *     next ready frame replaces it, so a stale clientId is never answered
 *     with;
 *   - R11: `$events` never replays the disconnect window, so after a
 *     reconnect snapshot the bridge re-derives pending approvals through the
 *     injected `reconcileApprovals` hook (completeness: Todo 23);
 *   - R13: follow streams are downlink-only — half-close is `cancel`, and
 *     this bridge has no uplink `end` path at all.
 *
 * Popup side effects (Todo 24's `onToolPart` / `onLiveReasoning` /
 * `onLiveSubagent`) fire ONLY for live frames; snapshot rebuilds, history
 * loads and replays route through `onReconcilePart`, which may close an
 * existing window but never opens one.
 */

import { shallowReactive } from 'vue';

import { createDshNormalizer } from '../backends/dsh/normalize';
import type { DshNormalizeResult, DshNormalizer } from '../backends/dsh/ops';
import {
  isDshEventsFrame,
  type DshEventsWaterfallFrame,
  type DshJsonValue,
} from '../backends/dsh/types';
import { createDshRpcClient, deriveDshBridgeHttpUrl } from '../utils/dshRpc';
import type { MessageInfo, MessagePart } from '../types/sse';
import type {
  DshApprovalRequest,
  DshBridgeSessionState,
  DshBridgeStreamHandle,
  DshCompletion,
  DshFrameOrigin,
  DshMessageBridge,
  DshMessageBridgeOptions,
  DshSyncState,
  DshWaterfallOutcome,
} from './dshMessageBridgeTypes';

/** The logical `$events` stream endpoint on the mux (upstream name, docs §8.1). */
const EVENTS_ENDPOINT = '$events';
/** The answer route: `POST <bridge>/dsh/$events/result` (docs §7.1 special endpoints). */
const EVENTS_RESULT_NAMESPACE = '$events';
const EVENTS_RESULT_METHOD = 'result';

/** Guard so a long-lived session cannot grow the answered-set without bound. */
const MAX_ANSWERED_EVENT_IDS = 1024;

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

export function useDshMessageBridge(options: DshMessageBridgeOptions): DshMessageBridge {
  const resultClient = createDshRpcClient({
    baseUrl: resolveBridgeHttpPrefix(options.rpc.baseUrl),
    getBridgeToken: options.rpc.getBridgeToken,
    fetcher: options.rpc.fetcher,
  });

  const messages = new Map<string, MessageInfo>();
  const normalizers = new Map<string, DshNormalizer>();
  const sessionStates = shallowReactive(new Map<string, DshBridgeSessionState>());
  /** Which session a live follow stream delivers (learned from its snapshot). */
  const streamSessions = new Map<DshBridgeStreamHandle, string>();
  const approvals = new Map<string, DshApprovalRequest>();
  const answeredEventIds = new Set<string>();
  /** Terminal answers held back while no connection clientId is available. */
  const queuedResponses: Array<{ eventId: string; outcome: DshWaterfallOutcome }> = [];
  const unsubscribers: Array<() => void> = [];

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
      normalizer = createDshNormalizer({ address: { kind: 'session', sessionId } });
      normalizers.set(sessionId, normalizer);
    }
    return normalizer;
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

  function applyPartOp(part: MessagePart, origin: DshFrameOrigin, sessionId: string): void {
    options.msg.updatePart(part);
    const info = messages.get(part.messageID);
    if (origin === 'live') {
      // Precedence matters: a child session's tool/reasoning part must reach the
      // subagent surface, so the session-mismatch check comes before the type checks.
      if (part.type === 'subtask' || part.sessionID !== (primarySessionId ?? sessionId)) {
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
  ): void {
    for (const op of result.ops) {
      if (op.kind === 'message') {
        messages.set(op.message.id, op.message);
        options.msg.updateMessage(op.message);
        continue;
      }
      if (op.kind === 'part') {
        applyPartOp(op.part, origin, sessionId);
        continue;
      }
      if (op.kind === 'turn') {
        if (op.phase === 'started') {
          mergeSession(sessionId, { busy: true });
        } else {
          mergeSession(sessionId, {
            busy: false,
            completion: op.reason
              ? completionOf(op.reason.kind, op.reason.code, op.reason.message)
              : undefined,
          });
        }
      }
      options.onSessionEvent?.(op, { origin, sessionId });
    }
  }

  // -------------------------------------------------------------------------
  // session/follow stream
  // -------------------------------------------------------------------------

  function handleFollowFrame(handle: DshBridgeStreamHandle, value: DshJsonValue | undefined): void {
    if (stopped || !isRecord(value)) return;

    if (value.type === 'snapshot') {
      const header = isRecord(value.header) ? value.header : {};
      const sessionId =
        typeof header.id === 'string' && header.id.length > 0
          ? header.id
          : streamSessions.get(handle);
      if (sessionId === undefined) return;
      streamSessions.set(handle, sessionId);
      if (primarySessionId === undefined) primarySessionId = sessionId;
      // R1: the snapshot is authoritative full state, so the seq gate is reset
      // and every record re-applied (upsert by identity) — a reconnect that
      // replays already-seen seqs must not skip them silently, and a record
      // from the disconnect window must not be lost either.
      const normalizer = normalizerFor(sessionId);
      normalizer.reset();
      setSync(sessionId, { kind: 'rebuilding' });
      const result = normalizer.ingest(value);
      applyResult(result, 'snapshot-rebuild', sessionId);
      setSync(sessionId, { kind: 'live', cursor: normalizer.cursor() });
      reconcileAfterRebuild(sessionId);
      return;
    }

    const sessionId = streamSessions.get(handle) ?? primarySessionId;
    if (sessionId === undefined) return;
    const normalizer = normalizerFor(sessionId);
    const result = normalizer.ingest(value);
    applyResult(result, 'live', sessionId);
    setSync(sessionId, { kind: 'live', cursor: normalizer.cursor() });
  }

  /**
   * R11 re-derivation: `$events` never replays the disconnect window, so the
   * pending-approval state is re-derived from the session's authoritative
   * state (the injected hook reads the follow snapshot records/projections).
   * A synchronous hook is applied synchronously; a promise is awaited.
   */
  function reconcileAfterRebuild(sessionId: string): void {
    const derive = options.reconcileApprovals;
    if (derive === undefined || stopped) return;
    const requests = derive(sessionId);
    if (isPromiseLike(requests)) {
      void Promise.resolve(requests).then((list) => {
        if (stopped) return;
        for (const request of list) surfaceApproval(request);
      });
      return;
    }
    for (const request of requests) surfaceApproval(request);
  }

  function watchStream(handle: DshBridgeStreamHandle, onDrop: () => void): void {
    if (handle.promise === undefined) return;
    handle.promise.catch(() => onDrop());
  }

  function attachFollow(handle: DshBridgeStreamHandle): void {
    if (stopped) {
      handle.cancel();
      return;
    }
    followHandles.push(handle);
    watchStream(handle, () => {
      const sessionId = streamSessions.get(handle);
      if (sessionId !== undefined) setSync(sessionId, { kind: 'detached' });
    });
    unsubscribers.push(handle.onItem((value) => handleFollowFrame(handle, value)));
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
    watchStream(handle, () => {
      // R10: a dropped connection's clientId is void from here on; answers
      // are held until the re-opened stream's ready frame arrives.
      clientId = undefined;
    });
    unsubscribers.push(handle.onItem((value) => handleEventsFrame(value)));
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

  function surfaceApproval(request: DshApprovalRequest): void {
    if (stopped) return;
    if (answeredEventIds.has(request.eventId) || approvals.has(request.eventId)) return;
    approvals.set(request.eventId, request);
    options.onApprovalRequest?.(request);
  }

  function cancelApproval(eventId: string): void {
    approvals.delete(eventId);
    // The host cancelled the request: a later answer would target a request
    // nobody is waiting for anymore.
    markAnswered(eventId);
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
    // Never leave a pending waterfall unanswered, even while disposing.
    const pending = [...approvals.keys()];
    for (const eventId of pending) void respond(eventId, safeRejection(STOP_REJECTION));
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const handle of followHandles) handle.cancel();
    followHandles.length = 0;
    eventsHandle?.cancel();
    eventsHandle = undefined;
    for (const sessionId of sessionStates.keys()) setSync(sessionId, { kind: 'detached' });
  }

  startEventsStream();

  return {
    attachFollow,
    applyHistory(entries: unknown[]) {
      if (stopped) return;
      // Pre-normalized snapshot/history entries are loaded verbatim: no
      // popups, no re-normalization, no op application.
      options.msg.loadHistory(entries);
    },
    resolveApproval,
    rejectApproval,
    rejectAllApprovals,
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
