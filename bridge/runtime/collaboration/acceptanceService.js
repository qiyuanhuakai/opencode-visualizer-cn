import {
  CollaborationError,
  MAX_DELIVERABLES,
  parseAt,
  parseCriteriaVerdicts,
  parseDeliverable,
  parseTaskId,
} from '../../../shared/runtime/collaboration.js';

/**
 * Canonical Acceptance service (task 37): task review and task acceptance.
 *
 * Task review and task acceptance are INDEPENDENT of the attempt. A task is not accepted because
 * its run finished; it is accepted because a reviewer approved it against the task's own frozen
 * criteria and a registered deliverable. That independence is structural, not a guard:
 *
 *   - the ONLY writer of the review and acceptance slices is `createAcceptanceSink`, whose scope
 *     is `{ review, acceptance, deliverables }` — three slices of the TASK record;
 *   - the attempt's native sink (`attemptService.createNativeSink`) is built from the ATTEMPT
 *     record's `observation` slice, whose type has no member reaching any of those three, so no
 *     native terminal event — however it is phrased — can mark a task accepted;
 *   - `accept` refuses without a registered deliverable, without an approved review, without
 *     every required criterion met, and without a live owner lease.
 *
 * So "a native end with no deliverable or no acceptance cannot be success" holds twice over: once
 * because the native path has no reachable writer, and once because the acceptance path itself
 * refuses.
 */
export function createAcceptanceService({ tasks } = {}) {
  if (tasks === null || typeof tasks !== 'object' || typeof tasks.record !== 'function'
    || typeof tasks.task !== 'function') {
    throw new CollaborationError('invalid_request', 'acceptance_tasks');
  }

  function requireRecord(taskId) {
    return tasks.record(parseTaskId(taskId));
  }

  function acceptanceScope(record) {
    return { review: record.review, acceptance: record.acceptance, deliverables: record.deliverables };
  }

  function assertLeaseLive(record, at) {
    if (record.lease === null || record.lease.expiresAt <= at) {
      throw new CollaborationError('conflict', 'task_lease', { taskId: record.taskId });
    }
  }

  /**
   * Register one immutable deliverable. Deliverables are the ONLY thing an acceptance may point
   * at, and a task never carries more than the frozen maximum.
   */
  function registerDeliverable(input = {}) {
    const record = requireRecord(input.taskId);
    const at = parseAt(input.at);
    assertLeaseLive(record, at);
    if (record.host.state === 'accepted' || record.acceptance.state === 'accepted') {
      throw new CollaborationError('conflict', 'acceptance_state');
    }
    const deliverable = parseDeliverable(input.deliverable);
    const sink = createAcceptanceSink(acceptanceScope(record));
    sink.deliverable({ deliverable, at });
    record.updatedAt = at;
    return tasks.task(record.taskId);
  }

  /** Move a completed task into review. A task still in flight, or already failed, may not. */
  function submitForReview(input = {}) {
    const record = requireRecord(input.taskId);
    const at = parseAt(input.at);
    assertLeaseLive(record, at);
    if (record.host.state !== 'review') throw new CollaborationError('conflict', 'task_state');
    if (record.review.state === 'pending') throw new CollaborationError('conflict', 'review_state');
    if (typeof input.reviewer !== 'string' || input.reviewer.length === 0 || input.reviewer.length > 128) {
      throw new CollaborationError('invalid_request', 'review_reviewer');
    }
    const sink = createAcceptanceSink(acceptanceScope(record));
    sink.submitReview({ reviewer: input.reviewer, at });
    record.updatedAt = at;
    return tasks.task(record.taskId);
  }

  /** The reviewer's verdict. Rejection keeps the task in review, visibly not accepted. */
  function review(input = {}) {
    const record = requireRecord(input.taskId);
    const at = parseAt(input.at);
    assertLeaseLive(record, at);
    if (record.review.state !== 'pending') throw new CollaborationError('conflict', 'review_state');
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new CollaborationError('invalid_request', 'review_decision');
    }
    if (typeof input.reviewer !== 'string' || input.reviewer.length === 0 || input.reviewer.length > 128) {
      throw new CollaborationError('invalid_request', 'review_reviewer');
    }
    const sink = createAcceptanceSink(acceptanceScope(record));
    sink.review({ decision: input.decision, reviewer: input.reviewer, reason: input.reason ?? null, at });
    record.updatedAt = at;
    return tasks.task(record.taskId);
  }

  /**
   * Mark the task accepted. Five independent preconditions, each an explicit refusal:
   * the live review lifecycle, an approved review, a live owner lease, a registered
   * deliverable, and every required criterion met. A native terminal event satisfies none
   * of them.
   */
  function accept(input = {}) {
    const record = requireRecord(input.taskId);
    const at = parseAt(input.at);
    if (record.acceptance.state === 'accepted') {
      const same = record.acceptance.deliverableId === input.deliverableId
        && record.acceptance.acceptedBy === input.acceptedBy;
      if (!same) throw new CollaborationError('conflict', 'acceptance_state');
      return tasks.task(record.taskId);
    }
    // The acceptance lifecycle: only a task sitting in review — its run ended and its review
    // live — may be accepted. A task in flight, failed or cancelled is outside the acceptable
    // lifecycle however approved a retained review reads, so a stale approval can never
    // accept a task that is running or already terminated.
    if (record.host.state !== 'review') {
      throw new CollaborationError('conflict', 'task_state', { taskId: record.taskId, state: record.host.state });
    }
    assertLeaseLive(record, at);
    const deliverable = record.deliverables.find((entry) => entry.deliverableId === input.deliverableId);
    if (deliverable === undefined) {
      throw new CollaborationError('invalid_request', 'acceptance_deliverable', { taskId: record.taskId });
    }
    if (record.review.state !== 'approved') throw new CollaborationError('conflict', 'acceptance_review');
    const verdicts = parseCriteriaVerdicts(input.criteria, record.criteria);
    const unmet = verdicts.filter((verdict) => verdict.met === false
      && record.criteria.some((criterion) => criterion.id === verdict.id && criterion.required === true));
    if (unmet.length > 0) {
      throw new CollaborationError('conflict', 'acceptance_criteria', { unmet: unmet.map((entry) => entry.id) });
    }
    if (typeof input.acceptedBy !== 'string' || input.acceptedBy.length === 0 || input.acceptedBy.length > 128) {
      throw new CollaborationError('invalid_request', 'acceptance_owner');
    }
    const sink = createAcceptanceSink(acceptanceScope(record));
    sink.accept({ deliverableId: deliverable.deliverableId, criteria: verdicts, acceptedBy: input.acceptedBy, at });
    record.host.state = 'accepted';
    record.host.endedAt = at;
    record.updatedAt = at;
    return tasks.task(record.taskId);
  }

  /** Reject the task's acceptance. The task stays in review, visibly not accepted. */
  function reject(input = {}) {
    const record = requireRecord(input.taskId);
    const at = parseAt(input.at);
    if (record.acceptance.state === 'accepted') throw new CollaborationError('conflict', 'acceptance_state');
    if (typeof input.reason !== 'string' || input.reason.length === 0 || input.reason.length > 256) {
      throw new CollaborationError('invalid_request', 'acceptance_reason');
    }
    const sink = createAcceptanceSink(acceptanceScope(record));
    sink.reject({ reason: input.reason, at });
    record.updatedAt = at;
    return tasks.task(record.taskId);
  }

  return {
    registerDeliverable,
    submitForReview,
    review,
    accept,
    reject,
  };
}

