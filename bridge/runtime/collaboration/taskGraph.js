import { randomUUID } from 'node:crypto';
import {
  BUDGET_REASONS,
  COLLABORATION_BUDGETS,
  CollaborationError,
  parseAt,
  parseCriteria,
  parseLeaseInput,
  parseOwner,
  parseTaskId,
  parseTaskState,
  parseTaskTitle,
  parseTeamId,
} from '../../../shared/runtime/collaboration.js';

/**
 * Canonical Task graph (task 37): the durable Team task DAG.
 *
 * Every task carries its acceptance criteria, its evidence-bearing deliverables, its owner and its
 * lease. Two relations shape the graph:
 *
 *   - `dependsOn` — an ORDERING edge. A dependency blocks: until it is `accepted`, the dependent
 *     reports a derived `blockedBy` and refuses to dispatch. Blocking is DERIVED, exactly like
 *     task 34's `active`: it is never a writable field, so no caller can claim a task is unblocked.
 *   - `parentId` — a DECOMPOSITION edge. It bounds the coordination tree and contributes to depth.
 *
 * The graph is acyclic by construction: an edge that would close a cycle is refused BEFORE anything
 * is written, so the refused edge leaves no trace.
 *
 * Two of the five coordination budgets are structural properties of this graph and are enforced
 * HERE, at the moment the shape is created: depth 4 and children 32. A task that breaks one is
 * still created and still fully visible — it is parked in the `paused` state with the explicit
 * budget reason, never dropped and never dispatched. The other three budgets (concurrency, Session
 * mutation, mailbox) depend on live counters and are enforced by the coordinator at dispatch time.
 */

/** Derived, never written: every dependency not yet `accepted`. Read fresh, so it can never lie. */
function blockedByOf(record, tasksById) {
  return Object.freeze(record.dependsOn.filter((dependency) => {
    const target = tasksById.get(dependency);
    return target === undefined || target.host.state !== 'accepted';
  }));
}

