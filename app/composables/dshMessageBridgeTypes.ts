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
 */
export type DshBridgeMux = {
  open(endpoint: string, payload: DshRpcArgs): DshBridgeStreamHandle;
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

export type DshSyncState =
  | { readonly kind: 'detached' }
  /** attach → first authoritative frame. */
  | { readonly kind: 'replaying' }
  /** A reconnect snapshot is being applied (authoritative full state). */
  | { readonly kind: 'rebuilding' }
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
  };
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
   */
  attachFollow(handle: DshBridgeStreamHandle): void;
  /** Pre-normalized snapshot/history entries: loaded, never popped up. */
  applyHistory(entries: unknown[]): void;
  /** Answer a pending approval with an explicit outcome (the UI decision). */
  resolveApproval(eventId: string, outcome: DshWaterfallOutcome): void;
  /** Answer one pending approval with the safe-rejection outcome. */
  rejectApproval(eventId: string, message?: string): void;
  /** Answer every pending approval with the safe-rejection outcome (degraded close). */
  rejectAllApprovals(message?: string): void;
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
