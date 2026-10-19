import { randomUUID } from 'node:crypto';
import {
  COLLABORATION_BUDGETS,
  CollaborationError,
  MAX_DELIVERABLES,
  parseAt,
  parseCriteria,
  parseDeliverable,
  parseTaskId,
  parseTaskTitle,
  parseTeamId,
  parseTeamName,
} from '../../../shared/runtime/collaboration.js';
import { encodeSessionKey, parseSessionRef } from '../../../shared/runtime/identity.js';
import { HARNESS_KINDS } from '../../../shared/runtime/harnessContract.js';
import { createMailbox } from './mailbox.js';

/**
 * Lead/Worker delegation (task 39): a Lead delegates scoped work to a Worker of ANY harness, the
 * worker attaches hash-identified evidence, and the lead reads it back. Five tools — delegate,
 * status, message, evidence, control — are dispatched through this service by the tool server.
 *
 * The load-bearing guarantees are enforced by CONSTRUCTION, not by condition:
 *
 *   - ROLE SCOPES ARE DISJOINT OBJECTS. `addMember` mints a frozen handle registered in an internal
 *     map and returns a role scope whose method set cannot reach the other role's operations: a
 *     lead scope has delegate/readEvidence/control, a worker scope has submitEvidence, and neither
 *     has the other's. A hand-forged object is not in the map, so it resolves to nothing. The
 *     service functions re-check the role as defence in depth, but the scope TYPE is the guarantee.
 *
 *   - THE BUDGET GATE RUNS BEFORE ANYTHING IS CREATED, in task 37's BUDGET_REASONS order, and every
 *     refusal carries the REAL numbers (running/limit, children/limit, depth/limit, used/limit).
 *     The limits themselves are task 37's frozen `COLLABORATION_BUDGETS` object, reused by
 *     identity — never a second literal.
 *
 *   - EVERY TERMINAL PATH TERMINATES. succeeded / failed / cancelled / timeout / ambiguous are the
 *     only exits; control cascades DOWN the whole subtree recording the cancelling ancestor, the
 *     timeout sweep retires deadlines, and reconcile retains every unresolved delegation without
 *     dispatching anything. A child's non-success cascades UP only through a parent whose
 *     `childFailure` policy was RECORDED as `cascade` at delegate time.
 *
 * This service records the worker's outcome claim and its evidence. It deliberately does NOT
 * implement review or acceptance — task 37's acceptance path owns `accepted`, and a worker's
 * `succeeded` claim is exactly that: a claim, never an acceptance.
 */

/** The two team roles. A member holds exactly one. */
export const DELEGATION_ROLES = Object.freeze(['lead', 'worker']);
/** The task lifecycle. Every value except `delegated` is terminal. */
export const DELEGATION_TASK_STATES = Object.freeze([
  'delegated', 'succeeded', 'failed', 'cancelled', 'timeout', 'ambiguous',
]);
const TERMINAL_TASK_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'timeout', 'ambiguous']);
const CHILD_FAILURE_POLICIES = Object.freeze(['cascade', 'independent']);
const SUBMIT_OUTCOMES = Object.freeze(['succeeded', 'failed']);
const MAX_PROMPT_CHARS = 32768;
const MAX_TIMEOUT_MS = 86400000;
const MAX_REASON_CHARS = 512;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

function parseParticipantId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CollaborationError('invalid_request', 'delegation_participant');
  }
  return value.toLowerCase();
}

function parseRole(value) {
  if (!DELEGATION_ROLES.includes(value)) throw new CollaborationError('invalid_request', 'delegation_role_input');
  return value;
}

function parseHarnessKind(value) {
  if (typeof value !== 'string' || !HARNESS_KINDS.includes(value)) {
    throw new CollaborationError('invalid_request', 'delegation_harness');
  }
  return value;
}

function parsePrompt(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROMPT_CHARS) {
    throw new CollaborationError('invalid_request', 'delegation_prompt', {
      length: typeof value === 'string' ? value.length : null,
      limit: MAX_PROMPT_CHARS,
    });
  }
  return value;
}

function parseTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new CollaborationError('invalid_request', 'delegation_timeout', { limit: MAX_TIMEOUT_MS });
  }
  return value;
}

