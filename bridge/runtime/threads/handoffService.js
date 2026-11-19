import { createHash, randomUUID } from 'node:crypto';
import { ProtocolError } from '../../../shared/runtime/capabilities.js';
import { parseParticipantId, parseThreadId } from '../../../shared/runtime/thread.js';
import { classifyHandoffFailure, restoreOriginalSelection } from './handoffRecovery.js';

/**
 * Canonical Handoff service (task 34): the observable, recoverable cross-harness relay.
 *
 * The ladder is `checkpoint → attached → prepared → delivered → observed → active`. The original
 * source binding is RETAINED through the whole handoff — no participant leaves, no native session
 * is re-created — and the thread's active selection moves to the target ONLY when a REAL native
 * observation arrives, never on a native ack.
 *
 * The load-bearing guarantee — "a native ack only means `delivered`" — is structural, exactly like
 * task 32's turn states. The four turn states there were independent because each sink could see
 * only its own slice; here the record carries THREE disjoint slices and three sinks that can each
 * write only their own:
 *
 *   - `createAckSink` sees only `delivery`  — it can write `delivered`, and nothing else. Its
 *     type has no member that reaches `observed`, so no ack input can advance a handoff past
 *     `delivered`, let alone to `active`.
 *   - `createObserveSink` sees only `observation` — it can write `observed`, and nothing else.
 *   - `createHostSink` sees only the Host progress slice and the resolution slot — checkpoint,
 *     attach, prepare, cancel, fail, reconcile. It structurally cannot touch either native slice.
 *
 * `active` is not a writable state at all: `projectHandoffState` DERIVES it from
 * `observation.observed`, which only the observe sink can set. The UI therefore cannot be shown
 * `active` without a real native observation.
 *
 * Every step is journaled before its side effect runs, so the journal is the point of no retry:
 * replaying an operation is a detected duplicate that re-runs nothing — in particular it never
 * sends the prompt a second time. An operation journal makes the handoff idempotent; the recovery
 * policy in handoffRecovery.js decides what an interrupted handoff may do (never "resend").
 */

/** The forward ladder, in order. `active` is derived, never written directly. */
export const HANDOFF_LADDER = Object.freeze(['checkpoint', 'attached', 'prepared', 'delivered', 'observed', 'active']);
/** The stopping and terminal states a handoff can be resolved into. */
export const HANDOFF_RESOLUTIONS = Object.freeze(['reconcile', 'failed', 'cancelled']);
/** Every state a handoff read model can report. */
export const HANDOFF_STATES = Object.freeze([...HANDOFF_LADDER, ...HANDOFF_RESOLUTIONS]);
/** Serialized prompt ceiling per handoff; an oversized prompt is rejected, never truncated. */
export const MAX_HANDOFF_PROMPT_CHARS = 65536;

const RUNG_PREDECESSOR = Object.freeze({ attach: 'checkpoint', prepare: 'attached', deliver: 'prepared', observe: 'delivered' });
/** The resolution enum differs from the Host sink method name, so resolve maps instead of indexing. */
const RESOLUTION_SINK = Object.freeze({ reconcile: 'reconcile', failed: 'fail', cancelled: 'cancel' });
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_TEXT_CHARS = 512;

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class HandoffError extends ProtocolError {
  constructor(code, reason) {
    super(code, `runtime.handoff.${reason}`);
    this.name = 'HandoffError';
    this.reason = reason;
    this.field = reason;
  }
}

function requireText(value, reason, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new HandoffError('invalid_request', reason);
  }
  return value;
}

export function parseHandoffId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new HandoffError('invalid_request', 'handoff_id');
  return value.toLowerCase();
}

export function parseHandoffAt(value) {
  if (value === undefined) return Date.now();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HandoffError('invalid_request', 'handoff_time');
  }
  return value;
}

export function parseHandoffPrompt(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HANDOFF_PROMPT_CHARS) {
    throw new HandoffError('invalid_request', 'handoff_prompt');
  }
  return value;
}

function parseResolution(value) {
  if (!HANDOFF_RESOLUTIONS.includes(value)) throw new HandoffError('invalid_request', 'handoff_resolution');
  return value;
}

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

/* ------------------------------------------------------------------ read models */

