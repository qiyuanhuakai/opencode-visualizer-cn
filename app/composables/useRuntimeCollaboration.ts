/**
 * Task 42 — the Team task and change-review interaction state.
 *
 * This composable is the app-side seat of the collaboration UI. It consumes the landed task-37
 * coordinator, the task-38 fan-out service, the task-40 writer-lease service and the task-39
 * delegation service through narrow ports, and it holds NO product state of its own beyond what
 * those services report. Every read model below is a FROZEN snapshot taken at the moment of
 * observation, never a live internal record.
 *
 * The four hard acceptance criteria are enforced HERE, structurally, not by `if` guards:
 *
 *   1. Agent finished / Task review pending / accepted are three DISTINCT phases, and each is
 *      derived from exactly one product slice: `agent-finished` from the host state a native end
 *      writes, `review-pending` from `review.state`, `accepted` SOLELY from `acceptance.state`.
 *      The task-37 acceptance sink is the only writer of the review/acceptance slices and the
 *      native sink's type has no member reaching them, so `observeNativeEnd` structurally cannot
 *      produce `accepted`. `deriveTaskPhase` reads only those frozen fields.
 *   2. The writer path and its resources are the OBSERVED lease fields (worktree, native cwd, base
 *      commit, policy) plus the coordinator's own budget read model — nothing is invented here.
 *   3. The writer posture is the port's OWN posture object (task 40's frozen `WRITER_ISOLATION`,
 *      `sandbox: false`), surfaced verbatim by identity. No composable function accepts a sandbox
 *      claim, and no operation pushes: the only way a review advances is the explicit
 *      `approveIntegration` action a user invokes. There is no auto-push default anywhere.
 *   4. Every operation captures the Thread target it was opened under. A task whose captured
 *      thread differs from the current one is REFUSED, never silently applied to the selection.
 *      Every ASYNC operation additionally captures the session generation and re-checks it after
 *      its await: a result that lands after the team was closed, or after the selection moved, is
 *      discarded instead of being written back, so a stale completion can never repopulate a
 *      closed surface or overwrite a newer selection. The writer lease is kept PER TASK for the
 *      same reason.
 *
 * The ports are injected (RUNTIME_COLLABORATION_STATE_KEY) so presentational components stay pure
 * and the wiring point for the container is a single provide — the same optional-seam posture task
 * 35's RUNTIME_THREAD_STATE_KEY uses. Absent seam → nothing renders, so existing surfaces are
 * unaffected.
 */
