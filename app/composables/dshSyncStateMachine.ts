/**
 * Per-session sync state machine for the dsh message bridge (plan Todo 23).
 *
 * Mirrors the kimi Todo 22 hardening precedent (a per-session
 * live / degraded / rebuilding machine with generation fencing), translated
 * to the dsh replay boundary contract measured in task 7 (R1–R16):
 *
 *   live ──connection lost (heartbeat miss / close 1001)──▶ degraded
 *   degraded ──transport reconnected, streams re-opened (R9)──▶ rebuilding
 *   rebuilding ──authoritative snapshot (R1)──▶ live
 *
 * Invariants enforced here (the numbers are the task-7 contract rules):
 *   R1  a snapshot is authoritative full state — the caller clears the
 *       superseded part set and re-applies; already-applied seqs are NEVER
 *       replayed (`admitFrame` drops seq ≤ cursor while live);
 *   R2  cursor is the single watermark;
 *   R4  reconnect recovery is snapshot-only — `session/page` is planned as a
 *       history-only window (R5/R6) and is never consulted here;
 *   R9  `rebuilding` is exactly "streams re-opened, first frame pending";
 *   R10 nothing per-connection lives in this module (clientId belongs to the
 *       bridge, which voids it on connection loss);
 *   R11 nothing is "waited for" here — buffered frames are either covered by
 *       the snapshot (dropped) or strictly newer (applied in order);
 *   R15 frames of a terminal (detached) session are dropped;
 *   R16 the bridge reacts to a dead stream by re-opening; this machine only
 *       provides the `forceRebuild` fence for it.
 *
 * The module is pure: it owns the transition table and the frame admission
 * decisions, and never touches the message store, the normalizer, or the
 * transport. The bridge (`useDshMessageBridge.ts`) performs the effects.
 */

/** Per-session phase. `detached` is terminal: no recovery will come. */
export type DshSyncPhase = 'live' | 'degraded' | 'rebuilding' | 'detached';

/** What the bridge must do with one follow frame value. */
export type DshSyncFrameDecision =
  /** Apply live (seq == cursor + 1, volatile, or the first frame after join). */
  | { action: 'apply' }
  /** Held while not live; drained in arrival order after the snapshot. */
  | { action: 'buffer' }
  /** Duplicate / late / terminal: already applied or unrecoverable. */
  | { action: 'drop' }
  /** A gap was detected: the caller must force a rebuild (fresh open). */
  | { action: 'gap' };

/** Outcome of planning one snapshot frame. */
export type DshSyncSnapshotSwitch =
  /** Late snapshot (cursor behind the watermark): dropped, state untouched. */
  | { action: 'drop-stale' }
  /** Authoritative switch granted; the buffer is handed to the caller. */
  | { action: 'apply'; buffered: unknown[] };

/** One planned `session/page` request (R6 bounds applied). */
export type DshHistoryPageRequest = {
  readonly sessionId: string;
  /** Closed upper bound; never above the watermark (R6). */
  readonly throughSeq: number;
  /** Open upper bound (`seq < beforeSeq`); `cursor + 1` includes the cursor. */
  readonly beforeSeq: number;
};

export type DshHistoryPagePlan =
  | { ok: true; request: DshHistoryPageRequest }
  | {
      ok: false;
      reason:
        /** No follow watermark yet (R7: the watermark comes from snapshots). */
        | 'no-watermark'
        /** The window would reach above the watermark: not history-only. */
        | 'before-seq-above-cursor'
        /** throughSeq above the cursor is a wire bad-request (R6). */
        | 'through-seq-above-cursor';
    };

export type DshSessionSyncState = {
  phase(): DshSyncPhase;
  /** Applied seq watermark (R2); -1 before the first authoritative frame. */
  cursor(): number;
  /** Fence token: bumped on every transition that invalidates in-flight work. */
  generation(): number;
  isCurrent(generation: number): boolean;
  bufferedCount(): number;
  /** live | rebuilding → degraded (connection lost). Clears the buffer. */
  markConnectionLost(): void;
  /** degraded → rebuilding (streams re-opened, snapshot pending). */
  markAwaitingSnapshot(): void;
  /** Any phase → detached (terminal: fatal frame / stopped). */
  markTerminal(): void;
  /** Any phase → rebuilding (gap / dead stream / explicit retry). */
  forceRebuild(): void;
  /** Observability hook: a snapshot is being applied synchronously. */
  beginSnapshotApply(): void;
  /** Decide what to do with a follow frame value (mutates on gap). */
  admitFrame(value: unknown): DshSyncFrameDecision;
  /** Plan the authoritative switch for one snapshot frame. */
  planSnapshot(snapshot: { cursor: number; version?: number }): DshSyncSnapshotSwitch;
  /** Commit the applied snapshot watermark (also starts a new generation). */
  commitSnapshot(cursor: number, version?: number): void;
  /** Record a live application (advances the watermark). */
  noteApplied(seq: number | undefined): void;
  /** Re-buffer frames that could not be drained (drain-time gap). */
  bufferFrames(values: readonly unknown[]): void;
  /** Plan a history-only `session/page` window (R5/R6). */
  planHistoryPage(input: {
    sessionId: string;
    beforeSeq?: number;
    throughSeq?: number;
  }): DshHistoryPagePlan;
};

/** Default mirror of the kimi precedent's bound on the rebuild buffer. */
const DEFAULT_MAX_BUFFERED_FRAMES = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `event.seq` of one follow frame value, when it carries one.
 *
 * Follow frames arrive either as the record itself (`{type:'event',
 * event:{type,seq,…}}`) or, defensively, wrapped in a mux `item` envelope.
 * Snapshots, volatile `assistant-stream` frames and non-records carry no
 * seq and are admitted without a watermark check.
 */