/**
 * Derive the reported state from the three independent slices. The resolution wins first (a
 * failed, cancelled or reconciled handoff never reports a forward rung), and `active` is
 * reachable ONLY through a real native observation.
 */
export function projectHandoffState(record) {
  if (record.resolution.value !== null) return record.resolution.value.resolution;
  if (record.observation.observed === true) return 'active';
  if (record.delivery.delivered === true) return 'delivered';
  if (record.host.preparedAt !== null) return 'prepared';
  if (record.host.attachedAt !== null) return 'attached';
  return 'checkpoint';
}

function checkpointView(checkpoint) {
  return Object.freeze({
    checkpointId: checkpoint.checkpointId,
    digest: checkpoint.digest,
    bytes: checkpoint.bytes,
    entryCount: checkpoint.entryCount,
  });
}

/** Frozen flattened read model of one handoff. `active` is derived, never a writable field. */
export function handoffView(record) {
  return Object.freeze({
    handoffId: record.handoffId,
    threadId: record.threadId,
    environmentId: record.environmentId,
    state: projectHandoffState(record),
    active: record.observation.observed === true && record.resolution.value === null,
    source: Object.freeze({ participantId: record.source.participantId, session: record.source.session }),
    target: Object.freeze({ participantId: record.target.participantId, session: record.target.session }),
    originalParticipantId: record.originalParticipantId,
    checkpoint: record.host.checkpoint,
    promptFingerprint: record.host.promptFingerprint,
    delivered: record.delivery.delivered,
    deliveredAt: record.delivery.deliveredAt,
    deliveredBy: record.delivery.deliveredBy,
    observed: record.observation.observed,
    observedAt: record.observation.observedAt,
    observedBy: record.observation.observedBy,
    resolution: record.resolution.value,
    sends: record.sends,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function opView(op) {
  return Object.freeze({
    opId: op.opId,
    handoffId: op.handoffId,
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
 * The native-ack side of the boundary. The scope carries the delivery slice and NOTHING else:
 * `accept`/`observe` do not exist here, so a native ack structurally cannot advance a handoff
 * past `delivered`. This is the enforcement of "native ack only means delivered".
 */
export function createAckSink(scope) {
  return Object.freeze({
    deliver(input = {}) {
      const ackId = requireText(input.ackId, 'handoff_ack_id');
      const at = parseHandoffAt(input.at);
      if (scope.delivery.delivered === true) return { applied: false, duplicate: true };
      scope.delivery.delivered = true;
      scope.delivery.deliveredAt = at;
      scope.delivery.deliveredBy = ackId;
      return { applied: true, duplicate: false };
    },
  });
}

/**
 * The native-observation side of the boundary. The scope carries the observation slice and
 * nothing else: `deliver` does not exist here, so a native event structurally cannot mark a
 * handoff delivered, and only this sink can make a handoff `active`.
 */
export function createObserveSink(scope) {
  return Object.freeze({
    observe(input = {}) {
      const nativeEventId = requireText(input.nativeEventId, 'handoff_native_event_id');
      const at = parseHandoffAt(input.at);
      if (scope.observation.observed === true) return { applied: false, duplicate: true };
      scope.observation.observed = true;
      scope.observation.observedAt = at;
      scope.observation.observedBy = nativeEventId;
      return { applied: true, duplicate: false };
    },
  });
}

function resolveHost(scope, resolution, input) {
  const code = requireText(input.code, 'handoff_resolution_code');
  const field = requireText(input.field, 'handoff_resolution_field', 128);
  const reason = input.reason === undefined || input.reason === null
    ? null
    : requireText(input.reason, 'handoff_resolution_reason', 256);
  const at = parseHandoffAt(input.at);
  if (resolution === 'cancelled') scope.host.cancelledAt = at;
  if (resolution === 'failed') scope.host.failedAt = at;
  if (resolution === 'reconcile') scope.host.reconcileAt = at;
  scope.resolution.value = Object.freeze({ resolution, code, field, reason, at });
}

/**
 * The Host side of the boundary: the only sink that may write the Host progress slice and the
 * resolution. Host commands — begin, attach, prepare, cancel — and the Host-side failure and
 * reconcile markings go through here. It structurally cannot touch `delivered` or `observed`.
 */
export function createHostSink(scope) {
  return Object.freeze({
    checkpoint(input = {}) {
      scope.host.checkpoint = Object.freeze({ ...input.checkpoint });
    },
    attach(input = {}) {
      scope.host.attachedAt = parseHandoffAt(input.at);
    },
    prepare(input = {}) {
      scope.host.preparedAt = parseHandoffAt(input.at);
      scope.host.promptFingerprint = requireText(input.promptFingerprint, 'handoff_prompt_fingerprint', 64);
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

export function createHandoffService({
  threads,
  checkpoints,
  openTarget,
  sendPrompt,
  cancelSource,
  isSourceBusy,
} = {}) {
  if (threads === null || typeof threads !== 'object' || typeof threads.activate !== 'function'
    || typeof threads.active !== 'function' || typeof threads.get !== 'function') {
    throw new HandoffError('invalid_request', 'handoff_threads');
  }
  if (checkpoints === null || typeof checkpoints !== 'object' || typeof checkpoints.create !== 'function'
    || typeof checkpoints.get !== 'function') {
    throw new HandoffError('invalid_request', 'handoff_checkpoints');
  }
  if (typeof openTarget !== 'function') throw new HandoffError('invalid_request', 'handoff_open_target');
  if (typeof sendPrompt !== 'function') throw new HandoffError('invalid_request', 'handoff_send');
  if (cancelSource !== undefined && typeof cancelSource !== 'function') {
    throw new HandoffError('invalid_request', 'handoff_cancel_source');
  }
  if (isSourceBusy !== undefined && typeof isSourceBusy !== 'function') {
    throw new HandoffError('invalid_request', 'handoff_source_busy_probe');
  }

  const handoffsById = new Map();
  /** checkpointId → { digest, scope, entriesFingerprint }: a carried context hash is never rewritten. */
  const carriedCheckpoints = new Map();
  const beginInflight = new Map();
  const journal = {
    ops: [],
    byHandoff: new Map(),
    byKey: new Map(),
  };
  const stats = { handoffs: 0, ops: 0, applied: 0, duplicates: 0, sends: 0, reconciles: 0, failures: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new HandoffError('cancelled', 'handoff_closed');
  }

  /**
   * Serialize every mutation of one handoffId across its whole async window, so the duplicate
   * check, the cancel await and the record write are one atomic unit.
   */
  function serializeBegin(handoffId, task) {
    const previous = beginInflight.get(handoffId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => { if (beginInflight.get(handoffId) === settled) beginInflight.delete(handoffId); },
      () => { if (beginInflight.get(handoffId) === settled) beginInflight.delete(handoffId); },
    );
    beginInflight.set(handoffId, settled);
    return run;
  }

  function requireHandoff(handoffId) {
    const record = handoffsById.get(parseHandoffId(handoffId));
    if (record === undefined) throw new HandoffError('invalid_request', 'handoff_unknown');
    return record;
  }

  function hostScope(record) {
    return { host: record.host, resolution: record.resolution };
  }

  /**
   * Journal one operation. The op exists BEFORE its side effect runs — that committed intent is
   * the point of no retry: a replay is a detected duplicate that re-runs nothing. A replay whose
   * fingerprint differs is a conflict, never a silent second execution.
   */
  function journalOp({ handoffId, kind, fingerprint, at, detail = null }) {
    const key = `${handoffId}\u0000${kind}`;
    const existing = journal.byKey.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new HandoffError('conflict', 'handoff_op');
      stats.duplicates += 1;
      return { op: existing, applied: false, duplicate: true };
    }
    const op = {
      opId: randomUUID(),
      handoffId,
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
    const perHandoff = journal.byHandoff.get(handoffId);
    if (perHandoff === undefined) journal.byHandoff.set(handoffId, [op]);
    else perHandoff.push(op);
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
   * Enter one ladder step. An already-applied op of this kind replays as a duplicate (the caller
   * returns the current view); a failed or ambiguous op never replays. A step whose predecessor
   * rung has not been reached is a conflict — the ladder order is enforced.
   */
  function enterStep(record, kind, fingerprint, at, detail = null) {
    const existing = journal.byKey.get(`${record.handoffId}\u0000${kind}`);
    if (existing !== undefined) {
      if (existing.outcome !== 'applied') throw new HandoffError('conflict', 'handoff_state');
      stats.duplicates += 1;
      return null;
    }
    if (projectHandoffState(record) !== RUNG_PREDECESSOR[kind]) {
      throw new HandoffError('conflict', 'handoff_state');
    }
    return journalOp({ handoffId: record.handoffId, kind, fingerprint, at, detail }).op;
  }

  /** Mark the record failed, restore the original selection and throw the explicit rejection. */
  function failRecord(record, op, error, fallback, at) {
    const failure = classifyHandoffFailure(error, fallback);
    createHostSink(hostScope(record)).fail({ ...failure, at });
    finalizeOp(op, 'failed', failure.code, failure.field);
    stats.failures += 1;
    restoreOriginalSelection({ threads, threadId: record.threadId, participantId: record.originalParticipantId });
    if (failure.typed === true) throw error;
    throw new HandoffError(failure.code, failure.field);
  }

  function peekCheckpoint(checkpointId) {
    try {
      return checkpoints.get(checkpointId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Mint or carry the bounded context checkpoint. A checkpoint id seen for the first time is
   * built (task 33 owns identity and the budget); a KNOWN id is carried forward as the very same
   * checkpoint — its digest is the context hash the round trip must preserve. Passing different
   * entries under a known id, or a scope from another thread, is refused: the context hash may
   * not be rewritten.
   */
  function resolveCheckpoint({ checkpointId, scope, entries }) {
    if (checkpointId === undefined) {
      if (!Array.isArray(entries) || entries.length === 0) throw new HandoffError('invalid_request', 'handoff_entries');
      const built = checkpoints.create({ scope, entries });
      carriedCheckpoints.set(built.checkpointId, {
        digest: built.digest,
        scope,
        entriesFingerprint: fingerprintOf({ entries }),
      });
      return built;
    }
    const id = parseHandoffId(checkpointId);
    const carried = carriedCheckpoints.get(id);
    if (carried === undefined) {
      if (!Array.isArray(entries) || entries.length === 0) throw new HandoffError('invalid_request', 'handoff_entries');
      const built = checkpoints.create({ checkpointId: id, scope, entries });
      carriedCheckpoints.set(id, {
        digest: built.digest,
        scope,
        entriesFingerprint: fingerprintOf({ entries }),
      });
      return built;
    }
    if (carried.scope.threadId !== scope.threadId || carried.scope.environmentId !== scope.environmentId) {
      throw new HandoffError('unauthorized', 'handoff_checkpoint_scope');
    }
    if (entries !== undefined && fingerprintOf({ entries }) !== carried.entriesFingerprint) {
      throw new HandoffError('conflict', 'handoff_checkpoint');
    }
    const stored = peekCheckpoint(id);
    if (stored === null || stored.digest !== carried.digest) {
      throw new HandoffError('conflict', 'handoff_checkpoint');
    }
    return stored;
  }

  async function begin(input = {}) {
    assertOpen();
    const threadId = parseThreadId(input.threadId);
    const thread = threads.get(threadId);
    const sourceParticipantId = parseParticipantId(input.sourceParticipantId);
    const targetParticipantId = parseParticipantId(input.targetParticipantId);
    if (targetParticipantId === sourceParticipantId) throw new HandoffError('invalid_request', 'handoff_target');
    const source = thread.participants.find((entry) => entry.participantId === sourceParticipantId);
    const target = thread.participants.find((entry) => entry.participantId === targetParticipantId);
    if (source === undefined || target === undefined) throw new HandoffError('invalid_request', 'handoff_participant');

    const handoffId = input.handoffId === undefined ? randomUUID() : parseHandoffId(input.handoffId);
    return serializeBegin(handoffId, async () => {
      const existing = handoffsById.get(handoffId);
      if (existing !== undefined) {
        // A re-opened handoff must carry the same identity, or the reopen is a conflict.
        if (existing.threadId !== threadId
          || existing.source.participantId !== sourceParticipantId
          || existing.target.participantId !== targetParticipantId) {
          throw new HandoffError('conflict', 'handoff_duplicate');
        }
        stats.duplicates += 1;
        return handoffView(existing);
      }

      // A busy source NEVER auto-migrates: without an explicit cancel the handoff is refused
      // before anything is created, attached or sent. An explicit cancel intent is not a
      // substitute for a working cancel adapter, so the adapter must exist.
      if (isSourceBusy !== undefined && isSourceBusy({ threadId, participantId: sourceParticipantId }) === true) {
        if (input.cancel !== true) throw new HandoffError('conflict', 'handoff_source_busy');
        if (typeof cancelSource !== 'function') throw new HandoffError('conflict', 'handoff_source_busy');
        await cancelSource({ threadId, participantId: sourceParticipantId });
      }

      const at = parseHandoffAt(input.at);
      const scope = { threadId, environmentId: thread.environmentId };
      const checkpoint = resolveCheckpoint({ checkpointId: input.checkpointId, scope, entries: input.entries });

      const activeNow = threads.active(threadId);
      const record = {
        handoffId,
        threadId,
        environmentId: thread.environmentId,
        source: { participantId: sourceParticipantId, session: source.session },
        target: { participantId: targetParticipantId, session: target.session },
        originalParticipantId: activeNow?.participantId ?? sourceParticipantId,
        host: {
          checkpoint: null,
          attachedAt: null,
          preparedAt: null,
          promptFingerprint: null,
          cancelledAt: null,
          failedAt: null,
          reconcileAt: null,
        },
        delivery: { delivered: false, deliveredAt: null, deliveredBy: null },
        observation: { observed: false, observedAt: null, observedBy: null },
        resolution: { value: null },
        pendingObservations: [],
        prompt: null,
        sends: 0,
        createdAt: at,
        updatedAt: at,
      };
      handoffsById.set(handoffId, record);
      stats.handoffs += 1;
      const view = checkpointView(checkpoint);
      const op = journalOp({
        handoffId,
        kind: 'checkpoint',
        fingerprint: fingerprintOf({ handoffId, kind: 'checkpoint', checkpointId: view.checkpointId, digest: view.digest }),
        at,
        detail: { checkpointId: view.checkpointId, digest: view.digest },
      }).op;
      createHostSink(hostScope(record)).checkpoint({ checkpoint: view, at });
      finalizeOp(op, 'applied');
      return handoffView(record);
    });
  }

  async function attach(input = {}) {
    assertOpen();
    const record = requireHandoff(input.handoffId);
    const at = parseHandoffAt(input.at);
    const op = enterStep(
      record,
      'attach',
      fingerprintOf({
        handoffId: record.handoffId,
        kind: 'attach',
        target: record.target.participantId,
        nativeSessionId: record.target.session.nativeSessionId,
      }),
      at,
    );
    if (op === null) return handoffView(record);
    let opened;
    try {
      opened = await openTarget({ threadId: record.threadId, handoffId: record.handoffId, target: record.target });
    } catch (error) {
      failRecord(record, op, error, { code: 'source_unavailable', field: 'handoff_target_open' }, at);
    }
    // The attach must bind the target's OWN native session; anything else is a refusal, never a
    // silent handoff to a session the thread never joined.
    const nativeSessionId = opened === null || opened === undefined ? undefined : opened.nativeSessionId;
    if (typeof nativeSessionId !== 'string' || nativeSessionId !== record.target.session.nativeSessionId) {
      failRecord(record, op, null, { code: 'conflict', field: 'handoff_target_session' }, at);
    }
    createHostSink(hostScope(record)).attach({ at });
    finalizeOp(op, 'applied');
    record.updatedAt = at;
    return handoffView(record);
  }

  async function prepare(input = {}) {
    assertOpen();
    const record = requireHandoff(input.handoffId);
    const at = parseHandoffAt(input.at);
    const prompt = parseHandoffPrompt(input.prompt);
    const promptFingerprint = fingerprintOf({ prompt });
    if (record.host.promptFingerprint !== null && record.host.promptFingerprint !== promptFingerprint) {
      throw new HandoffError('conflict', 'handoff_prompt');
    }
    const op = enterStep(
      record,
      'prepare',
      fingerprintOf({ handoffId: record.handoffId, kind: 'prepare', promptFingerprint }),
      at,
    );
    if (op === null) return handoffView(record);
    createHostSink(hostScope(record)).prepare({ promptFingerprint, at });
    record.prompt = prompt;
    finalizeOp(op, 'applied');
    record.updatedAt = at;
    return handoffView(record);
  }

  async function deliver(input = {}) {
    assertOpen();
    const record = requireHandoff(input.handoffId);
    const at = parseHandoffAt(input.at);
    if (record.host.promptFingerprint === null) throw new HandoffError('conflict', 'handoff_state');
    const op = enterStep(
      record,
      'deliver',
      fingerprintOf({ handoffId: record.handoffId, kind: 'deliver', promptFingerprint: record.host.promptFingerprint }),
      at,
    );
    if (op === null) return handoffView(record);
    // The committed intent exists BEFORE the send: a crash right here must not be retried into a
    // second prompt, and the journal entry is what makes the replay a duplicate.
    record.sends += 1;
    stats.sends += 1;
    let result;
    try {
      result = await sendPrompt({
        threadId: record.threadId,
        handoffId: record.handoffId,
        target: record.target,
        prompt: record.prompt,
        promptFingerprint: record.host.promptFingerprint,
      });
    } catch (error) {
      // A typed protocol refusal is the adapter stating the prompt was never issued; anything
      // else is an UNKNOWN outcome after the committed send, so it stops at reconcile.
      if (error instanceof ProtocolError) {
        failRecord(record, op, error, { code: 'source_unavailable', field: 'handoff_send' }, at);
      }
      createHostSink(hostScope(record)).reconcile({ code: 'reconcile_required', field: 'handoff_send_ambiguous', at });
      finalizeOp(op, 'reconcile', 'reconcile_required', 'handoff_send_ambiguous');
      stats.reconciles += 1;
      restoreOriginalSelection({ threads, threadId: record.threadId, participantId: record.originalParticipantId });
      record.updatedAt = at;
      throw new HandoffError('reconcile_required', 'handoff_send_ambiguous');
    }
    const ackId = result !== null && typeof result === 'object' ? result.ackId : undefined;
    if (typeof ackId !== 'string' || ackId.length === 0) {      // The send outcome is unreadable: an ambiguous send stops at reconcile. It is never
      // silently retried and never marked successful.
      createHostSink(hostScope(record)).reconcile({ code: 'reconcile_required', field: 'handoff_ambiguous', at });
      finalizeOp(op, 'reconcile', 'reconcile_required', 'handoff_ambiguous');
      stats.reconciles += 1;
      restoreOriginalSelection({ threads, threadId: record.threadId, participantId: record.originalParticipantId });
      record.updatedAt = at;
      throw new HandoffError('reconcile_required', 'handoff_ambiguous');
    }
    createAckSink({ delivery: record.delivery }).deliver({ ackId, at });
    finalizeOp(op, 'applied');
    record.updatedAt = at;
    flushPendingObservations(record);
    return handoffView(record);
  }

  function applyObservation(record, op, nativeEventId, at) {
    createObserveSink({ observation: record.observation }).observe({ nativeEventId, at });
    finalizeOp(op, 'applied');
    // Only a REAL native observation moves the thread's active selection to the target.
    threads.activate({ threadId: record.threadId, participantId: record.target.participantId });
    record.updatedAt = at;
  }

  /**
   * Apply every observation that arrived before the ack reported the delivery. The native event
   * stream and the RPC receipt have no ordering guarantee, so an early observation is real and
   * must be applied the moment the delivery is known — never discarded.
   *
   * A terminal resolution written while the send was in flight INVALIDATES the buffer: the
   * cancellation, failure or reconciliation already restored the original selection, so a late
   * ack must not replay held observations back onto a resolved handoff.
   */
  function flushPendingObservations(record) {
    if (record.resolution.value !== null) {
      record.pendingObservations.length = 0;
      return;
    }
    const held = record.pendingObservations.splice(0);
    for (const entry of held) {
      const op = journalOp({
        handoffId: record.handoffId,
        kind: 'observe',
        fingerprint: fingerprintOf({ handoffId: record.handoffId, kind: 'observe' }),
        at: entry.at,
        detail: { nativeEventId: entry.nativeEventId },
      }).op;
      applyObservation(record, op, entry.nativeEventId, entry.at);
    }
  }

  async function observe(input = {}) {
    assertOpen();
    const record = requireHandoff(input.handoffId);
    const at = parseHandoffAt(input.at);
    const nativeEventId = requireText(input.nativeEventId, 'handoff_native_event_id');
    const replayed = journal.byKey.get(`${record.handoffId}\u0000observe`);
    if (replayed !== undefined) {
      if (replayed.outcome !== 'applied') throw new HandoffError('conflict', 'handoff_state');
      stats.duplicates += 1;
      return handoffView(record);
    }
    if (projectHandoffState(record) !== RUNG_PREDECESSOR.observe) {
      // Only a handoff that already has a resolution refuses an observation; one whose send is
      // committed (deliver in flight, `sends` already incremented) but whose ack has not landed
      // yet holds the observation and applies it as soon as the delivery is known. An event that
      // predates the committed send proves nothing about the prompt and is refused: the public
      // observe input carries only handoffId/nativeEventId/at, so the send intent is the one
      // causal boundary available here.
      if (record.resolution.value !== null || record.sends === 0) {
        throw new HandoffError('conflict', 'handoff_state');
      }
      record.pendingObservations.push({ nativeEventId, at });
      record.updatedAt = at;
      return handoffView(record);
    }
    const op = enterStep(
      record,
      'observe',
      fingerprintOf({ handoffId: record.handoffId, kind: 'observe' }),
      at,
      { nativeEventId },
    );
    if (op === null) return handoffView(record);
    applyObservation(record, op, nativeEventId, at);
    return handoffView(record);
  }

  async function cancel(input = {}) {
    assertOpen();
    const record = requireHandoff(input.handoffId);
    const at = parseHandoffAt(input.at);
    // Cancel is a Host command, not a ladder rung: it has no predecessor, but it may not touch a
    // completed handoff, an already-resolved one, or replay after a failed attempt.
    const existing = journal.byKey.get(`${record.handoffId}\u0000cancel`);
    if (existing !== undefined) {
      if (existing.outcome !== 'applied') throw new HandoffError('conflict', 'handoff_state');
      stats.duplicates += 1;
      return handoffView(record);
    }
    if (record.resolution.value !== null || projectHandoffState(record) === 'active') {
      throw new HandoffError('conflict', 'handoff_state');
    }
    const op = journalOp({
      handoffId: record.handoffId,
      kind: 'cancel',
      fingerprint: fingerprintOf({ handoffId: record.handoffId, kind: 'cancel' }),
      at,
    }).op;
    createHostSink(hostScope(record)).cancel({
      code: 'cancelled',
      field: 'handoff_cancelled',
      reason: input.reason ?? null,
      at,
    });
    finalizeOp(op, 'applied');
    restoreOriginalSelection({ threads, threadId: record.threadId, participantId: record.originalParticipantId });
    record.updatedAt = at;
    return handoffView(record);
  }

  /** Recovery-facing marker. Idempotent for the same resolution; a different one is a conflict. */
  function resolve(input = {}) {
    assertOpen();
    const record = requireHandoff(input.handoffId);
    const resolution = parseResolution(input.resolution);
    const at = parseHandoffAt(input.at);
    const current = record.resolution.value;
    if (current !== null) {
      if (current.resolution !== resolution) throw new HandoffError('conflict', 'handoff_state');
      return handoffView(record);
    }
    const sink = createHostSink(hostScope(record));
    sink[RESOLUTION_SINK[resolution]]({ code: input.code, field: input.field, reason: input.reason ?? null, at });
    if (resolution === 'reconcile') stats.reconciles += 1;
    if (resolution === 'failed') stats.failures += 1;
    record.updatedAt = at;
    return handoffView(record);
  }

  function handoff(handoffId) {
    assertOpen();
    return handoffView(requireHandoff(handoffId));
  }

  function handoffs() {
    assertOpen();
    return Object.freeze([...handoffsById.values()].map(handoffView));
  }

  function ops(handoffId) {
    assertOpen();
    const record = requireHandoff(handoffId);
    const perHandoff = journal.byHandoff.get(record.handoffId) ?? [];
    return Object.freeze(perHandoff.map(opView));
  }

  function close() {
    closed = true;
    handoffsById.clear();
    carriedCheckpoints.clear();
    journal.ops.length = 0;
    journal.byHandoff.clear();
    journal.byKey.clear();
  }

  return {
    begin,
    attach,
    prepare,
    deliver,
    observe,
    cancel,
    resolve,
    handoff,
    handoffs,
    ops,
    close,
    get state() {
      return { ...stats, closed };
    },
  };
}
