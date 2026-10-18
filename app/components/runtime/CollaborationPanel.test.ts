/**
 * Task 42 acceptance tests — the Team task and change-review UI, mounted for real.
 *
 * Four hard acceptance criteria, each proven by a NAMED test that drives the REAL product (the
 * landed task-37 coordinator, task-38 fan-out service, task-39 delegation service and task-40
 * writer-lease service, loaded through the createRequire boundary exactly like task 34/35) through
 * the REAL composable and the REAL components over a real happy-dom mount. Every expected value
 * was derived by driving the real product in a throwaway probe first.
 *
 *   1. 明确区分 Agent finished / Task review pending / accepted — three DISTINCT phases, each
 *      derived from exactly one product slice, and a native terminal event structurally cannot
 *      render `accepted` (tests: "renders Agent finished, review pending and accepted as three
 *      distinct phases derived only from the product", "a native end alone never renders accepted").
 *   2. 显示 writer 路径与资源 — the OBSERVED lease path/resources render (test: "shows the writer
 *      path and resources from the real lease").
 *   3. 不得引入自动 push 默认或假 read-only capability — the posture is the port's OWN frozen
 *      WRITER_ISOLATION (sandbox:false), no function accepts a sandbox claim, and approve is the
 *      only forward action (tests: "surfaces the real WRITER_ISOLATION posture and never a fake
 *      read-only capability", "approve is the only forward action and there is no auto-push").
 *   4. 操作捕获 Thread target — every operation is scoped to the captured Thread target, and a
 *      target from a different thread is refused (test: "an operation on a task from a different
 *      Thread target is refused, not silently applied").
 */
import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

import type { SessionRef } from '../../../shared/runtime/identity.js';
import type {
  RuntimeCollaborationPorts,
  RuntimeCollaborationState,
} from '../../composables/useRuntimeCollaboration';
import { createRuntimeCollaborationState } from '../../composables/useRuntimeCollaboration';
import CollaborationPanel from './CollaborationPanel.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const require = createRequire(import.meta.url);
const COLLAB = '../../../bridge/runtime/collaboration';
const { createCollaborationCoordinator } = require(`${COLLAB}/coordinator.js`) as {
  createCollaborationCoordinator(options?: { deliver?: (payload: unknown) => Promise<{ ackId: string }> }): RuntimeCollaborationPorts['coordinator'];
};
const { createDelegationService } = require(`${COLLAB}/delegationService.js`) as {
  createDelegationService(options: { mailbox: unknown; deliver: (payload: unknown) => Promise<{ ackId: string }> }): RuntimeCollaborationPorts['delegation'] & object;
};
const { createMailbox } = require(`${COLLAB}/mailbox.js`) as { createMailbox(): unknown };
const { createFanoutService } = require(`${COLLAB}/fanoutService.js`) as {
  createFanoutService(options: { deliver: (target: { participantId: string }) => Promise<{ ackId: string }> }): RuntimeCollaborationPorts['fanout'] & object;
};
const writerLeases = require(`${COLLAB}/writerLeases.js`) as {
  createWriterLeaseService(options: { writersRoot: string }): RuntimeCollaborationPorts['writer'] & object;
  WRITER_ISOLATION: Readonly<Record<string, unknown>>;
  POSTURE_KEYS: readonly string[];
};

const ENV = '11111111-1111-4111-8111-111111111111';
const H_LEAD = '22222222-2222-4222-8222-222222222222';
const H_WORKER = '33333333-3333-4333-8333-333333333333';
const LEAD_P = 'aaaaaaaa-1111-4111-8111-111111111111';
const WORKER_P = 'bbbbbbbb-2222-4222-8222-222222222222';
const THREAD_1 = 'cccccccc-1111-4111-8111-111111111111';
const THREAD_2 = 'dddddddd-2222-4222-8222-222222222222';
const LEASE_OWNER = 'eeeeeeee-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

const LEAD_SESSION: SessionRef = Object.freeze({ environmentId: ENV, harnessInstanceId: H_LEAD, nativeSessionId: 'lead-session' }) as SessionRef;
const WORKER_SESSION: SessionRef = Object.freeze({ environmentId: ENV, harnessInstanceId: H_WORKER, nativeSessionId: 'worker-session' }) as SessionRef;
const OWNER = Object.freeze({ participantId: LEAD_P, session: LEAD_SESSION });
const LEASE = Object.freeze({ ownerId: LEASE_OWNER, expiresAt: 9_999_999_999_999 });

async function settle(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

interface Services {
  coordinator: RuntimeCollaborationPorts['coordinator'];
  delegation: RuntimeCollaborationPorts['delegation'] & object;
  fanout: RuntimeCollaborationPorts['fanout'] & object;
  ports: RuntimeCollaborationPorts;
  /** participantIds whose fan-out delivery fails, to exercise the partial state. */
  failFor: Set<string>;
}

function buildServices(): Services {
  const failFor = new Set<string>();
  const coordinator = createCollaborationCoordinator();
  const mailbox = createMailbox();
  const delegation = createDelegationService({
    mailbox,
    deliver: async () => ({ ackId: `ack-${Math.random()}` }),
  });
  const fanout = createFanoutService({
    deliver: async (target: { participantId: string }) => {
      if (failFor.has(target.participantId)) {
        throw Object.assign(new Error('source unavailable'), { code: 'source_unavailable', field: 'fanout_send' });
      }
      return { ackId: `ack-${target.participantId}` };
    },
  });
  return { coordinator, delegation, fanout, ports: { coordinator, delegation, fanout }, failFor };
}

interface Mounted {
  root: HTMLElement;
  state: RuntimeCollaborationState;
  emitted: Map<string, unknown[]>;
  unmount(): void;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount();
  document.body.innerHTML = '';
});

