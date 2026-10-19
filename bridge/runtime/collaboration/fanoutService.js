import { randomUUID } from 'node:crypto';
import {
  CollaborationError,
  parseAt,
} from '../../../shared/runtime/collaboration.js';
import { encodeSessionKey, parseSessionRef } from '../../../shared/runtime/identity.js';

/**
 * Canonical fan-out service (task 38): ONE prompt delivered to a FROZEN target list, where every
 * recipient runs its OWN child operation and the overall operation is DERIVED from each recipient's
 * real outcome — never a synthetic aggregate.
 *
 * The load-bearing guarantees are enforced by CONSTRUCTION, not by condition:
 *
 *   - A send failure touches ONLY its own recipient. `sendRecipient` awaits one recipient's
 *     `deliver`, catches that recipient's error and writes only that recipient's record. It has no
 *     reference to any sibling, so a failure of the second recipient structurally cannot revoke a
 *     recipient that is already running. ("第二失败不撤销已运行者".)
 *
 *   - `dispatch` only ever sends a SENDABLE recipient — `isSendable` is `dispatched === false &&
 *     outcome === 'pending'`. A recipient whose send was already initiated (sent, ambiguous,
 *     in-flight) or that was cancelled is therefore structurally unreachable by a second send, which
 *     is the first of the two independent layers behind "ambiguous 禁重发".
 *
 *   - Each recipient's deliver payload is built from ITS OWN record (`recipient.attachmentPath`),
 *     one recipient at a time. There is no shared slot a sibling could read, so different targets
 *     structurally cannot receive each other's attachment path. ("不同 target 不能错用附件路径".)
 *
 * The overall `state` is recomputed on every read by `deriveFanoutState` from the observed
 * per-recipient outcomes; nothing stores an aggregate. Duplicate participants to the same session
 * are de-duplicated once, at creation, against the canonical session key.
 */

/** The one frozen limits object, shared by the service and the recovery planner. */
export const FANOUT_LIMITS = Object.freeze({
  maxTargets: 32,
  maxPromptChars: 65536,
  maxAttachmentPathChars: 1024,
});

/** The overall fan-out lifecycle, every value derived from the per-recipient outcomes. */
export const FANOUT_STATES = Object.freeze([
  'pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'ambiguous',
]);
/** One recipient's child-operation outcome. `pending` covers both never-sent and in-flight. */
export const RECIPIENT_OUTCOMES = Object.freeze(['pending', 'sent', 'failed', 'ambiguous', 'cancelled']);

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function parseFanoutPrompt(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > FANOUT_LIMITS.maxPromptChars) {
    throw new CollaborationError('invalid_request', 'fanout_prompt');
  }
  return value;
}

function parseAttachmentPath(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > FANOUT_LIMITS.maxAttachmentPathChars) {
    throw new CollaborationError('invalid_request', 'fanout_attachment');
  }
  // A NUL byte or a parent-directory segment is a malformed attachment target.
  if (value.includes('\0') || value.split(/[/\\]/).includes('..')) {
    throw new CollaborationError('invalid_request', 'fanout_attachment');
  }
  return value;
}

/** One target: a participant, the native session it works in, and its OWN optional attachment. */
function parseFanoutTarget(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(value, 'participantId') || !Object.hasOwn(value, 'session')) {
    throw new CollaborationError('invalid_request', 'fanout_target');
  }
  if (typeof value.participantId !== 'string' || !UUID_PATTERN.test(value.participantId)) {
    throw new CollaborationError('invalid_request', 'fanout_target');
  }
  let session;
  try {
    session = parseSessionRef(value.session);
  } catch {
    throw new CollaborationError('invalid_request', 'fanout_target');
  }
  const attachmentPath = parseAttachmentPath(value.attachmentPath);
  return Object.freeze({ participantId: value.participantId.toLowerCase(), session, attachmentPath });
}

function normalizeFanoutId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CollaborationError('invalid_request', 'fanout_id');
  }
  return value.toLowerCase();
}

function normalizeRecipientId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CollaborationError('invalid_request', 'fanout_recipient');
  }
  return value.toLowerCase();
}

function classifyFailure(error, fallback) {
  if (error instanceof CollaborationError) {
    return { code: error.code, field: error.field };
  }
  return { code: fallback.code, field: fallback.field };
}

/** A recipient is sendable ONLY when it was never dispatched and never cancelled. */
function isSendable(recipient) {
  return recipient.dispatched === false && recipient.outcome === 'pending';
}

/**
 * Derive the overall fan-out state from the observed per-recipient outcomes. This pure function is
 * the ONLY source of the overall state; an ambiguous recipient makes the whole operation ambiguous,
 * and every other value is the honest read of how the recipients actually settled.
 */
