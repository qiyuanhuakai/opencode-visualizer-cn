/**
 * dsh message bridge contracts (plan Todo 19; dsh web 0.2.0-rc.2).
 *
 * Mirrors `kimiWebMessageBridgeTypes.ts` (factory input shape) with the dsh
 * wire contracts from `docs/dsh.md` §8.1/§8.2 and the replay boundary
 * contract (task 7). Everything here is transport-level: the shared
 * `MessageInfo`/`MessagePart` contracts (`app/types/sse.ts`) are never
 * restructured (memory #801) — the bridge only routes the ops the landed
 * Todo 18 normalizer emits.
 */

import type { DshJsonValue, DshRpcArgs } from '../backends/dsh/types';
import type { DshNormalizeOp } from '../backends/dsh/ops';
import type { MessageInfo, MessagePart } from '../types/sse';
import type { DshRpcFetcher, DshRpcTokenProvider } from '../utils/dshRpc';
import type { DshMuxConnectionInfo } from '../utils/dshMux';

/**
 * Structural view of a mux stream handle (superset of `DshMuxStreamHandle`).
 *
 * There is deliberately NO `send`: a `session/follow` stream is downlink-only,
 * so its half-close is `cancel` and never an uplink `end` (replay boundary
 * contract R13 — an uplink `end` on a follow stream silently kills the
 * downlink on the next stray item).
 */
export type DshBridgeStreamHandle = {
  readonly streamId: string;
  /** Live item callback; the returned function unsubscribes. */
  onItem(listener: (value: DshJsonValue | undefined) => void): () => void;
  /** Half-close: sends `cancel` for this stream (R13). */
  cancel(): void;
  /** Settles when the stream ends/fails; used to watch for transport drops. */
  promise?: Promise<readonly (DshJsonValue | undefined)[]>;
};

/**
 * The mux seam the bridge uses for the `$events` stream. Production passes the
 * real client (`createDshMuxClient`); the `session/follow` stream arrives
 * through `attachFollow` because the bootstrap pipeline opens it itself (it
 * needs the snapshot cursor before handing control over).
 *
 * The two optional lifecycle hooks mirror the kimiWebWs precedent
 * (`onClose` / `onReconnectReady`): the mux owns the transport reconnect
 * (Todo 5 — exponential backoff, re-open of every in-flight stream), so the
 * bridge only needs to be told WHEN the connection dropped (every session
 * degrades; the per-connection clientId is void) and WHEN it came back
 * (degraded → rebuilding, awaiting the re-opened stream's snapshot). A mux
 * without them degrades gracefully: transitions still happen through stream
 * drops and snapshot frames.
 */
export type DshBridgeMux = {
  open(endpoint: string, payload: DshRpcArgs): DshBridgeStreamHandle;
  /** Fires on every recoverable socket close (heartbeat loss / 1001). */
  onConnectionLost?: (listener: (info: DshMuxConnectionInfo) => void) => () => void;
  /** Fires when a socket opened and in-flight streams were re-opened (R9). */
  onReconnectReady?: (listener: () => void) => () => void;
};

/** One `session/page` request as planned by the sync state machine (R5/R6). */
export type DshHistoryPageRequest = {
  /** Closed upper bound; never above the watermark (R6). */
  readonly throughSeq: number;
  /** Open upper bound (`seq < beforeSeq`); `cursor + 1` includes the cursor. */
  readonly beforeSeq: number;
};

/** One `session/page` window as returned by the bridge HTTP route. */
export type DshHistoryPageWindow = {
  readonly records: readonly DshJsonValue[];
};

export type DshBridgePageFetcher = (
  request: DshHistoryPageRequest & { readonly sessionId: string },
) => Promise<DshHistoryPageWindow>;

export type DshHistoryFillResult =
  | {
      ok: true;
      request: DshHistoryPageRequest & { readonly sessionId: string };
      /** Records newly applied through the replay path. */
      applied: number;
      /** Records the seq gate recognized as already applied. */
      duplicates: number;
    }
  | {
      ok: false;
      reason:
        /** No follow watermark yet (R7: the watermark comes from snapshots). */
        | 'no-watermark'
        /** The window would reach above the watermark: not history-only. */
        | 'before-seq-above-cursor'
        /** throughSeq above the cursor is a wire bad-request (R6). */
        | 'through-seq-above-cursor'
        /** No page source was injected. */
        | 'no-page-source'
        /** A newer authoritative state landed while the window was in flight. */
        | 'stale';
    };

