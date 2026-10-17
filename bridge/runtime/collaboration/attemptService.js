import { createHash, randomUUID } from 'node:crypto';
import {
  CollaborationError,
  parseAttemptId,
  parseAt,
  parseOwner,
  parseTaskId,
  parseTerminalReason,
} from '../../../shared/runtime/collaboration.js';

/**
 * Canonical Attempt service (task 37): one attempt of one task, walked
 * `accepted → sent → observed → terminal`, or stopped at `reconcile`.
 *
 * The four rungs are INDEPENDENT, exactly like task 32's turn states and task 34's handoff ladder.
 * The record carries three disjoint slices and three sinks that can each write only their own:
 *
 *   - `createDeliverySink` sees only `delivery` — it can write `sent`, and nothing else. Its type
 *     has no member that reaches `observed` or `terminal`, so a native ack structurally cannot
 *     advance an attempt past `sent`.
 *   - `createNativeSink` sees only `observation` — it can write `observed` and `terminal`, and
 *     nothing else. Its type has no member that reaches the TASK's review or acceptance scope, so
 *     a native end structurally cannot mark a task success. That is the enforcement of
 *     "native end ≠ task success".
 *   - `createHostSink` sees only the Host slice and the resolution slot — accept, cancel, fail,
 *     reconcile. It structurally cannot touch either native slice.
 *
 * A note on names, because this is the load-bearing distinction of the whole task: the Host sink's
 * `accept` ACCEPTS AN ATTEMPT into the ladder. It says nothing about the task. A task is accepted
 * only by acceptanceService, through a scope this module has no reference to.
 *
 * Every step is journaled before its side effect runs, so the journal is the point of no retry:
 * replaying an operation is a detected duplicate that re-runs nothing — in particular it never
 * sends the prompt a second time. The terminal rung is deliberately NOT idempotent: a second
 * native end is a refusal, because a repeated terminal event is either a contradiction or a
 * duplicate delivery the caller must not read as progress.
 */

/** The forward ladder, in order. `reconcile` is a stop, never a forward rung. */
export const ATTEMPT_LADDER = Object.freeze(['accepted', 'sent', 'observed', 'terminal']);
/** A resolution kind: why the ladder stopped without a trustworthy forward outcome. */
export const ATTEMPT_RESOLUTION_KINDS = Object.freeze(['reconcile', 'failed', 'cancelled']);

const RUNG_PREDECESSOR = Object.freeze({ deliver: 'accepted', observe: 'sent', end: 'sent' });
const STOP_METHOD = Object.freeze({ reconcile: 'reconcile', failed: 'fail', cancelled: 'cancel' });
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function canonical(value) {
  const sorted = (item) => Array.isArray(item)
    ? item.map(sorted)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]))
      : item;
  return JSON.stringify(sorted(value));
}