/**
 * The acceptance side of the boundary: the ONLY sink that may write a task's review, acceptance
 * and deliverable slices. It is constructed from a TASK record; no attempt record has a member
 * that can produce this scope, which is what makes a native end structurally unable to accept.
 */
export function createAcceptanceSink(scope) {
  if (scope === null || typeof scope !== 'object' || !Object.hasOwn(scope, 'review')
    || !Object.hasOwn(scope, 'acceptance') || !Object.hasOwn(scope, 'deliverables')
    || !Array.isArray(scope.deliverables)) {
    throw new CollaborationError('invalid_request', 'acceptance_scope');
  }
  return Object.freeze({
    deliverable(input = {}) {
      const deliverable = parseDeliverable(input.deliverable);
      if (scope.deliverables.length >= MAX_DELIVERABLES) {
        throw new CollaborationError('conflict', 'acceptance_deliverable', { limit: MAX_DELIVERABLES });
      }
      if (scope.deliverables.some((entry) => entry.deliverableId === deliverable.deliverableId)) {
        throw new CollaborationError('conflict', 'acceptance_deliverable');
      }
      scope.deliverables.push(deliverable);
    },
    submitReview(input = {}) {
      scope.review.state = 'pending';
      scope.review.reviewer = input.reviewer;
      scope.review.reason = null;
      scope.review.at = input.at ?? Date.now();
    },
    review(input = {}) {
      scope.review.state = input.decision;
      scope.review.reviewer = input.reviewer;
      scope.review.reason = input.reason ?? null;
      scope.review.at = input.at ?? Date.now();
    },
    accept(input = {}) {
      scope.acceptance.state = 'accepted';
      scope.acceptance.acceptedBy = input.acceptedBy;
      scope.acceptance.acceptedAt = input.at ?? Date.now();
      scope.acceptance.deliverableId = input.deliverableId;
      scope.acceptance.criteria = input.criteria.map((entry) => entry.id);
    },
    reject(input = {}) {
      scope.acceptance.state = 'rejected';
      scope.review.reason = input.reason;
      scope.review.at = input.at ?? Date.now();
    },
  });
}