/**
 * Outcome of a waterfall answer (`docs/dsh.md` §7.1 special endpoints row:
 * `POST /api/$events/result` with `payload.args = {clientId, eventId,
 * outcome}`; outcome = `{kind:"next"}` / `{kind:"result", value?}` /
 * `{kind:"rejected", error:{name,message,code?,details?}}`).
 */
export type DshWaterfallOutcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'result'; readonly value?: DshJsonValue }
  | { readonly kind: 'rejected'; readonly error: DshWaterfallRejection };

export type DshWaterfallRejection = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
};

/** One pending `approval/request` handed to the permission UI surface. */
export type DshApprovalRequest = {
  readonly eventId: string;
  readonly agentId: string;
  /** The follow session the bridge is attached to ('' before the first snapshot). */
  readonly sessionId: string;
  /** The wire request payload, treated as an opaque value by the bridge. */
  readonly request: DshJsonValue;
};

/** Frame provenance — drives popup suppression. */
export type DshFrameOrigin = 'live' | 'snapshot-rebuild';

export type DshFrameContext = {
  readonly origin: DshFrameOrigin;
  readonly sessionId?: string;
};

/**
 * Per-session sync phase (Todo 23 state machine, mirroring the kimi Todo 22
 * precedent):
 *   live → degraded (connection lost) → rebuilding (snapshot pending) → live
 * `detached` is terminal (fatal frame / stopped); `replaying` covers the
 * window between an attach and its first authoritative frame.
 */
export type DshSyncState =
  | { readonly kind: 'detached' }
  /** attach → first authoritative frame. */
  | { readonly kind: 'replaying' }
  /** Connection lost (heartbeat loss / close 1001): awaiting backoff + reopen. */
  | { readonly kind: 'degraded'; readonly cursor: number }
  /** Streams re-opened, authoritative snapshot pending (R9). */
  | { readonly kind: 'rebuilding'; readonly cursor: number }
  | { readonly kind: 'live'; readonly cursor: number };

export type DshCompletion = {
  readonly kind: string;
  readonly code?: string;
  readonly message?: string;
};

export type DshBridgeSessionState = {
  readonly sessionId: string;
  readonly sync: DshSyncState;
  /** Turn running (`turn/start` seen without its `turn/end`). */
  readonly busy?: boolean;
  /** Authoritative completion from `turn/end.reason`. */
  readonly completion?: DshCompletion;
};

/** Bridge HTTP seam: the vis_bridge `/dsh` prefix (never the dsh upstream). */
export type DshBridgeRpcOptions = {
  /** Bridge HTTP prefix (`http://localhost:23004/dsh`) or its `ws://…/dsh/ws` form. */
  readonly baseUrl: string;
  readonly getBridgeToken?: DshRpcTokenProvider;
  readonly fetcher?: DshRpcFetcher;
};

