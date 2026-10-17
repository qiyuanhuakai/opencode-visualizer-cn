import { CollaborationError } from '../../../shared/runtime/collaboration.js';

/**
 * Canonical fan-out recovery planner (task 38): given a fan-out's read model, decide which
 * recipients may be retried and which must be RETAINED.
 *
 * The guarantee "retry 只显式安全未发送 recipient，ambiguous 禁重发" is STRUCTURAL, held twice over:
 *
 *   1. `planFanoutRetry` builds the `retryable` set by iterating the recipients and admitting ONLY
 *      those that were never dispatched and never cancelled (`dispatched === false && outcome ===
 *      'pending'`). An ambiguous recipient — dispatched, outcome unknowable — is written to
 *      `retained` and is never constructed into a retryable spec. There is no code path that turns a
 *      dispatched recipient into a retryable one.
 *
 *   2. Even if a caller ignores the plan and re-dispatches a dispatched recipient's id, the service's
 *      `dispatch` re-checks every id against the same `isSendable` predicate and refuses it. The
 *      planner and the dispatcher are two independent gates on the same invariant.
 *
 * `retained` carries the OBSERVED outcome and the reason each recipient is withheld, so the recovery
 * is fully visible: nothing is silently dropped and nothing ambiguous is silently re-sent.
 */
export function planFanoutRetry(view) {
  if (view === null || typeof view !== 'object' || !Array.isArray(view.targets)) {
    throw new CollaborationError('invalid_request', 'fanout_view');
  }
  const retryable = [];
  const retained = [];
  for (const target of view.targets) {
    if (target.dispatched === false && target.outcome === 'pending') {
      retryable.push(Object.freeze({
        recipientId: target.recipientId,
        participantId: target.participantId,
        session: target.session,
        attachmentPath: target.attachmentPath,
      }));
      continue;
    }
    let reason;
    if (target.outcome === 'ambiguous') reason = 'fanout_ambiguous';
    else if (target.outcome === 'cancelled') reason = 'fanout_cancelled';
    else if (target.outcome === 'pending') reason = 'fanout_in_flight';
    else reason = 'fanout_already_dispatched';
    retained.push(Object.freeze({
      recipientId: target.recipientId,
      outcome: target.outcome,
      reason,
    }));
  }
  return Object.freeze({
    retryable: Object.freeze(retryable),
    retained: Object.freeze(retained),
  });
}