export function deriveFanoutState(recipients) {
  if (recipients.length === 0) return 'pending';
  if (recipients.some((recipient) => recipient.outcome === 'ambiguous')) return 'ambiguous';
  const settled = recipients.filter((recipient) => recipient.outcome !== 'pending');
  if (settled.length === 0) return 'pending';
  const stillPending = recipients.length - settled.length;
  const bad = settled.filter((recipient) => recipient.outcome === 'failed' || recipient.outcome === 'cancelled');
  if (stillPending > 0) return bad.length > 0 ? 'partial' : 'running';
  if (bad.length === 0) return 'succeeded';
  if (bad.length === settled.length) {
    return settled.every((recipient) => recipient.outcome === 'cancelled') ? 'cancelled' : 'failed';
  }
  return 'partial';
}

function recipientView(recipient) {
  return Object.freeze({
    recipientId: recipient.recipientId,
    participantId: recipient.participantId,
    session: recipient.session,
    sessionKey: recipient.sessionKey,
    attachmentPath: recipient.attachmentPath,
    dispatched: recipient.dispatched,
    sendCount: recipient.sendCount,
    outcome: recipient.outcome,
    ackId: recipient.ackId,
    resolution: recipient.resolution,
    retryable: isSendable(recipient),
    createdAt: recipient.createdAt,
    updatedAt: recipient.updatedAt,
  });
}