function parseChildFailure(value) {
  if (!CHILD_FAILURE_POLICIES.includes(value)) {
    throw new CollaborationError('invalid_request', 'delegation_child_failure');
  }
  return value;
}

function parseOutcome(value) {
  if (!SUBMIT_OUTCOMES.includes(value)) throw new CollaborationError('invalid_request', 'delegation_outcome');
  return value;
}

function parseAction(value) {
  if (value !== 'cancel' && value !== 'timeout') {
    throw new CollaborationError('invalid_request', 'delegation_action');
  }
  return value;
}

function parseReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REASON_CHARS) {
    throw new CollaborationError('invalid_request', 'delegation_reason', { limit: MAX_REASON_CHARS });
  }
  return value;
}

function classifyFailure(error, fallback) {
  if (error instanceof CollaborationError) return { code: error.code, field: error.field };
  return fallback;
}

/* ------------------------------------------------------------------ read models */

function memberView(member) {
  return Object.freeze({
    memberId: member.memberId,
    teamId: member.teamId,
    participantId: member.participantId,
    role: member.role,
    harnessKind: member.harnessKind,
    session: member.session,
    sessionKey: member.sessionKey,
    joinedAt: member.joinedAt,
  });
}

function teamView(team) {
  return Object.freeze({
    teamId: team.teamId,
    name: team.name,
    memberCount: team.memberIds.length,
    taskCount: team.taskIds.length,
    mailboxDepth: team.mailboxDepth(),
    createdAt: team.createdAt,
  });
}

function taskView(task) {
  return Object.freeze({
    taskId: task.taskId,
    teamId: task.teamId,
    parentId: task.parentId,
    title: task.title,
    criteria: task.criteria,
    depth: task.depth,
    state: task.state,
    delegatedTo: task.delegatedTo,
    delegatedBy: task.delegatedBy,
    workerHarnessKind: task.workerHarnessKind,
    leadHarnessKind: task.leadHarnessKind,
    prompt: task.prompt,
    timeoutMs: task.timeoutMs,
    deadlineAt: task.deadlineAt,
    childFailure: task.childFailure,
    children: Object.freeze([...task.children]),
    evidence: Object.freeze([...task.evidence]),
    resolution: task.resolution,
    endedBy: task.endedBy,
    reason: task.reason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    endedAt: task.endedAt,
  });
}

/* ------------------------------------------------------------------ the service */