export function dshFollowFrameSeq(value: unknown): number | undefined {
  let frame = value;
  for (let depth = 0; depth < 4 && isRecord(frame); depth += 1) {
    if (frame.type === 'item' && 'value' in frame) {
      frame = frame.value;
      continue;
    }
    if (frame.type === 'event' || 'event' in frame) {
      const event = frame.event;
      if (isRecord(event) && typeof event.seq === 'number' && Number.isFinite(event.seq)) {
        return event.seq;
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

export function createDshSessionSyncState(
  options: { maxBufferedFrames?: number } = {},
): DshSessionSyncState {
  const maxBuffered = Math.max(1, options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES);
  let phase: DshSyncPhase = 'live';
  let cursor = -1;
  /** Snapshot header version of the applied state (the epoch substitute). */
  let version: number | undefined;
  let generation = 0;
  /** False until the first frame: joining mid-stream must not look like a gap. */
  let synchronized = false;
  let buffered: unknown[] = [];

  function bump(): void {
    generation += 1;
  }

  function pushBuffered(value: unknown): void {
    buffered.push(value);
    if (buffered.length > maxBuffered) {
      // Overflow: the pending snapshot is a full replay that supersedes the
      // whole queue, so the queue is dropped and the generation bumped to
      // fence any commit that was waiting on the old buffer.
      buffered = [];
      bump();
    }
  }

  function takeBuffer(): unknown[] {
    const taken = buffered;
    buffered = [];
    return taken;
  }

  function admitFrame(value: unknown): DshSyncFrameDecision {
    if (phase === 'detached') return { action: 'drop' };
    if (phase !== 'live') {
      pushBuffered(value);
      return { action: 'buffer' };
    }
    const seq = dshFollowFrameSeq(value);
    if (!synchronized) {
      // The bridge attaches to a live session mid-stream (bootstrap consumed
      // the first snapshot): the first frame is accepted whatever its seq.
      synchronized = true;
      if (seq !== undefined && seq > cursor) cursor = seq;
      return { action: 'apply' };
    }
    if (seq === undefined) return { action: 'apply' };
    if (seq <= cursor) return { action: 'drop' };
    if (seq > cursor + 1) {
      // Missing seqs: rebuild from authority, never silently skip (R1).
      phase = 'rebuilding';
      buffered = [];
      bump();
      pushBuffered(value);
      return { action: 'gap' };
    }
    return { action: 'apply' };
  }

  function planSnapshot(snapshot: { cursor: number; version?: number }): DshSyncSnapshotSwitch {
    const epochChange =
      version !== undefined && snapshot.version !== undefined && snapshot.version !== version;
    if (!epochChange && snapshot.cursor < cursor) {
      // A late snapshot must not overwrite newer state. If it was the one a
      // rebuild was waiting for, the session degrades instead of hanging in
      // `rebuilding`; a live session simply ignores the late frame.
      if (phase === 'rebuilding') {
        phase = 'degraded';
        buffered = [];
        bump();
      }
      return { action: 'drop-stale' };
    }
    return { action: 'apply', buffered: takeBuffer() };
  }

  function planHistoryPage(input: {
    sessionId: string;
    beforeSeq?: number;
    throughSeq?: number;
  }): DshHistoryPagePlan {
    if (cursor < 0) return { ok: false, reason: 'no-watermark' };
    // Open upper bound; the default includes the cursor itself (R6 +1).
    const beforeSeq = input.beforeSeq ?? cursor + 1;
    if (beforeSeq > cursor + 1) return { ok: false, reason: 'before-seq-above-cursor' };
    // Closed upper bound, never above the watermark (R6: the wire rejects it).
    const throughSeq = input.throughSeq ?? cursor;
    if (throughSeq > cursor) return { ok: false, reason: 'through-seq-above-cursor' };
    return { ok: true, request: { sessionId: input.sessionId, throughSeq, beforeSeq } };
  }

  return {
    phase: () => phase,
    cursor: () => cursor,
    generation: () => generation,
    isCurrent: (candidate) => candidate === generation,
    bufferedCount: () => buffered.length,
    markConnectionLost() {
      if (phase === 'detached') return;
      phase = 'degraded';
      buffered = [];
      bump();
    },
    markAwaitingSnapshot() {
      if (phase === 'detached') return;
      phase = 'rebuilding';
      bump();
    },
    markTerminal() {
      phase = 'detached';
      buffered = [];
      bump();
    },
    forceRebuild() {
      if (phase === 'detached') return;
      phase = 'rebuilding';
      buffered = [];
      bump();
    },
    beginSnapshotApply() {
      if (phase !== 'rebuilding') {
        phase = 'rebuilding';
        bump();
      }
    },
    admitFrame,
    planSnapshot,
    commitSnapshot(appliedCursor: number, appliedVersion?: number) {
      cursor = appliedCursor;
      if (appliedVersion !== undefined) version = appliedVersion;
      synchronized = true;
      phase = 'live';
      // Every authoritative switch starts a new recovery generation so a
      // commit still in flight from a superseded attempt is fenced out.
      bump();
    },
    noteApplied(seq: number | undefined) {
      if (seq !== undefined && seq > cursor) cursor = seq;
    },
    bufferFrames(values: readonly unknown[]) {
      for (const value of values) pushBuffered(value);
    },
    planHistoryPage,
  };
}
