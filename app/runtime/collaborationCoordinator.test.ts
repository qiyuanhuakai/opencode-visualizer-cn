// @vitest-environment node
//
// Task 37 — the Team / Task / Attempt coordinator and its budgets.
//
// Product under test:
//   bridge/runtime/collaboration/coordinator.js       (budget gate, mailbox, restart retention)
//   bridge/runtime/collaboration/taskGraph.js         (the DAG: acyclic, derived blocking, depth/children)
//   bridge/runtime/collaboration/attemptService.js    (accepted → sent → observed → terminal | reconcile)
//   bridge/runtime/collaboration/acceptanceService.js (task review + acceptance)
//   shared/runtime/collaboration.js                   (the frozen contract: budgets, states, parsers)
//
// The four bridge modules under test are loaded through createRequire rather than a static
// import: this task's grant is exactly seven new paths and only one of them is a declaration
// file (shared/runtime/collaboration.d.ts). A static import of a .d.ts-less bridge module is
// TS7016 under the repo's strict vue-tsc gate — the same reason task 34's handoff.test.ts uses
// the require boundary for handoffService.js. The contracts below are therefore declared here,
// in the test, and the require boundary is the only untyped edge. shared/runtime/collaboration.js
// DOES ship a sibling declaration file and is imported statically, so its contract is checked by
// vue-tsc itself.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_BUDGETS,
  CollaborationError,
  parseSessionMutationKey,
} from '../../shared/runtime/collaboration.js';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  encodeSessionKey,
} from '../../shared/runtime/identity.js';
import type { SessionRef } from '../../shared/runtime/identity.js';

/* ------------------------------------------------------------------ contracts */

interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly required: boolean;
}
interface TaskOwner {
  readonly participantId: string;
  readonly session: SessionRef;
}
interface TaskLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
}
interface TaskPaused {
  readonly reasons: readonly string[];
  readonly at: number;
}
interface TaskReview {
  readonly state: 'none' | 'pending' | 'approved' | 'rejected';
  readonly reviewer: string | null;
  readonly reason: string | null;
  readonly at: number | null;
}
interface TaskAcceptance {
  readonly state: 'none' | 'pending' | 'accepted' | 'rejected';
  readonly acceptedBy: string | null;
  readonly acceptedAt: number | null;
  readonly deliverableId: string | null;
  readonly criteria: readonly string[];
}
interface DeliverableView {
  readonly deliverableId: string;
  readonly artifactHash: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}