import { computed, inject, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { SessionRef } from '../../shared/runtime/identity.js';

/**
 * The three review phases the UI must keep visually distinct, plus the raw host states. This is
 * the single source of the Agent-finished / review-pending / accepted distinction.
 */
export type TaskPhase =
  | 'pending'
  | 'dispatched'
  | 'agent-finished'
  | 'review-pending'
  | 'review-approved'
  | 'accepted'
  | 'failed'
  | 'cancelled'
  | 'paused';

/** One registered deliverable (task 37's `parseDeliverable` view). */
export interface CollaborationDeliverableView {
  readonly deliverableId: string;
  readonly artifactHash: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}

/** One attempt of a task (task 37's attempt view); the native ladder the UI renders. */
export interface CollaborationAttemptView {
  readonly attemptId: string;
  readonly state: string;
  readonly sent: boolean;
  readonly observed: boolean;
  readonly terminal: boolean;
  readonly terminalReason: string | null;
  readonly sends: number;
}

/** A task read model. `phase` is DERIVED (see `deriveTaskPhase`); the rest is the frozen view. */
export interface CollaborationTaskView {
  readonly taskId: string;
  readonly title: string;
  readonly state: string;
  readonly phase: TaskPhase;
  readonly depth: number;
  readonly review: { readonly state: string; readonly reviewer: string | null; readonly reason: string | null };
  readonly acceptance: {
    readonly state: string;
    readonly acceptedBy: string | null;
    readonly deliverableId: string | null;
    readonly criteria: readonly string[];
  };
  readonly deliverables: readonly CollaborationDeliverableView[];
  readonly attempts: readonly CollaborationAttemptView[];
  readonly owner: { readonly participantId: string; readonly session: SessionRef };
  readonly criteria: readonly { readonly id: string; readonly text: string; readonly required: boolean }[];
  readonly dependsOn: readonly string[];
  readonly children: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ambiguous: boolean;
  readonly pausedReasons: readonly string[];
}

/** A team member (task 39's member view): harness, role and native session. */
export interface CollaborationMemberView {
  readonly memberId: string;
  readonly participantId: string;
  readonly role: 'lead' | 'worker';
  readonly harnessKind: string;
  readonly session: SessionRef;
  readonly sessionKey: string;
}

/** The team read model the UI edits. */
export interface CollaborationTeamView {
  readonly teamId: string;
  readonly name: string;
  readonly members: readonly CollaborationMemberView[];
}

/** The five-budget read model (task 37/39's `budgets()`): the frozen limits and the observed use. */
export interface CollaborationBudgetView {
  readonly limits: Readonly<Record<string, number>>;
  readonly used: Readonly<Record<string, number>>;
}

/** One fan-out recipient (task 38's recipient view); its outcome is OBSERVED, never assumed. */
export interface CollaborationRecipientView {
  readonly recipientId: string;
  readonly participantId: string;
  readonly outcome: string;
  readonly attachmentPath: string | null;
  /** The service's OWN resolution object, crossing verbatim. */
  readonly resolution: { readonly code: string; readonly field: string } | null;
  /** The resolution's code under the name this view declares — see `toRecipientView`. */
  readonly resolutionCode: string | null;
}

/** The fan-out read model; `state` is derived from the OBSERVED per-recipient outcomes. */
export interface CollaborationFanoutView {
  readonly fanoutId: string;
  readonly state: string;
  readonly stats: Readonly<Record<string, number>>;
  readonly targets: readonly CollaborationRecipientView[];
  readonly retryable: readonly string[];
}

/** The writer read model: the OBSERVED lease path/resources plus the port's OWN posture object. */
export interface CollaborationWriterView {
  readonly leaseId: string;
  readonly worktree: string;
  readonly nativeCwd: string;
  readonly baseCommit: string;
  readonly policy: { readonly worktreeAccess: string; readonly userRepository: string };
  /** Task 40's frozen WRITER_ISOLATION, surfaced by identity — never a hardcoded posture. */
  readonly posture: Readonly<Record<string, unknown>>;
}

/** A change-review read model (task 41's review/approval): pending until an explicit approve. */
export interface CollaborationReviewView {
  readonly reviewId: string;
  readonly target: string;
  readonly artifactHash: string;
  readonly base: string;
  readonly state: 'pending' | 'approved';
  readonly reviewerId: string | null;
}

/* ------------------------------------------------------------------ narrow ports */

/** The frozen task view as the coordinator returns it (only the fields the UI reads). */
export interface CoordinatorTaskSnapshot {
  readonly taskId: string;
  readonly title: string;
  readonly state: string;
  readonly depth: number;
  readonly review: { readonly state: string; readonly reviewer: string | null; readonly reason: string | null };
  readonly acceptance: {
    readonly state: string;
    readonly acceptedBy: string | null;
    readonly deliverableId: string | null;
    readonly criteria: readonly string[];
  };
  readonly deliverables: readonly CollaborationDeliverableView[];
  readonly attempts: readonly string[];
  readonly owner: { readonly participantId: string; readonly session: SessionRef };
  readonly criteria: readonly { readonly id: string; readonly text: string; readonly required: boolean }[];
  readonly dependsOn: readonly string[];
  readonly children: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ambiguous: boolean;
  readonly paused: { readonly reasons: readonly string[] } | null;
}

export interface CoordinatorAttemptSnapshot {
  readonly attemptId: string;
  readonly state: string;
  readonly sent: boolean;
  readonly observed: boolean;
  readonly terminal: boolean;
  readonly terminalReason: string | null;
  readonly sends: number;
}

/** The landed task-37 coordinator, narrowed to the surface the UI drives. */
export interface CollaborationCoordinatorPort {
  createTeam(input: { name: string; at?: number }): { teamId: string; name: string };
  createTask(input: {
    teamId: string;
    title: string;
    criteria: readonly { id: string; text: string; required?: boolean }[];
    owner: { participantId: string; session: SessionRef };
    lease: { ownerId: string; expiresAt: number };
    parentId?: string | null;
    dependsOn?: readonly string[];
    at?: number;
  }): CoordinatorTaskSnapshot;
  task(taskId: string): CoordinatorTaskSnapshot;
  tasks(teamId?: string): readonly CoordinatorTaskSnapshot[];
  attempt(attemptId: string): CoordinatorAttemptSnapshot;
  dispatch(input: { taskId: string; prompt?: string; at?: number }): Promise<{ task: CoordinatorTaskSnapshot; attempt: CoordinatorAttemptSnapshot | null }>;
  send(input: { attemptId: string; at?: number }): Promise<{ task: CoordinatorTaskSnapshot; attempt: CoordinatorAttemptSnapshot }>;
  observeNativeEnd(input: { attemptId: string; reason: string; nativeEventId?: string; at?: number }): CoordinatorAttemptSnapshot;
  registerDeliverable(input: { taskId: string; deliverable: CollaborationDeliverableView; at?: number }): CoordinatorTaskSnapshot;
  submitForReview(input: { taskId: string; reviewer: string; at?: number }): CoordinatorTaskSnapshot;
  review(input: { taskId: string; decision: string; reviewer: string; reason?: string; at?: number }): CoordinatorTaskSnapshot;
  accept(input: { taskId: string; deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[]; at?: number }): CoordinatorTaskSnapshot;
  reject(input: { taskId: string; reason: string; at?: number }): CoordinatorTaskSnapshot;
  cancelTask(input: { taskId: string; reason?: string; at?: number }): CoordinatorTaskSnapshot;
  budgets(): { limits: Readonly<Record<string, number>>; used: Readonly<Record<string, number>> };
  close(): void;
}

/** The landed task-39 delegation service, narrowed to the team-member surface the UI shows. */
export interface CollaborationDelegationPort {
  createTeam(input: { name: string; environmentId: string; at?: number }): { teamId: string; name: string };
  addMember(input: {
    teamId: string;
    role: 'lead' | 'worker';
    harnessKind: string;
    session: SessionRef;
    participantId: string;
  }): { member: CollaborationMemberView };
  budgets(): { limits: Readonly<Record<string, number>>; used: Readonly<Record<string, number>> };
  close(): void;
}

/**
 * The landed task-38 recipient AS THE SERVICE RETURNS IT: the failure reason is an OBJECT under
 * `resolution` ({ code, field }), not the flat `resolutionCode` the view declares. The port types
 * below name this raw shape on purpose — declaring the view's shape here is what let the failure
 * reason silently fail to cross before.
 */
export interface FanoutRecipientSnapshot {
  readonly recipientId: string;
  readonly participantId: string;
  readonly outcome: string;
  readonly attachmentPath: string | null;
  readonly resolution: { readonly code: string; readonly field: string } | null;
}

/** The landed task-38 fan-out service, narrowed to create + dispatch. */
export interface CollaborationFanoutPort {
  createFanout(input: {
    prompt: string;
    targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[];
  }): {
    fanoutId: string;
    state: string;
    stats: Readonly<Record<string, number>>;
    targets: readonly FanoutRecipientSnapshot[];
  };
  dispatch(input: { fanoutId: string }): Promise<{
    fanoutId: string;
    state: string;
    stats: Readonly<Record<string, number>>;
    targets: readonly FanoutRecipientSnapshot[];
  }>;
  close(): void;
}

/** The landed task-40 writer-lease service, narrowed to allocate + lease + posture. */
export interface CollaborationWriterPort {
  allocate(input: { repository: string; taskId: string; ownerId: string; ttlMs?: number; at?: number; readOnly?: boolean }): Promise<{
    leaseId: string;
    worktree: string;
    nativeCwd: string;
    baseCommit: string;
    policy: { worktreeAccess: string; userRepository: string };
  }>;
  lease(leaseId: string): {
    leaseId: string;
    worktree: string;
    nativeCwd: string;
    baseCommit: string;
    policy: { worktreeAccess: string; userRepository: string };
  } | null;
  /** The service's OWN frozen posture object; the UI surfaces it verbatim. */
  posture(leaseId: string): Readonly<Record<string, unknown>>;
  close(): void;
}

export interface RuntimeCollaborationPorts {
  readonly coordinator: CollaborationCoordinatorPort;
  readonly delegation?: CollaborationDelegationPort | null;
  readonly fanout?: CollaborationFanoutPort | null;
  readonly writer?: CollaborationWriterPort | null;
}

/* ------------------------------------------------------------------ the phase derivation */

/**
 * THE three-state rule, in one place. Each phase is read from exactly one frozen product slice:
 *
 *   - `accepted`        ← `acceptance.state === 'accepted'`  (only the acceptance sink writes it)
 *   - `review-approved` ← `review.state === 'approved'`      (the reviewer's verdict is recorded;
 *                          this is the ONLY state the acceptance sink will accept from)
 *   - `review-pending`  ← `review.state === 'pending'`        (submitted, awaiting the verdict)
 *   - `agent-finished`  ← `state === 'review'`                (a native end moves the host here)
 *
 * A native terminal event writes the attempt's observation slice and moves the host to `review` at
 * most — it never touches `review.state` or `acceptance.state`, so it can reach `agent-finished`
 * but never `review-pending`, `review-approved` or `accepted`. The function is a pure projection
 * of frozen fields; it recomputes nothing and accepts no input that could reach those slices.
 *
 * `review-approved` is a DISTINCT phase because the acceptance sink refuses an accept whose review
 * is merely pending (conflict/acceptance_review): without it the verdict would fold back into
 * `agent-finished` and the accept affordance would be disabled exactly where the service accepts.
 */
export function deriveTaskPhase(snapshot: {
  readonly state: string;
  readonly review: { readonly state: string };
  readonly acceptance: { readonly state: string };
}): TaskPhase {
  if (snapshot.acceptance.state === 'accepted') return 'accepted';
  if (snapshot.acceptance.state === 'rejected') return 'failed';
  if (snapshot.review.state === 'pending') return 'review-pending';
  if (snapshot.review.state === 'approved') return 'review-approved';
  if (snapshot.state === 'review') return 'agent-finished';
  if (snapshot.state === 'accepted') return 'accepted';
  return snapshot.state as TaskPhase;
}

function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const protocol = error as { code?: unknown; field?: unknown };
    const code = typeof protocol.code === 'string' ? protocol.code : '';
    const field = typeof protocol.field === 'string' ? protocol.field : '';
    const detail = code || field ? ` (${[code, field].filter(Boolean).join('/')})` : '';
    return `${fallback}: ${error.message}${detail}`;
  }
  return fallback;
}

