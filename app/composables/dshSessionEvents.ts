/**
 * dsh session events applier (plan Todo 22; dsh web 0.2.0-rc.2, docs/dsh.md §8).
 *
 * Mirrors `kimiWebSessionEvents.ts`: the inbox/thread event family
 * (`turn/start`, `turn/end`, `agent/inbox/spliced` / `user/message`,
 * `session/title`, subagent child terminals) is normalized onto the shared
 * `serverSessionsChanged` record and applied to `serverState.projects`. The
 * shared `MessageInfo`/`MessagePart` contracts are never restructured here —
 * message ops stay owned by the message bridge (memory #801).
 *
 * Status semantics (plan IS-5):
 *   - a session that has not run in this connection stays 'unknown'
 *     (hollow gray) — an ended turn must never fabricate Idle for it;
 *   - 'busy' from `turn/start` until `turn/end`, whose `reason.kind` is the
 *     ONLY completion authority;
 *   - a snapshot rebuild (replay) applies durable fields only (title): it
 *     must not fabricate transient busy/idle state or rewrite activity time.
 *
 * Step churn, system context snapshots and policy/request envelopes carry no
 * session-visible state and normalize to nothing.
 *
 * pid: dsh `session/list` reports NO pid, so every mapped or normalized
 * record defaults pid to the empty string — never `undefined`, so a display
 * consumer's `pid.startsWith(...)` cannot throw a TypeError (MCP
 * continuation note; the regression lives in dshSessionEvents.test.ts).
 */

import type { DshNormalizeOp, DshTurnReason } from '../backends/dsh/ops';
import type { ProjectState, SessionState } from '../types/worker-state';

/** Where a frame came from — replay must not fabricate transient state. */
export type DshSessionEventOrigin = 'live' | 'snapshot-rebuild';

export type DshSessionEventContext = {
  /** Follow-stream session id, when the frame carried one. */
  readonly sessionId?: string;
  readonly origin?: DshSessionEventOrigin;
  /** dsh never reports pid; present only for forward compatibility. */
  readonly pid?: unknown;
};

/** The shared record every dsh inbox/thread event normalizes onto. */
export type DshServerSessionChange = {
  readonly sessionId: string;
  /** Defaults to '' — dsh session/list has no pid (never `undefined`). */
  readonly pid: string;
  readonly status?: Extract<NonNullable<SessionState['status']>, 'busy' | 'idle'>;
  readonly title?: string;
  readonly timeUpdated?: number;
  readonly timeArchived?: number;
  readonly turn?: number;
  /** Authoritative only from `turn/end.reason`. */
  readonly reason?: DshTurnReason;
};

/** The pid-safe dsh session view (the mapping layer that defaults pid). */
export type DshEventSession = {
  readonly id: string;
  readonly workspaceId: string;
  readonly directory: string;
  readonly title: string;
  readonly status: NonNullable<SessionState['status']>;
  readonly parentID?: string;
  /** '' unless a pid is explicitly present (dsh reports none). */
  readonly pid: string;
  readonly timeCreated?: number;
  readonly timeUpdated?: number;
  readonly model?: string;
};

/** One sidebar entry: the shared SessionCard contract (no native scrollbar). */
export type DshMoreSessionCard = {
  readonly sessionId: string;
  readonly title: string;
  readonly status: SessionState['status'];
  readonly timeCreated?: number;
  readonly timeUpdated?: number;
  readonly directory: string;
  readonly workspaceId: string;
  /** '' for every dsh session — the pid empty-string contract. */
  readonly pid: string;
};

/** The dsh more-sessions sidebar contract (App.vue renders shared cards). */
export type DshMoreSessionsMenu = {
  readonly contract: 'shared-session-cards';
  readonly cards: readonly DshMoreSessionCard[];
  readonly selectedSessionId: string | undefined;
};

/**
 * The ONE shared event transport seam. The dsh message bridge feeds
 * `emitSessionEvent` from its single `$events`/follow event source and
 * `emitPromptRunning` from the send path; subscribers fan out per session id
 * — never one transport per session.
 */
export type DshSessionEventHub = {
  emitSessionEvent(op: DshNormalizeOp, context?: DshSessionEventContext): void;
  emitPromptRunning(sessionId: string): void;
  onSessionEvent(listener: (op: DshNormalizeOp, context: DshSessionEventContext) => void): () => void;
  onPromptRunning(listener: (sessionId: string) => void): () => void;
};

