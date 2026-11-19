import { ProtocolError } from '../../../shared/runtime/capabilities.js';

/**
 * Handoff recovery policy (task 34).
 *
 * Two rules live here, and both are about NOT guessing:
 *
 *   1. A failure returns the thread to the ORIGINAL participant selection — the participant that
 *      was active when the handoff began — never to a half-migrated one. The handoff service
 *      imports `restoreOriginalSelection` so its own failure path and this policy cannot drift
 *      apart.
 *   2. An ambiguous outcome stops at `reconcile`: it is never silently retried and never marked
 *      successful. A handoff that was interrupted after its send was committed but before a real
 *      native observation has an UNKNOWN outcome, so the decision table fails closed.
 *
 * This module is pure policy over the read models the handoff service exposes; it holds no
 * handoff state of its own.
 */

/**
 * Wrap a driver error into an explicit {code, field}. A typed protocol error passes through
 * untouched (its code and field are already the rejection's identity); anything else — a plain
 * Error, a string, undefined — is wrapped in the caller's fallback so no failure is ever a bare
 * throw.
 */
export function classifyHandoffFailure(error, fallback) {
  if (error instanceof ProtocolError) {
    return Object.freeze({ code: error.code, field: error.field, typed: true });
  }
  return Object.freeze({ code: fallback.code, field: fallback.field, typed: false });
}

/**
 * Restore the ORIGINAL participant selection. `threads.activate` is idempotent when the
 * participant is already active, so a repeated rollback neither moves the selection nor bumps
 * the thread revision — the recovery is safe to run twice.
 */
export function restoreOriginalSelection({ threads, threadId, participantId }) {
  const participant = threads.activate({ threadId, participantId });
  return Object.freeze({
    participantId: participant.participantId,
    session: participant.session,
    revision: threads.get(threadId).revision,
  });
}

/**
 * The restart decision table. Given a handoff read model and its journal ops it answers what a
 * recovering process may do — and the answer is never "resend".
 *
 * `active` is the only completed rung, because only a REAL native observation reaches it. A
 * native ack alone (`delivered`) is not success: the handoff stops at `reconcile` and waits for
 * an explicit resolution instead of being retried or declared done.
 */
export function handoffRecoveryDecision({ record, ops }) {
  const deliverOp = ops.find((op) => op.kind === 'deliver') ?? null;
  const sendAttempted = deliverOp !== null;
  switch (record.state) {
    case 'active':
      return Object.freeze({ action: 'complete', reason: 'handoff_observed', sendAttempted });
    case 'cancelled':
      return Object.freeze({ action: 'cancelled', reason: record.resolution?.reason ?? 'handoff_cancelled', sendAttempted });
    case 'failed':
      return Object.freeze({ action: 'rollback', reason: record.resolution?.reason ?? null, sendAttempted });
    case 'reconcile':
      return Object.freeze({ action: 'reconcile', reason: record.resolution?.reason ?? 'handoff_already_reconciling', sendAttempted });
    case 'prepared':
      // The send was committed as an intent but no native ack ever arrived: whether the prompt
      // reached the target is unknowable, so the handoff is preserved at reconcile.
      return Object.freeze({ action: 'reconcile', reason: 'handoff_interrupted_before_ack', sendAttempted });
    case 'delivered':
      // A native ack only means delivered. Without a real observation the handoff is not
      // successful and must not be retried.
      return Object.freeze({ action: 'reconcile', reason: 'handoff_ack_without_observation', sendAttempted });
    default:
      // checkpoint / attached: nothing was ever sent, so the caller may resume the handoff.
      return Object.freeze({ action: 'resumable', reason: 'handoff_not_sent', sendAttempted });
  }
}

/**
 * Apply the decision table to one handoff and return the frozen outcome. A reconcile or failed
 * decision is MARKED on the record (through the service's own resolve, which stays idempotent),
 * every non-complete decision returns the thread to the original participant selection, and no
 * path ever dispatches the prompt.
 */
export function recoverHandoff({ service, threads, handoffId }) {
  const record = service.handoff(handoffId);
  const ops = service.ops(handoffId);
  const decision = handoffRecoveryDecision({ record, ops });
  if (decision.action === 'reconcile') {
    service.resolve({
      handoffId,
      resolution: 'reconcile',
      code: 'reconcile_required',
      field: 'handoff_ambiguous',
      reason: decision.reason,
    });
  } else if (decision.action === 'rollback') {
    service.resolve({
      handoffId,
      resolution: 'failed',
      code: record.resolution?.code ?? 'conflict',
      field: record.resolution?.field ?? 'handoff_rollback',
      reason: decision.reason,
    });
  }
  const restored = decision.action === 'complete'
    ? null
    : restoreOriginalSelection({ threads, threadId: record.threadId, participantId: record.originalParticipantId });
  return Object.freeze({
    handoffId,
    action: decision.action,
    reason: decision.reason,
    state: service.handoff(handoffId).state,
    restoredParticipantId: restored?.participantId ?? null,
    sendAttempted: decision.sendAttempted,
    observed: record.observed,
  });
}