function containerProps(state: RuntimeCollaborationState, emitted: Map<string, unknown[]>) {
  return {
    open: true,
    threadId: state.threadId.value,
    team: state.team.value,
    tasks: state.tasks.value,
    selectedTaskId: state.selectedTaskId.value,
    selectedTask: state.selectedTask.value,
    attempts: state.attempts.value,
    budgets: state.budgets.value,
    fanout: state.fanout.value,
    writer: state.writer.value,
    busy: state.busy.value,
    error: state.error.value,
    onClose: () => emitted.set('close', []),
    'onSelect-task': (taskId: string) => { state.selectTask(taskId); emitted.set('select-task', [taskId]); },
    'onAdd-member': (input: unknown) => { state.addMember(input as Parameters<RuntimeCollaborationState['addMember']>[0]); },
    'onCreate-task': (input: unknown) => { state.createTask(input as Parameters<RuntimeCollaborationState['createTask']>[0]); },
    'onFan-out': (input: unknown) => { void state.fanOut(...(input as Parameters<RuntimeCollaborationState['fanOut']>)); },
    onDispatch: (taskId: string) => { void state.dispatchTask(taskId); },
    onSend: (taskId: string) => { void state.sendTask(taskId); },
    'onFinish': (input: { taskId: string; nativeEventId: string }) => { state.finishTask(input.taskId, input.nativeEventId); },
    'onRegister-deliverable': (input: { taskId: string; deliverable: unknown }) => { state.registerDeliverable(input.taskId, input.deliverable as Parameters<RuntimeCollaborationState['registerDeliverable']>[1]); },
    'onSubmit-review': (input: { taskId: string; reviewer: string }) => { state.submitForReview(input.taskId, input.reviewer); },
    onReview: (input: { taskId: string; decision: string; reviewer: string }) => { state.reviewTask(input.taskId, input.decision, input.reviewer); },
    onAccept: (input: { taskId: string; deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }) => { state.acceptTask(input.taskId, input); },
    onReject: (input: { taskId: string; reason: string }) => { state.rejectTask(input.taskId, input.reason); },
    onCancel: (input: { taskId: string; reason?: string }) => { state.cancelTask(input.taskId, input.reason); },
    'onAllocate-writer': (input: { taskId: string; repository: string }) => { void state.allocateWriter(input.taskId, input.repository); },
    onApprove: (input: { taskId: string; reviewerId: string }) => { state.approveReview(input.taskId, input.reviewerId); },
  };
}