interface TaskView {
  readonly taskId: string;
  readonly teamId: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly depth: number;
  readonly state: 'pending' | 'dispatched' | 'review' | 'accepted' | 'failed' | 'cancelled' | 'paused';
  readonly criteria: readonly Criterion[];
  readonly dependsOn: readonly string[];
  readonly children: readonly string[];
  readonly owner: TaskOwner;
  readonly lease: TaskLease | null;
  readonly blockedBy: readonly string[];
  readonly paused: TaskPaused | null;
  readonly ambiguous: boolean;
  readonly attempts: readonly string[];
  readonly review: TaskReview;
  readonly acceptance: TaskAcceptance;
  readonly deliverables: readonly DeliverableView[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface AttemptView {
  readonly attemptId: string;
  readonly taskId: string;
  readonly teamId: string;
  readonly state: 'accepted' | 'sent' | 'observed' | 'terminal' | 'reconcile';
  readonly accepted: boolean;
  readonly sent: boolean;
  readonly observed: boolean;
  readonly terminal: boolean;
  readonly terminalReason: string | null;
  readonly resolution: { readonly code: string; readonly field: string; readonly reason: string | null } | null;
  readonly sends: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface AttemptOpView {
  readonly opId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly outcome: string;
  readonly code: string | null;
  readonly field: string | null;
}
interface TeamView {
  readonly teamId: string;
  readonly name: string;
  readonly taskCount: number;
  readonly mailboxDepth: number;
  readonly createdAt: number;
}
interface MessageView {
  readonly messageId: string;
  readonly teamId: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly at: number;
}
interface RestartView {
  readonly rehydrated: number;
  readonly retained: readonly { readonly taskId: string; readonly attemptId: string; readonly state: string }[];
  readonly dispatched: readonly { readonly taskId: string; readonly attemptId: string }[];
  readonly paused: readonly string[];
}
interface CoordinatorState {
  readonly teams: number;
  readonly tasks: number;
  readonly attempts: number;
  readonly dispatches: number;
  readonly running: number;
  readonly sessionMutations: number;
  readonly mailbox: number;
  readonly reconciles: number;
  readonly failures: number;
  readonly closed: boolean;
}
interface BudgetView {
  readonly limits: Readonly<Record<string, number>>;
  readonly used: Readonly<Record<string, number>>;
}

/** The native-observation sink of an attempt: it can write `observed`/`terminal`, and nothing else. */
interface NativeSink {
  observe(input: { readonly nativeEventId: string; readonly at?: number }): { readonly applied: boolean; readonly duplicate: boolean };
  end(input: { readonly reason: string; readonly nativeEventId?: string; readonly at?: number }): { readonly applied: boolean; readonly duplicate: boolean };
}
/** The delivery (ack) sink of an attempt: it can write `sent`, and nothing else. */
interface DeliverySink {
  deliver(input: { readonly ackId: string; readonly at?: number }): { readonly applied: boolean; readonly duplicate: boolean };
}
/** The Host sink of an attempt: accepted/cancel/fail/reconcile — never the native slices. */
interface AttemptHostSink {
  accept(input: { readonly at?: number }): void;
  cancel(input: { readonly code: string; readonly field: string; readonly reason?: string | null; readonly at?: number }): void;
  fail(input: { readonly code: string; readonly field: string; readonly reason?: string | null; readonly at?: number }): void;
  reconcile(input: { readonly code: string; readonly field: string; readonly reason?: string | null; readonly at?: number }): void;
}
/** The acceptance sink of a task: the ONLY writer of review + acceptance + deliverables. */
interface AcceptanceSink {
  deliverable(input: { readonly deliverable: DeliverableView; readonly at?: number }): void;
  submitReview(input: { readonly reviewer: string; readonly at?: number }): void;
  review(input: { readonly decision: 'approved' | 'rejected'; readonly reviewer: string; readonly reason?: string | null; readonly at?: number }): void;
  accept(input: {
    readonly deliverableId: string;
    readonly criteria: readonly { readonly id: string; readonly met: boolean }[];
    readonly acceptedBy: string;
    readonly at?: number;
  }): void;
  reject(input: { readonly reason: string; readonly at?: number }): void;
}

interface CoordinatorModule {
  createCollaborationCoordinator(options?: {
    readonly deliver?: (input: {
      readonly taskId: string;
      readonly attemptId: string;
      readonly owner: TaskOwner;
      readonly prompt: string;
    }) => Promise<{ readonly ackId: string } | { readonly ambiguous: true }>;
    readonly at?: number;
  }): CoordinatorLike;
}
interface AttemptModule {
  ATTEMPT_STATES: readonly string[];
  createNativeSink(scope: { readonly observation: Record<string, unknown> }): NativeSink;
  createDeliverySink(scope: { readonly delivery: Record<string, unknown> }): DeliverySink;
  createHostSink(scope: { readonly host: Record<string, unknown>; readonly resolution: Record<string, unknown> }): AttemptHostSink;
}
interface AcceptanceModule {
  createAcceptanceSink(scope: {
    readonly review: Record<string, unknown>;
    readonly acceptance: Record<string, unknown>;
    readonly deliverables: unknown[];
  }): AcceptanceSink;
}
interface CoordinatorLike {
  createTeam(input: { readonly teamId?: string; readonly name: string; readonly at?: number }): TeamView;
  team(teamId: string): TeamView;
  teams(): readonly TeamView[];
  createTask(input: {
    readonly teamId: string;
    readonly title: string;
    readonly criteria: readonly { readonly id: string; readonly text: string; readonly required?: boolean }[];
    readonly owner: TaskOwner;
    readonly lease: { readonly ownerId: string; readonly expiresAt: number };
    readonly parentId?: string;
    readonly dependsOn?: readonly string[];
    readonly at?: number;
  }): TaskView;
  addDependency(input: { readonly taskId: string; readonly dependsOn: string; readonly at?: number }): TaskView;
  task(taskId: string): TaskView;
  tasks(teamId?: string): readonly TaskView[];
  dispatch(input: { readonly taskId: string; readonly prompt?: string; readonly at?: number }): Promise<{
    readonly task: TaskView;
    readonly attempt: AttemptView | null;
  }>;
  send(input: { readonly attemptId: string; readonly at?: number }): Promise<{
    readonly task: TaskView;
    readonly attempt: AttemptView;
  }>;
  observe(input: { readonly attemptId: string; readonly nativeEventId: string; readonly at?: number }): AttemptView;
  observeNativeEnd(input: { readonly attemptId: string; readonly reason: string; readonly nativeEventId?: string; readonly at?: number }): AttemptView;
  cancelAttempt(input: { readonly attemptId: string; readonly reason?: string; readonly at?: number }): AttemptView;
  attempt(attemptId: string): AttemptView;
  attempts(taskId?: string): readonly AttemptView[];
  ops(attemptId: string): readonly AttemptOpView[];
  registerDeliverable(input: { readonly taskId: string; readonly deliverable: DeliverableView; readonly at?: number }): TaskView;
  submitForReview(input: { readonly taskId: string; readonly reviewer: string; readonly at?: number }): TaskView;
  review(input: { readonly taskId: string; readonly decision: 'approved' | 'rejected'; readonly reviewer: string; readonly reason?: string; readonly at?: number }): TaskView;
  accept(input: {
    readonly taskId: string;
    readonly deliverableId: string;
    readonly criteria: readonly { readonly id: string; readonly met: boolean }[];
    readonly acceptedBy: string;
    readonly at?: number;
  }): TaskView;
  failTask(input: { readonly taskId: string; readonly code: string; readonly field: string; readonly reason?: string; readonly at?: number }): TaskView;
  cancelTask(input: { readonly taskId: string; readonly reason?: string; readonly at?: number }): TaskView;
  postMessage(input: { readonly teamId: string; readonly from: string; readonly to: string; readonly text: string; readonly at?: number }): MessageView;
  mailbox(teamId: string): readonly MessageView[];
  pump(input?: { readonly at?: number }): readonly TaskView[];
  restart(): RestartView;
  budgets(): BudgetView;
  state(): CoordinatorState;
  close(): void;
}

/* ------------------------------------------------------------------ fixtures */

const require_ = createRequire(import.meta.url);

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_A = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HARNESS_B = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const HARNESS_C = parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const HARNESS_D = parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const HARNESS_E = parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

const SESSION_A: SessionRef = { environmentId: ENV_A, harnessInstanceId: HARNESS_A, nativeSessionId: 'native:codex-1' };
const SESSION_B: SessionRef = { environmentId: ENV_A, harnessInstanceId: HARNESS_B, nativeSessionId: 'native:acp-1' };
const SESSION_C: SessionRef = { environmentId: ENV_A, harnessInstanceId: HARNESS_C, nativeSessionId: 'native:kimi-1' };
const SESSION_D: SessionRef = { environmentId: ENV_A, harnessInstanceId: HARNESS_D, nativeSessionId: 'native:dsh-1' };
const SESSION_E: SessionRef = { environmentId: ENV_A, harnessInstanceId: HARNESS_E, nativeSessionId: 'native:opencode-1' };

const OWNER_1 = '12121212-1212-4212-8212-121212121211';
const REVIEWER = '13131313-1313-4313-8313-131313131313';
const ACCEPTER = '14141414-1414-4414-8414-141414141414';

const PARTICIPANT_1 = '15151515-1515-4515-8515-151515151511';
const PARTICIPANT_2 = '15151515-1515-4515-8515-151515151512';
const PARTICIPANT_3 = '15151515-1515-4515-8515-151515151513';
const PARTICIPANT_4 = '15151515-1515-4515-8515-151515151514';
const PARTICIPANT_5 = '15151515-1515-4515-8515-151515151515';

const T0 = 1700000000000;
const LEASE_TTL = 600000;

/** The five owners: five DISTINCT native sessions, so only the session budget can pair them. */
const OWNERS: readonly TaskOwner[] = Object.freeze([
  { participantId: PARTICIPANT_1, session: SESSION_A },
  { participantId: PARTICIPANT_2, session: SESSION_B },
  { participantId: PARTICIPANT_3, session: SESSION_C },
  { participantId: PARTICIPANT_4, session: SESSION_D },
  { participantId: PARTICIPANT_5, session: SESSION_E },
]);

const CRITERIA: readonly { readonly id: string; readonly text: string; readonly required?: boolean }[] = Object.freeze([
  { id: 'build', text: 'the production build passes' },
  { id: 'tests', text: 'the focused regression passes', required: true },
]);

const DELIVERABLE: DeliverableView = Object.freeze({
  deliverableId: 'deliverable-1',
  artifactHash: 'f'.repeat(64),
  bytes: 4096,
  paths: Object.freeze(['bridge/runtime/collaboration/coordinator.js']),
});

function ownerAt(index: number): TaskOwner {
  const owner = OWNERS[index];
  if (owner === undefined) throw new Error(`no owner fixture at index ${index}`);
  return owner;
}

function rejectionOf(run: () => unknown): { code: string | null; field: string | null } {
  try {
    run();
    return { code: null, field: null };
  } catch (error) {
    const typed = error as { code?: unknown; field?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code : null,
      field: typeof typed.field === 'string' ? typed.field : null,
    };
  }
}

async function rejectionOfAsync(run: () => Promise<unknown>): Promise<{ code: string | null; field: string | null }> {
  try {
    await run();
    return { code: null, field: null };
  } catch (error) {
    const typed = error as { code?: unknown; field?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code : null,
      field: typeof typed.field === 'string' ? typed.field : null,
    };
  }
}

interface WorldCounters {
  deliver: number;
}

interface World {
  readonly coordinator: CoordinatorLike;
  readonly teamId: string;
  readonly counters: WorldCounters;
  makeTask(overrides?: {
    readonly title?: string;
    readonly ownerIndex?: number;
    readonly parentId?: string;
    readonly dependsOn?: readonly string[];
    readonly at?: number;
    readonly leaseTtl?: number;
  }): TaskView;
}

async function makeWorld(overrides: {
  readonly deliver?: (input: { readonly taskId: string; readonly attemptId: string; readonly owner: TaskOwner; readonly prompt: string }) => Promise<{ readonly ackId: string } | { readonly ambiguous: true }>;
} = {}): Promise<World> {
  const counters: WorldCounters = { deliver: 0 };
  const deliver = overrides.deliver
    ?? (async () => {
      counters.deliver += 1;
      return { ackId: `ack-${counters.deliver}` };
    });
  const module = require_('../../bridge/runtime/collaboration/coordinator.js') as CoordinatorModule;
  const coordinator = module.createCollaborationCoordinator({ deliver });
  const team = coordinator.createTeam({ name: 'runtime-migration', at: T0 });
  const makeTask = (input: {
    readonly title?: string;
    readonly ownerIndex?: number;
    readonly parentId?: string;
    readonly dependsOn?: readonly string[];
    readonly at?: number;
    readonly leaseTtl?: number;
  } = {}): TaskView => {
    const at = input.at ?? T0;
    const ownerIndex = input.ownerIndex ?? 0;
    return coordinator.createTask({
      teamId: team.teamId,
      title: input.title ?? 'migrate the runtime collaboration surface',
      criteria: CRITERIA,
      owner: ownerAt(ownerIndex),
      lease: { ownerId: `12121212-1212-4212-8212-12121212121${ownerIndex + 1}`, expiresAt: at + (input.leaseTtl ?? LEASE_TTL) },
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      at,
    });
  };
  return { coordinator, teamId: team.teamId, counters, makeTask };
}

/* ------------------------------------------------------------------ the frozen contract */

describe('collaboration contract', () => {
  it('freezes one shared budget object with the five plan limits', () => {
    expect(COLLABORATION_BUDGETS).toEqual({
      maxConcurrency: 4,
      maxSessionMutations: 1,
      maxDepth: 4,
      maxChildren: 32,
      maxMailbox: 1000,
    });
    expect(Object.isFrozen(COLLABORATION_BUDGETS)).toBe(true);
    expect(COLLABORATION_BUDGETS.maxConcurrency).toBe(4);
    expect(COLLABORATION_BUDGETS.maxSessionMutations).toBe(1);
    expect(COLLABORATION_BUDGETS.maxDepth).toBe(4);
    expect(COLLABORATION_BUDGETS.maxChildren).toBe(32);
    expect(COLLABORATION_BUDGETS.maxMailbox).toBe(1000);
  });

  it('reports the same frozen limits through the coordinator budget read model', async () => {
    const world = await makeWorld();
    const budgets = world.coordinator.budgets();
    expect(budgets.limits).toEqual(COLLABORATION_BUDGETS);
    expect(Object.isFrozen(budgets.limits)).toBe(true);
    expect(Object.isFrozen(budgets)).toBe(true);
  });

  it('gives every rejection an explicit code and field, never a bare throw', async () => {
    const world = await makeWorld();
    const missing = rejectionOf(() => world.coordinator.task('22222222-2222-4222-8222-222222222222'));
    expect(missing.code).toBe('invalid_request');
    expect(missing.field).toBe('task_unknown');
    const notUuid = rejectionOf(() => world.coordinator.task('nope'));
    expect(notUuid.code).toBe('invalid_request');
    expect(notUuid.field).toBe('task_id');
    const error = new CollaborationError('conflict', 'task_blocked', { blockedBy: ['x'] });
    expect(error.code).toBe('conflict');
    expect(error.field).toBe('task_blocked');
    expect(error.detail).toEqual({ blockedBy: ['x'] });
  });

  it('returns frozen read models from every accessor', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.criteria)).toBe(true);
    expect(Object.isFrozen(world.coordinator.task(task.taskId))).toBe(true);
    expect(Object.isFrozen(world.coordinator.tasks())).toBe(true);
    expect(Object.isFrozen(world.coordinator.team(world.teamId))).toBe(true);
    expect(Object.isFrozen(world.coordinator.teams())).toBe(true);
    expect(Object.isFrozen(world.coordinator.mailbox(world.teamId))).toBe(true);
  });
});