/**
 * The port adapter for one fan-out recipient. The landed task-38 service reports a failed
 * recipient's reason as an OBJECT under `resolution` ({ code, field }); the view declares the flat
 * `resolutionCode` the template renders. The conversion lives HERE, in the product-side port, so a
 * surface wired to the real service shows the service's own reason without any case-specific
 * patching: the service's `resolution` object crosses verbatim and the code is derived from it.
 */
function toRecipientView(raw: FanoutRecipientSnapshot): CollaborationRecipientView {
  return Object.freeze({
    recipientId: raw.recipientId,
    participantId: raw.participantId,
    outcome: raw.outcome,
    attachmentPath: raw.attachmentPath,
    resolution: raw.resolution,
    resolutionCode: raw.resolution === null ? null : raw.resolution.code,
  });
}

export interface RuntimeCollaborationState {
  /** False until a coordinator port exists; components render nothing when false. */
  readonly available: boolean;
  /** The captured Thread target every operation is scoped to. */
  readonly threadId: Ref<string | null>;
  readonly team: Ref<CollaborationTeamView | null>;
  readonly tasks: Ref<readonly CollaborationTaskView[]>;
  readonly selectedTaskId: Ref<string | null>;
  readonly selectedTask: ComputedRef<CollaborationTaskView | null>;
  readonly attempts: Ref<readonly CollaborationAttemptView[]>;
  readonly budgets: Ref<CollaborationBudgetView | null>;
  readonly fanout: Ref<CollaborationFanoutView | null>;
  readonly writer: Ref<CollaborationWriterView | null>;
  readonly busy: Ref<boolean>;
  readonly error: Ref<string>;
  openTeam(input: {
    threadId: string;
    teamName: string;
    environmentId: string;
    owner: { participantId: string; session: SessionRef };
    lease: { ownerId: string; expiresAt: number };
    repository?: string;
  }): Promise<void>;
  addMember(input: { role: 'lead' | 'worker'; harnessKind: string; session: SessionRef; participantId: string }): void;
  createTask(input: { title: string; criteria: readonly { id: string; text: string; required?: boolean }[] }): void;
  selectTask(taskId: string | null): void;
  dispatchTask(taskId: string): Promise<void>;
  sendTask(taskId: string): Promise<void>;
  finishTask(taskId: string, nativeEventId: string): void;
  registerDeliverable(taskId: string, deliverable: CollaborationDeliverableView): void;
  submitForReview(taskId: string, reviewer: string): void;
  reviewTask(taskId: string, decision: string, reviewer: string): void;
  acceptTask(taskId: string, input: { deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }): void;
  rejectTask(taskId: string, reason: string): void;
  cancelTask(taskId: string, reason?: string): void;
  fanOut(prompt: string, targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[]): Promise<void>;
  allocateWriter(taskId: string, repository: string): Promise<void>;
  /** The explicit apply-approve. It captures the Thread target and never pushes. */
  approveReview(taskId: string, reviewerId: string): void;
  closeTeam(): void;
}

