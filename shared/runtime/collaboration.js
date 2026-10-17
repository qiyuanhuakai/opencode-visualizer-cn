import { ProtocolError } from './capabilities.js';
import { encodeSessionKey, parseSessionRef } from './identity.js';

/**
 * The frozen collaboration contract (task 37): Team / Task / Attempt coordination.
 *
 * Everything a coordinator, a task graph, an attempt service or an acceptance service must agree
 * on lives here as ONE frozen object or ONE frozen table, so no service can invent its own limit
 * or its own state name. In particular the five coordination budgets are a single frozen object:
 * concurrency 4, Session mutation 1, depth 4, children 32, mailbox 1000.
 *
 * The load-bearing distinction of this contract — "a native end is not a task success" — is
 * expressed by keeping the TASK lifecycle tables (review, acceptance) separate from the ATTEMPT
 * lifecycle tables (accepted, sent, observed, terminal, reconcile). Nothing in this module maps a
 * native terminal reason onto a task acceptance state; the only writer of `accepted` is the
 * acceptance path, and it requires a deliverable plus an approved review.
 */

/** One schema version for the whole collaboration contract. */
export const COLLABORATION_SCHEMA_VERSION = 1;

/**
 * The five coordination budgets, frozen once and shared by every enforcing service.
 *
 *   maxConcurrency      — attempts in flight across one coordinator
 *   maxSessionMutations — concurrent attempts mutating ONE native session
 *   maxDepth            — the longest dependency chain a task may sit on
 *   maxChildren         — direct children of one parent task
 *   maxMailbox          — notices one team mailbox may hold
 */
export const COLLABORATION_BUDGETS = Object.freeze({
  maxConcurrency: 4,
  maxSessionMutations: 1,
  maxDepth: 4,
  maxChildren: 32,
  maxMailbox: 1000,
});

/** The task lifecycle. `paused` is the VISIBLE budget state — never a silent drop, never a silent run. */
export const TASK_STATES = Object.freeze(['pending', 'dispatched', 'review', 'accepted', 'failed', 'cancelled', 'paused']);
/**
 * The task states that END a task's lifecycle. No scheduler, graph refresh, stop or acceptance
 * may revive them: a terminated task is never re-admitted, whatever a stale pause field claims.
 */
export const TERMINAL_TASK_STATES = Object.freeze(['accepted', 'failed', 'cancelled']);
/** The attempt ladder: accepted → sent → observed → terminal, or the reconcile stop. */
export const ATTEMPT_STATES = Object.freeze(['accepted', 'sent', 'observed', 'terminal', 'reconcile']);
/** The native terminal reasons an attempt can report. `completed` is NOT a task acceptance. */
export const ATTEMPT_TERMINAL_REASONS = Object.freeze(['completed', 'failed', 'cancelled', 'timeout', 'aborted']);
/** Task review, independent of the attempt: a task is reviewed by a reviewer, never by its run. */
export const REVIEW_STATES = Object.freeze(['none', 'pending', 'approved', 'rejected']);
/** Task acceptance, independent of the attempt: only the acceptance path can reach `accepted`. */
export const ACCEPTANCE_STATES = Object.freeze(['none', 'pending', 'accepted', 'rejected']);
/** Every budget reason a visibly paused task can carry. */
export const BUDGET_REASONS = Object.freeze([
  'collaboration_concurrency',
  'collaboration_session_mutation',
  'collaboration_depth',
  'collaboration_children',
  'collaboration_mailbox',
]);

export const MAX_TASK_TITLE_CHARS = 512;
export const MAX_CRITERIA_COUNT = 32;
export const MAX_CRITERION_ID_CHARS = 128;
export const MAX_CRITERION_CHARS = 512;
export const MAX_DELIVERABLES = 16;
export const MAX_DELIVERABLE_PATHS = 64;
export const MAX_PATH_CHARS = 1024;
export const MAX_MAILBOX_TEXT_CHARS = 512;
export const MAX_NAMES = Object.freeze({ team: 512, participant: 128, owner: 128, reviewer: 128 });

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class CollaborationError extends ProtocolError {
  constructor(code, reason, detail = null) {
    super(code, `collaboration.${reason}`);
    this.name = 'CollaborationError';
    this.reason = reason;
    this.field = reason;
    this.detail = detail === null ? null : Object.freeze({ ...detail });
  }
}