function fanoutView(record) {
  const recipients = record.recipients;
  return Object.freeze({
    fanoutId: record.fanoutId,
    prompt: record.prompt,
    state: deriveFanoutState(recipients),
    targets: Object.freeze(recipients.map(recipientView)),
    deduped: record.deduped,
    stats: Object.freeze({
      total: recipients.length,
      sent: recipients.filter((recipient) => recipient.outcome === 'sent').length,
      failed: recipients.filter((recipient) => recipient.outcome === 'failed').length,
      ambiguous: recipients.filter((recipient) => recipient.outcome === 'ambiguous').length,
      cancelled: recipients.filter((recipient) => recipient.outcome === 'cancelled').length,
      pending: recipients.filter((recipient) => recipient.outcome === 'pending').length,
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createFanoutService({ deliver } = {}) {
  if (deliver !== undefined && typeof deliver !== 'function') {
    throw new CollaborationError('invalid_request', 'fanout_deliver');
  }
  const deliverPrompt = deliver ?? (async () => ({ ackId: `ack-${randomUUID()}` }));

  const fanoutsById = new Map();
  const stats = {
    fanouts: 0,
    recipients: 0,
    deduped: 0,
    dispatches: 0,
    sends: 0,
    failures: 0,
    reconciles: 0,
    cancellations: 0,
  };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'fanout_service_closed');
  }

  function requireFanout(fanoutId) {
    const record = fanoutsById.get(normalizeFanoutId(fanoutId));
    if (record === undefined) throw new CollaborationError('invalid_request', 'fanout_unknown');
    return record;
  }

  function requireRecipient(record, recipientId) {
    const id = normalizeRecipientId(recipientId);
    const recipient = record.recipients.find((entry) => entry.recipientId === id);
    if (recipient === undefined) throw new CollaborationError('invalid_request', 'fanout_recipient_unknown');
    return recipient;
  }

  function createFanout(input = {}) {
    assertOpen();
    const prompt = parseFanoutPrompt(input.prompt);
    const at = parseAt(input.at);
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > FANOUT_LIMITS.maxTargets) {
      throw new CollaborationError('invalid_request', 'fanout_targets');
    }
    const recipients = [];
    const seen = new Set();
    let deduped = 0;
    for (const raw of input.targets) {
      const parsed = parseFanoutTarget(raw);
      const sessionKey = encodeSessionKey(parsed.session);
      const dedupKey = `${parsed.participantId}\u0000${sessionKey}`;
      if (seen.has(dedupKey)) {
        deduped += 1;
        continue;
      }
      seen.add(dedupKey);
      recipients.push({
        recipientId: randomUUID(),
        participantId: parsed.participantId,
        session: parsed.session,
        sessionKey,
        attachmentPath: parsed.attachmentPath,
        dispatched: false,
        sendCount: 0,
        outcome: 'pending',
        ackId: null,
        resolution: null,
        createdAt: at,
        updatedAt: at,
      });
    }
    const fanoutId = randomUUID();
    const record = { fanoutId, prompt, recipients, deduped, createdAt: at, updatedAt: at };
    fanoutsById.set(fanoutId, record);
    stats.fanouts += 1;
    stats.recipients += recipients.length;
    stats.deduped += deduped;
    return fanoutView(record);
  }

  /**
   * Deliver one recipient's prompt. The record is marked in-flight BEFORE the send runs, so a crash
   * here cannot be retried into a second prompt for this recipient. Every outcome is written to THIS
   * recipient only; the function never touches a sibling and never rejects.
   */
  async function sendRecipient(record, recipient, at) {
    if (!isSendable(recipient)) return;
    recipient.dispatched = true;
    recipient.sendCount += 1;
    recipient.updatedAt = at;
    stats.sends += 1;
    let result;
    try {
      result = await deliverPrompt({
        recipientId: recipient.recipientId,
        participantId: recipient.participantId,
        session: recipient.session,
        attachmentPath: recipient.attachmentPath,
        prompt: record.prompt,
      });
    } catch (error) {
      const failure = classifyFailure(error, { code: 'source_unavailable', field: 'fanout_send' });
      recipient.outcome = 'failed';
      recipient.resolution = Object.freeze({ code: failure.code, field: failure.field });
      recipient.updatedAt = at;
      stats.failures += 1;
      return;
    }
    // A result that arrives after this recipient was reconciled, cancelled or failed is ignored.
    if (recipient.outcome !== 'pending') return;
    const ackId = result !== null && typeof result === 'object' ? result.ackId : undefined;
    if (typeof ackId !== 'string' || ackId.length === 0) {
      recipient.outcome = 'ambiguous';
      recipient.resolution = Object.freeze({ code: 'reconcile_required', field: 'fanout_ambiguous' });
      recipient.updatedAt = at;
      stats.reconciles += 1;
      return;
    }
    recipient.outcome = 'sent';
    recipient.ackId = ackId;
    recipient.updatedAt = at;
  }

  /**
   * Dispatch the fan-out. With no `recipientIds` every sendable recipient is dispatched; with an
   * explicit list only that subset is (partial dispatch). Each selected recipient is sent
   * independently and concurrently, so one recipient's failure never revokes another.
   */
  async function dispatch(input = {}) {
    assertOpen();
    const record = requireFanout(input.fanoutId);
    const at = parseAt(input.at);
    let selected;
    if (input.recipientIds === undefined) {
      selected = record.recipients.filter(isSendable);
    } else {
      if (!Array.isArray(input.recipientIds)) throw new CollaborationError('invalid_request', 'fanout_recipients');
      const wanted = new Set(input.recipientIds.map(normalizeRecipientId));
      selected = record.recipients.filter((recipient) => wanted.has(recipient.recipientId) && isSendable(recipient));
    }
    if (selected.length > 0) stats.dispatches += 1;
    await Promise.all(selected.map((recipient) => sendRecipient(record, recipient, at)));
    record.updatedAt = at;
    return fanoutView(record);
  }

  /** Cancel ONE recipient individually. A sibling is never touched; a terminal recipient is left as-is. */
  function cancelRecipient(input = {}) {
    assertOpen();
    const record = requireFanout(input.fanoutId);
    const at = parseAt(input.at);
    const recipient = requireRecipient(record, input.recipientId);
    if (recipient.outcome === 'pending' || recipient.outcome === 'sent') {
      recipient.outcome = 'cancelled';
      recipient.resolution = Object.freeze({ code: 'cancelled', field: 'fanout_cancelled' });
      recipient.updatedAt = at;
      stats.cancellations += 1;
    }
    return fanoutView(record);
  }

  /**
   * The manager-kill recovery pass. Every recipient whose send was initiated but never resolved is
   * unknowable: it becomes `ambiguous` and is RETAINED. A recipient that already settled is untouched.
   */
  function reconcile(input = {}) {
    assertOpen();
    const record = requireFanout(input.fanoutId);
    const at = parseAt(input.at);
    for (const recipient of record.recipients) {
      if (recipient.dispatched === true && recipient.outcome === 'pending') {
        recipient.outcome = 'ambiguous';
        recipient.resolution = Object.freeze({ code: 'reconcile_required', field: 'fanout_ambiguous' });
        recipient.updatedAt = at;
        stats.reconciles += 1;
      }
    }
    record.updatedAt = at;
    return fanoutView(record);
  }

  /**
   * Retry. The caller passes the recipient ids a recovery planner marked safe; `dispatch` re-checks
   * each one against `isSendable`, so an ambiguous or already-sent recipient can never be re-sent
   * even if its id is supplied here — the second independent layer behind "ambiguous 禁重发".
   */
  async function retry(input = {}) {
    assertOpen();
    const record = requireFanout(input.fanoutId);
    if (!Array.isArray(input.recipientIds)) throw new CollaborationError('invalid_request', 'fanout_recipients');
    return dispatch({ fanoutId: record.fanoutId, recipientIds: input.recipientIds, at: input.at });
  }

  function fanout(fanoutId) {
    assertOpen();
    return fanoutView(requireFanout(fanoutId));
  }

  function fanouts() {
    assertOpen();
    return Object.freeze([...fanoutsById.values()].map(fanoutView));
  }

  function state() {
    return Object.freeze({ ...stats, closed });
  }

  function close() {
    closed = true;
    fanoutsById.clear();
  }

  return {
    createFanout,
    fanout,
    fanouts,
    dispatch,
    cancelRecipient,
    reconcile,
    retry,
    state,
    close,
  };
}