export function createDelegationService({ deliver, mailbox: injectedMailbox } = {}) {
  if (deliver !== undefined && typeof deliver !== 'function') {
    throw new CollaborationError('invalid_request', 'delegation_deliver');
  }
  if (injectedMailbox !== undefined && (injectedMailbox === null || typeof injectedMailbox !== 'object')) {
    throw new CollaborationError('invalid_request', 'delegation_mailbox');
  }
  const deliverPrompt = deliver ?? (async () => ({ ackId: `ack-${randomUUID()}` }));
  const mailbox = injectedMailbox ?? createMailbox();

  /** teamId → { teamId, name, environmentId, createdAt, memberIds, taskIds, mailboxDepth }. */
  const teamsById = new Map();
  /** memberId → the live member record. */
  const membersById = new Map();
  /** taskId → the live task record. */
  const tasksById = new Map();
  /** minted scope handle → its resolution. A forged object is never a key here. */
  const scopes = new Map();
  const stats = {
    teams: 0,
    members: 0,
    tasks: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timeouts: 0,
    ambiguous: 0,
    reconciles: 0,
  };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'delegation_service_closed');
  }

  function requireTeam(teamId) {
    const team = teamsById.get(parseTeamId(teamId));
    if (team === undefined) throw new CollaborationError('invalid_request', 'team_unknown', { teamId: parseTeamId(teamId) });
    return team;
  }

  function requireTask(taskId) {
    const task = tasksById.get(parseTaskId(taskId));
    if (task === undefined) {
      throw new CollaborationError('invalid_request', 'delegation_task_unknown', { taskId: parseTaskId(taskId) });
    }
    return task;
  }

  /** A task is only reachable inside the caller's own team. */
  function requireTaskInTeam(taskId, teamId) {
    const task = requireTask(taskId);
    if (task.teamId !== teamId) {
      throw new CollaborationError('unauthorized', 'delegation_scope', { taskId: task.taskId, teamId: task.teamId });
    }
    return task;
  }

  function requireMember(memberId) {
    const member = membersById.get(memberId);
    if (member === undefined) {
      throw new CollaborationError('invalid_request', 'delegation_member_unknown', { memberId });
    }
    return member;
  }

  function requireWorker(team, participantId) {
    const id = parseParticipantId(participantId);
    const member = team.memberIds.map((memberId) => membersById.get(memberId))
      .find((entry) => entry.participantId === id);
    if (member !== undefined) {
      if (member.role !== 'worker') {
        throw new CollaborationError('unauthorized', 'delegation_role', { teamId: team.teamId, participantId: id, role: member.role });
      }
      return member;
    }
    // Not a member of THIS team: a participant that exists in another team is a scope violation,
    // a participant that exists nowhere is simply unknown.
    const elsewhere = [...membersById.values()].find((entry) => entry.participantId === id);
    if (elsewhere !== undefined) {
      throw new CollaborationError('unauthorized', 'delegation_scope', { participantId: id, teamId: elsewhere.teamId });
    }
    throw new CollaborationError('invalid_request', 'delegation_worker_unknown', { teamId: team.teamId, participantId: id });
  }

  function requireRole(resolved, role) {
    if (resolved.role !== role) {
      throw new CollaborationError('unauthorized', 'delegation_role', { role: resolved.role, required: role });
    }
  }

  /* ------------------------------------------------------------------ scopes */

  function mintScope(member) {
    const handle = Object.freeze({
      role: member.role,
      teamId: member.teamId,
      participantId: member.participantId,
      memberId: member.memberId,
    });
    scopes.set(handle, {
      role: member.role,
      teamId: member.teamId,
      participantId: member.participantId,
      memberId: member.memberId,
    });
    return handle;
  }

  /**
   * Resolve a scope. Only service-minted objects resolve — both the internal handle and the role
   * scope bundle the caller holds — so a hand-forged object resolves to nothing.
   */
  function resolveScope(scope) {
    const resolved = scopes.get(scope);
    if (resolved === undefined) throw new CollaborationError('invalid_request', 'delegation_scope');
    return resolved;
  }

  function roleScope(role, handle) {
    const resolution = scopes.get(handle);
    if (role === 'lead') {
      const bundle = Object.freeze({
        delegate: (input) => delegate(handle, input),
        readEvidence: (input) => readEvidence(handle, input),
        control: (input) => control(handle, input),
        status: (input) => status(handle, input),
        message: (input) => message(handle, input),
      });
      scopes.set(bundle, resolution);
      return bundle;
    }
    const bundle = Object.freeze({
      submitEvidence: (input) => submitEvidence(handle, input),
      status: (input) => status(handle, input),
      message: (input) => message(handle, input),
    });
    scopes.set(bundle, resolution);
    return bundle;
  }

  /* ------------------------------------------------------------------ teams and members */

  function createTeam(input = {}) {
    assertOpen();
    const name = parseTeamName(input.name);
    const at = parseAt(input.at);
    const teamId = input.teamId === undefined ? randomUUID() : parseTeamId(input.teamId);
    if (teamsById.has(teamId)) throw new CollaborationError('conflict', 'team_duplicate', { teamId });
    // The mailbox team is opened first, so a shared mailbox that already knows this team refuses
    // the delegation service before anything is created here.
    mailbox.openTeam({ teamId, at });
    const team = {
      teamId,
      name,
      environmentId: null,
      createdAt: at,
      memberIds: [],
      taskIds: [],
      mailboxDepth: () => mailbox.depth(teamId),
    };
    teamsById.set(teamId, team);
    stats.teams += 1;
    return teamView(team);
  }

  function team(teamId) {
    assertOpen();
    return teamView(requireTeam(teamId));
  }

  function teams() {
    assertOpen();
    return Object.freeze([...teamsById.values()].map(teamView));
  }

  function addMember(input = {}) {
    assertOpen();
    const team = requireTeam(input.teamId);
    const at = parseAt(input.at);
    const participantId = parseParticipantId(input.participantId);
    const role = parseRole(input.role);
    const harnessKind = parseHarnessKind(input.harnessKind);
    let session;
    try {
      session = parseSessionRef(input.session);
    } catch (error) {
      if (error instanceof TypeError) throw new CollaborationError('invalid_request', 'delegation_session');
      throw error;
    }
    if (team.memberIds.some((memberId) => membersById.get(memberId).participantId === participantId)) {
      throw new CollaborationError('conflict', 'delegation_participant', { teamId: team.teamId, participantId });
    }
    // The team's environment is fixed by its FIRST member; a later member from another
    // environment is refused with both real ids.
    if (team.environmentId === null) team.environmentId = session.environmentId;
    else if (team.environmentId !== session.environmentId) {
      throw new CollaborationError('conflict', 'delegation_environment', {
        expected: team.environmentId,
        observed: session.environmentId,
      });
    }
    const member = {
      memberId: randomUUID(),
      teamId: team.teamId,
      participantId,
      role,
      harnessKind,
      session,
      sessionKey: encodeSessionKey(session),
      joinedAt: at,
    };
    membersById.set(member.memberId, member);
    team.memberIds.push(member.memberId);
    mailbox.addParticipant({ teamId: team.teamId, participantId, at });
    stats.members += 1;
    const handle = mintScope(member);
    return Object.freeze({ member: memberView(member), scope: roleScope(role, handle) });
  }

  function member(memberId) {
    assertOpen();
    return memberView(requireMember(memberId));
  }

  function members(teamId) {
    assertOpen();
    const team = requireTeam(teamId);
    return Object.freeze(team.memberIds.map((id) => memberView(membersById.get(id))));
  }

  /* ------------------------------------------------------------------ budgets */

  function inFlightTasks() {
    return [...tasksById.values()].filter((task) => !TERMINAL_TASK_STATES.includes(task.state));
  }

  /**
   * The budget gate, in task 37's BUDGET_REASONS order, computed FRESH from the task records —
   * never from a remembered counter — and run before anything is created.
   */
  function budgetRefusal(team, parent, workerSessionKey) {
    const inFlight = inFlightTasks();
    if (inFlight.length >= COLLABORATION_BUDGETS.maxConcurrency) {
      return new CollaborationError('conflict', 'collaboration_concurrency', {
        running: inFlight.length,
        limit: COLLABORATION_BUDGETS.maxConcurrency,
      });
    }
    if (inFlight.some((task) => task.workerSessionKey === workerSessionKey)) {
      return new CollaborationError('conflict', 'collaboration_session_mutation', {
        sessionKey: workerSessionKey,
        limit: COLLABORATION_BUDGETS.maxSessionMutations,
      });
    }
    if (parent !== null) {
      const depth = parent.depth + 1;
      if (depth > COLLABORATION_BUDGETS.maxDepth) {
        return new CollaborationError('conflict', 'collaboration_depth', {
          depth,
          limit: COLLABORATION_BUDGETS.maxDepth,
        });
      }
      if (parent.children.length >= COLLABORATION_BUDGETS.maxChildren) {
        return new CollaborationError('conflict', 'collaboration_children', {
          parentTaskId: parent.taskId,
          children: parent.children.length,
          limit: COLLABORATION_BUDGETS.maxChildren,
        });
      }
    }
    const used = mailbox.depth(team.teamId);
    if (used >= COLLABORATION_BUDGETS.maxMailbox) {
      return new CollaborationError('conflict', 'collaboration_mailbox', {
        teamId: team.teamId,
        limit: COLLABORATION_BUDGETS.maxMailbox,
        used,
      });
    }
    return null;
  }

  function budgets() {
    assertOpen();
    const inFlight = inFlightTasks();
    const sessions = new Set(inFlight.map((task) => task.workerSessionKey));
    let depth = 0;
    let children = 0;
    for (const task of tasksById.values()) {
      depth = Math.max(depth, task.depth);
      children = Math.max(children, task.children.length);
    }
    let mailboxDepth = 0;
    for (const team of teamsById.values()) mailboxDepth = Math.max(mailboxDepth, team.mailboxDepth());
    return Object.freeze({
      limits: COLLABORATION_BUDGETS,
      used: Object.freeze({
        concurrency: inFlight.length,
        sessionMutations: sessions.size,
        depth,
        children,
        mailbox: mailboxDepth,
      }),
    });
  }

  /* ------------------------------------------------------------------ settlement */

  function settle(task, state, at, resolution, endedBy, reason) {
    task.state = state;
    task.resolution = resolution === null ? null : Object.freeze({ ...resolution });
    task.endedBy = endedBy === null ? null : Object.freeze({ ...endedBy });
    task.reason = reason === null ? null : reason;
    task.endedAt = at;
    task.updatedAt = at;
  }

  function countTerminal(state) {
    if (state === 'succeeded') stats.succeeded += 1;
    else if (state === 'failed') stats.failed += 1;
    else if (state === 'cancelled') stats.cancelled += 1;
    else if (state === 'timeout') stats.timeouts += 1;
    else if (state === 'ambiguous') stats.ambiguous += 1;
  }

  /**
   * Walk UP from a task that settled non-successfully, settling each ancestor whose RECORDED
   * childFailure policy is `cascade`. The walk stops at the first `independent` or terminal
   * ancestor, so it is bounded by the depth-4 limit and always terminates.
   */
  function cascadeUp(task, state, at) {
    const cascaded = [];
    let current = task;
    while (current.parentId !== null) {
      const parent = tasksById.get(current.parentId);
      if (parent === undefined || TERMINAL_TASK_STATES.includes(parent.state)) break;
      if (parent.childFailure !== 'cascade') break;
      settle(parent, state, at, { code: 'delegation_failed', field: 'delegation_child_failure' },
        { taskId: current.taskId, action: `child-${state}`, at }, null);
      countTerminal(state);
      cascaded.push(parent.taskId);
      current = parent;
    }
    return cascaded;
  }

  /* ------------------------------------------------------------------ delegate */

  async function delegate(scope, input = {}) {
    assertOpen();
    const resolved = resolveScope(scope);
    requireRole(resolved, 'lead');
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'delegation_input');
    }
    const at = parseAt(input.at);
    const title = parseTaskTitle(input.title);
    const criteria = parseCriteria(input.criteria);
    const prompt = typeof input.prompt === 'string' && input.prompt.length > 0 ? parsePrompt(input.prompt) : title;
    const timeoutMs = input.timeoutMs === undefined || input.timeoutMs === null ? null : parseTimeoutMs(input.timeoutMs);
    const childFailure = input.childFailure === undefined ? 'independent' : parseChildFailure(input.childFailure);
    const parentId = input.parentTaskId === undefined || input.parentTaskId === null ? null : parseTaskId(input.parentTaskId);
    const team = requireTeam(resolved.teamId);
    const lead = requireMember(resolved.memberId);
    const worker = requireWorker(team, input.workerParticipantId);
    const parent = parentId === null ? null : requireTaskInTeam(parentId, team.teamId);

    const refusal = budgetRefusal(team, parent, worker.sessionKey);
    if (refusal !== null) throw refusal;

    const task = {
      taskId: randomUUID(),
      teamId: team.teamId,
      parentId,
      title,
      criteria,
      depth: parent === null ? 1 : parent.depth + 1,
      state: 'delegated',
      delegatedTo: worker.participantId,
      delegatedBy: resolved.participantId,
      workerHarnessKind: worker.harnessKind,
      leadHarnessKind: lead.harnessKind,
      prompt,
      timeoutMs,
      deadlineAt: timeoutMs === null ? null : at + timeoutMs,
      childFailure,
      children: [],
      evidence: [],
      resolution: null,
      endedBy: null,
      reason: null,
      workerSessionKey: worker.sessionKey,
      createdAt: at,
      updatedAt: at,
      endedAt: null,
    };
    tasksById.set(task.taskId, task);
    team.taskIds.push(task.taskId);
    if (parent !== null) parent.children.push(task.taskId);
    stats.tasks += 1;

    // The deliver outcome is written to THIS task only; a failure never touches a sibling.
    let result;
    try {
      result = await deliverPrompt({
        taskId: task.taskId,
        teamId: task.teamId,
        participantId: worker.participantId,
        harnessKind: worker.harnessKind,
        session: worker.session,
        prompt,
      });
    } catch (error) {
      const failure = classifyFailure(error, { code: 'source_unavailable', field: 'delegation_send' });
      settle(task, 'failed', at, failure, null, null);
      countTerminal('failed');
      return taskView(task);
    }
    const ackId = result !== null && typeof result === 'object' ? result.ackId : undefined;
    if (typeof ackId !== 'string' || ackId.length === 0) {
      // An unreadable outcome is a STOP at ambiguous: retained, never retried by this service.
      settle(task, 'ambiguous', at, { code: 'reconcile_required', field: 'delegation_ambiguous' }, null, null);
      countTerminal('ambiguous');
      return taskView(task);
    }
    try {
      mailbox.post({
        teamId: team.teamId,
        from: resolved.participantId,
        to: worker.participantId,
        text: `delegated ${task.taskId}: ${title}`,
        at,
      });
    } catch (error) {
      const failure = classifyFailure(error, { code: 'source_unavailable', field: 'delegation_notice' });
      settle(task, 'failed', at, failure, null, null);
      countTerminal('failed');
    }
    return taskView(task);
  }

  function task(taskId) {
    assertOpen();
    return taskView(requireTask(taskId));
  }

  function tasks(teamId) {
    assertOpen();
    const team = requireTeam(teamId);
    return Object.freeze(team.taskIds.map((id) => taskView(tasksById.get(id))));
  }

  /* ------------------------------------------------------------------ evidence */

  function submitEvidence(scope, input = {}) {
    assertOpen();
    const resolved = resolveScope(scope);
    requireRole(resolved, 'worker');
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'delegation_input');
    }
    const at = parseAt(input.at);
    const task = requireTaskInTeam(input.taskId, resolved.teamId);
    if (task.delegatedTo !== resolved.participantId) {
      throw new CollaborationError('unauthorized', 'delegation_scope', {
        taskId: task.taskId,
        participantId: resolved.participantId,
      });
    }
    if (TERMINAL_TASK_STATES.includes(task.state)) {
      throw new CollaborationError('conflict', 'delegation_state', { taskId: task.taskId, state: task.state });
    }
    const outcome = parseOutcome(input.outcome);
    if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > MAX_DELIVERABLES) {
      throw new CollaborationError('invalid_request', 'delegation_evidence', { limit: MAX_DELIVERABLES });
    }
    const evidence = input.evidence.map((entry) => parseDeliverable(entry));
    task.evidence = evidence;
    const reason = parseReason(input.reason);
    if (outcome === 'succeeded') {
      // A worker's success is a CLAIM with evidence attached, never a task acceptance.
      settle(task, 'succeeded', at, null, null, null);
      countTerminal('succeeded');
      return taskView(task);
    }
    settle(task, 'failed', at, { code: 'delegation_failed', field: 'delegation_outcome' }, null, reason);
    countTerminal('failed');
    cascadeUp(task, 'failed', at);
    return taskView(task);
  }

  function readEvidence(scope, input = {}) {
    assertOpen();
    const resolved = resolveScope(scope);
    requireRole(resolved, 'lead');
    const task = requireTaskInTeam(input.taskId, resolved.teamId);
    return Object.freeze({ taskId: task.taskId, evidence: Object.freeze([...task.evidence]) });
  }

  /* ------------------------------------------------------------------ status and messages */

  function status(scope, input = {}) {
    assertOpen();
    const resolved = resolveScope(scope);
    const team = requireTeam(resolved.teamId);
    let taskId = null;
    let visible;
    if (input.taskId === undefined || input.taskId === null) {
      visible = resolved.role === 'lead'
        ? team.taskIds.map((id) => tasksById.get(id))
        : team.taskIds.map((id) => tasksById.get(id)).filter((entry) => entry.delegatedTo === resolved.participantId);
    } else {
      const entry = requireTaskInTeam(input.taskId, team.teamId);
      if (resolved.role === 'worker' && entry.delegatedTo !== resolved.participantId) {
        throw new CollaborationError('unauthorized', 'delegation_scope', {
          taskId: entry.taskId,
          participantId: resolved.participantId,
        });
      }
      taskId = entry.taskId;
      visible = [entry];
    }
    return Object.freeze({
      role: resolved.role,
      teamId: team.teamId,
      participantId: resolved.participantId,
      taskId,
      tasks: Object.freeze(visible.map(taskView)),
      mailboxDepth: team.mailboxDepth(),
      budgets: budgets(),
    });
  }

  function message(scope, input = {}) {
    assertOpen();
    const resolved = resolveScope(scope);
    const team = requireTeam(resolved.teamId);
    return mailbox.post({
      teamId: team.teamId,
      from: resolved.participantId,
      to: input.to,
      text: input.text,
      parentMessageId: input.parentMessageId ?? null,
      at: input.at,
    });
  }

  /* ------------------------------------------------------------------ control */

  function control(scope, input = {}) {
    assertOpen();
    const resolved = resolveScope(scope);
    requireRole(resolved, 'lead');
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'delegation_input');
    }
    const at = parseAt(input.at);
    const action = parseAction(input.action);
    const team = requireTeam(resolved.teamId);
    const target = requireTaskInTeam(input.taskId, team.teamId);
    const state = action === 'cancel' ? 'cancelled' : 'timeout';
    const resolution = action === 'cancel'
      ? { code: 'cancelled', field: 'delegation_cancel' }
      : { code: 'timeout', field: 'delegation_timeout' };
    const transitioned = [];
    const skipped = [];
    // Cascade DOWN the whole subtree, breadth-first: every non-terminal descendant settles with
    // the cancelling ancestor recorded, and an already-terminal task is skipped, never re-settled.
    const queue = [target];
    const seen = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current.taskId)) continue;
      seen.add(current.taskId);
      // The subtree is WALKED even through already-terminal tasks, so `skipped` reports every
      // task the cascade found settled rather than silently stopping at the first one.
      for (const childId of current.children) {
        const child = tasksById.get(childId);
        if (child !== undefined) queue.push(child);
      }
      if (TERMINAL_TASK_STATES.includes(current.state)) {
        skipped.push(current.taskId);
        continue;
      }
      settle(current, state, at, resolution, { taskId: target.taskId, action, at }, parseReason(input.reason));
      countTerminal(state);
      transitioned.push(current.taskId);
    }
    // The target's own parent reacts only through its recorded policy.
    for (const taskId of cascadeUp(target, state, at)) transitioned.push(taskId);
    return Object.freeze({
      action,
      taskId: target.taskId,
      transitioned: Object.freeze(transitioned),
      skipped: Object.freeze(skipped),
      count: transitioned.length,
    });
  }

  /** Retire every non-terminal delegation whose deadline has passed. */
  function sweep(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const timedOut = [];
    for (const task of tasksById.values()) {
      if (TERMINAL_TASK_STATES.includes(task.state)) continue;
      if (task.deadlineAt === null || task.deadlineAt > at) continue;
      settle(task, 'timeout', at, { code: 'timeout', field: 'delegation_timeout' },
        { taskId: task.taskId, action: 'timeout', at }, null);
      countTerminal('timeout');
      timedOut.push(task.taskId);
      for (const taskId of cascadeUp(task, 'timeout', at)) timedOut.push(taskId);
    }
    return Object.freeze({ timedOut: Object.freeze(timedOut), count: timedOut.length });
  }

  /**
   * The restart recovery pass. Every unresolved delegation is retained as `ambiguous`; nothing is
   * re-dispatched, so a restart can never turn one delegation into two.
   */
  function reconcile(input = {}) {
    assertOpen();
    const at = parseAt(input.at);
    const retained = [];
    for (const task of tasksById.values()) {
      if (TERMINAL_TASK_STATES.includes(task.state)) continue;
      settle(task, 'ambiguous', at, { code: 'reconcile_required', field: 'delegation_restart_ambiguous' }, null, null);
      countTerminal('ambiguous');
      stats.reconciles += 1;
      retained.push(Object.freeze({ taskId: task.taskId, state: task.state }));
    }
    return Object.freeze({ retained: Object.freeze(retained), dispatched: Object.freeze([]) });
  }

  /* ------------------------------------------------------------------ state */

  function state() {
    return Object.freeze({
      teams: stats.teams,
      members: stats.members,
      tasks: stats.tasks,
      inFlight: inFlightTasks().length,
      succeeded: stats.succeeded,
      failed: stats.failed,
      cancelled: stats.cancelled,
      timeouts: stats.timeouts,
      ambiguous: stats.ambiguous,
      reconciles: stats.reconciles,
      closed,
    });
  }

  function close() {
    closed = true;
    teamsById.clear();
    membersById.clear();
    tasksById.clear();
    scopes.clear();
    mailbox.close();
  }

  return {
    createTeam,
    team,
    teams,
    addMember,
    member,
    members,
    delegate,
    task,
    tasks,
    submitEvidence,
    readEvidence,
    status,
    message,
    control,
    sweep,
    reconcile,
    resolveScope,
    budgets,
    state,
    close,
  };
}
