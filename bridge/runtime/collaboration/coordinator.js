import { randomUUID } from 'node:crypto';
import {
  COLLABORATION_BUDGETS,
  CollaborationError,
  MAX_MAILBOX_TEXT_CHARS,
  parseAt,
  parseCriteria,
  parseOwner,
  parseSessionMutationKey,
  parseTeamId,
  parseTeamName,
  parseTaskTitle,
  parseLeaseInput,
} from '../../../shared/runtime/collaboration.js';
import { createTaskGraph } from './taskGraph.js';
import { createAttemptService } from './attemptService.js';
import { createAcceptanceService } from './acceptanceService.js';

/**
 * Canonical Collaboration coordinator (task 37): Teams, their task DAG, the attempts those tasks
 * run, and the five budgets that bound all of it.
 *
 * The budget gate is the heart of this module. A dispatch is admitted only when ALL FIVE budgets
 * have room — concurrency 4, Session mutation 1, depth 4, children 32, mailbox 1000, taken from
 * the one frozen shared object. When any of them is exhausted the task is PARKED: it keeps its
 * identity, its place in the DAG and its history, and its read model reports `state: 'paused'`
 * with the explicit budget reasons. Nothing is silently dropped and nothing is silently run — a
 * paused task is the loudest state this coordinator has.
 *
 * The three native-terminal guarantees are enforced by construction, not by condition:
 *
 *   - a native end writes only the attempt's observation slice (attemptService.createNativeSink),
 *     so it moves the task to `review` at most — never to `accepted`;
 *   - an ambiguous send or an ambiguous restart stops at `reconcile` and is RETAINED. `restart()`
 *     re-derives every counter and reconciles every attempt whose outcome is unknowable, and it
 *     dispatches NOTHING: `RestartView.dispatched` is empty by construction. Only the explicit
 *     scheduler `pump()` admits paused work, and only once a budget has actually freed up.
 *
 * The mailbox is the team's bounded notice channel: at capacity a post is refused with an explicit
 * code, and a dispatch that cannot deliver its notice is paused rather than run.
 */

const RUNNING_ATTEMPT_STATES = Object.freeze(['accepted', 'sent', 'observed']);

function teamView(record) {
  return Object.freeze({
    teamId: record.teamId,
    name: record.name,
    taskCount: record.taskIds.length,
    mailboxDepth: record.mailbox.length,
    createdAt: record.createdAt,
  });
}

function messageView(message) {
  return Object.freeze({
    messageId: message.messageId,
    teamId: message.teamId,
    from: message.from,
    to: message.to,
    text: message.text,
    at: message.at,
  });
}

function dispatchPair(task, attempt) {
  return Object.freeze({ task, attempt });
}

