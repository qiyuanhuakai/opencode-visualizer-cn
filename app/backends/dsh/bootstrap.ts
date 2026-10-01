/**
 * dsh workspace bootstrap pipeline (plan Todo 16; mirrors kimiWeb/bootstrap.ts).
 *
 * Stages:
 * 1. `workspace/follow` baseline joined onto `session/list` through the injected
 *    session source (Todo 15 `DshAdapter.listSessions`): workspaceId/path/title
 *    membership plus the archived/pinned classifications.
 * 2. Group the mapped sessions into `serverState.projects` shape (Todo 15
 *    `mapDshSessionsToProjects`).
 * 3. Select the default entry: the first session that is NOT archived and NOT a
 *    child session (plan audit correction, fixes L23 — a child session must
 *    never become the default entry).
 * 4. Open that session's `session/follow` on the injected mux transport. The
 *    first frame is the authoritative full snapshot (Todo 7 R1/R2).
 * 5. Backfill history with `session/page` windows below the snapshot cursor
 *    (Todo 7 R5/R6: history paging only, never reconnect gap filling — that is
 *    R4 and belongs to the message bridge's reconnect path).
 * 6. Commit projects + selection, then hand the live follow handle to the
 *    injected bridge.
 *
 * Staged seams: the snapshot/history normalizer (Todo 18) and the message
 * bridge (Todo 19) are explicitly INJECTED collaborators, so this pipeline is
 * testable before they exist. The registry is deliberately not imported — the
 * adapter arrives as a parameter, and `getActiveBackendAdapter` refusing before
 * the registry placeholder lands is the correct behavior.
 *
 * Generation discipline: every await is followed by an `isCurrent()` fence, so
 * a bootstrap orphaned by a backend switch drops its commits silently and tears
 * its own transport down.
 */

import type { DshMuxClient, DshMuxStreamHandle } from '../../utils/dshMux';
import type { ProjectState } from '../../types/worker-state';
import {
  mapDshSessionsToProjects,
  upsertDshSessionIntoProjects,
  type DshMappedSession,
} from './dshAdapter';
import type { DshJsonValue } from './types';

// ---------------------------------------------------------------------------
// Injected collaborators (the staged seams described above)
// ---------------------------------------------------------------------------

/**
 * Session tree source. Production passes the dsh adapter, whose `listSessions`
 * performs the `workspace/follow` baseline + `session/list` join; tests pass a
 * double. Keeping it structural means this module never reaches for the
 * registry.
 */
export type DshBootstrapSessionSource = {
  listSessions(): Promise<readonly DshMappedSession[]>;
};

/** What the injected normalizer makes of one `session/follow` snapshot frame. */
export type DshSnapshotNormalization = {
  /** Watermark: `max(event.seq)` in the snapshot == `snapshot.cursor` (R2). */
  cursor: number;
  /** Normalized message entries (shape owned by the Todo 18 normalize module). */
  entries: readonly unknown[];
};

export type DshBootstrapNormalizer = {
  normalizeSnapshot(snapshot: DshJsonValue | undefined): DshSnapshotNormalization;
  normalizeHistoryRecords(records: readonly DshJsonValue[]): readonly unknown[];
};

/**
 * One `session/page` window (docs/dsh.md §7.1 → `{records, hasMore}`).
 *
 * `hasMore` is the HISTORY module's own assertion that an older window exists.
 * It is never read from the wire: the wire `hasMore` was measured constant
 * `false` even when older records were still available (Todo 7 R6), so paging
 * must not be driven by it.
 */
export type DshHistoryWindow = {
  /** Raw `session/page` records inside the window. */
  records: readonly DshJsonValue[];
  /** Lowest `event.seq` in the window — the next open upper bound. */
  lowestSeq?: number;
  hasMore: boolean;
};

export type DshHistoryPageRequest = {
  sessionId: string;
  /** OPEN upper bound: only records with `seq < beforeSeq` are wanted. */
  beforeSeq: number;
};

export type DshHistoryPageFetcher = (request: DshHistoryPageRequest) => Promise<DshHistoryWindow>;

/**
 * Message bridge seam (Todo 19 `useDshMessageBridge` in production). Bootstrap
 * opens the follow stream itself — it needs the snapshot for the page cursor —
 * so the bridge ATTACHES to that live stream instead of opening a second one.
 */
export type DshBootstrapBridge = {
  attachFollow(handle: DshMuxStreamHandle, sessionId?: string): void;
  applyHistory(entries: unknown[]): void;
  stop(): void;
};

// ---------------------------------------------------------------------------
// Result contracts
// ---------------------------------------------------------------------------

export type DshBootstrapCommit = {
  projects: Record<string, ProjectState>;
  selectedProjectId: string;
  selectedSessionId: string;
};

/**
 * Tree data source for Todo 21 (`useBackendSessionTrees` dsh branch).
 *
 * `archivedSessionIds` / `pinnedSessionIds` are the `workspace/follow` baseline
 * classifications, and `upsertSession` applies one live session mutation onto a
 * projects store — live-created dsh sessions never pass through `listSessions`,
 * so the tree needs its own upsert path (same helper the adapter uses).
 */
export type DshBootstrapTreeSource = {
  sessions: readonly DshMappedSession[];
  archivedSessionIds: readonly string[];
  pinnedSessionIds: readonly string[];
  upsertSession(projects: Record<string, ProjectState>, session: DshMappedSession): void;
};

export type DshBootstrapResult = {
  /** Live `session/follow` stream for the selected session (Todo 19 attaches). */
  follow?: DshMuxStreamHandle;
  /** The injected bridge, kept alive for the caller (Todo 19). */
  bridge?: DshBootstrapBridge;
  tree: DshBootstrapTreeSource;
};