function fingerprintOf(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Derive the reported state from the three independent slices. A resolution always wins. */
export function projectAttemptState(record) {
  if (record.resolution.value !== null) return 'reconcile';
  if (record.observation.terminal === true) return 'terminal';
  if (record.observation.observed === true) return 'observed';
  if (record.delivery.delivered === true) return 'sent';
  return 'accepted';
}

function attemptView(record) {
  return Object.freeze({
    attemptId: record.attemptId,
    taskId: record.taskId,
    teamId: record.teamId,
    state: projectAttemptState(record),
    accepted: record.host.acceptedAt !== null,
    sent: record.delivery.delivered,
    observed: record.observation.observed,
    terminal: record.observation.terminal,
    terminalReason: record.observation.terminalReason,
    resolution: record.resolution.value,
    sends: record.sends,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function opView(op) {
  return Object.freeze({
    opId: op.opId,
    attemptId: op.attemptId,
    kind: op.kind,
    fingerprint: op.fingerprint,
    at: op.at,
    applied: op.applied,
    duplicate: op.duplicate,
    outcome: op.outcome,
    code: op.code,
    field: op.field,
    detail: op.detail,
  });
}

/* ------------------------------------------------------------------ the sinks */

/**
 * The native-observation side of the boundary. The scope carries the observation slice and NOTHING
 * else: `deliver` does not exist here, so a native event structurally cannot mark an attempt sent,
 * and no member of this type reaches a task's review or acceptance scope.
 */
export function createNativeSink(scope) {
  return Object.freeze({
    observe(input = {}) {
      const nativeEventId = input.nativeEventId;
      if (typeof nativeEventId !== 'string' || nativeEventId.length === 0 || nativeEventId.length > 128) {
        throw new CollaborationError('invalid_request', 'attempt_native_event_id');
      }
      if (scope.observation.observed === true) return { applied: false, duplicate: true };
      scope.observation.observed = true;
      scope.observation.observedAt = input.at ?? Date.now();
      scope.observation.observedBy = nativeEventId;
      return { applied: true, duplicate: false };
    },
    end(input = {}) {
      const reason = parseTerminalReason(input.reason);
      if (scope.observation.terminal === true) throw new CollaborationError('conflict', 'attempt_state');
      scope.observation.terminal = true;
      scope.observation.terminalAt = input.at ?? Date.now();
      scope.observation.terminalReason = reason;
      scope.observation.terminalBy = typeof input.nativeEventId === 'string' && input.nativeEventId.length > 0
        ? input.nativeEventId
        : null;
      return { applied: true, duplicate: false };
    },
  });
}

/**
 * The delivery (ack) side of the boundary. The scope carries the delivery slice and nothing else:
 * `observe` and `end` do not exist here, so a native ack structurally cannot advance an attempt
 * past `sent`.
 */
export function createDeliverySink(scope) {
  return Object.freeze({
    deliver(input = {}) {
      const ackId = input.ackId;
      if (typeof ackId !== 'string' || ackId.length === 0 || ackId.length > 128) {
        throw new CollaborationError('invalid_request', 'attempt_ack_id');
      }
      if (scope.delivery.delivered === true) return { applied: false, duplicate: true };
      scope.delivery.delivered = true;
      scope.delivery.deliveredAt = input.at ?? Date.now();
      scope.delivery.deliveredBy = ackId;
      return { applied: true, duplicate: false };
    },
  });
}

function resolveHost(scope, kind, input) {
  const code = input.code;
  const field = input.field;
  if (typeof code !== 'string' || code.length === 0 || code.length > 128
    || typeof field !== 'string' || field.length === 0 || field.length > 128) {
    throw new CollaborationError('invalid_request', 'attempt_resolution');
  }
  let reason = null;
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== 'string' || input.reason.length === 0 || input.reason.length > 256) {
      throw new CollaborationError('invalid_request', 'attempt_resolution');
    }
    reason = input.reason;
  }
  const at = input.at ?? Date.now();
  if (kind === 'cancelled') scope.host.cancelledAt = at;
  if (kind === 'failed') scope.host.failedAt = at;
  if (kind === 'reconcile') scope.host.reconcileAt = at;
  scope.resolution.value = Object.freeze({ kind, code, field, reason, at });
}

/**
 * The Host side of the boundary: the only sink that may write the Host slice and the resolution.
 * `accept` here ACCEPTS AN ATTEMPT into the ladder — it is not, and cannot be, a task acceptance.
 * It structurally cannot touch `delivered`, `observed` or `terminal`.
 */
export function createHostSink(scope) {
  return Object.freeze({
    accept(input = {}) {
      if (scope.host.acceptedAt !== null) return;
      scope.host.acceptedAt = input.at ?? Date.now();
    },
    cancel(input = {}) {
      resolveHost(scope, 'cancelled', input);
    },
    fail(input = {}) {
      resolveHost(scope, 'failed', input);
    },
    reconcile(input = {}) {
      resolveHost(scope, 'reconcile', input);
    },
  });
}

/* ------------------------------------------------------------------ the service */

export function createAttemptService() {
  const attemptsById = new Map();
  const attemptIdsByTask = new Map();
  const journal = { ops: [], byAttempt: new Map(), byKey: new Map() };
  const stats = { attempts: 0, ops: 0, applied: 0, duplicates: 0, sends: 0, reconciles: 0, failures: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'attempt_service_closed');
  }

  function requireAttempt(attemptId) {
    const record = attemptsById.get(parseAttemptId(attemptId));
    if (record === undefined) throw new CollaborationError('invalid_request', 'attempt_unknown');
    return record;
  }

  function hostScope(record) {
    return { host: record.host, resolution: record.resolution };
  }

  function journalOp({ attemptId, kind, fingerprint, at, detail = null }) {
    const key = `${attemptId}\u0000${kind}`;
    const existing = journal.byKey.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new CollaborationError('conflict', 'attempt_op');
      stats.duplicates += 1;
      return { op: existing, applied: false, duplicate: true };
    }
    const op = {
      opId: randomUUID(),
      attemptId,
      kind,
      fingerprint,
      at,
      applied: true,
      duplicate: false,
      outcome: 'pending',
      code: null,
      field: null,
      detail,
    };
    journal.ops.push(op);
    const perAttempt = journal.byAttempt.get(attemptId);
    if (perAttempt === undefined) journal.byAttempt.set(attemptId, [op]);
    else perAttempt.push(op);
    journal.byKey.set(key, op);
    stats.ops += 1;
    stats.applied += 1;
    return { op, applied: true, duplicate: false };
  }

  function finalizeOp(op, outcome, code = null, field = null) {
    op.outcome = outcome;
    op.code = code;
    op.field = field;
  }

  /**
   * Enter one ladder rung. An already-applied op of this kind replays as a duplicate (the caller
   * returns the current view); a failed or reconciled op never replays. A rung whose predecessor
   * has not been reached is a conflict — the ladder order is enforced.
   */
  function enterStep(record, kind, fingerprint, at, detail = null) {
    const existing = journal.byKey.get(`${record.attemptId}\u0000${kind}`);
    if (existing !== undefined) {
      if (existing.outcome !== 'applied') throw new CollaborationError('conflict', 'attempt_state');
      stats.duplicates += 1;
      return null;
    }
    if (projectAttemptState(record) !== RUNG_PREDECESSOR[kind]) {
      throw new CollaborationError('conflict', 'attempt_state');
    }
    return journalOp({ attemptId: record.attemptId, kind, fingerprint, at, detail }).op;
  }

  /** Mark the record stopped, keeping the typed rejection the caller must observe. */
  function stopRecord(record, op, kind, failure, at) {
    createHostSink(hostScope(record))[STOP_METHOD[kind]]({ ...failure, at });
    finalizeOp(op, kind, failure.code, failure.field);
    if (kind === 'failed') stats.failures += 1;
    if (kind === 'reconcile') stats.reconciles += 1;
    record.updatedAt = at;
  }

  function classifyFailure(error, fallback) {
    if (error instanceof CollaborationError) {
      return { typed: true, code: error.code, field: error.field };
    }
    return { typed: false, code: fallback.code, field: fallback.field };
  }

  function begin(input = {}) {
    assertOpen();
    const taskId = parseTaskId(input.taskId);
    const teamId = input.teamId;
    if (typeof teamId !== 'string' || !UUID_PATTERN.test(teamId)) {
      throw new CollaborationError('invalid_request', 'team_id');
    }
    const owner = parseOwner(input.owner);
    if (typeof input.prompt !== 'string' || input.prompt.length === 0 || input.prompt.length > 65536) {
      throw new CollaborationError('invalid_request', 'attempt_prompt');
    }
    const at = parseAt(input.at);
    const attemptId = input.attemptId === undefined ? randomUUID() : parseAttemptId(input.attemptId);
    if (attemptsById.has(attemptId)) throw new CollaborationError('conflict', 'attempt_duplicate');
    const record = {
      attemptId,
      taskId,
      teamId,
      owner,
      prompt: input.prompt,
      host: { acceptedAt: null, cancelledAt: null, failedAt: null, reconcileAt: null },
      delivery: { delivered: false, deliveredAt: null, deliveredBy: null },
      observation: { observed: false, observedAt: null, observedBy: null, terminal: false, terminalAt: null, terminalReason: null, terminalBy: null },
      resolution: { value: null },
      sends: 0,
      createdAt: at,
      updatedAt: at,
    };
    attemptsById.set(attemptId, record);
    const perTask = attemptIdsByTask.get(taskId);
    if (perTask === undefined) attemptIdsByTask.set(taskId, [attemptId]);
    else perTask.push(attemptId);
    stats.attempts += 1;
    const op = journalOp({
      attemptId,
      kind: 'accept',
      fingerprint: fingerprintOf({ attemptId, kind: 'accept', taskId }),
      at,
      detail: { taskId },
    }).op;
    createHostSink(hostScope(record)).accept({ at });
    finalizeOp(op, 'applied');
    return attemptView(record);
  }

  /**
   * Deliver the prompt. The op is journaled BEFORE the send runs — that committed intent is the
   * point of no retry, so a crash right here must not be retried into a second prompt. An
   * unreadable outcome is a STOP at reconcile: never silently retried, never marked successful.
   */
  async function deliver(input = {}) {
    assertOpen();
    const record = requireAttempt(input.attemptId);
    const at = parseAt(input.at);
    if (typeof input.deliver !== 'function') throw new CollaborationError('invalid_request', 'attempt_deliver');
    const op = enterStep(
      record,
      'deliver',
      fingerprintOf({ attemptId: record.attemptId, kind: 'deliver', prompt: record.prompt }),
      at,
    );
    if (op === null) return { attempt: attemptView(record), outcome: 'applied' };
    record.sends += 1;
    stats.sends += 1;
    let result;
    try {
      result = await input.deliver({
        attemptId: record.attemptId,
        taskId: record.taskId,
        owner: record.owner,
        prompt: record.prompt,
      });
    } catch (error) {
      const failure = classifyFailure(error, { code: 'source_unavailable', field: 'attempt_send' });
      stopRecord(record, op, 'failed', failure, at);
      if (failure.typed === true) throw error;
      throw new CollaborationError(failure.code, failure.field);
    }
    const ackId = result !== null && typeof result === 'object' ? result.ackId : undefined;
    if (typeof ackId !== 'string' || ackId.length === 0) {
      stopRecord(record, op, 'reconcile', { code: 'reconcile_required', field: 'attempt_ambiguous' }, at);
      return { attempt: attemptView(record), outcome: 'reconcile' };
    }
    createDeliverySink({ delivery: record.delivery }).deliver({ ackId, at });
    finalizeOp(op, 'applied');
    record.updatedAt = at;
    return { attempt: attemptView(record), outcome: 'applied' };
  }

  function observe(input = {}) {
    assertOpen();
    const record = requireAttempt(input.attemptId);
    const at = parseAt(input.at);
    const nativeEventId = input.nativeEventId;
    if (typeof nativeEventId !== 'string' || nativeEventId.length === 0) {
      throw new CollaborationError('invalid_request', 'attempt_native_event_id');
    }
    const op = enterStep(
      record,
      'observe',
      fingerprintOf({ attemptId: record.attemptId, kind: 'observe', nativeEventId }),
      at,
      { nativeEventId },
    );
    if (op === null) return attemptView(record);
    createNativeSink({ observation: record.observation }).observe({ nativeEventId, at });
    finalizeOp(op, 'applied');
    record.updatedAt = at;
    return attemptView(record);
  }

  /**
   * The native end. A second native end is REFUSED: the terminal rung is a one-way door and a
   * repeated terminal event is not progress. Crucially this writes the ATTEMPT's observation slice
   * only — there is no code path from here to a task's acceptance scope.
   */
  function end(input = {}) {
    assertOpen();
    const record = requireAttempt(input.attemptId);
    const at = parseAt(input.at);
    const reason = parseTerminalReason(input.reason);
    if (record.observation.terminal === true) throw new CollaborationError('conflict', 'attempt_state');
    if (record.delivery.delivered !== true) throw new CollaborationError('conflict', 'attempt_state');
    if (record.resolution.value !== null) throw new CollaborationError('conflict', 'attempt_state');
    const nativeEventId = input.nativeEventId === undefined || input.nativeEventId === null ? null : input.nativeEventId;
    if (nativeEventId !== null && (typeof nativeEventId !== 'string' || nativeEventId.length === 0)) {
      throw new CollaborationError('invalid_request', 'attempt_native_event_id');
    }
    const op = journalOp({
      attemptId: record.attemptId,
      kind: 'end',
      fingerprint: fingerprintOf({ attemptId: record.attemptId, kind: 'end', reason, nativeEventId }),
      at,
      detail: { reason, nativeEventId },
    }).op;
    createNativeSink({ observation: record.observation }).end({ reason, nativeEventId, at });
    finalizeOp(op, 'applied');
    record.updatedAt = at;
    return attemptView(record);
  }

  /** A Host stop. Idempotent for the same kind and code; a different stop is a conflict. */
  function stop(input = {}, kind) {
    assertOpen();
    const record = requireAttempt(input.attemptId);
    const at = parseAt(input.at);
    if (!ATTEMPT_RESOLUTION_KINDS.includes(kind)) throw new CollaborationError('invalid_request', 'attempt_resolution');
    if (record.observation.terminal === true) throw new CollaborationError('conflict', 'attempt_state');
    const current = record.resolution.value;
    if (current !== null) {
      if (current.kind !== kind || current.code !== input.code || current.field !== input.field) {
        throw new CollaborationError('conflict', 'attempt_state');
      }
      return attemptView(record);
    }
    if (typeof input.code !== 'string' || input.code.length === 0
      || typeof input.field !== 'string' || input.field.length === 0) {
      throw new CollaborationError('invalid_request', 'attempt_resolution');
    }
    const op = journalOp({
      attemptId: record.attemptId,
      kind,
      fingerprint: fingerprintOf({ attemptId: record.attemptId, kind, code: input.code, field: input.field }),
      at,
    }).op;
    stopRecord(record, op, kind, { code: input.code, field: input.field, reason: input.reason ?? null }, at);
    return attemptView(record);
  }

  function attempt(attemptId) {
    assertOpen();
    return attemptView(requireAttempt(attemptId));
  }

  function attempts(taskId) {
    assertOpen();
    if (taskId === undefined) return Object.freeze([...attemptsById.values()].map(attemptView));
    const ids = attemptIdsByTask.get(parseTaskId(taskId)) ?? [];
    return Object.freeze(ids.map((id) => attemptView(attemptsById.get(id))));
  }

  function ops(attemptId) {
    assertOpen();
    const record = requireAttempt(attemptId);
    const perAttempt = journal.byAttempt.get(record.attemptId) ?? [];
    return Object.freeze(perAttempt.map(opView));
  }

  /** The LIVE record. Internal: consumers write through a narrow sink, never directly. */
  function record(attemptId) {
    return requireAttempt(attemptId);
  }

  function close() {
    closed = true;
    attemptsById.clear();
    attemptIdsByTask.clear();
    journal.ops.length = 0;
    journal.byAttempt.clear();
    journal.byKey.clear();
  }

  return {
    begin,
    deliver,
    observe,
    end,
    cancel: (input = {}) => stop(input, 'cancelled'),
    fail: (input = {}) => stop(input, 'failed'),
    reconcile: (input = {}) => stop(input, 'reconcile'),
    attempt,
    attempts,
    ops,
    record,
    close,
    get state() {
      return { ...stats, closed };
    },
  };
}