async function mountPanel(
  ports: RuntimeCollaborationPorts,
  options: Readonly<{ threadId?: string; withWriter?: boolean }> = {},
): Promise<Mounted> {
  const state = createRuntimeCollaborationState(ports);
  await state.openTeam({
    threadId: options.threadId ?? THREAD_1,
    teamName: 'Team Alpha',
    environmentId: ENV,
    owner: OWNER,
    lease: LEASE,
  });
  state.addMember({ role: 'lead', harnessKind: 'opencode', session: LEAD_SESSION, participantId: LEAD_P });
  state.addMember({ role: 'worker', harnessKind: 'acp', session: WORKER_SESSION, participantId: WORKER_P });
  const emitted = new Map<string, unknown[]>();
  const Container = defineComponent({
    setup() {
      return { state };
    },
    render() {
      return h(CollaborationPanel, containerProps(this.state, emitted));
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(Container);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  await settle();
  const entry: Mounted = { root: host, state, emitted, unmount: () => app.unmount() };
  mounted.push(entry);
  void options.withWriter;
  return entry;
}

function phaseOf(view: Mounted, taskId: string): string | null {
  return view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"]`)?.getAttribute('data-phase') ?? null;
}

// ---------------------------------------------------------------------------
// Acceptance 1 — three distinct phases, each derived from exactly one product slice
// ---------------------------------------------------------------------------

describe('task 42 — Agent finished / Task review pending / accepted are three distinct phases', () => {
  it('renders Agent finished, review pending and accepted as three distinct phases derived only from the product', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    view.state.createTask({ title: 'Implement the collaboration UI', criteria: [{ id: 'c1', text: 'renders three states', required: true }] });
    await settle();
    const taskId = view.state.tasks.value[0]?.taskId ?? '';
    view.state.selectTask(taskId);
    await settle();

    // pending → dispatched: the chip names the raw host state.
    expect(phaseOf(view, taskId)).toBe('pending');
    await view.state.dispatchTask(taskId);
    await settle();
    expect(phaseOf(view, taskId)).toBe('dispatched');
    await view.state.sendTask(taskId);
    await settle();

    // The native-end action is DISABLED until a real native event id exists, so the UI structurally
    // cannot fabricate the agent-finished transition without one (task 35's observe-button standard).
    expect(view.root.querySelector<HTMLButtonElement>('[data-testid="attempt-finish"]')?.disabled).toBe(true);

    // A native end with a real native event id moves the task to AGENT FINISHED (never accepted).
    view.state.finishTask(taskId, 'native-evt-1');
    await settle();
    expect(phaseOf(view, taskId)).toBe('agent-finished');
    expect(view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"] [data-testid="phase-chip"]`)?.textContent).toContain('Agent finished');
    // The attempt reached its terminal rung with the observed reason.
    const attemptRow = view.root.querySelector('[data-testid="attempt-row"]');
    expect(attemptRow?.getAttribute('data-state')).toBe('terminal');
    expect(view.root.querySelector('[data-testid="attempt-reason"]')?.textContent).toBe('completed');

    // Register a deliverable, then submit for review → REVIEW PENDING (a distinct phase).
    view.state.registerDeliverable(taskId, { deliverableId: 'deliv-1', artifactHash: HASH, bytes: 2048, paths: ['src/App.vue'] });
    await settle();
    view.state.submitForReview(taskId, 'reviewer-1');
    await settle();
    expect(phaseOf(view, taskId)).toBe('review-pending');
    expect(view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"] [data-testid="phase-chip"]`)?.textContent).toContain('Review pending');

    // Approve the review, then accept → ACCEPTED (a third distinct phase).
    view.state.reviewTask(taskId, 'approved', 'reviewer-1');
    await settle();
    view.state.acceptTask(taskId, { deliverableId: 'deliv-1', acceptedBy: 'reviewer-1', criteria: [{ id: 'c1', met: true }] });
    await settle();
    expect(phaseOf(view, taskId)).toBe('accepted');
    expect(view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"] [data-testid="phase-chip"]`)?.textContent).toContain('Accepted');
  });

  it('a native end alone never renders accepted, and cannot reach the acceptance slice', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    view.state.createTask({ title: 'Native end only', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskId = view.state.tasks.value[0]?.taskId ?? '';
    await view.state.dispatchTask(taskId);
    await settle();
    await view.state.sendTask(taskId);
    await settle();
    // Drive the native end through the REAL coordinator — the only writer it has is the attempt's
    // observation slice, whose type has no member reaching review/acceptance/deliverables.
    view.state.finishTask(taskId, 'native-evt-2');
    await settle();

    const snapshot = services.coordinator.task(taskId);
    expect(snapshot.state).toBe('review');
    expect(snapshot.review.state).toBe('none');
    expect(snapshot.acceptance.state).toBe('none');
    // The UI renders AGENT FINISHED, never review-pending or accepted.
    expect(phaseOf(view, taskId)).toBe('agent-finished');
    const chip = view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"] [data-testid="phase-chip"]`);
    expect(chip?.textContent).not.toContain('Accepted');
    expect(chip?.textContent).not.toContain('Review pending');
    // The submit-for-review and accept affordances are disabled at agent-finished-with-no-review,
    // so a native end cannot be walked forward into acceptance without the explicit review path.
    expect(view.root.querySelector('[data-testid="task-accept"]')?.hasAttribute('disabled')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4 — operations capture the Thread target; a foreign target is refused
// ---------------------------------------------------------------------------

describe('task 42 — operations capture the Thread target', () => {
  it('an operation on a task from a different Thread target is refused, not silently applied', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports, { threadId: THREAD_1 });
    view.state.createTask({ title: 'Task under thread 1', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskInThread1 = view.state.tasks.value[0]?.taskId ?? '';
    expect(view.state.threadId.value).toBe(THREAD_1);

    // Walk the thread-1 task all the way to an APPROVED review with a registered deliverable, so
    // that if the cross-thread guard were removed the accept below would genuinely SUCCEED — a real
    // silent application, not a validation refusal.
    await view.state.dispatchTask(taskInThread1);
    await settle();
    await view.state.sendTask(taskInThread1);
    await settle();
    view.state.finishTask(taskInThread1, 'native-evt-t1');
    await settle();
    view.state.registerDeliverable(taskInThread1, { deliverableId: 'deliv-t1', artifactHash: HASH, bytes: 10, paths: ['a.txt'] });
    view.state.submitForReview(taskInThread1, 'reviewer-1');
    await settle();
    view.state.reviewTask(taskInThread1, 'approved', 'reviewer-1');
    await settle();
    expect(services.coordinator.task(taskInThread1).review.state).toBe('approved');

    // Open a SECOND team under a DIFFERENT Thread target. The current target becomes THREAD_2.
    await view.state.openTeam({ threadId: THREAD_2, teamName: 'Team Beta', environmentId: ENV, owner: OWNER, lease: LEASE });
    await settle();
    expect(view.state.threadId.value).toBe(THREAD_2);

    // Operating on the thread-1 task now is REFUSED with a readable error — never silently applied.
    view.state.error.value = '';
    view.state.acceptTask(taskInThread1, { deliverableId: 'deliv-t1', acceptedBy: 'reviewer-1', criteria: [{ id: 'c1', met: true }] });
    await settle();
    expect(view.state.error.value).toContain('different Thread target');
    // Nothing was accepted on the foreign task: its acceptance slice is untouched, even though it
    // was fully reviewable — the Thread-target capture is what refuses it.
    expect(services.coordinator.task(taskInThread1).acceptance.state).toBe('none');

    // The current thread's own task IS operable, proving the capture is per-thread, not a blanket block.
    view.state.createTask({ title: 'Task under thread 2', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskInThread2 = view.state.tasks.value.find((entry) => entry.title === 'Task under thread 2')?.taskId ?? '';
    await view.state.dispatchTask(taskInThread2);
    await settle();
    expect(view.state.error.value).toBe('');
    expect(phaseOf(view, taskInThread2)).toBe('dispatched');
  });
});

// ---------------------------------------------------------------------------
// What to build — fan-out targets / partial, Team members (harness / role), budget
// ---------------------------------------------------------------------------

describe('task 42 — fan-out partial, team members and budget', () => {
  it('renders the fan-out PARTIAL state from the observed per-recipient outcomes', async () => {
    const services = buildServices();
    services.failFor.add(WORKER_P);
    const view = await mountPanel(services.ports);
    // Fan out to every member; the worker's delivery fails, so the observed state is partial.
    await view.state.fanOut('review this', [
      { participantId: LEAD_P, session: LEAD_SESSION },
      { participantId: WORKER_P, session: WORKER_SESSION },
    ]);
    await settle();

    const fanoutState = view.root.querySelector('[data-testid="fanout-state"]');
    expect(fanoutState?.getAttribute('data-state')).toBe('partial');
    expect(fanoutState?.textContent).toContain('partial');
    const stats = view.root.querySelector('[data-testid="fanout-stats"]')?.textContent ?? '';
    expect(stats).toContain('sent 1');
    expect(stats).toContain('failed 1');
    // Each recipient renders its OWN observed outcome, never a synthetic success.
    const outcomes = [...view.root.querySelectorAll('[data-testid="fanout-recipient"]')].map((row) => [
      row.getAttribute('data-participant-id'),
      row.getAttribute('data-outcome'),
    ]);
    expect(outcomes).toEqual([
      [LEAD_P, 'sent'],
      [WORKER_P, 'failed'],
    ]);
  });

  it('renders each team member with its harness and role, and the concurrency budget', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    const members = [...view.root.querySelectorAll('[data-testid="member-row"]')].map((row) => [
      row.getAttribute('data-role'),
      row.getAttribute('data-harness'),
    ]);
    expect(members).toEqual([
      ['lead', 'opencode'],
      ['worker', 'acp'],
    ]);
    // The budget row names the real frozen concurrency limit and its observed use.
    const concurrency = view.root.querySelector('[data-testid="budget-row"][data-budget-key="maxConcurrency"]');
    expect(concurrency?.textContent).toContain('4');
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2 & 3 — writer path / resources, real posture, explicit approve (real writerLeases)
// ---------------------------------------------------------------------------

describe('task 42 — writer path, real posture and explicit apply-approve', () => {
  let repoDir = '';
  let writersRoot = '';
  let writer: (RuntimeCollaborationPorts['writer'] & object) | null = null;

  beforeAll(() => {
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'vis-task42-repo-'));
    writersRoot = mkdtempSync(path.join(os.tmpdir(), 'vis-task42-writers-'));
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'vis@example.invalid']);
    git(['config', 'user.name', 'vis']);
    writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'base']);
    writer = writerLeases.createWriterLeaseService({ writersRoot });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(writersRoot, { recursive: true, force: true });
  });

  it('shows the writer path and resources from the real lease', async () => {
    const services = buildServices();
    const view = await mountPanel({ ...services.ports, writer: writer! });
    view.state.createTask({ title: 'Writer task', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskId = view.state.tasks.value[0]?.taskId ?? '';
    view.state.selectTask(taskId);
    await view.state.allocateWriter(taskId, repoDir);
    await settle();

    const lease = writer!.lease(view.state.writer.value?.leaseId ?? '') as { worktree: string; nativeCwd: string; baseCommit: string } | null;
    expect(lease).not.toBeNull();
    // The UI renders the OBSERVED lease path and base commit verbatim — nothing invented.
    expect(view.root.querySelector('[data-testid="writer-worktree"]')?.textContent).toBe(lease!.worktree);
    expect(view.root.querySelector('[data-testid="writer-native-cwd"]')?.textContent).toBe(lease!.nativeCwd);
    expect(view.root.querySelector('[data-testid="writer-base-commit"]')?.getAttribute('title')).toBe(lease!.baseCommit);
    // The user repository is read-only to the writer (the real policy), the worktree is read-write.
    expect(view.root.querySelector('[data-testid="writer-user-repository"]')?.textContent).toBe('read-only');
    expect(view.root.querySelector('[data-testid="writer-worktree-access"]')?.textContent).toBe('read-write');
  });

  it('surfaces the real WRITER_ISOLATION posture and never a fake read-only capability', async () => {
    const services = buildServices();
    const view = await mountPanel({ ...services.ports, writer: writer! });
    view.state.createTask({ title: 'Posture task', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskId = view.state.tasks.value[0]?.taskId ?? '';
    view.state.selectTask(taskId);
    await view.state.allocateWriter(taskId, repoDir);
    await settle();

    // The posture the UI shows IS the port's OWN frozen object, by identity — never a hardcoded one.
    expect(view.state.writer.value?.posture).toBe(writerLeases.WRITER_ISOLATION);
    expect(writerLeases.WRITER_ISOLATION.sandbox).toBe(false);
    expect(Object.keys(view.state.writer.value?.posture ?? {}).sort()).toEqual([...writerLeases.POSTURE_KEYS].sort());
    // The rendered posture states sandbox:false and lists what is NOT provided (a real sandbox claim
    // is never fabricated — "no ... sandbox" appears among the notProvided entries).
    expect(view.root.querySelector('[data-testid="posture-sandbox-value"]')?.textContent).toBe('false');
    const notProvided = view.root.querySelector('[data-testid="posture-not-provided"]')?.textContent ?? '';
    expect(notProvided.toLowerCase()).toContain('sandbox');
  });

  it('approve is the only forward action and there is no auto-push default', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    view.state.createTask({ title: 'Approve task', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskId = view.state.tasks.value[0]?.taskId ?? '';
    view.state.selectTask(taskId);
    await settle();

    // Approve is disabled until the task is review-pending — nothing auto-advances.
    const approve = view.root.querySelector<HTMLButtonElement>('[data-testid="approve-integration"]');
    expect(approve?.disabled).toBe(true);

    // No push/remote ACTION exists anywhere in the change-review surface: there is no button or
    // testid that would push or set a remote. (The note's own wording — "Nothing is pushed
    // automatically" — is the honest disclosure that there is no auto-push default.)
    const pushButtons = [...view.root.querySelectorAll('button')].filter((button) => /push|remote/i.test(button.textContent ?? ''));
    expect(pushButtons).toHaveLength(0);
    const panelTestids = [...view.root.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid') ?? '');
    expect(panelTestids.some((id) => /push|remote/i.test(id))).toBe(false);
    expect(view.root.querySelector('[data-testid="approve-note"]')?.textContent).toContain('Nothing is pushed automatically');

    // Walk the task to review-pending, then the explicit approve is the only forward action.
    await view.state.dispatchTask(taskId);
    await settle();
    await view.state.sendTask(taskId);
    await settle();
    view.state.finishTask(taskId, 'native-evt-3');
    await settle();
    view.state.registerDeliverable(taskId, { deliverableId: 'deliv-1', artifactHash: HASH, bytes: 10, paths: ['a.txt'] });
    view.state.submitForReview(taskId, 'reviewer-1');
    await settle();
    expect(view.root.querySelector<HTMLButtonElement>('[data-testid="approve-integration"]')?.disabled).toBe(false);

    view.state.approveReview(taskId, 'reviewer-1');
    await settle();
    // Approval records the reviewer's verdict; it never claims a push happened.
    expect(services.coordinator.task(taskId).review.state).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// The eight PR #198 review findings — each reproduced RED-first against the reviewed head
// (b62b3c49e6) and then closed in the product code.
// ---------------------------------------------------------------------------

describe('task 42 — the eight PR #198 review findings', () => {
  async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await settle();
    }
  }

  function buttonOf(view: Mounted, testId: string): HTMLButtonElement {
    const button = view.root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no [data-testid="${testId}"] in the mounted panel`);
    return button;
  }

  function rowButtonOf(view: Mounted, taskId: string, testId: string): HTMLButtonElement {
    const row = view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"]`);
    const button = row?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`) ?? null;
    if (button === null) throw new Error(`no [data-testid="${testId}"] in the row of ${taskId}`);
    return button;
  }

  async function typeNativeEventId(view: Mounted, value: string): Promise<void> {
    const input = view.root.querySelector<HTMLInputElement>('[data-testid="native-event-input"]');
    if (input === null) throw new Error('no native event input in the mounted panel');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Let the v-model land and the dependent disabled binding re-render before the next click.
    await settle();
  }

  /** Create one task through the container action (TeamEditor renders no create button). */
  async function createOneTask(view: Mounted, title: string): Promise<string> {
    view.state.createTask({ title, criteria: [{ id: 'c1', text: 'x', required: true }] });
    const taskId = view.state.tasks.value.find((entry) => entry.title === title)?.taskId ?? '';
    if (taskId === '') throw new Error(`the task "${title}" was not created`);
    await settle();
    return taskId;
  }

  /** A promise plus its resolver, typed so the resolver is callable after the closure runs. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settleResolve) => { resolve = settleResolve; });
    return { promise, resolve };
  }

  it('W1: the review chain is walkable through the REAL buttons: submit → approve → Accept reaches accepted', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    const taskId = await createOneTask(view, 'Walk to accepted');
    buttonOf(view, 'task-select').click();
    await settle();
    buttonOf(view, 'task-dispatch').click();
    await settle();
    buttonOf(view, 'attempt-send').click();
    await settle();
    await typeNativeEventId(view, 'native-evt-w1');
    buttonOf(view, 'attempt-finish').click();
    await settle();
    expect(phaseOf(view, taskId)).toBe('agent-finished');
    // A REAL deliverable is registered through the composable (the container's job — W2 proves the
    // UI button itself no longer fabricates one).
    view.state.registerDeliverable(taskId, { deliverableId: 'deliv-w1', artifactHash: HASH, bytes: 2048, paths: ['src/App.vue'] });
    buttonOf(view, 'submit-review').click();
    await settle();
    expect(phaseOf(view, taskId)).toBe('review-pending');

    // At review-pending the Accept button is DISABLED: the real acceptanceService refuses an
    // accept whose review is not yet approved (conflict/acceptance_review), so the affordance is
    // not offered where the service would refuse it.
    expect(buttonOf(view, 'task-accept').disabled).toBe(true);

    // The explicit approve records the verdict — and the task moves to the phase where the
    // service will actually accept, instead of falling back to agent-finished with the buttons
    // disabled.
    buttonOf(view, 'approve-integration').click();
    await settle();
    expect(services.coordinator.task(taskId).review.state).toBe('approved');
    expect(phaseOf(view, taskId)).toBe('review-approved');

    // Accept is ENABLED at the real review state, and clicking it reaches accepted.
    const accept = buttonOf(view, 'task-accept');
    expect(accept.disabled).toBe(false);
    accept.click();
    await settle();
    expect(phaseOf(view, taskId)).toBe('accepted');
    expect(services.coordinator.task(taskId).acceptance.state).toBe('accepted');
    expect(view.root.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"] [data-testid="phase-chip"]`)?.textContent).toContain('Accepted');
  });

  it('W2: the Register deliverable button no longer fabricates artifact metadata', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    const taskId = await createOneTask(view, 'No fabricated deliverable');
    buttonOf(view, 'task-select').click();
    await settle();
    buttonOf(view, 'task-dispatch').click();
    await settle();
    buttonOf(view, 'attempt-send').click();
    await settle();
    await typeNativeEventId(view, 'native-evt-w2');
    buttonOf(view, 'attempt-finish').click();
    await settle();
    expect(phaseOf(view, taskId)).toBe('agent-finished');

    // With no captured artifact there is nothing real to register, so the button is disabled and
    // says why instead of writing an all-zero hash, zero bytes and a synthetic path.
    const register = buttonOf(view, 'register-deliverable');
    expect(register.disabled).toBe(true);
    expect(view.root.querySelector('[data-testid="register-deliverable-note"]')?.textContent ?? '')
      .toMatch(/artifact/i);
    register.click();
    await settle();
    // Nothing was fabricated into the real coordinator.
    expect(services.coordinator.task(taskId).deliverables).toEqual([]);
    expect(view.root.querySelector('[data-testid="deliverable-list"]')).toBeNull();

    // A REAL deliverable still registers through the composable and renders as the FIRST row.
    view.state.registerDeliverable(taskId, { deliverableId: 'deliv-w2', artifactHash: HASH, bytes: 512, paths: ['src/real.txt'] });
    await settle();
    const rows = [...view.root.querySelectorAll('[data-testid="deliverable-row"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-deliverable-id')).toBe('deliv-w2');
    expect(rows[0]?.textContent).toContain(HASH.slice(0, 12));
  });

  it('W3: the approve affordance says what it does — it records the review verdict, it does not apply files', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    const taskId = await createOneTask(view, 'Honest approve');
    buttonOf(view, 'task-select').click();
    await settle();
    await view.state.dispatchTask(taskId);
    await settle();
    await view.state.sendTask(taskId);
    await settle();
    view.state.finishTask(taskId, 'native-evt-w3');
    await settle();
    view.state.registerDeliverable(taskId, { deliverableId: 'deliv-w3', artifactHash: HASH, bytes: 8, paths: ['a.txt'] });
    view.state.submitForReview(taskId, 'reviewer-1');
    await settle();

    const approve = buttonOf(view, 'approve-integration');
    // The label no longer promises an apply this surface cannot perform.
    expect(approve.textContent?.trim()).toBe('Approve review');
    const note = view.root.querySelector('[data-testid="approve-note"]')?.textContent ?? '';
    expect(note).toContain('records the review verdict');
    expect(note).toContain('not wired');
    expect(note).toContain('Nothing is pushed automatically');
    approve.click();
    await settle();
    // What actually happened: the verdict is recorded, and nothing claims a file was integrated.
    expect(services.coordinator.task(taskId).review.state).toBe('approved');
    expect(phaseOf(view, taskId)).toBe('review-approved');
  });

  it('W4a: a send that completes after the team closed is discarded, never re-applied to the surface', async () => {
    let deliverEntered = false;
    const sendGate = deferred<{ ackId: string }>();
    const gated = createCollaborationCoordinator({
      deliver: async () => {
        deliverEntered = true;
        return sendGate.promise;
      },
    });
    const mailbox = createMailbox();
    const delegation = createDelegationService({ mailbox, deliver: async () => ({ ackId: 'ack' }) });
    const view = await mountPanel({ coordinator: gated, delegation });
    const taskId = await createOneTask(view, 'Close during send');
    buttonOf(view, 'task-select').click();
    await settle();
    buttonOf(view, 'task-dispatch').click();
    await settle();
    const sending = view.state.sendTask(taskId);
    await waitFor(() => deliverEntered, 'the gated deliver was never entered');

    // The team is closed while the send is still in flight.
    view.state.closeTeam();
    expect(view.state.threadId.value).toBeNull();
    expect(view.state.tasks.value).toHaveLength(0);

    // The send now completes. Its result belongs to a closed session and must be discarded: the
    // surface stays empty instead of being repopulated from every team the coordinator knows.
    sendGate.resolve({ ackId: 'ack-w4a' });
    await sending;
    await settle();
    expect(view.state.tasks.value).toHaveLength(0);
    expect(view.state.selectedTaskId.value).toBeNull();
    expect(view.state.attempts.value).toHaveLength(0);
    expect(view.state.threadId.value).toBeNull();
    expect(view.state.error.value).toBe('');
  });

  it('W4b: a writer lease that lands after the selection moved does not overwrite the new selection', async () => {
    const allocateGate = deferred<{
      leaseId: string;
      worktree: string;
      nativeCwd: string;
      baseCommit: string;
      policy: { worktreeAccess: string; userRepository: string };
    }>();
    const writerPort = {
      allocate: async () => allocateGate.promise,
      lease: () => null,
      posture: () => writerLeases.WRITER_ISOLATION,
      close: () => {},
    };
    const services = buildServices();
    const view = await mountPanel({ ...services.ports, writer: writerPort });
    const taskA = await createOneTask(view, 'Writer task A');
    const taskB = await createOneTask(view, 'Writer task B');
    view.state.selectTask(taskA);
    await settle();
    const allocating = view.state.allocateWriter(taskA, '/tmp/vis-w4b-repo');
    await waitFor(() => view.state.busy.value, 'the writer allocation never started');

    // The user selects ANOTHER task while the allocation is still in flight.
    view.state.selectTask(taskB);
    await settle();
    expect(view.state.writer.value).toBeNull();

    // The allocation lands now. It belongs to task A, so it must not surface for task B.
    allocateGate.resolve({
      leaseId: 'lease-w4b',
      worktree: '/tmp/vis-w4b-repo/.vis-writers/lease-w4b',
      nativeCwd: '/tmp/vis-w4b-repo/.vis-writers/lease-w4b',
      baseCommit: 'b'.repeat(40),
      policy: { worktreeAccess: 'read-write', userRepository: 'read-only' },
    });
    await allocating;
    await settle();
    expect(view.state.writer.value).toBeNull();
    // Selecting A again surfaces A's OWN lease: the writer is kept per task.
    view.state.selectTask(taskA);
    await settle();
    expect(view.state.writer.value?.leaseId).toBe('lease-w4b');
  });

  it('W5: a budget-paused task is RESUMED through its own Dispatch button once the budget frees', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    const taskA = await createOneTask(view, 'Occupies the session');
    const taskB = await createOneTask(view, 'Parked by the budget');
    view.state.selectTask(taskA);
    await settle();
    rowButtonOf(view, taskA, 'task-dispatch').click();
    await settle();
    expect(phaseOf(view, taskA)).toBe('dispatched');
    // The attempt must be SENT before a native end is accepted (the coordinator refuses a native
    // end on an unsent attempt), so the budget really is released below.
    await view.state.sendTask(taskA);
    await settle();

    // The second task on the SAME session cannot be admitted: the coordinator parks it, visibly.
    rowButtonOf(view, taskB, 'task-dispatch').click();
    await settle();
    expect(phaseOf(view, taskB)).toBe('paused');
    expect(view.state.tasks.value.find((entry) => entry.taskId === taskB)?.pausedReasons)
      .toContain('collaboration_session_mutation');
    expect(services.coordinator.task(taskB).state).toBe('paused');
    // The paused task's own Dispatch button is the resume path, enabled at the real state.
    expect(rowButtonOf(view, taskB, 'task-dispatch').disabled).toBe(false);

    // Release the session budget: the first attempt reaches its native end. The pause survives
    // unchanged (nothing auto-admits), and the button stays available.
    view.state.selectTask(taskA);
    await settle();
    view.state.finishTask(taskA, 'native-evt-w5');
    await settle();
    expect(phaseOf(view, taskB)).toBe('paused');
    expect(rowButtonOf(view, taskB, 'task-dispatch').disabled).toBe(false);

    // Resume the ORIGINAL parked task through its own button.
    rowButtonOf(view, taskB, 'task-dispatch').click();
    await settle();
    expect(phaseOf(view, taskB)).toBe('dispatched');
    expect(services.coordinator.task(taskB).state).toBe('dispatched');
    expect(services.coordinator.budgets().used.sessionMutations).toBe(1);
  });

  it('W6: the budget rows render the OBSERVED use under the matching key, and finish refreshes them', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    const taskId = await createOneTask(view, 'Budget rendering');
    view.state.selectTask(taskId);
    await settle();
    await view.state.dispatchTask(taskId);
    await settle();
    // The attempt is SENT so the native end below is accepted and really releases the budgets.
    await view.state.sendTask(taskId);
    await settle();
    // The coordinator's own read model: one running attempt on the owner's session.
    expect(services.coordinator.budgets().used.concurrency).toBe(1);
    expect(services.coordinator.budgets().used.sessionMutations).toBe(1);
    // The rendered rows pair each limit with the used value under the MATCHING key: 1 / 4, not 0 / 4.
    expect(view.root.querySelector('[data-testid="budget-row"][data-budget-key="maxConcurrency"]')?.textContent)
      .toContain('1 / 4');
    expect(view.root.querySelector('[data-testid="budget-row"][data-budget-key="maxSessionMutations"]')?.textContent)
      .toContain('1 / 1');
    // The native end releases both budgets, and the rendered snapshot refreshes with them.
    view.state.finishTask(taskId, 'native-evt-w6');
    await settle();
    expect(view.root.querySelector('[data-testid="budget-row"][data-budget-key="maxConcurrency"]')?.textContent)
      .toContain('0 / 4');
    expect(view.root.querySelector('[data-testid="budget-row"][data-budget-key="maxSessionMutations"]')?.textContent)
      .toContain('0 / 1');
  });

  it('W7: a failed fan-out recipient renders the service OWN resolution code through the product port', async () => {
    const services = buildServices();
    services.failFor.add(WORKER_P);
    const view = await mountPanel(services.ports);
    await view.state.fanOut('review this', [
      { participantId: LEAD_P, session: LEAD_SESSION },
      { participantId: WORKER_P, session: WORKER_SESSION },
    ]);
    await settle();
    const failed = view.root.querySelector(`[data-testid="fanout-recipient"][data-participant-id="${WORKER_P}"]`);
    expect(failed?.getAttribute('data-outcome')).toBe('failed');
    expect(failed?.querySelector('.recipient-resolution')?.textContent).toBe('source_unavailable');
    const sent = view.root.querySelector(`[data-testid="fanout-recipient"][data-participant-id="${LEAD_P}"]`);
    expect(sent?.getAttribute('data-outcome')).toBe('sent');
    expect(sent?.querySelector('.recipient-resolution')).toBeNull();
  });

  it('W8: the panel is a REAL modal dialog: open shows it modally, close hides it, a closed panel never opens itself', async () => {
    const showModalCalls: HTMLDialogElement[] = [];
    const closeCalls: HTMLDialogElement[] = [];
    const originalShowModal = HTMLDialogElement.prototype.showModal;
    const originalClose = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.showModal = function patchedShowModal(this: HTMLDialogElement) {
      showModalCalls.push(this);
      return originalShowModal.call(this);
    };
    HTMLDialogElement.prototype.close = function patchedClose(this: HTMLDialogElement, returnValue?: string) {
      closeCalls.push(this);
      return originalClose.call(this, returnValue);
    };
    const mountWith = async (open: Ref<boolean>): Promise<{ host: HTMLElement; unmount: () => void }> => {
      const services = buildServices();
      const state = createRuntimeCollaborationState(services.ports);
      await state.openTeam({ threadId: THREAD_1, teamName: 'Team Alpha', environmentId: ENV, owner: OWNER, lease: LEASE });
      const emitted = new Map<string, unknown[]>();
      const Container = defineComponent({
        setup() {
          return { state, open };
        },
        render() {
          return h(CollaborationPanel, {
            ...containerProps(this.state, emitted),
            open: this.open,
            onClose: () => { this.open = false; emitted.set('close', []); },
          });
        },
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const app = createApp(Container);
      app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
      app.mount(host);
      await settle();
      return { host, unmount: () => app.unmount() };
    };
    try {
      // (a) mounted OPEN: the native modal is shown through showModal(), not by setting the open
      // attribute and reading it back to decide whether to call showModal.
      const open = ref(true);
      const shown = await mountWith(open);
      const dialog = shown.host.querySelector<HTMLDialogElement>('[data-testid="collaboration-panel"]');
      expect(dialog).not.toBeNull();
      expect(showModalCalls).toHaveLength(1);
      expect(dialog?.open).toBe(true);

      // (b) closing goes through close(), and the dialog is actually closed afterwards.
      open.value = false;
      await settle();
      expect(closeCalls.length).toBeGreaterThanOrEqual(1);
      expect(dialog?.open).toBe(false);
      expect(showModalCalls).toHaveLength(1);
      shown.unmount();

      // (c) mounted CLOSED: nothing opens it — the old watcher called showModal() on an element
      // whose own open attribute was false, opening a dialog nobody asked for.
      showModalCalls.length = 0;
      closeCalls.length = 0;
      const closed = ref(false);
      const hidden = await mountWith(closed);
      expect(showModalCalls).toHaveLength(0);
      expect(closeCalls).toHaveLength(0);
      expect(hidden.host.querySelector<HTMLDialogElement>('[data-testid="collaboration-panel"]')?.open).toBe(false);
      hidden.unmount();
    } finally {
      HTMLDialogElement.prototype.showModal = originalShowModal;
      HTMLDialogElement.prototype.close = originalClose;
    }
  });
});

// ---------------------------------------------------------------------------
// Residual round-4 findings — a cancelled task's accept path, the shared busy
// counter across sessions, and the attempts slot's ownership.
// ---------------------------------------------------------------------------

describe('a cancelled task never renders or accepts its review verdict', () => {
  it('renders cancelled, disables Accept and refuses the accept even when called directly', async () => {
    const services = buildServices();
    const view = await mountPanel(services.ports);
    view.state.createTask({ title: 'Cancel after approve', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const taskId = view.state.tasks.value[0]?.taskId ?? '';
    view.state.selectTask(taskId);
    await view.state.dispatchTask(taskId);
    await settle();
    await view.state.sendTask(taskId);
    await settle();
    view.state.finishTask(taskId, 'native-evt-1');
    await settle();
    view.state.registerDeliverable(taskId, { deliverableId: 'deliv-1', artifactHash: HASH, bytes: 2048, paths: ['src/App.vue'] });
    view.state.submitForReview(taskId, 'reviewer-1');
    await settle();
    view.state.reviewTask(taskId, 'approved', 'reviewer-1');
    await settle();
    expect(phaseOf(view, taskId)).toBe('review-approved');

    view.state.cancelTask(taskId, 'cancelled by reviewer');
    await settle();
    // The host state is terminal, so the verdict it still carries must not be displayed as the
    // task's phase, and the accept affordance must not be offered for work that is over.
    expect(phaseOf(view, taskId)).toBe('cancelled');
    const accept = view.root.querySelector<HTMLButtonElement>(`[data-testid="task-row"][data-task-id="${taskId}"] [data-testid="task-accept"]`);
    expect(accept?.disabled).toBe(true);

    // The composable refuses it too: the acceptance service does not check the host's terminal
    // state, so a cancelled task would otherwise become accepted through this surface.
    view.state.error.value = '';
    view.state.acceptTask(taskId, { deliverableId: 'deliv-1', acceptedBy: 'reviewer-1', criteria: [{ id: 'c1', met: true }] });
    await settle();
    expect(view.state.error.value).toContain('cancelled');
    expect(services.coordinator.task(taskId).state).toBe('cancelled');
    expect(services.coordinator.task(taskId).acceptance.state).not.toBe('accepted');
  });
});

describe('the busy counter belongs to the session that started the operation', () => {
  it('a late finally from a previous session does not clear the new session busy', async () => {
    const gates: Array<() => void> = [];
    const coordinator = createCollaborationCoordinator();
    const fanout = createFanoutService({
      deliver: async () => {
        await new Promise<void>((resolve) => { gates.push(resolve); });
        return { ackId: 'ack' };
      },
    });
    const view = await mountPanel({ coordinator, fanout });
    const oldFanout = view.state.fanOut('prompt one', [{ participantId: WORKER_P, session: WORKER_SESSION }]);
    await settle();
    expect(view.state.busy.value).toBe(true);

    view.state.closeTeam();
    await view.state.openTeam({ threadId: THREAD_1, teamName: 'Team Beta', environmentId: ENV, owner: OWNER, lease: LEASE });
    const newFanout = view.state.fanOut('prompt two', [{ participantId: WORKER_P, session: WORKER_SESSION }]);
    await settle();
    expect(view.state.busy.value).toBe(true);

    // Release ONLY the old request: its finally used to decrement the shared counter and report
    // the surface idle while the new request was still in flight.
    gates[0]?.();
    await oldFanout;
    await settle();
    expect(view.state.busy.value).toBe(true);

    gates[1]?.();
    await newFanout;
    await settle();
    expect(view.state.busy.value).toBe(false);
  });
});

describe('the attempts slot belongs to the selected task', () => {
  it('an operation on another task does not backfill its attempts under the selected task', async () => {
    const gates: Array<() => void> = [];
    const coordinator = createCollaborationCoordinator({
      deliver: async () => {
        await new Promise<void>((resolve) => { gates.push(resolve); });
        return { ackId: 'ack' };
      },
    });
    const view = await mountPanel({ coordinator });
    view.state.createTask({ title: 'Task A', criteria: [{ id: 'c1', text: 'x', required: true }] });
    view.state.createTask({ title: 'Task B', criteria: [{ id: 'c1', text: 'x', required: true }] });
    await settle();
    const [taskA, taskB] = view.state.tasks.value.map((entry) => entry.taskId);
    await view.state.dispatchTask(taskA);
    await settle();
    view.state.selectTask(taskB);
    await settle();

    const sending = view.state.sendTask(taskA);
    await settle();
    gates[0]?.();
    await sending;
    await settle();

    // The details panel names task B, so every attempt row it renders must be task B's own.
    const details = view.root.querySelector('[data-testid="attempt-details"]');
    expect(details?.getAttribute('data-task-id')).toBe(taskB);
    const rendered = [...view.root.querySelectorAll('[data-testid="attempt-row"]')].map((row) => row.getAttribute('data-attempt-id'));
    expect(rendered).toEqual(coordinator.task(taskB).attempts);
    expect(rendered).not.toEqual(coordinator.task(taskA).attempts);

    // Selecting task A still shows its own attempts, read fresh from the coordinator.
    view.state.selectTask(taskA);
    await settle();
    const afterSelect = [...view.root.querySelectorAll('[data-testid="attempt-row"]')].map((row) => row.getAttribute('data-attempt-id'));
    expect(afterSelect).toEqual(coordinator.task(taskA).attempts);
  });
});