/** Hard upper bound so a hostile page loop can never spin forever. */
export const DSH_HISTORY_MAX_PAGES = 100;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Resolve with the first frame of a mux stream; reject when the stream fails. */
function readFirstFrame(handle: DshMuxStreamHandle): Promise<DshJsonValue | undefined> {
  return new Promise<DshJsonValue | undefined>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      finish();
    };
    unsubscribe = handle.onItem((value) => settle(() => resolve(value)));
    handle.promise.then(
      (values) => settle(() => resolve(values[0])),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/**
 * Backfill history BELOW the snapshot cursor with `session/page`.
 *
 * The first window uses `beforeSeq: cursor + 1` — `beforeSeq` is an OPEN upper
 * bound, so `+1` is what includes `cursor` itself (Todo 7 R6). Later windows
 * start at the previous window's lowest seq. The walk stops when a window is
 * empty, when the window stops making progress (a frozen `lowestSeq` must not
 * loop), or at the page cap.
 */
async function backfillDshHistory(params: {
  sessionId: string;
  cursor: number;
  fetchPage: DshHistoryPageFetcher;
  normalize: DshBootstrapNormalizer;
  isCurrent: () => boolean;
}): Promise<{ entries: unknown[]; pages: number }> {
  const entries: unknown[] = [];
  let beforeSeq = params.cursor + 1;
  let pages = 0;
  while (pages < DSH_HISTORY_MAX_PAGES) {
    if (!params.isCurrent()) return { entries: [], pages };
    const window = await params.fetchPage({ sessionId: params.sessionId, beforeSeq });
    pages += 1;
    if (window.records.length === 0) break;
    entries.push(...params.normalize.normalizeHistoryRecords(window.records));
    if (!window.hasMore) break;
    const lowest = window.lowestSeq;
    if (lowest === undefined || lowest <= 0 || lowest >= beforeSeq) break;
    beforeSeq = lowest;
  }
  return { entries, pages };
}

function dshBootstrapTreeSource(sessions: readonly DshMappedSession[]): DshBootstrapTreeSource {
  return {
    sessions,
    archivedSessionIds: sessions.filter((session) => session.time?.archived).map((session) => session.id),
    pinnedSessionIds: sessions.filter((session) => session.time?.pinned).map((session) => session.id),
    upsertSession: (projects, session) => {
      upsertDshSessionIntoProjects(projects, session);
    },
  };
}

/**
 * The default entry: the first session that is neither archived nor a child
 * (plan audit correction, fixes L23). Pinned sessions stay eligible.
 */
function dshDefaultEntry(sessions: readonly DshMappedSession[]): DshMappedSession | undefined {
  return sessions.find((session) => !session.parentID && !session.time?.archived);
}

export async function bootstrapDshWorkspace(options: {
  adapter: DshBootstrapSessionSource;
  mux: DshMuxClient;
  createBridge: () => DshBootstrapBridge;
  normalize: DshBootstrapNormalizer;
  fetchPage: DshHistoryPageFetcher;
  isCurrent: () => boolean;
  commit: (state: DshBootstrapCommit) => void;
}): Promise<DshBootstrapResult> {
  const sessions = await options.adapter.listSessions();
  const tree = dshBootstrapTreeSource(sessions);
  if (!options.isCurrent()) return { tree };

  const projects = mapDshSessionsToProjects(sessions);
  const entry = dshDefaultEntry(sessions);

  let follow: DshMuxStreamHandle | undefined;
  let bridge: DshBootstrapBridge | undefined;
  const dispose = () => {
    // Follow streams are downlink-only: the half-close is `cancel`, never an
    // uplink `end` (Todo 7 R13).
    follow?.cancel();
    bridge?.stop();
    options.mux.disconnect();
  };

  try {
    bridge = options.createBridge();
    await options.mux.connect();
    if (!options.isCurrent()) {
      dispose();
      return { tree };
    }

    if (entry) {
      follow = options.mux.open('session/follow', {
        args: { request: { address: { kind: 'session', sessionId: entry.id }, assistantStream: true } },
      });
      const snapshot = await readFirstFrame(follow);
      if (!options.isCurrent()) {
        dispose();
        return { tree };
      }
      const { cursor, entries } = options.normalize.normalizeSnapshot(snapshot);
      const history = await backfillDshHistory({
        sessionId: entry.id,
        cursor,
        fetchPage: options.fetchPage,
        normalize: options.normalize,
        isCurrent: options.isCurrent,
      });
      if (!options.isCurrent()) {
        dispose();
        return { tree };
      }
      // The join-time binding: this stream's snapshot was consumed above, so
      // the bridge cannot learn the session from it (handleFollowFrame resolves
      // later frames through streamSessions / primarySessionId).
      bridge.attachFollow(follow, entry.id);
      bridge.applyHistory([...entries, ...history.entries]);
      if (!options.isCurrent()) {
        dispose();
        return { tree };
      }
      options.commit({
        projects,
        selectedProjectId: entry.workspaceId,
        selectedSessionId: entry.id,
      });
      return { follow, bridge, tree };
    }

    // Empty workspace (or every session filtered out): the tree is still
    // committed so the UI shows an empty tree instead of a health-check-only
    // success, and the transport stays up for the first session the user
    // creates (kimi bootstrap precedent).
    options.commit({ projects, selectedProjectId: '', selectedSessionId: '' });
    return { bridge, tree };
  } catch (error) {
    dispose();
    throw error;
  }
}
