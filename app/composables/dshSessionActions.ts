/**
 * dsh session action orchestration (plan Todo 27).
 *
 * The dsh wire contract (docs/dsh.md §7.1/§7.2) exposes:
 *   - `session/rename`  `{request:{sessionId,title}}` → `{title,seq}`
 *   - `session/fork`    `{request:{sessionId,atSeq?}}` → `{sessionId}`
 *   - `workspace/archiveSession` / `unarchiveSession` / `pinSession` / `unpinSession`
 *   - **no** `session/delete` endpoint at all.
 *
 * This module is the single place that encodes those semantics so the shared
 * `useBackendSessionActions` composable never has to guess at a dsh payload and
 * never falls through to the OpenCode generic path. It is deliberately
 * transport-agnostic: the caller injects a {@link DshSessionActionApi} (the
 * adapter-backed seam), which keeps the orchestration unit-testable without a
 * live bridge.
 *
 * Two load-bearing rules live here:
 *
 * 1. **Delete is a documented refusal, never a fabricated request.** dsh has no
 *    server-side delete; VIS-local hide is the only semantics. {@link deleteDshSession}
 *    always throws {@link DshSessionDeleteUnsupportedError} naming the reason, so
 *    a caller can never mistake a silent no-op for a successful remote delete.
 *
 * 2. **Fork restores the archive state and re-subscribes the follow stream.**
 *    The replay-boundary contract (Todo 7, R7) proves `session/list` does NOT
 *    share the `session/follow` stream, so a fork must open a FRESH follow stream
 *    (the stale one is disposed first). The fork's snapshot copies the source's
 *    `archived` flag, and dsh has no server-side unarchive — without an immediate
 *    unarchive the forked session stays in `hiddenThreadIds`. {@link forkDshSession}
 *    therefore injects the archive→unarchive restoration right after the fork ack.
 */

/** Documented reason surfaced when a dsh delete is refused. */
export const DSH_DELETE_UNSUPPORTED_REASON =
  'dsh exposes no session delete endpoint; VIS hides the session locally instead';

/**
 * Raised when a caller asks dsh to delete a session. dsh has no delete endpoint
 * (docs/dsh.md §7.1/§7.2), so this is a refusal with a reason — never a silent
 * no-op and never a fabricated request.
 */
export class DshSessionDeleteUnsupportedError extends Error {
  readonly code = 'dsh/delete-unsupported';
  readonly reason = DSH_DELETE_UNSUPPORTED_REASON;

  constructor() {
    super(DSH_DELETE_UNSUPPORTED_REASON);
    this.name = 'DshSessionDeleteUnsupportedError';
  }
}

/**
 * The dsh session surface this module orchestrates. Mirrors the adapter methods
 * (`DshAdapter.forkSession` / `updateSession`) plus the follow-stream lifecycle
 * the fork path owns. Every method is required: a partially wired host must fail
 * closed at the call site rather than silently skip a step.
 */
export type DshSessionActionApi = {
  renameSession: (sessionId: string, title: string) => Promise<unknown>;
  forkSession: (sessionId: string, atSeq?: number) => Promise<unknown>;
  archiveSession: (sessionId: string) => Promise<unknown>;
  unarchiveSession: (sessionId: string) => Promise<unknown>;
  pinSession: (sessionId: string) => Promise<unknown>;
  unpinSession: (sessionId: string) => Promise<unknown>;
  /** Open a FRESH `session/follow` for the session; returns its snapshot archive flag. */
  followSession: (sessionId: string) => Promise<{ archived?: boolean }>;
  /** Dispose the follow stream previously opened for a session (R7: never reuse). */
  disposeSessionFollow: (sessionId: string) => void;
};

/** Outcome of a dsh fork: the new session id and whether archive state was restored. */
export type DshForkOutcome = {
  sessionId: string;
  archivedRestored: boolean;
};

function readForkedSessionId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const id = record.sessionId ?? record.id;
  return typeof id === 'string' ? id.trim() : '';
}

export function renameDshSession(
  api: DshSessionActionApi,
  sessionId: string,
  title: string,
): Promise<unknown> {
  return api.renameSession(sessionId, title);
}

export function archiveDshSession(api: DshSessionActionApi, sessionId: string): Promise<unknown> {
  return api.archiveSession(sessionId);
}

export function unarchiveDshSession(api: DshSessionActionApi, sessionId: string): Promise<unknown> {
  return api.unarchiveSession(sessionId);
}

export function pinDshSession(api: DshSessionActionApi, sessionId: string): Promise<unknown> {
  return api.pinSession(sessionId);
}

export function unpinDshSession(api: DshSessionActionApi, sessionId: string): Promise<unknown> {
  return api.unpinSession(sessionId);
}

/**
 * Refuse a dsh session delete. Always throws — dsh has no delete endpoint, so
 * there is nothing to call. The caller owns the VIS-local hide.
 */
export function deleteDshSession(): never {
  throw new DshSessionDeleteUnsupportedError();
}

/**
 * Fork a dsh session and restore its archive state.
 *
 * Sequence (asserted by `dshSessionActions.test.ts`):
 *   1. `session/fork` ack → the new session id;
 *   2. dispose the stale follow stream (R7: `session/list` does not share the
 *      `session/follow` stream, so the fork must NOT reuse it);
 *   3. open a FRESH `session/follow` for the forked session and read its snapshot;
 *   4. if the snapshot reports `archived` (the fork copies the source's flag and
 *      dsh has no server-side unarchive), immediately `workspace/unarchiveSession`
 *      so the fork does not stay in `hiddenThreadIds`.
 */
export async function forkDshSession(
  api: DshSessionActionApi,
  sessionId: string,
  atSeq?: number,
): Promise<DshForkOutcome> {
  const forked = await api.forkSession(sessionId, atSeq);
  const forkedId = readForkedSessionId(forked);
  if (!forkedId) throw new Error('dsh session/fork returned no sessionId.');

  // R7: dispose the superseded stream BEFORE opening the fork's own stream.
  api.disposeSessionFollow(sessionId);
  const snapshot = await api.followSession(forkedId);

  const archivedRestored = snapshot.archived === true;
  if (archivedRestored) await api.unarchiveSession(forkedId);

  return { sessionId: forkedId, archivedRestored };
}