function requireUuid(value, reason) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new CollaborationError('invalid_request', reason);
  return value.toLowerCase();
}

function requireText(value, reason, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new CollaborationError('invalid_request', reason);
  }
  return value;
}

export const parseTaskId = (value) => requireUuid(value, 'task_id');
export const parseAttemptId = (value) => requireUuid(value, 'attempt_id');
export const parseTeamId = (value) => requireUuid(value, 'team_id');
export const parseLeaseId = (value) => requireUuid(value, 'lease_id');
export const parseMessageId = (value) => requireUuid(value, 'message_id');

export function parseTaskState(value) {
  if (!TASK_STATES.includes(value)) throw new CollaborationError('invalid_request', 'task_state');
  return value;
}

export function parseAttemptState(value) {
  if (!ATTEMPT_STATES.includes(value)) throw new CollaborationError('invalid_request', 'attempt_state');
  return value;
}

export function parseTerminalReason(value) {
  if (!ATTEMPT_TERMINAL_REASONS.includes(value)) throw new CollaborationError('invalid_request', 'attempt_terminal_reason');
  return value;
}

export function parseBudgetReason(value) {
  if (!BUDGET_REASONS.includes(value)) throw new CollaborationError('invalid_request', 'budget_reason');
  return value;
}

export function parseReviewState(value) {
  if (!REVIEW_STATES.includes(value)) throw new CollaborationError('invalid_request', 'review_state');
  return value;
}

export function parseAcceptanceState(value) {
  if (!ACCEPTANCE_STATES.includes(value)) throw new CollaborationError('invalid_request', 'acceptance_state');
  return value;
}

/**
 * The parsed Host stop payload every task-level and attempt-level stop shares: a code and a
 * field (both required, bounded) plus an optional bounded reason. Parsing runs BEFORE anything
 * is written — before a reservation is released and before an op is journaled — so a payload
 * the attempt service would reject leaves the attempt, its task and every budget share
 * byte-identical, and a refused stop can never free a slot another task then spends.
 */
export function parseStopPayload(input) {
  if (input === null || typeof input !== 'object') throw new CollaborationError('invalid_request', 'attempt_resolution');
  const code = requireText(input.code, 'attempt_resolution', 128);
  const field = requireText(input.field, 'attempt_resolution', 128);
  let reason = null;
  if (input.reason !== undefined && input.reason !== null) {
    reason = requireText(input.reason, 'attempt_resolution', 256);
  }
  return Object.freeze({ code, field, reason });
}

/** A monotonic-ish clock reading: an explicit `at` is required for every observable transition. */
export function parseAt(value) {
  if (value === undefined) return Date.now();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new CollaborationError('invalid_request', 'collaboration_time');
  }
  return value;
}

export function parseTeamName(value) {
  return requireText(value, 'team_name', MAX_NAMES.team);
}

export function parseTaskTitle(value) {
  return requireText(value, 'task_title', MAX_TASK_TITLE_CHARS);
}

/** One acceptance criterion. `required` defaults to true: an unmet required criterion blocks acceptance. */
export function parseCriterion(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollaborationError('invalid_request', 'task_criteria');
  }
  const keys = Object.keys(value);
  if (keys.length < 2 || keys.length > 3 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'text')
    || (keys.length === 3 && !Object.hasOwn(value, 'required'))) {
    throw new CollaborationError('invalid_request', 'task_criteria');
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new CollaborationError('invalid_request', 'task_criteria');
  }
  return Object.freeze({
    id: requireText(value.id, 'task_criteria', MAX_CRITERION_ID_CHARS),
    text: requireText(value.text, 'task_criteria', MAX_CRITERION_CHARS),
    required: value.required === undefined ? true : value.required,
  });
}