export function createCollaborationCoordinator({
  deliver,
} = {}) {
  if (deliver !== undefined && typeof deliver !== 'function') {
    throw new CollaborationError('invalid_request', 'coordinator_deliver');
  }
  const deliverPrompt = deliver ?? (async () => ({ ackId: `ack-${randomUUID()}` }));

  const graph = createTaskGraph();
  const attempts = createAttemptService();
  const acceptance = createAcceptanceService({ tasks: graph });

  const teamsById = new Map();
  /** mailbox per team: the bounded notice channel. */
  const mailboxes = new Map();
  /** attemptIds currently in flight. */
  const running = new Set();
  /** session mutation key → running attempts on that native session. */
  const sessionRunning = new Map();
  const stats = {
    teams: 0,
    tasks: 0,
    attempts: 0,
    dispatches: 0,
    reconciles: 0,
    failures: 0,
    messages: 0,
  };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'coordinator_closed');
  }

  function requireTeam(teamId) {
    const team = teamsById.get(parseTeamId(teamId));
    if (team === undefined) throw new CollaborationError('invalid_request', 'team_unknown');
    return team;
  }

  /* ------------------------------------------------------------------ budgets */

  function maxMailboxDepth() {
    let depth = 0;
    for (const mailbox of mailboxes.values()) depth = Math.max(depth, mailbox.length);
    return depth;
  }

  /**
   * The five budget reasons that currently block this task, in BUDGET_REASONS order. An empty
   * list means the task may run; a non-empty list is the OBSERVED, visible pause.
   */
  function budgetReasonsFor(record) {
    const reasons = [];
    if (running.size >= COLLABORATION_BUDGETS.maxConcurrency) reasons.push('collaboration_concurrency');
    const sessionKey = parseSessionMutationKey(record.owner.session);
    if ((sessionRunning.get(sessionKey) ?? 0) >= COLLABORATION_BUDGETS.maxSessionMutations) {
      reasons.push('collaboration_session_mutation');
    }
    if (record.depth > COLLABORATION_BUDGETS.maxDepth) reasons.push('collaboration_depth');
    if (record.parentId !== null) {
      const parent = graph.record(record.parentId);
      if (parent.children.indexOf(record.taskId) >= COLLABORATION_BUDGETS.maxChildren) {
        reasons.push('collaboration_children');
      }
    }
    if (maxMailboxDepth() >= COLLABORATION_BUDGETS.maxMailbox) reasons.push('collaboration_mailbox');
    return reasons;
  }

  function park(record, reasons, at) {
    record.paused = Object.freeze({ reasons: Object.freeze(reasons), at });
    if (record.host.state !== 'review') record.host.state = 'paused';
    record.updatedAt = at;
  }

  /* ------------------------------------------------------------------ running accounting */

  function markRunning(attemptRecord, on) {
    const sessionKey = parseSessionMutationKey(attemptRecord.owner.session);
    if (on) {
      running.add(attemptRecord.attemptId);
      sessionRunning.set(sessionKey, (sessionRunning.get(sessionKey) ?? 0) + 1);
      return;
    }
    // Release ONLY a reservation this attempt actually holds. `running` is exactly the set of
    // in-flight attemptIds, so a duplicate cancel, fail or end is a no-op here and can never
    // decrement another attempt's share of the Session-mutation budget.
    if (!running.delete(attemptRecord.attemptId)) return;
    const current = sessionRunning.get(sessionKey) ?? 0;
    if (current <= 1) sessionRunning.delete(sessionKey);
    else sessionRunning.set(sessionKey, current - 1);
  }

  /** Re-derive every counter from the attempt records themselves, never from a remembered number. */
  function rederiveRunning() {
    running.clear();
    sessionRunning.clear();
    for (const view of attempts.attempts()) {
      if (!RUNNING_ATTEMPT_STATES.includes(view.state)) continue;
      const record = attempts.record(view.attemptId);
      running.add(record.attemptId);
      const sessionKey = parseSessionMutationKey(record.owner.session);
      sessionRunning.set(sessionKey, (sessionRunning.get(sessionKey) ?? 0) + 1);
    }
  }

  /* ------------------------------------------------------------------ teams and tasks */

  function createTeam(input = {}) {
    assertOpen();
    const name = parseTeamName(input.name);
    const at = parseAt(input.at);
    const teamId = input.teamId === undefined ? randomUUID() : parseTeamId(input.teamId);
    if (teamsById.has(teamId)) throw new CollaborationError('conflict', 'team_duplicate');
    const record = {
      teamId,
      name,
      taskIds: [],
      mailbox: [],
      createdAt: at,
    };
    teamsById.set(teamId, record);
    mailboxes.set(teamId, record.mailbox);
    graph.registerTeam(teamId);
    stats.teams += 1;
    return teamView(record);
  }

  function team(teamId) {
    assertOpen();
    return teamView(requireTeam(teamId));
  }

  function teams() {
    assertOpen();
    return Object.freeze([...teamsById.values()].map(teamView));
  }

  function createTask(input = {}) {
    assertOpen();
    const view = graph.createTask({
      teamId: parseTeamId(input.teamId),
      title: parseTaskTitle(input.title),
      criteria: parseCriteria(input.criteria),
      owner: parseOwner(input.owner),
      lease: parseLeaseInput(input.lease),
      parentId: input.parentId,
      dependsOn: input.dependsOn,
      at: input.at,
    });
    const team = requireTeam(view.teamId);
    team.taskIds.push(view.taskId);
    stats.tasks += 1;
    return view;
  }

  function addDependency(input = {}) {
    assertOpen();
    return graph.addDependency({ taskId: input.taskId, dependsOn: input.dependsOn, at: input.at });
  }

  function task(taskId) {
    assertOpen();
    return graph.task(taskId);
  }

  function tasks(teamId) {
    assertOpen();
    return graph.tasks(teamId);
  }

  /* ------------------------------------------------------------------ dispatch */

  /**
   * Admit one task: mint its attempt at the `accepted` rung and consume its budget share. The
   * gate runs BEFORE anything is created — a blocked dependency, a lapsed owner lease or an
   * exhausted budget all refuse or park the task without minting an attempt. Delivering the
   * prompt is a separate, separately observable rung (`send`).
   */
  async function dispatch(input = {}) {
    assertOpen();
    const record = graph.record(input.taskId);
    const at = parseAt(input.at);
    if (record.host.state === 'dispatched') {
      throw new CollaborationError('conflict', 'task_dispatched', { taskId: record.taskId });
    }
    if (record.host.state === 'accepted' || record.host.state === 'failed' || record.host.state === 'cancelled'
      || record.host.state === 'review') {
      throw new CollaborationError('conflict', 'task_state', { taskId: record.taskId, state: record.host.state });
    }
    if (record.lease === null || record.lease.expiresAt <= at) {
      throw new CollaborationError('conflict', 'task_lease', { taskId: record.taskId });
    }
    // The budget gate runs BEFORE the blocking check so an exhausted budget is always reported as
    // the visible pause the plan demands, even on a task that is also blocked. `blockedBy` stays
    // in the read model either way.
    const reasons = budgetReasonsFor(record);
    if (reasons.length > 0) {
      park(record, reasons, at);
      return dispatchPair(graph.task(record.taskId), null);
    }
    const blockedBy = graph.blockedBy(record.taskId);
    if (blockedBy.length > 0) {
      throw new CollaborationError('conflict', 'task_blocked', { taskId: record.taskId, blockedBy });
    }
    record.paused = null;

    const prompt = typeof input.prompt === 'string' && input.prompt.length > 0
      ? input.prompt
      : record.title;
    const begun = attempts.begin({
      taskId: record.taskId,
      teamId: record.teamId,
      owner: record.owner,
      prompt,
      at,
    });
    record.attempts.push(begun.attemptId);
    stats.dispatches += 1;
    stats.attempts += 1;
    markRunning(attempts.record(begun.attemptId), true);
    record.host.state = 'dispatched';
    record.host.dispatchedAt = at;
    record.updatedAt = at;
    return dispatchPair(graph.task(record.taskId), begun);
  }

  /**
   * Deliver the prompt: the attempt's `sent` rung. The op is journaled before the send runs, so a
   * crash here must not be retried into a second prompt. An unreadable outcome is a STOP at
   * reconcile — the attempt is retained, the task is visibly ambiguous, and nothing is retried.
   * A source error fails the attempt and the task, and keeps the typed rejection.
   */
  async function send(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const attemptRecord = attempts.record(input.attemptId);
    const taskRecord = graph.record(attemptRecord.taskId);
    let delivered;
    try {
      delivered = await attempts.deliver({ attemptId: input.attemptId, deliver: deliverPrompt, at });
    } catch (error) {
      // Only a send that ACTUALLY terminated may fail the task and free its budget. The
      // deliver op's outcome is the evidence: `failed` means this call's send stopped, while
      // a missing or non-failed op means the request was REJECTED by a state check — a
      // duplicate in-flight send, or a send for an attempt that already stopped. Such a
      // rejection must leave the original send's lifecycle, and the reservation it still
      // holds, untouched.
      const deliverOp = attempts.ops(input.attemptId).find((op) => op.kind === 'deliver');
      if (deliverOp === undefined || deliverOp.outcome !== 'failed') throw error;
      markRunning(attemptRecord, false);
      if (taskRecord.host.state === 'dispatched' || taskRecord.host.state === 'paused') {
        taskRecord.host.state = 'failed';
        taskRecord.host.endedAt = at;
        taskRecord.updatedAt = at;
        stats.failures += 1;
      }
      throw error;
    }
    if (delivered.outcome === 'reconcile') {
      markRunning(attemptRecord, false);
      taskRecord.ambiguous = true;
      taskRecord.updatedAt = at;
      stats.reconciles += 1;
    }
    return dispatchPair(graph.task(taskRecord.taskId), delivered.attempt);
  }

  /**
   * The explicit scheduler. It walks the paused tasks in CREATION order and admits the ones whose
   * budgets have freed up — fair, and only ever driven by a caller. `restart()` never calls this.
   */
  async function pump(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const admitted = [];
    for (const view of graph.tasks()) {
      if (view.state !== 'paused') continue;
      const record = graph.record(view.taskId);
      if (budgetReasonsFor(record).length > 0) continue;
      if (graph.blockedBy(record.taskId).length > 0) continue;
      const result = await dispatch({ taskId: view.taskId, at });
      if (result.attempt !== null) admitted.push(result.task);
    }
    return Object.freeze(admitted);
  }

  /* ------------------------------------------------------------------ native events */

  function observe(input = {}) {
    assertOpen();
    return attempts.observe({ attemptId: input.attemptId, nativeEventId: input.nativeEventId, at: input.at });
  }

  /**
   * The native end. It writes the ATTEMPT's observation slice and moves the task to `review` when
   * the run completed — never to `accepted`. A task is accepted only by the acceptance path.
   */
  function observeNativeEnd(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const attemptRecord = attempts.record(input.attemptId);
    const view = attempts.end({
      attemptId: input.attemptId,
      reason: input.reason,
      nativeEventId: input.nativeEventId,
      at,
    });
    markRunning(attemptRecord, false);
    const taskRecord = graph.record(attemptRecord.taskId);
    taskRecord.ambiguous = false;
    taskRecord.host.state = input.reason === 'completed' ? 'review' : 'failed';
    taskRecord.host.endedAt = at;
    taskRecord.updatedAt = at;
    if (input.reason !== 'completed') stats.failures += 1;
    return view;
  }

  function cancelAttempt(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const attemptRecord = attempts.record(input.attemptId);
    const view = attempts.cancel({
      attemptId: input.attemptId,
      code: 'cancelled',
      field: 'attempt_cancelled',
      reason: input.reason ?? null,
      at,
    });
    markRunning(attemptRecord, false);
    const taskRecord = graph.record(attemptRecord.taskId);
    if (taskRecord.host.state === 'dispatched' || taskRecord.host.state === 'paused') {
      taskRecord.host.state = 'cancelled';
      taskRecord.host.endedAt = at;
      taskRecord.updatedAt = at;
    }
    return view;
  }

  function attempt(attemptId) {
    assertOpen();
    return attempts.attempt(attemptId);
  }

  function attemptsOf(taskId) {
    assertOpen();
    return attempts.attempts(taskId);
  }

  function ops(attemptId) {
    assertOpen();
    return attempts.ops(attemptId);
  }

  /* ------------------------------------------------------------------ Host task outcomes */

  function failTask(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const record = graph.record(input.taskId);
    if (record.host.state === 'accepted') throw new CollaborationError('conflict', 'task_state');
    for (const attemptId of record.attempts) {
      const state = attempts.attempt(attemptId).state;
      if (!RUNNING_ATTEMPT_STATES.includes(state)) continue;
      // Release the reservation BEFORE the stop rewrites the projected state: the release keys
      // off the reservation actually held, never off the post-stop projection.
      markRunning(attempts.record(attemptId), false);
      attempts.fail({ attemptId, code: input.code, field: input.field, reason: input.reason ?? null, at });
    }
    record.host.state = 'failed';
    record.host.endedAt = at;
    record.updatedAt = at;
    stats.failures += 1;
    return graph.task(record.taskId);
  }

  function cancelTask(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const record = graph.record(input.taskId);
    if (record.host.state === 'accepted') throw new CollaborationError('conflict', 'task_state');
    for (const attemptId of record.attempts) {
      const state = attempts.attempt(attemptId).state;
      if (!RUNNING_ATTEMPT_STATES.includes(state)) continue;
      // Release the reservation BEFORE the stop rewrites the projected state, exactly like
      // failTask: a task-level stop must free every slot its running attempts hold.
      markRunning(attempts.record(attemptId), false);
      attempts.cancel({ attemptId, code: 'cancelled', field: 'task_cancelled', reason: input.reason ?? null, at });
    }
    record.host.state = 'cancelled';
    record.host.endedAt = at;
    record.updatedAt = at;
    return graph.task(record.taskId);
  }

  /* ------------------------------------------------------------------ the mailbox */

  function postMessage(input = {}) {
    assertOpen();
    const team = requireTeam(input.teamId);
    const at = parseAt(input.at);
    if (typeof input.from !== 'string' || input.from.length === 0 || input.from.length > 128
      || typeof input.to !== 'string' || input.to.length === 0 || input.to.length > 128) {
      throw new CollaborationError('invalid_request', 'mailbox_participant');
    }
    if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > MAX_MAILBOX_TEXT_CHARS) {
      throw new CollaborationError('invalid_request', 'mailbox_text');
    }
    if (team.mailbox.length >= COLLABORATION_BUDGETS.maxMailbox) {
      throw new CollaborationError('conflict', 'collaboration_mailbox', {
        teamId: team.teamId,
        limit: COLLABORATION_BUDGETS.maxMailbox,
      });
    }
    const message = Object.freeze({
      messageId: randomUUID(),
      teamId: team.teamId,
      from: input.from,
      to: input.to,
      text: input.text,
      at,
    });
    team.mailbox.push(message);
    stats.messages += 1;
    return message;
  }

  function mailbox(teamId) {
    assertOpen();
    return Object.freeze([...requireTeam(teamId).mailbox].map(messageView));
  }

  /* ------------------------------------------------------------------ restart */

  /**
   * The restart recovery pass. Every attempt whose outcome is unknowable — delivered but never
   * ended, or accepted but never delivered — is reconciled and RETAINED. Nothing is dispatched:
   * `dispatched` is empty by construction, and the observed dispatch counter does not move. The
   * only path that admits paused work is the explicit `pump()`.
   */
  function restart(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const retained = [];
    for (const view of attempts.attempts()) {
      if (view.state === 'terminal') continue;
      if (view.state !== 'reconcile') {
        const record = attempts.record(view.attemptId);
        attempts.reconcile({
          attemptId: view.attemptId,
          code: 'reconcile_required',
          field: 'collaboration_restart_ambiguous',
          reason: `attempt ${view.attemptId} stopped at ${view.state} before a native end`,
          at,
        });
        markRunning(record, false);
        const taskRecord = graph.record(view.taskId);
        taskRecord.ambiguous = true;
        taskRecord.updatedAt = at;
        stats.reconciles += 1;
      }
      retained.push(Object.freeze({
        taskId: view.taskId,
        attemptId: view.attemptId,
        state: attempts.attempt(view.attemptId).state,
      }));
    }
    rederiveRunning();
    return Object.freeze({
      rehydrated: stats.tasks + stats.attempts,
      retained: Object.freeze(retained),
      dispatched: Object.freeze([]),
      paused: Object.freeze(graph.tasks().filter((view) => view.state === 'paused').map((view) => view.taskId)),
    });
  }

  /* ------------------------------------------------------------------ read models */

  function budgets() {
    assertOpen();
    let maxDepth = 0;
    let maxChildren = 0;
    for (const view of graph.tasks()) {
      maxDepth = Math.max(maxDepth, view.depth);
      maxChildren = Math.max(maxChildren, view.children.length);
    }
    return Object.freeze({
      limits: COLLABORATION_BUDGETS,
      used: Object.freeze({
        concurrency: running.size,
        sessionMutations: sessionRunning.size,
        depth: maxDepth,
        children: maxChildren,
        mailbox: maxMailboxDepth(),
      }),
    });
  }

  function state() {
    return Object.freeze({
      teams: stats.teams,
      tasks: stats.tasks,
      attempts: stats.attempts,
      dispatches: stats.dispatches,
      running: running.size,
      sessionMutations: sessionRunning.size,
      mailbox: stats.messages,
      reconciles: stats.reconciles,
      failures: stats.failures,
      closed,
    });
  }

  function close() {
    closed = true;
    teamsById.clear();
    mailboxes.clear();
    running.clear();
    sessionRunning.clear();
    graph.close();
    attempts.close();
  }

  return {
    createTeam,
    team,
    teams,
    createTask,
    addDependency,
    task,
    tasks,
    dispatch,
    send,
    pump,
    observe,
    observeNativeEnd,
    cancelAttempt,
    attempt,
    attempts: attemptsOf,
    ops,
    registerDeliverable: acceptance.registerDeliverable,
    submitForReview: acceptance.submitForReview,
    review: acceptance.review,
    accept: acceptance.accept,
    reject: acceptance.reject,
    failTask,
    cancelTask,
    postMessage,
    mailbox,
    restart,
    budgets,
    state,
    close,
  };
}