const FROZEN_EMPTY: readonly never[] = Object.freeze([]);

function toTaskView(snapshot: CoordinatorTaskSnapshot): CollaborationTaskView {
  return Object.freeze({
    taskId: snapshot.taskId,
    title: snapshot.title,
    state: snapshot.state,
    phase: deriveTaskPhase(snapshot),
    depth: snapshot.depth,
    review: Object.freeze({
      state: snapshot.review.state,
      reviewer: snapshot.review.reviewer,
      reason: snapshot.review.reason,
    }),
    acceptance: Object.freeze({
      state: snapshot.acceptance.state,
      acceptedBy: snapshot.acceptance.acceptedBy,
      deliverableId: snapshot.acceptance.deliverableId,
      criteria: Object.freeze([...snapshot.acceptance.criteria]),
    }),
    deliverables: Object.freeze(snapshot.deliverables.map((entry) => Object.freeze({ ...entry }))),
    attempts: FROZEN_EMPTY,
    owner: snapshot.owner,
    criteria: snapshot.criteria,
    dependsOn: snapshot.dependsOn,
    children: snapshot.children,
    blockedBy: snapshot.blockedBy,
    ambiguous: snapshot.ambiguous,
    pausedReasons: Object.freeze(snapshot.paused === null ? [] : [...snapshot.paused.reasons]),
  });
}