/* ------------------------------------------------------------------ the DAG */

describe('task DAG', () => {
  it('creates a task carrying criteria, an owner and a lease, and derives its depth', async () => {
    const world = await makeWorld();
    const task = world.makeTask({ title: 'land the coordinator' });
    expect(task.state).toBe('pending');
    expect(task.depth).toBe(1);
    expect(task.parentId).toBeNull();
    expect(task.criteria.map((entry) => entry.id)).toEqual(['build', 'tests']);
    expect(task.criteria[1]?.required).toBe(true);
    expect(task.owner.session.nativeSessionId).toBe('native:codex-1');
    expect(task.lease?.ownerId).toBeTruthy();
    expect(task.lease?.expiresAt).toBe(T0 + LEASE_TTL);
    expect(task.blockedBy).toEqual([]);
    expect(task.paused).toBeNull();
    expect(task.attempts).toEqual([]);
    expect(task.review.state).toBe('none');
    expect(task.acceptance.state).toBe('none');
    expect(task.deliverables).toEqual([]);
  });

  it('refuses a dependency edge that would close a cycle (DAG stays acyclic)', async () => {
    const world = await makeWorld();
    const a = world.makeTask({ title: 'task a' });
    const b = world.makeTask({ title: 'task b', dependsOn: [a.taskId] });
    expect(b.dependsOn).toEqual([a.taskId]);
    expect(b.depth).toBe(2);
    // b now depends on a; making a depend on b would close a cycle.
    const cycle = rejectionOf(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: b.taskId, at: T0 + 10 }));
    expect(cycle.code).toBe('conflict');
    expect(cycle.field).toBe('task_cycle');
    // The refused edge is NOT recorded: a still has no dependencies.
    expect(world.coordinator.task(a.taskId).dependsOn).toEqual([]);
    expect(world.coordinator.task(a.taskId).depth).toBe(1);
    // A self-dependency is a cycle too, refused before anything is written.
    const self = rejectionOf(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: a.taskId, at: T0 + 11 }));
    expect(self.code).toBe('conflict');
    expect(self.field).toBe('task_cycle');
    // A longer cycle (a → c → b → a) is refused as well.
    const c = world.makeTask({ title: 'task c', dependsOn: [b.taskId] });
    const longCycle = rejectionOf(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: c.taskId, at: T0 + 12 }));
    expect(longCycle.code).toBe('conflict');
    expect(longCycle.field).toBe('task_cycle');
    expect(world.coordinator.task(b.taskId).dependsOn).toEqual([a.taskId]);
    expect(world.coordinator.task(c.taskId).dependsOn).toEqual([b.taskId]);
    expect(world.coordinator.task(a.taskId).dependsOn).toEqual([]);
  });

  it('refuses an unknown dependency and a duplicate dependency with an explicit code', async () => {
    const world = await makeWorld();
    const a = world.makeTask();
    const unknown = rejectionOf(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: '22222222-2222-4222-8222-222222222222', at: T0 + 5 }));
    expect(unknown.code).toBe('invalid_request');
    expect(unknown.field).toBe('task_unknown');
    const b = world.makeTask();
    world.coordinator.addDependency({ taskId: b.taskId, dependsOn: a.taskId, at: T0 + 6 });
    const duplicate = rejectionOf(() => world.coordinator.addDependency({ taskId: b.taskId, dependsOn: a.taskId, at: T0 + 7 }));
    expect(duplicate.code).toBe('conflict');
    expect(duplicate.field).toBe('task_dependency');
  });

  it('a dependency blocks dispatch until it is accepted', async () => {
    const world = await makeWorld();
    const first = world.makeTask({ title: 'first' });
    const second = world.makeTask({ title: 'second', dependsOn: [first.taskId] });
    expect(world.coordinator.task(second.taskId).blockedBy).toEqual([first.taskId]);
    const blocked = await rejectionOfAsync(() => world.coordinator.dispatch({ taskId: second.taskId, at: T0 + 1 }));
    expect(blocked.code).toBe('conflict');
    expect(blocked.field).toBe('task_blocked');
    // Nothing was dispatched for the blocked task.
    expect(world.coordinator.state().dispatches).toBe(0);
    expect(world.coordinator.attempts(second.taskId)).toEqual([]);
    // Complete and accept the dependency, then the blocked task becomes dispatchable.
    const dispatched = await world.coordinator.dispatch({ taskId: first.taskId, at: T0 + 2 });
    await world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 3 });
    world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt?.attemptId ?? '', reason: 'completed', at: T0 + 4 });
    world.coordinator.registerDeliverable({ taskId: first.taskId, deliverable: DELIVERABLE, at: T0 + 5 });
    world.coordinator.submitForReview({ taskId: first.taskId, reviewer: REVIEWER, at: T0 + 6 });
    world.coordinator.review({ taskId: first.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 7 });
    world.coordinator.accept({
      taskId: first.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'build', met: true }, { id: 'tests', met: true }],
      acceptedBy: ACCEPTER,
      at: T0 + 8,
    });
    expect(world.coordinator.task(first.taskId).state).toBe('accepted');
    expect(world.coordinator.task(second.taskId).blockedBy).toEqual([]);
    const secondDispatched = await world.coordinator.dispatch({ taskId: second.taskId, at: T0 + 9 });
    expect(secondDispatched.task.state).toBe('dispatched');
    expect(secondDispatched.attempt?.state).toBe('accepted');
  });

  it('refuses a duplicate assignment: one live attempt per task', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    expect(world.coordinator.attempts(task.taskId)).toHaveLength(1);
    const duplicate = await rejectionOfAsync(() => world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 2 }));
    expect(duplicate.code).toBe('conflict');
    expect(duplicate.field).toBe('task_dispatched');
    expect(world.coordinator.state().dispatches).toBe(1);
    expect(world.coordinator.attempts(task.taskId)).toHaveLength(1);
  });

  it('registers a child under its parent and counts it', async () => {
    const world = await makeWorld();
    const parent = world.makeTask({ title: 'parent' });
    const child = world.makeTask({ title: 'child', parentId: parent.taskId });
    expect(child.parentId).toBe(parent.taskId);
    expect(child.depth).toBe(2);
    expect(world.coordinator.task(parent.taskId).children).toEqual([child.taskId]);
    const orphan = rejectionOf(() => world.coordinator.createTask({
      teamId: world.teamId,
      title: 'orphan',
      criteria: CRITERIA,
      owner: ownerAt(0),
      lease: { ownerId: OWNER_1, expiresAt: T0 + LEASE_TTL },
      parentId: '22222222-2222-4222-8222-222222222222',
      at: T0,
    }));
    expect(orphan.code).toBe('invalid_request');
    expect(orphan.field).toBe('task_parent');
  });
});