function taskView(record, tasksById) {
  return Object.freeze({
    taskId: record.taskId,
    teamId: record.teamId,
    parentId: record.parentId,
    title: record.title,
    depth: record.depth,
    state: parseTaskState(record.host.state),
    criteria: record.criteria,
    dependsOn: record.dependsOn,
    children: record.children,
    owner: record.owner,
    lease: record.lease,
    blockedBy: blockedByOf(record, tasksById),
    paused: record.paused,
    ambiguous: record.ambiguous,
    attempts: Object.freeze([...record.attempts]),
    review: Object.freeze({ ...record.review }),
    acceptance: Object.freeze({
      state: record.acceptance.state,
      acceptedBy: record.acceptance.acceptedBy,
      acceptedAt: record.acceptance.acceptedAt,
      deliverableId: record.acceptance.deliverableId,
      criteria: Object.freeze([...record.acceptance.criteria]),
    }),
    deliverables: Object.freeze([...record.deliverables]),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createTaskGraph() {
  /** taskId → the live task record. Slices are disjoint: the Host slice is written here, the
   *  review/acceptance/deliverable slices are written only through the acceptance sink. */
  const tasksById = new Map();
  /** teamId → taskId[], in creation order, so a team's task list is stable. */
  const taskIdsByTeam = new Map();
  const knownTeams = new Set();

  function requireRecord(taskId) {
    const record = tasksById.get(parseTaskId(taskId));
    if (record === undefined) throw new CollaborationError('invalid_request', 'task_unknown');
    return record;
  }

  function registerTeam(teamId) {
    const id = parseTeamId(teamId);
    if (knownTeams.has(id)) throw new CollaborationError('conflict', 'team_duplicate');
    knownTeams.add(id);
    if (!taskIdsByTeam.has(id)) taskIdsByTeam.set(id, []);
  }

  /** Reachability over BOTH edge kinds, so a mixed parent/dependency cycle is caught too. */
  function reachable(from, target) {
    const seen = new Set();
    const pending = [from];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const record = tasksById.get(current);
      if (record === undefined) continue;
      pending.push(...record.dependsOn);
      if (record.parentId !== null) pending.push(record.parentId);
    }
    return false;
  }

  /**
   * Longest-path depth over both edge kinds. Memoized and cycle-guarded: a graph that somehow
   * became cyclic is refused here rather than looping forever.
   */
  function computeDepths() {
    const memo = new Map();
    const visiting = new Set();
    const depthOf = (taskId) => {
      const cached = memo.get(taskId);
      if (cached !== undefined) return cached;
      if (visiting.has(taskId)) throw new CollaborationError('conflict', 'task_cycle');
      visiting.add(taskId);
      const record = tasksById.get(taskId);
      let depth = 1;
      if (record !== undefined) {
        const predecessors = record.parentId === null ? [...record.dependsOn] : [...record.dependsOn, record.parentId];
        for (const predecessor of predecessors) {
          if (!tasksById.has(predecessor)) continue;
          depth = Math.max(depth, depthOf(predecessor) + 1);
        }
      }
      visiting.delete(taskId);
      memo.set(taskId, depth);
      return depth;
    };
    for (const taskId of tasksById.keys()) depthOf(taskId);
    return memo;
  }

  /** Shape budgets, in BUDGET_REASONS order. Only the child that OVERFLOWS its parent is parked. */
  function shapeReasons(record) {
    const reasons = [];
    if (record.depth > COLLABORATION_BUDGETS.maxDepth) reasons.push('collaboration_depth');
    if (record.parentId !== null) {
      const parent = tasksById.get(record.parentId);
      if (parent !== undefined && parent.children.indexOf(record.taskId) >= COLLABORATION_BUDGETS.maxChildren) {
        reasons.push('collaboration_children');
      }
    }
    return reasons;
  }

  /**
   * Re-derive every depth and every shape pause. A pause is only ever WRITTEN here from the two
   * structural budgets, so a task can never be paused by a caller's say-so.
   */
  function refreshShape() {
    const depths = computeDepths();
    for (const record of tasksById.values()) {
      const next = depths.get(record.taskId);
      if (next !== undefined) record.depth = next;
      const reasons = shapeReasons(record);
      if (reasons.length > 0) {
        record.paused = Object.freeze({ reasons: Object.freeze(reasons), at: record.updatedAt });
        if (record.host.state !== 'dispatched' && record.host.state !== 'review') record.host.state = 'paused';
      } else if (record.paused !== null && record.paused.reasons.every((reason) => BUDGET_REASONS.includes(reason))
        && record.host.state === 'paused') {
        record.paused = null;
        record.host.state = 'pending';
      }
    }
  }

  function attachChild(parentId, childId) {
    const parent = tasksById.get(parentId);
    if (parent === undefined) throw new CollaborationError('invalid_request', 'task_parent');
    parent.children = Object.freeze([...parent.children, childId]);
  }

  function createTask(input = {}) {
    if (input === null || typeof input !== 'object') throw new CollaborationError('invalid_request', 'task_input');
    const teamId = parseTeamId(input.teamId);
    if (!taskIdsByTeam.has(teamId)) throw new CollaborationError('invalid_request', 'team_unknown');
    const title = parseTaskTitle(input.title);
    const criteria = parseCriteria(input.criteria);
    const owner = parseOwner(input.owner);
    const leaseInput = parseLeaseInput(input.lease);
    const at = parseAt(input.at);
    const parentId = input.parentId === undefined || input.parentId === null ? null : parseTaskId(input.parentId);
    if (parentId !== null && !tasksById.has(parentId)) throw new CollaborationError('invalid_request', 'task_parent');

    const taskId = input.taskId === undefined ? randomUUID() : parseTaskId(input.taskId);
    if (tasksById.has(taskId)) throw new CollaborationError('conflict', 'task_duplicate');

    const dependsOn = [];
    if (input.dependsOn !== undefined && input.dependsOn !== null) {
      if (!Array.isArray(input.dependsOn)) throw new CollaborationError('invalid_request', 'task_dependency');
      for (const entry of input.dependsOn) {
        const dependency = parseTaskId(entry);
        if (!tasksById.has(dependency)) throw new CollaborationError('invalid_request', 'task_unknown');
        if (dependency === taskId || reachable(dependency, taskId)) {
          throw new CollaborationError('conflict', 'task_cycle');
        }
        if (dependsOn.includes(dependency)) throw new CollaborationError('conflict', 'task_dependency');
        dependsOn.push(dependency);
      }
    }

    const record = {
      taskId,
      teamId,
      parentId,
      title,
      criteria,
      dependsOn: Object.freeze([...dependsOn]),
      children: Object.freeze([]),
      owner,
      lease: Object.freeze({
        leaseId: randomUUID(),
        ownerId: leaseInput.ownerId,
        grantedAt: at,
        expiresAt: leaseInput.expiresAt,
      }),
      depth: 1,
      host: { state: 'pending', dispatchedAt: null, endedAt: null },
      paused: null,
      ambiguous: false,
      attempts: [],
      review: { state: 'none', reviewer: null, reason: null, at: null },
      acceptance: { state: 'none', acceptedBy: null, acceptedAt: null, deliverableId: null, criteria: [] },
      deliverables: [],
      createdAt: at,
      updatedAt: at,
    };
    tasksById.set(taskId, record);
    const teamTasks = taskIdsByTeam.get(teamId);
    if (teamTasks === undefined) taskIdsByTeam.set(teamId, [taskId]);
    else teamTasks.push(taskId);
    if (parentId !== null) attachChild(parentId, taskId);
    refreshShape();
    return taskView(record, tasksById);
  }

  /**
   * Add one ordering edge. The cycle check runs BEFORE anything is written, so a refused edge
   * leaves the graph byte-identical; a duplicate edge is a conflict, never a second copy.
   */
  function addDependency(input = {}) {
    const record = requireRecord(input.taskId);
    const dependency = parseTaskId(input.dependsOn);
    const at = parseAt(input.at);
    if (!tasksById.has(dependency)) throw new CollaborationError('invalid_request', 'task_unknown');
    if (dependency === record.taskId || reachable(dependency, record.taskId)) {
      throw new CollaborationError('conflict', 'task_cycle');
    }
    if (record.dependsOn.includes(dependency)) throw new CollaborationError('conflict', 'task_dependency');
    record.dependsOn = Object.freeze([...record.dependsOn, dependency]);
    record.updatedAt = at;
    refreshShape();
    return taskView(record, tasksById);
  }

  function task(taskId) {
    return taskView(requireRecord(taskId), tasksById);
  }

  function tasks(teamId) {
    if (teamId === undefined) return Object.freeze([...tasksById.values()].map((entry) => taskView(entry, tasksById)));
    const ids = taskIdsByTeam.get(parseTeamId(teamId)) ?? [];
    return Object.freeze(ids.map((taskId) => taskView(tasksById.get(taskId), tasksById)));
  }

  function depthOf(taskId) {
    return requireRecord(taskId).depth;
  }

  function childrenOf(taskId) {
    return requireRecord(taskId).children;
  }

  function blockedBy(taskId) {
    return blockedByOf(requireRecord(taskId), tasksById);
  }

  /** The LIVE record. Internal: every consumer must write through a narrow sink, never directly. */
  function record(taskId) {
    return requireRecord(taskId);
  }

  function has(taskId) {
    return tasksById.has(parseTaskId(taskId));
  }

  function close() {
    tasksById.clear();
    taskIdsByTeam.clear();
    knownTeams.clear();
  }

  return {
    createTask,
    addDependency,
    task,
    tasks,
    depthOf,
    childrenOf,
    blockedBy,
    record,
    has,
    registerTeam,
    close,
  };
}