export type DshMessageBridgeOptions = {
  /** Opens the mux `$events` stream; production passes `mux.open('$events', {args:{}})`. */
  readonly mux: DshBridgeMux;
  readonly rpc: DshBridgeRpcOptions;
  /** Shared message facade (the production `useMessages` store). */
  readonly msg: {
    updateMessage(info: MessageInfo): void;
    updatePart(part: MessagePart): void;
    loadHistory(entries: unknown[]): void;
    /**
     * Existing `useMessages` API, used only for the R1 authoritative switch:
     * the snapshot replaces the local view, so the superseded part set is
     * explicitly removed before the snapshot is re-applied. Optional so a
     * facade without it still works (upserts alone stay idempotent).
     */
    removeMessage?(id: string): void;
  };
  /** `session/page` source for history-only windows (R5/R6); never reconnect gap-fill (R4). */
  readonly fetchPage?: DshBridgePageFetcher;
  /** `approval/request` waterfall frame → the existing permission UI surface. */
  readonly onApprovalRequest?: (request: DshApprovalRequest) => void;
  /** Read-only `$events` broadcast (`api-session/*`, `plugin-manager/*`, …). */
  readonly onEventsEmit?: (event: string, args: readonly DshJsonValue[]) => void;
  /** A fresh per-connection `clientId` was captured from the ready frame. */
  readonly onEventsReady?: (clientId: string) => void;
  /** A terminal answer could not be delivered (the turn stays pending upstream). */
  readonly onWaterfallResponseError?: (eventId: string, error: unknown) => void;
  /** Tool part during LIVE frames only (popup surface for Todo 24). */
  readonly onToolPart?: (part: MessagePart) => void;
  /** Reasoning part during LIVE frames only (popup surface for Todo 24). */
  readonly onLiveReasoning?: (info: MessageInfo, part: MessagePart) => void;
  /** Subagent/child-session part during LIVE frames only (popup surface for Todo 24). */
  readonly onLiveSubagent?: (info: MessageInfo, part: MessagePart) => void;
  /** Replay/rebuild parts: may close existing windows, never open one. */
  readonly onReconcilePart?: (info: MessageInfo | undefined, part: MessagePart) => void;
  /** Every non-message/part op (turn/step/policy/title/subagent/error/…). */
  readonly onSessionEvent?: (op: DshNormalizeOp, context: DshFrameContext) => void;
  readonly onSyncStateChange?: (sessionId: string, state: DshSyncState) => void;
  /**
   * R11 re-derivation hook: `$events` is an at-most-once per-connection
   * broadcast and never replays the disconnect window, so after a reconnect
   * snapshot the bridge asks the upper layer to re-derive pending approvals
   * from the session's authoritative state (follow records + projections).
   * Completeness of the recovery is Todo 23's acceptance; this is the hook.
   */
  readonly reconcileApprovals?: (
    sessionId: string,
  ) => DshApprovalRequest[] | Promise<DshApprovalRequest[]>;
};

export type DshMessageBridge = {
  /**
   * Attach the live `session/follow` stream the bootstrap pipeline opened.
   * The first authoritative frame rebinds the stream's session; every later
   * snapshot (reconnect) is applied as authoritative full state (R1).
   *
   * `sessionId` is the optional join-time binding (the bootstrap consumes the
   * first snapshot frame itself, so live records need the session up front);
   * omitting it keeps the snapshot-learned binding.
   */
  attachFollow(handle: DshBridgeStreamHandle, sessionId?: string): void;
  /** Pre-normalized snapshot/history entries: loaded, never popped up. */
  applyHistory(entries: unknown[]): void;
  /**
   * History-only `session/page` fill for a window BELOW the watermark
   * (R5/R6: throughSeq ≤ cursor, beforeSeq open upper bound). Reconnect
   * recovery NEVER goes through here (R4) — it is the snapshot's job.
   * Records apply through the replay path (no popups) and the seq gate makes
   * the merge idempotent (already-applied records count as duplicates).
   */
  fillHistoryWindow(
    sessionId: string,
    window?: { beforeSeq?: number; throughSeq?: number },
  ): Promise<DshHistoryFillResult>;
  /** Answer a pending approval with an explicit outcome (the UI decision). */
  resolveApproval(eventId: string, outcome: DshWaterfallOutcome): void;
  /** Answer one pending approval with the safe-rejection outcome. */
  rejectApproval(eventId: string, message?: string): void;
  /** Answer every pending approval with the safe-rejection outcome (degraded close). */
  rejectAllApprovals(message?: string): void;
  /**
   * Subscribe to `approval/request` frames AFTER construction — the seam the
   * real permission UI attaches to without a construction-order cycle
   * (its reply path needs the bridge, the bridge does not need it). Listeners
   * fire in addition to the construction-time `onApprovalRequest` option;
   * the returned function unsubscribes.
   */
  subscribeApprovals(listener: (request: DshApprovalRequest) => void): () => void;
  pendingApprovals(): readonly DshApprovalRequest[];
  /** The current connection's clientId (void between a drop and the next ready). */
  clientId(): string | undefined;
  sessionIds(): readonly string[];
  syncState(sessionId?: string): DshSyncState;
  /** Applied seq high-water mark for a session (R2: the single watermark). */
  cursor(sessionId?: string): number;
  sessionState(sessionId?: string): DshBridgeSessionState | undefined;
  /** Dispose: answer pending approvals, then cancel both streams (never uplink `end`). */
  stop(): void;
};