/* ------------------------------------------------------------------ the budgets */

describe('collaboration budgets', () => {
  it('budget overrun is VISIBLY paused for all five budgets (concurrency, session mutation, depth, children, mailbox)', async () => {
    const world = await makeWorld();

    // --- concurrency 4 -------------------------------------------------------
    const concurrencyTasks = [0, 1, 2, 3, 4].map((index) =>
      world.makeTask({ title: `concurrency ${index}`, ownerIndex: index }));
    for (let index = 0; index < 4; index += 1) {
      const task = concurrencyTasks[index];
      if (task === undefined) throw new Error('missing concurrency task');
      const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 + index });
      expect(dispatched.task.state).toBe('dispatched');
    }
    expect(world.coordinator.state().running).toBe(4);
    const fifth = concurrencyTasks[4];
    if (fifth === undefined) throw new Error('missing fifth concurrency task');
    const pausedConcurrency = await world.coordinator.dispatch({ taskId: fifth.taskId, at: T0 + 20 });
    expect(pausedConcurrency.task.state).toBe('paused');
    expect(pausedConcurrency.task.paused?.reasons).toEqual(['collaboration_concurrency']);
    expect(pausedConcurrency.attempt).toBeNull();
    expect(world.coordinator.state().dispatches).toBe(4);
    expect(world.coordinator.state().running).toBe(4);
    expect(world.coordinator.attempts(fifth.taskId)).toEqual([]);
    // The pause is visible in the task list and in the budget read model.
    expect(world.coordinator.tasks().filter((task) => task.state === 'paused')).toHaveLength(1);
    expect(world.coordinator.budgets().used.concurrency).toBe(4);

    // --- Session mutation 1 --------------------------------------------------
    const sessionWorld = await makeWorld();
    const firstOnSession = sessionWorld.makeTask({ title: 'first on session a', ownerIndex: 0 });
    const secondOnSession = sessionWorld.makeTask({ title: 'second on session a', ownerIndex: 0 });
    const sessionDispatched = await sessionWorld.coordinator.dispatch({ taskId: firstOnSession.taskId, at: T0 + 1 });
    expect(sessionDispatched.task.state).toBe('dispatched');
    const pausedSession = await sessionWorld.coordinator.dispatch({ taskId: secondOnSession.taskId, at: T0 + 2 });
    expect(pausedSession.task.state).toBe('paused');
    expect(pausedSession.task.paused?.reasons).toEqual(['collaboration_session_mutation']);
    expect(sessionWorld.coordinator.state().dispatches).toBe(1);
    expect(sessionWorld.coordinator.state().sessionMutations).toBe(1);
    expect(sessionWorld.coordinator.attempts(secondOnSession.taskId)).toEqual([]);
    expect(sessionWorld.coordinator.budgets().used.sessionMutations).toBe(1);

    // --- depth 4 -------------------------------------------------------------
    const depthWorld = await makeWorld();
    const chain: TaskView[] = [];
    for (let level = 0; level < 4; level += 1) {
      const task = depthWorld.makeTask({
        title: `depth ${level + 1}`,
        ownerIndex: level,
        ...(level === 0 ? {} : { dependsOn: [chain[level - 1]?.taskId ?? ''] }),
      });
      chain.push(task);
    }
    expect(chain.map((task) => task.depth)).toEqual([1, 2, 3, 4]);
    const tooDeep = depthWorld.makeTask({
      title: 'depth 5',
      ownerIndex: 4,
      dependsOn: [chain[3]?.taskId ?? ''],
    });
    expect(tooDeep.depth).toBe(5);
    expect(tooDeep.state).toBe('paused');
    expect(tooDeep.paused?.reasons).toEqual(['collaboration_depth']);
    const pausedDepth = await depthWorld.coordinator.dispatch({ taskId: tooDeep.taskId, at: T0 + 30 });
    expect(pausedDepth.task.state).toBe('paused');
    expect(pausedDepth.task.paused?.reasons).toEqual(['collaboration_depth']);
    expect(depthWorld.coordinator.state().dispatches).toBe(0);
    expect(depthWorld.coordinator.attempts(tooDeep.taskId)).toEqual([]);
    expect(depthWorld.coordinator.budgets().used.depth).toBe(5);

    // --- children 32 ---------------------------------------------------------
    const childrenWorld = await makeWorld();
    const parent = childrenWorld.makeTask({ title: 'fan-out parent' });
    const children: TaskView[] = [];
    for (let index = 0; index < 33; index += 1) {
      children.push(childrenWorld.makeTask({ title: `child ${index}`, ownerIndex: index % 5, parentId: parent.taskId }));
    }
    expect(children.slice(0, 32).every((task) => task.state === 'pending')).toBe(true);
    const thirtyThird = children[32];
    if (thirtyThird === undefined) throw new Error('missing 33rd child');
    expect(thirtyThird.state).toBe('paused');
    expect(thirtyThird.paused?.reasons).toEqual(['collaboration_children']);
    expect(childrenWorld.coordinator.task(parent.taskId).children).toHaveLength(33);
    const pausedChildren = await childrenWorld.coordinator.dispatch({ taskId: thirtyThird.taskId, at: T0 + 40 });
    expect(pausedChildren.task.state).toBe('paused');
    expect(pausedChildren.task.paused?.reasons).toEqual(['collaboration_children']);
    expect(childrenWorld.coordinator.attempts(thirtyThird.taskId)).toEqual([]);
    expect(childrenWorld.coordinator.budgets().used.children).toBe(33);

    // --- mailbox 1000 --------------------------------------------------------
    const mailboxWorld = await makeWorld();
    const mailboxTask = mailboxWorld.makeTask({ title: 'mailbox task' });
    for (let index = 0; index < 1000; index += 1) {
      mailboxWorld.coordinator.postMessage({
        teamId: mailboxWorld.teamId,
        from: 'lead',
        to: 'worker',
        text: `notice ${index}`,
        at: T0 + index,
      });
    }
    expect(mailboxWorld.coordinator.mailbox(mailboxWorld.teamId)).toHaveLength(1000);
    expect(mailboxWorld.coordinator.budgets().used.mailbox).toBe(1000);
    // The 1001st post is REFUSED with an explicit code — never silently dropped.
    const overflow = rejectionOf(() => mailboxWorld.coordinator.postMessage({
      teamId: mailboxWorld.teamId,
      from: 'lead',
      to: 'worker',
      text: 'notice 1000',
      at: T0 + 1000,
    }));
    expect(overflow.code).toBe('conflict');
    expect(overflow.field).toBe('collaboration_mailbox');
    expect(mailboxWorld.coordinator.mailbox(mailboxWorld.teamId)).toHaveLength(1000);
    // And a dispatch that owes the team a notice is visibly paused, not silently run.
    const pausedMailbox = await mailboxWorld.coordinator.dispatch({ taskId: mailboxTask.taskId, at: T0 + 1001 });
    expect(pausedMailbox.task.state).toBe('paused');
    expect(pausedMailbox.task.paused?.reasons).toEqual(['collaboration_mailbox']);
    expect(mailboxWorld.coordinator.state().dispatches).toBe(0);
    expect(mailboxWorld.coordinator.attempts(mailboxTask.taskId)).toEqual([]);
  });

  it('releases a concurrency slot when an attempt ends, so a paused task can then dispatch', async () => {
    const world = await makeWorld();
    const tasks = [0, 1, 2, 3, 4].map((index) => world.makeTask({ title: `slot ${index}`, ownerIndex: index }));
    const running: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const task = tasks[index];
      if (task === undefined) throw new Error('missing task');
      const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 + index });
      if (dispatched.attempt === null) throw new Error('dispatch did not mint an attempt');
      running.push(dispatched.attempt.attemptId);
    }
    const fifth = tasks[4];
    if (fifth === undefined) throw new Error('missing fifth task');
    const paused = await world.coordinator.dispatch({ taskId: fifth.taskId, at: T0 + 20 });
    expect(paused.task.state).toBe('paused');
    // End one attempt: the slot is released and the paused task can run.
    await world.coordinator.send({ attemptId: running[0] ?? '', at: T0 + 20 });
    world.coordinator.observeNativeEnd({ attemptId: running[0] ?? '', reason: 'completed', at: T0 + 21 });
    expect(world.coordinator.state().running).toBe(3);
    const resumed = await world.coordinator.dispatch({ taskId: fifth.taskId, at: T0 + 22 });
    expect(resumed.task.state).toBe('dispatched');
    expect(resumed.attempt?.state).toBe('accepted');
    await world.coordinator.send({ attemptId: resumed.attempt?.attemptId ?? '', at: T0 + 23 });
    expect(world.coordinator.attempt(resumed.attempt?.attemptId ?? '').state).toBe('sent');
    expect(world.coordinator.state().running).toBe(4);
  });

  it('refuses a dispatch whose owner lease has expired, and never auto-succeeds it', async () => {
    const world = await makeWorld();
    const task = world.makeTask({ leaseTtl: 10 });
    const expired = await rejectionOfAsync(() => world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 100 }));
    expect(expired.code).toBe('conflict');
    expect(expired.field).toBe('task_lease');
    expect(world.coordinator.state().dispatches).toBe(0);
  });
});