/** The task's frozen acceptance criteria: at least one, at most MAX_CRITERIA_COUNT, unique ids. */
export function parseCriteria(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CRITERIA_COUNT) {
    throw new CollaborationError('invalid_request', 'task_criteria');
  }
  const criteria = value.map(parseCriterion);
  const ids = new Set(criteria.map((entry) => entry.id));
  if (ids.size !== criteria.length) throw new CollaborationError('conflict', 'task_criteria');
  return Object.freeze(criteria);
}

/** The task's owner: the collaborating participant and the native session it works in. */
export function parseOwner(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'participantId') || !Object.hasOwn(value, 'session')) {
    throw new CollaborationError('invalid_request', 'task_owner');
  }
  let session;
  try {
    session = parseSessionRef(value.session);
  } catch (error) {
    if (error instanceof TypeError) throw new CollaborationError('invalid_request', 'task_owner');
    throw error;
  }
  return Object.freeze({ participantId: requireUuid(value.participantId, 'task_owner'), session });
}

/** The caller-supplied half of a lease; the service mints the lease id and the grant time. */
export function parseLeaseInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'ownerId') || !Object.hasOwn(value, 'expiresAt')) {
    throw new CollaborationError('invalid_request', 'task_lease');
  }
  if (typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
    throw new CollaborationError('invalid_request', 'task_lease');
  }
  return Object.freeze({ ownerId: requireUuid(value.ownerId, 'task_lease'), expiresAt: value.expiresAt });
}

/** A registered deliverable: immutable bytes identified by hash, with the paths it carries. */
export function parseDeliverable(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || !Object.hasOwn(value, 'deliverableId')
    || !Object.hasOwn(value, 'artifactHash') || !Object.hasOwn(value, 'bytes') || !Object.hasOwn(value, 'paths')) {
    throw new CollaborationError('invalid_request', 'acceptance_deliverable');
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > MAX_DELIVERABLE_PATHS) {
    throw new CollaborationError('invalid_request', 'acceptance_deliverable');
  }
  if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new CollaborationError('invalid_request', 'acceptance_deliverable');
  }
  const artifactHash = requireText(value.artifactHash, 'acceptance_deliverable', 64);
  if (!HASH_PATTERN.test(artifactHash)) throw new CollaborationError('invalid_request', 'acceptance_deliverable');
  return Object.freeze({
    deliverableId: requireText(value.deliverableId, 'acceptance_deliverable', 128),
    artifactHash,
    bytes: value.bytes,
    paths: Object.freeze(value.paths.map((entry) => requireText(entry, 'acceptance_deliverable', MAX_PATH_CHARS))),
  });
}

/** The criteria verdicts an acceptance must carry: one entry per task criterion, no extras. */
export function parseCriteriaVerdicts(value, criteria) {
  if (!Array.isArray(value) || value.length !== criteria.length) {
    throw new CollaborationError('invalid_request', 'acceptance_criteria');
  }
  const seen = new Set();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'met')
      || typeof entry.met !== 'boolean') {
      throw new CollaborationError('invalid_request', 'acceptance_criteria');
    }
    const id = requireText(entry.id, 'acceptance_criteria', MAX_CRITERION_ID_CHARS);
    if (seen.has(id)) throw new CollaborationError('invalid_request', 'acceptance_criteria');
    seen.add(id);
    if (!criteria.some((criterion) => criterion.id === id)) {
      throw new CollaborationError('invalid_request', 'acceptance_criteria');
    }
  }
  return Object.freeze(value.map((entry) => Object.freeze({ id: entry.id, met: entry.met })));
}

/**
 * The canonical key of the native session a task mutates. The Session-mutation budget is per
 * native session, so the key is the session contract's own canonical key — the same one the
 * thread binding uses, so a session can never be counted twice under two spellings.
 */
export function parseSessionMutationKey(value) {
  try {
    return encodeSessionKey(value);
  } catch (error) {
    if (error instanceof TypeError) throw new CollaborationError('invalid_request', 'collaboration_session');
    throw error;
  }
}

/** The frozen limit row the coordinator reports: the shared object, verbatim. */
export function collaborationBudgetLimits() {
  return COLLABORATION_BUDGETS;
}