/** dsh session/list reports no pid: '' by default, never `undefined`. */
export function dshSessionPid(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map one dsh session record (session/list item, session/create response or
 * follow snapshot projection) onto the pid-safe event view. Workspace path
 * wins over the item cwd when both are present; a missing pid maps to ''.
 */
export function mapDshEventSession(raw: unknown): DshEventSession | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readString(raw.id) || readString(raw.sessionId);
  if (!id) return undefined;
  const directory = readString(raw.directory) || readString(raw.cwd) || '/';
  const status = raw.status;
  return {
    id,
    workspaceId: readString(raw.workspaceId) || readString(raw.projectID) || readString(raw.projectId),
    directory,
    title: readString(raw.title) || id,
    status:
      status === 'busy' || status === 'idle' || status === 'retry' || status === 'unknown'
        ? status
        : raw.busy === true
          ? 'busy'
          : 'unknown',
    ...(readString(raw.parentID) || readString(raw.parentSession)
      ? { parentID: readString(raw.parentID) || readString(raw.parentSession) }
      : {}),
    pid: dshSessionPid(raw.pid),
    ...(readTimestamp(raw.timeCreated) !== undefined ? { timeCreated: readTimestamp(raw.timeCreated) } : {}),
    ...(readTimestamp(raw.timeUpdated) !== undefined ? { timeUpdated: readTimestamp(raw.timeUpdated) } : {}),
    ...(isRecord(raw.time)
      ? {
          ...(readTimestamp(raw.time.created) !== undefined ? { timeCreated: readTimestamp(raw.time.created) } : {}),
          ...(readTimestamp(raw.time.updated) !== undefined ? { timeUpdated: readTimestamp(raw.time.updated) } : {}),
        }
      : {}),
    ...(readString(raw.model) ? { model: readString(raw.model) } : {}),
  };
}

/**
 * Normalize ONE inbox/thread event onto the shared `serverSessionsChanged`
 * record. Returns undefined when the event carries no session-visible state
 * (steps, system snapshots, message/part/policy/request ops) or when a
 * snapshot rebuild would otherwise fabricate transient state.
 */
export function normalizeDshSessionEvent(
  op: DshNormalizeOp,
  context: DshSessionEventContext = {},
): DshServerSessionChange | undefined {
  const pid = dshSessionPid(context.pid);
  const replay = context.origin === 'snapshot-rebuild';
  switch (op.kind) {
    case 'turn':
      // Rebuilds replay whole histories: a historical turn must not flip the
      // live dot or rewrite activity time.
      if (replay) return undefined;
      return op.phase === 'started'
        ? { sessionId: op.sessionId, pid, status: 'busy', timeUpdated: op.time, turn: op.turn }
        : {
            sessionId: op.sessionId,
            pid,
            status: 'idle',
            timeUpdated: op.time,
            turn: op.turn,
            ...(op.reason ? { reason: op.reason } : {}),
          };
    case 'session-title':
      // Durable: a rebuild title is authoritative.
      return { sessionId: op.sessionId, pid, title: op.title, ...(replay ? {} : { timeUpdated: op.time }) };
    case 'user-message':
      // Inbox acceptance is activity; replays must not rewrite the clock.
      return replay ? undefined : { sessionId: op.sessionId, pid, timeUpdated: op.time };
    case 'subagent':
      return replay ? undefined : { sessionId: op.parentSessionId, pid, timeUpdated: op.time };
    default:
      return undefined;
  }
}

/** The optimistic prompt-accepted marker (mirrors the kimi prompt-running dispatch). */
export function dshPromptRunningChange(sessionId: string, time: number = Date.now()): DshServerSessionChange {
  return { sessionId, pid: '', status: 'busy', timeUpdated: time };
}

/**
 * Apply one normalized change onto `serverState.projects`, scoped to the
 * change's own session id (cross-session isolation). Idle only lands on a
 * session that already ran in this connection; 'unknown' stays hollow.
 */
export function applyDshSessionEvent(
  projects: Record<string, ProjectState>,
  change: DshServerSessionChange,
): void {
  for (const project of Object.values(projects)) {
    for (const sandbox of Object.values(project.sandboxes)) {
      const session = sandbox.sessions[change.sessionId];
      if (!session) continue;
      if (change.title !== undefined) session.title = change.title;
      if (change.status === 'busy') session.status = 'busy';
      else if (change.status === 'idle' && (session.status === 'busy' || session.status === 'idle')) {
        session.status = 'idle';
      }
      if (change.timeUpdated !== undefined) session.timeUpdated = change.timeUpdated;
      if (change.timeArchived !== undefined) session.timeArchived = change.timeArchived;
    }
  }
}

/** Normalize and apply in one step (the App.vue wiring shape). */
export function applyDshSessionEventOp(
  projects: Record<string, ProjectState>,
  op: DshNormalizeOp,
  context: DshSessionEventContext = {},
): void {
  const change = normalizeDshSessionEvent(op, context);
  if (!change) return;
  applyDshSessionEvent(projects, change);
}

/** Create the ONE shared event transport the bridge and send path feed. */
export function createDshSessionEventHub(): DshSessionEventHub {
  const sessionListeners = new Set<(op: DshNormalizeOp, context: DshSessionEventContext) => void>();
  const promptListeners = new Set<(sessionId: string) => void>();
  return {
    emitSessionEvent(op, context = {}) {
      for (const listener of [...sessionListeners]) listener(op, context);
    },
    emitPromptRunning(sessionId) {
      for (const listener of [...promptListeners]) listener(sessionId);
    },
    onSessionEvent(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    onPromptRunning(listener) {
      promptListeners.add(listener);
      return () => {
        promptListeners.delete(listener);
      };
    },
  };
}