/* ------------------------------------------------------------------ native end is not task success */

describe('native end is not task success', () => {
  it('a native end with no deliverable and no acceptance CANNOT be success', async () => {
    const world = await makeWorld();
    const task = world.makeTask({ title: 'worker task' });
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    expect(dispatched.attempt?.state).toBe('accepted');
    expect(dispatched.attempt?.accepted).toBe(true);
    expect(dispatched.attempt?.sent).toBe(false);
    await world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 2 });
    expect(world.coordinator.attempt(dispatched.attempt?.attemptId ?? '').state).toBe('sent');
    expect(world.coordinator.attempt(dispatched.attempt?.attemptId ?? '').sends).toBe(1);
    world.coordinator.observe({ attemptId: dispatched.attempt?.attemptId ?? '', nativeEventId: 'evt-native-1', at: T0 + 3 });
    expect(world.coordinator.attempt(dispatched.attempt?.attemptId ?? '').state).toBe('observed');
    // The native end arrives with reason `completed` and NO deliverable and NO acceptance.
    const ended = world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt?.attemptId ?? '', reason: 'completed', nativeEventId: 'evt-native-2', at: T0 + 4 });
    expect(ended.state).toBe('terminal');
    expect(ended.terminalReason).toBe('completed');
    // The TASK is NOT success: it is waiting for review, and its acceptance is still none.
    const afterEnd = world.coordinator.task(task.taskId);
    expect(afterEnd.state).toBe('review');
    expect(afterEnd.state).not.toBe('accepted');
    expect(afterEnd.acceptance.state).toBe('none');
    expect(afterEnd.acceptance.deliverableId).toBeNull();
    expect(afterEnd.deliverables).toEqual([]);
    // An acceptance without a deliverable is refused with an explicit code.
    const noDeliverable = rejectionOf(() => world.coordinator.accept({
      taskId: task.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'build', met: true }, { id: 'tests', met: true }],
      acceptedBy: ACCEPTER,
      at: T0 + 5,
    }));
    expect(noDeliverable.code).toBe('invalid_request');
    expect(noDeliverable.field).toBe('acceptance_deliverable');
    expect(world.coordinator.task(task.taskId).state).toBe('review');
    // An acceptance without a review is refused too.
    world.coordinator.registerDeliverable({ taskId: task.taskId, deliverable: DELIVERABLE, at: T0 + 6 });
    const noReview = rejectionOf(() => world.coordinator.accept({
      taskId: task.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'build', met: true }, { id: 'tests', met: true }],
      acceptedBy: ACCEPTER,
      at: T0 + 7,
    }));
    expect(noReview.code).toBe('conflict');
    expect(noReview.field).toBe('acceptance_review');
    expect(world.coordinator.task(task.taskId).state).toBe('review');
    // POSITIVE CONTROL: the Host path (review → approve → accept) is what marks success.
    world.coordinator.submitForReview({ taskId: task.taskId, reviewer: REVIEWER, at: T0 + 8 });
    world.coordinator.review({ taskId: task.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 9 });
    const accepted = world.coordinator.accept({
      taskId: task.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'build', met: true }, { id: 'tests', met: true }],
      acceptedBy: ACCEPTER,
      at: T0 + 10,
    });
    expect(accepted.state).toBe('accepted');
    expect(accepted.acceptance.state).toBe('accepted');
    expect(accepted.acceptance.deliverableId).toBe(DELIVERABLE.deliverableId);
    expect(accepted.acceptance.acceptedBy).toBe(ACCEPTER);
  });

  it('a native end is structurally unable to reach the acceptance scope', async () => {
    const attempt = require_('../../bridge/runtime/collaboration/attemptService.js') as AttemptModule;
    const acceptance = require_('../../bridge/runtime/collaboration/acceptanceService.js') as AcceptanceModule;
    // The native sink's whole surface is observe + end: it has no member that could review or
    // accept a task, so no native input can reach the acceptance slice.
    const nativeSink = attempt.createNativeSink({ observation: { observed: false, terminal: false } });
    expect(Object.keys(nativeSink)).toEqual(['observe', 'end']);
    expect('accept' in nativeSink).toBe(false);
    expect('review' in nativeSink).toBe(false);
    expect('deliverable' in nativeSink).toBe(false);
    expect('submitReview' in nativeSink).toBe(false);
    // The delivery sink can only write `sent`.
    const deliverySink = attempt.createDeliverySink({ delivery: { delivered: false } });
    expect(Object.keys(deliverySink)).toEqual(['deliver']);
    expect('end' in deliverySink).toBe(false);
    // The Host sink cannot touch either native slice.
    const hostSink = attempt.createHostSink({ host: {}, resolution: { value: null } });
    expect(Object.keys(hostSink)).toEqual(['accept', 'cancel', 'fail', 'reconcile']);
    expect('observe' in hostSink).toBe(false);
    expect('end' in hostSink).toBe(false);
    expect('deliver' in hostSink).toBe(false);
    // The acceptance sink is the ONLY writer of review + acceptance, and its scope is built from
    // the TASK record — never from an attempt record, whose type has no such member.
    const acceptanceSink = acceptance.createAcceptanceSink({
      review: { state: 'none', reviewer: null, reason: null, at: null },
      acceptance: { state: 'none', acceptedBy: null, acceptedAt: null, deliverableId: null, criteria: [] },
      deliverables: [],
    });
    expect(Object.keys(acceptanceSink)).toEqual(['deliverable', 'submitReview', 'review', 'accept', 'reject']);
    const observationScope = { observed: false, terminal: false };
    expect('acceptance' in observationScope).toBe(false);
    expect('review' in observationScope).toBe(false);
    // Driving the native sink through its whole surface leaves an acceptance-shaped scope untouched.
    const scope = {
      review: { state: 'none', reviewer: null, reason: null, at: null },
      acceptance: { state: 'none', acceptedBy: null, acceptedAt: null, deliverableId: null, criteria: [] },
      deliverables: [] as unknown[],
    };
    const sink = acceptance.createAcceptanceSink(scope);
    const native = attempt.createNativeSink({ observation: { observed: false, terminal: false } });
    native.observe({ nativeEventId: 'evt-1' });
    native.end({ reason: 'completed', nativeEventId: 'evt-2' });
    expect(scope.acceptance.state).toBe('none');
    expect(scope.review.state).toBe('none');
    expect(scope.deliverables).toEqual([]);
    expect(Object.keys(sink)).toEqual(['deliverable', 'submitReview', 'review', 'accept', 'reject']);
  });

  it('refuses an unmet required criterion and an unknown criterion with explicit codes', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    await world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 2 });
    world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt?.attemptId ?? '', reason: 'completed', at: T0 + 3 });
    world.coordinator.registerDeliverable({ taskId: task.taskId, deliverable: DELIVERABLE, at: T0 + 4 });
    world.coordinator.submitForReview({ taskId: task.taskId, reviewer: REVIEWER, at: T0 + 5 });
    world.coordinator.review({ taskId: task.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 6 });
    const unmet = rejectionOf(() => world.coordinator.accept({
      taskId: task.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'build', met: true }, { id: 'tests', met: false }],
      acceptedBy: ACCEPTER,
      at: T0 + 7,
    }));
    expect(unmet.code).toBe('conflict');
    expect(unmet.field).toBe('acceptance_criteria');
    const unknown = rejectionOf(() => world.coordinator.accept({
      taskId: task.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'nope', met: true }],
      acceptedBy: ACCEPTER,
      at: T0 + 8,
    }));
    expect(unknown.code).toBe('invalid_request');
    expect(unknown.field).toBe('acceptance_criteria');
    expect(world.coordinator.task(task.taskId).state).toBe('review');
  });

  it('an owner whose lease lapses mid-flight cannot be auto-accepted', async () => {
    const world = await makeWorld();
    const task = world.makeTask({ leaseTtl: 10 });
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    await world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 2 });
    world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt?.attemptId ?? '', reason: 'completed', at: T0 + 3 });
    world.coordinator.registerDeliverable({ taskId: task.taskId, deliverable: DELIVERABLE, at: T0 + 4 });
    world.coordinator.submitForReview({ taskId: task.taskId, reviewer: REVIEWER, at: T0 + 5 });
    world.coordinator.review({ taskId: task.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 6 });
    const lapsed = rejectionOf(() => world.coordinator.accept({
      taskId: task.taskId,
      deliverableId: DELIVERABLE.deliverableId,
      criteria: [{ id: 'build', met: true }, { id: 'tests', met: true }],
      acceptedBy: ACCEPTER,
      at: T0 + 100,
    }));
    expect(lapsed.code).toBe('conflict');
    expect(lapsed.field).toBe('task_lease');
    expect(world.coordinator.task(task.taskId).state).toBe('review');
    expect(world.coordinator.task(task.taskId).acceptance.state).toBe('none');
  });
});