export function createRuntimeCollaborationState(ports: RuntimeCollaborationPorts): RuntimeCollaborationState {
  const coordinator = ports.coordinator;
  const threadId = ref<string | null>(null);
  const team = ref<CollaborationTeamView | null>(null);
  const tasks = ref<readonly CollaborationTaskView[]>(FROZEN_EMPTY);
  const selectedTaskId = ref<string | null>(null);
  const attempts = ref<readonly CollaborationAttemptView[]>(FROZEN_EMPTY);
  const budgets = ref<CollaborationBudgetView | null>(null);
  const fanout = ref<CollaborationFanoutView | null>(null);
  const writer = ref<CollaborationWriterView | null>(null);
  const busy = ref(false);
  const error = ref('');
  /** teamId under the captured Thread target. */
  let teamId: string | null = null;
  /** The delegation service's OWN team id (distinct from the coordinator team id). */
  let delegationTeamId: string | null = null;
  /** The Thread target's owner + lease, reused by every task created in this team. */
  let owner: { participantId: string; session: SessionRef } | null = null;
  let lease: { ownerId: string; expiresAt: number } | null = null;
  /** taskId → the Thread target it was created under; the capture that criterion 4 enforces. */
  const taskThreads = new Map<string, string>();
  /** taskId → the writer lease observed for THAT task. Selecting a task shows its own lease. */
  const writers = new Map<string, CollaborationWriterView>();
  /**
   * The session generation. It advances on every openTeam / closeTeam, and every async operation
   * captures it before its await and re-checks it after: a completion that lands in a later
   * session is discarded rather than written back.
   */
  let session = 0;
  /** How many async operations are in flight; the surface is busy while ANY of them is. */
  let busyCount = 0;

  function beginBusy(): void {
    busyCount += 1;
    busy.value = true;
  }

  function endBusy(): void {
    if (busyCount > 0) busyCount -= 1;
    busy.value = busyCount > 0;
  }

  const selectedTask = computed<CollaborationTaskView | null>(
    () => tasks.value.find((entry) => entry.taskId === selectedTaskId.value) ?? null,
  );

  function fail(message: string): void {
    error.value = message;
  }

  function syncTasks(): void {
    // With no team open there is NOTHING to sync: reading every team the coordinator knows here
    // would repopulate a closed surface from an operation that belonged to a dead session.
    if (teamId === null) {
      tasks.value = FROZEN_EMPTY;
      return;
    }
    tasks.value = Object.freeze(coordinator.tasks(teamId).map(toTaskView));
  }

  function syncBudgets(): void {
    const view = coordinator.budgets();
    budgets.value = Object.freeze({ limits: view.limits, used: view.used });
  }

  function syncAttempts(task: CollaborationTaskView | null): void {
    if (task === null) {
      attempts.value = FROZEN_EMPTY;
      return;
    }
    // Read each attempt's ladder from the coordinator by id; the snapshot carries the ids.
    const snapshot = coordinator.task(task.taskId);
    attempts.value = Object.freeze(
      snapshot.attempts.map((attemptId) => {
        const attempt = coordinator.attempt(attemptId);
        return Object.freeze({
          attemptId: attempt.attemptId,
          state: attempt.state,
          sent: attempt.sent,
          observed: attempt.observed,
          terminal: attempt.terminal,
          terminalReason: attempt.terminalReason,
          sends: attempt.sends,
        });
      }),
    );
  }

  /**
   * Criterion 4: resolve a task ONLY when it was captured under the CURRENT Thread target. A task
   * from a different thread is refused with a readable error and never applied to the selection.
   */
  function requireTaskInThread(taskId: string): CollaborationTaskView | null {
    const currentThread = threadId.value;
    const captured = taskThreads.get(taskId);
    if (currentThread === null) {
      fail('No Thread target is open. Open a team under a Thread before operating on its tasks.');
      return null;
    }
    if (captured === undefined) {
      fail(`Task "${taskId}" is not part of the open Thread target.`);
      return null;
    }
    if (captured !== currentThread) {
      fail(`Task "${taskId}" belongs to a different Thread target and cannot be operated on here.`);
      return null;
    }
    // The task view comes from the coordinator (any task it knows), so the thread-capture check
    // above is the SOLE guard against operating on a foreign-thread task — removing it would let a
    // different thread's task be silently applied here.
    let snapshot: CoordinatorTaskSnapshot;
    try {
      snapshot = coordinator.task(taskId);
    } catch {
      fail(`Task "${taskId}" is not part of this team.`);
      return null;
    }
    return toTaskView(snapshot);
  }

  async function openTeam(input: {
    threadId: string;
    teamName: string;
    environmentId: string;
    owner: { participantId: string; session: SessionRef };
    lease: { ownerId: string; expiresAt: number };
    repository?: string;
  }): Promise<void> {
    // A new session: every operation still in flight from the previous one is discarded from here.
    session += 1;
    busyCount = 0;
    busy.value = true;
    error.value = '';
    try {
      const created = coordinator.createTeam({ name: input.teamName });
      teamId = created.teamId;
      threadId.value = input.threadId;
      owner = input.owner;
      lease = input.lease;
      const members: CollaborationMemberView[] = [];
      const delegation = ports.delegation ?? null;
      if (delegation !== null) {
        const delegationTeam = delegation.createTeam({ name: input.teamName, environmentId: input.environmentId });
        delegationTeamId = delegationTeam.teamId;
      }
      team.value = Object.freeze({ teamId: created.teamId, name: created.name, members: Object.freeze(members) });
      selectedTaskId.value = null;
      writers.clear();
      syncTasks();
      syncBudgets();
      writer.value = null;
      fanout.value = null;
    } catch (openError) {
      threadId.value = null;
      team.value = null;
      teamId = null;
      delegationTeamId = null;
      fail(readableError(openError, 'The collaboration team could not be opened'));
    } finally {
      busy.value = false;
      busyCount = 0;
    }
  }

  function addMember(input: { role: 'lead' | 'worker'; harnessKind: string; session: SessionRef; participantId: string }): void {
    const currentThread = threadId.value;
    const currentTeam = team.value;
    const delegation = ports.delegation ?? null;
    if (currentThread === null || currentTeam === null || delegation === null || delegationTeamId === null) {
      fail('A team must be open under a Thread target before a member can be added.');
      return;
    }
    error.value = '';
    try {
      const added = delegation.addMember({
        teamId: delegationTeamId,
        role: input.role,
        harnessKind: input.harnessKind,
        session: input.session,
        participantId: input.participantId,
      });
      team.value = Object.freeze({
        teamId: currentTeam.teamId,
        name: currentTeam.name,
        members: Object.freeze([...currentTeam.members, added.member]),
      });
      syncBudgets();
    } catch (memberError) {
      fail(readableError(memberError, 'The team member could not be added'));
    }
  }

  function createTask(input: { title: string; criteria: readonly { id: string; text: string; required?: boolean }[] }): void {
    const currentThread = threadId.value;
    const currentTeam = team.value;
    if (currentThread === null || currentTeam === null || teamId === null) {
      fail('A team must be open under a Thread target before a task can be created.');
      return;
    }
    error.value = '';
    try {
      if (owner === null || lease === null) {
        fail('A team must be open under a Thread target before a task can be created.');
        return;
      }
      const created = coordinator.createTask({
        teamId: teamId,
        title: input.title,
        criteria: input.criteria,
        owner,
        lease,
      });
      taskThreads.set(created.taskId, currentThread);
      syncTasks();
      syncBudgets();
    } catch (taskError) {
      fail(readableError(taskError, 'The task could not be created'));
    }
  }

  function selectTask(taskId: string | null): void {
    selectedTaskId.value = taskId;
    const task = tasks.value.find((entry) => entry.taskId === taskId) ?? null;
    syncAttempts(task);
    // The writer is kept PER TASK: selecting another task surfaces that task's own lease (or
    // nothing), never the last allocation's.
    writer.value = taskId === null ? null : writers.get(taskId) ?? null;
  }

  async function dispatchTask(taskId: string): Promise<void> {
    const task = requireTaskInThread(taskId);
    if (task === null) return;
    const operationSession = session;
    beginBusy();
    error.value = '';
    try {
      await coordinator.dispatch({ taskId });
      if (operationSession !== session) return;
      syncTasks();
      syncBudgets();
      syncAttempts(tasks.value.find((entry) => entry.taskId === taskId) ?? null);
    } catch (dispatchError) {
      if (operationSession !== session) return;
      fail(readableError(dispatchError, 'The task could not be dispatched'));
    } finally {
      endBusy();
    }
  }

  async function sendTask(taskId: string): Promise<void> {
    const task = requireTaskInThread(taskId);
    if (task === null) return;
    const snapshot = coordinator.task(taskId);
    const attemptId = snapshot.attempts[snapshot.attempts.length - 1];
    if (attemptId === undefined) {
      fail('The task has no attempt to send yet. Dispatch it first.');
      return;
    }
    const operationSession = session;
    beginBusy();
    error.value = '';
    try {
      await coordinator.send({ attemptId });
      if (operationSession !== session) return;
      syncTasks();
      syncBudgets();
      syncAttempts(tasks.value.find((entry) => entry.taskId === taskId) ?? null);
    } catch (sendError) {
      if (operationSession !== session) return;
      fail(readableError(sendError, 'The attempt could not be sent'));
    } finally {
      endBusy();
    }
  }

  function finishTask(taskId: string, nativeEventId: string): void {
    const task = requireTaskInThread(taskId);
    if (task === null) return;
    const snapshot = coordinator.task(taskId);
    const attemptId = snapshot.attempts[snapshot.attempts.length - 1];
    if (attemptId === undefined) {
      fail('The task has no attempt to finish.');
      return;
    }
    error.value = '';
    try {
      // A native end writes ONLY the attempt's observation slice and moves the host to `review`.
      coordinator.observeNativeEnd({ attemptId, reason: 'completed', nativeEventId });
      syncTasks();
      // The native end RELEASES the attempt's concurrency and session-mutation shares, so the
      // budget snapshot must be re-read here or the rendered use stays stale at the old value.
      syncBudgets();
      syncAttempts(tasks.value.find((entry) => entry.taskId === taskId) ?? null);
    } catch (endError) {
      fail(readableError(endError, 'The native end could not be recorded'));
    }
  }

  function registerDeliverable(taskId: string, deliverable: CollaborationDeliverableView): void {
    if (requireTaskInThread(taskId) === null) return;
    error.value = '';
    try {
      coordinator.registerDeliverable({ taskId, deliverable });
      syncTasks();
    } catch (deliverableError) {
      fail(readableError(deliverableError, 'The deliverable could not be registered'));
    }
  }

  function submitForReview(taskId: string, reviewer: string): void {
    if (requireTaskInThread(taskId) === null) return;
    error.value = '';
    try {
      coordinator.submitForReview({ taskId, reviewer });
      syncTasks();
    } catch (reviewError) {
      fail(readableError(reviewError, 'The task could not be submitted for review'));
    }
  }

  function reviewTask(taskId: string, decision: string, reviewer: string): void {
    if (requireTaskInThread(taskId) === null) return;
    error.value = '';
    try {
      coordinator.review({ taskId, decision, reviewer });
      syncTasks();
    } catch (reviewError) {
      fail(readableError(reviewError, 'The review could not be recorded'));
    }
  }

  function acceptTask(taskId: string, input: { deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }): void {
    if (requireTaskInThread(taskId) === null) return;
    error.value = '';
    try {
      coordinator.accept({ taskId, deliverableId: input.deliverableId, acceptedBy: input.acceptedBy, criteria: input.criteria });
      syncTasks();
    } catch (acceptError) {
      fail(readableError(acceptError, 'The task could not be accepted'));
    }
  }

  function rejectTask(taskId: string, reason: string): void {
    if (requireTaskInThread(taskId) === null) return;
    error.value = '';
    try {
      coordinator.reject({ taskId, reason });
      syncTasks();
    } catch (rejectError) {
      fail(readableError(rejectError, 'The task could not be rejected'));
    }
  }

  function cancelTask(taskId: string, reason?: string): void {
    if (requireTaskInThread(taskId) === null) return;
    error.value = '';
    try {
      coordinator.cancelTask({ taskId, ...(reason === undefined ? {} : { reason }) });
      syncTasks();
      syncBudgets();
      syncAttempts(tasks.value.find((entry) => entry.taskId === taskId) ?? null);
    } catch (cancelError) {
      fail(readableError(cancelError, 'The task could not be cancelled'));
    }
  }

  async function fanOut(
    prompt: string,
    targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[],
  ): Promise<void> {
    const fanoutPort = ports.fanout ?? null;
    if (fanoutPort === null) {
      fail('Fan-out is not wired to this surface yet.');
      return;
    }
    const operationSession = session;
    beginBusy();
    error.value = '';
    try {
      const created = fanoutPort.createFanout({ prompt, targets });
      const view = await fanoutPort.dispatch({ fanoutId: created.fanoutId });
      if (operationSession !== session) return;
      fanout.value = Object.freeze({
        fanoutId: view.fanoutId,
        state: view.state,
        stats: view.stats,
        // The contract conversion happens HERE, in the product-side port: the service's own
        // `resolution` object crosses verbatim and the flat `resolutionCode` the template renders
        // is derived from it, so a failed recipient's reason is never lost between service and UI.
        targets: Object.freeze(view.targets.map(toRecipientView)),
        retryable: FROZEN_EMPTY,
      });
    } catch (fanoutError) {
      if (operationSession !== session) return;
      fail(readableError(fanoutError, 'The fan-out could not be dispatched'));
    } finally {
      endBusy();
    }
  }

  async function allocateWriter(taskId: string, repository: string): Promise<void> {
    const writerPort = ports.writer ?? null;
    const task = requireTaskInThread(taskId);
    if (task === null || writerPort === null) {
      if (writerPort === null) fail('The writer-lease service is not wired to this surface yet.');
      return;
    }
    const operationSession = session;
    beginBusy();
    error.value = '';
    try {
      const lease = await writerPort.allocate({ repository, taskId, ownerId: task.owner.participantId });
      if (operationSession !== session) return;
      // The posture is the port's OWN frozen object, surfaced verbatim by identity.
      const view = Object.freeze({
        leaseId: lease.leaseId,
        worktree: lease.worktree,
        nativeCwd: lease.nativeCwd,
        baseCommit: lease.baseCommit,
        policy: lease.policy,
        posture: writerPort.posture(lease.leaseId),
      });
      writers.set(taskId, view);
      // Only the CURRENTLY selected task's lease is surfaced: an allocation that completes after
      // the user moved on must not overwrite the new selection's writer state.
      const currentSelection = selectedTaskId.value;
      writer.value = currentSelection === taskId
        ? view
        : currentSelection === null ? null : writers.get(currentSelection) ?? null;
    } catch (allocateError) {
      if (operationSession !== session) return;
      fail(readableError(allocateError, 'The writer lease could not be allocated'));
    } finally {
      endBusy();
    }
  }

  /**
   * The explicit apply-approve (criterion 3). It captures the Thread target, requires the task to
   * be in this thread, and NEVER pushes: it advances the task's review only. There is no auto-push
   * path and no function anywhere accepts a push/remote claim.
   */
  function approveReview(taskId: string, reviewerId: string): void {
    const task = requireTaskInThread(taskId);
    if (task === null) return;
    error.value = '';
    // A review is approved only from an explicitly submitted, review-pending task.
    if (task.phase !== 'review-pending') {
      fail(`Task "${taskId}" is at "${task.phase}"; only a review-pending task can be approved.`);
      return;
    }
    coordinator.review({ taskId, decision: 'approved', reviewer: reviewerId });
    syncTasks();
  }

  function closeTeam(): void {
    // A new session: every operation still in flight from the closed one is discarded from here,
    // and nothing it completes afterwards may write back to this surface.
    session += 1;
    busyCount = 0;
    threadId.value = null;
    team.value = null;
    teamId = null;
    delegationTeamId = null;
    owner = null;
    lease = null;
    tasks.value = FROZEN_EMPTY;
    selectedTaskId.value = null;
    attempts.value = FROZEN_EMPTY;
    budgets.value = null;
    fanout.value = null;
    writer.value = null;
    writers.clear();
    taskThreads.clear();
    busy.value = false;
  }

  return {
    available: true,
    threadId,
    team,
    tasks,
    selectedTaskId,
    selectedTask,
    attempts,
    budgets,
    fanout,
    writer,
    busy,
    error,
    openTeam,
    addMember,
    createTask,
    selectTask,
    dispatchTask,
    sendTask,
    finishTask,
    registerDeliverable,
    submitForReview,
    reviewTask,
    acceptTask,
    rejectTask,
    cancelTask,
    fanOut,
    allocateWriter,
    approveReview,
    closeTeam,
  };
}

/**
 * Injection key a container provides so the collaboration surfaces can host this state. Absent →
 * the surfaces keep their legacy behaviour exactly.
 */
export const RUNTIME_COLLABORATION_STATE_KEY: InjectionKey<RuntimeCollaborationState | null> = Symbol(
  'vis.runtime.collaborationState',
);

/** Resolve the optional collaboration state; null when no container provides one. */
export function useRuntimeCollaborationState(): RuntimeCollaborationState | null {
  return inject(RUNTIME_COLLABORATION_STATE_KEY, null);
}