/* ------------------------------------------------------------------ the attempt ladder */

describe('attempt ladder', () => {
  it('walks accepted → sent → observed → terminal over observed values', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const attemptId = dispatched.attempt?.attemptId ?? '';
    expect(dispatched.attempt?.state).toBe('accepted');
    expect(dispatched.attempt?.accepted).toBe(true);
    expect(dispatched.attempt?.sent).toBe(false);
    expect(world.coordinator.state().running).toBe(1);
    const sent = await world.coordinator.send({ attemptId, at: T0 + 2 });
    expect(sent.attempt.state).toBe('sent');
    expect(sent.attempt.sent).toBe(true);
    expect(sent.attempt.sends).toBe(1);
    expect(world.coordinator.state().running).toBe(1);
    world.coordinator.observe({ attemptId, nativeEventId: 'evt-1', at: T0 + 3 });
    expect(world.coordinator.attempt(attemptId).state).toBe('observed');
    const ended = world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', nativeEventId: 'evt-2', at: T0 + 4 });
    expect(ended.state).toBe('terminal');
    expect(ended.terminal).toBe(true);
    expect(ended.terminalReason).toBe('completed');
    expect(ended.observed).toBe(true);
    expect(world.coordinator.state().running).toBe(0);
    // The ops journal records one entry per rung, each applied exactly once.
    const kinds = world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`);
    expect(kinds).toEqual(['accept:applied', 'deliver:applied', 'observe:applied', 'end:applied']);
  });

  it('stops at reconcile when the send outcome is unreadable, and never retries', async () => {
    let calls = 0;
    const world = await makeWorld({
      deliver: async () => {
        calls += 1;
        return calls === 1 ? { ackId: 'ack-1' } : { ambiguous: true };
      },
    });
    const first = world.makeTask({ title: 'first', ownerIndex: 0 });
    const second = world.makeTask({ title: 'second', ownerIndex: 1 });
    const firstDispatched = await world.coordinator.dispatch({ taskId: first.taskId, at: T0 + 1 });
    await world.coordinator.send({ attemptId: firstDispatched.attempt?.attemptId ?? '', at: T0 + 2 });
    world.coordinator.observeNativeEnd({ attemptId: firstDispatched.attempt?.attemptId ?? '', reason: 'completed', at: T0 + 3 });
    const secondDispatched = await world.coordinator.dispatch({ taskId: second.taskId, at: T0 + 4 });
    const ambiguous = await world.coordinator.send({ attemptId: secondDispatched.attempt?.attemptId ?? '', at: T0 + 5 });
    expect(ambiguous.attempt.state).toBe('reconcile');
    expect(ambiguous.task.state).toBe('dispatched');
    expect(ambiguous.task.ambiguous).toBe(true);
    expect(world.coordinator.state().reconciles).toBe(1);
    expect(world.coordinator.state().dispatches).toBe(2);
    // A reconcile is a stop, never a forward rung, and never a success.
    expect(ambiguous.task.state).not.toBe('accepted');
    expect(ambiguous.task.acceptance.state).toBe('none');
    // Nothing is retried automatically: the delivery probe ran exactly twice.
    expect(calls).toBe(2);
    // The ambiguous attempt holds no budget: the slot was released.
    expect(world.coordinator.state().running).toBe(0);
  });

  it('refuses a duplicate native end and a cancel that races a terminal attempt', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const attemptId = dispatched.attempt?.attemptId ?? '';
    await world.coordinator.send({ attemptId, at: T0 + 2 });
    world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 3 });
    const duplicate = rejectionOf(() => world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 4 }));
    expect(duplicate.code).toBe('conflict');
    expect(duplicate.field).toBe('attempt_state');
    const cancelRace = rejectionOf(() => world.coordinator.cancelAttempt({ attemptId, at: T0 + 5 }));
    expect(cancelRace.code).toBe('conflict');
    expect(cancelRace.field).toBe('attempt_state');
    // The first terminal is retained and the journal holds exactly one end op.
    expect(world.coordinator.attempt(attemptId).state).toBe('terminal');
    expect(world.coordinator.ops(attemptId).filter((op) => op.kind === 'end')).toHaveLength(1);
  });

  it('a source error fails the attempt without losing the task', async () => {
    const world = await makeWorld({
      deliver: async () => {
        throw new CollaborationError('source_unavailable', 'attempt_send');
      },
    });
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const failed = await rejectionOfAsync(() => world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 2 }));
    expect(failed.code).toBe('source_unavailable');
    expect(failed.field).toBe('attempt_send');
    const after = world.coordinator.task(task.taskId);
    expect(after.state).toBe('failed');
    expect(world.coordinator.state().failures).toBe(1);
    expect(world.coordinator.state().running).toBe(0);
    // The failed attempt is retained and observable, and it is never a success.
    expect(world.coordinator.attempts(task.taskId)).toHaveLength(1);
    expect(world.coordinator.attempt(world.coordinator.attempts(task.taskId)[0]?.attemptId ?? '').state).toBe('reconcile');
    expect(after.acceptance.state).toBe('none');
  });

  it('a native end with a failure reason fails the task instead of succeeding it', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    await world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 2 });
    world.coordinator.observe({ attemptId: dispatched.attempt?.attemptId ?? '', nativeEventId: 'evt-1', at: T0 + 3 });
    const ended = world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt?.attemptId ?? '', reason: 'failed', nativeEventId: 'evt-2', at: T0 + 4 });
    expect(ended.state).toBe('terminal');
    expect(ended.terminalReason).toBe('failed');
    const after = world.coordinator.task(task.taskId);
    expect(after.state).toBe('failed');
    expect(after.state).not.toBe('accepted');
    expect(after.acceptance.state).toBe('none');
  });
});

/* ------------------------------------------------------------------ restart */

describe('restart recovery', () => {
  it('an ambiguous restart is RETAINED and never auto-dispatched', async () => {
    const world = await makeWorld();
    const task = world.makeTask({ title: 'in flight' });
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const attemptId = dispatched.attempt?.attemptId ?? '';
    await world.coordinator.send({ attemptId, at: T0 + 2 });
    expect(world.coordinator.attempt(attemptId).state).toBe('sent');
    expect(world.coordinator.state().dispatches).toBe(1);
    // A restart with a delivered-but-never-ended attempt: the outcome is unknowable.
    const view = world.coordinator.restart();
    // The ambiguous attempt is RETAINED, reconciled — not dropped, not re-dispatched.
    expect(view.dispatched).toEqual([]);
    expect(view.retained).toHaveLength(1);
    expect(view.retained[0]?.attemptId).toBe(attemptId);
    expect(view.retained[0]?.state).toBe('reconcile');
    const retained = world.coordinator.attempt(attemptId);
    expect(retained.state).toBe('reconcile');
    expect(retained.resolution?.code).toBe('reconcile_required');
    expect(retained.resolution?.field).toBe('collaboration_restart_ambiguous');
    // The OBSERVED dispatch count did not move: nothing was auto-dispatched.
    expect(world.coordinator.state().dispatches).toBe(1);
    expect(world.coordinator.state().running).toBe(0);
    expect(world.coordinator.attempts()).toHaveLength(1);
    // The task is retained too, and it is NOT success.
    const after = world.coordinator.task(task.taskId);
    expect(after.state).toBe('dispatched');
    expect(after.ambiguous).toBe(true);
    expect(after.state).not.toBe('accepted');
    expect(after.acceptance.state).toBe('none');
    // A second restart is idempotent: still retained, still nothing dispatched.
    const again = world.coordinator.restart();
    expect(again.dispatched).toEqual([]);
    expect(world.coordinator.state().dispatches).toBe(1);
  });

  it('a restart retains an already-reconciled attempt without dispatching anything', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    if (dispatched.attempt === null) throw new Error('dispatch did not mint an attempt');
    const attemptId = dispatched.attempt.attemptId;
    world.coordinator.restart();
    const view = world.coordinator.restart();
    expect(view.dispatched).toEqual([]);
    expect(view.retained).toHaveLength(1);
    expect(view.retained[0]?.attemptId).toBe(attemptId);
    expect(world.coordinator.state().dispatches).toBe(1);
    expect(world.coordinator.attempts()).toHaveLength(1);
  });

  it('a restart never dispatches a task whose attempt already ended', async () => {
    const world = await makeWorld();
    const task = world.makeTask();
    const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    await world.coordinator.send({ attemptId: dispatched.attempt?.attemptId ?? '', at: T0 + 2 });
    world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt?.attemptId ?? '', reason: 'completed', at: T0 + 3 });
    const view = world.coordinator.restart();
    expect(view.dispatched).toEqual([]);
    expect(view.retained).toEqual([]);
    expect(world.coordinator.state().dispatches).toBe(1);
    expect(world.coordinator.attempts()).toHaveLength(1);
    expect(world.coordinator.task(task.taskId).state).toBe('review');
  });
});

/* ------------------------------------------------------------------ session mutation key */

describe('session mutation key', () => {
  it('derives one canonical key per native session, shared with the thread contract', () => {
    expect(parseSessionMutationKey(SESSION_A)).toBe(encodeSessionKey(SESSION_A));
    expect(parseSessionMutationKey(SESSION_A)).toBe(parseSessionMutationKey({ ...SESSION_A }));
    expect(parseSessionMutationKey(SESSION_A)).not.toBe(parseSessionMutationKey(SESSION_B));
    const invalid = rejectionOf(() => parseSessionMutationKey({ environmentId: ENV_A }));
    expect(invalid.code).toBe('invalid_request');
  });
});
