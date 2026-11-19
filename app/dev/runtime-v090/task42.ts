// Task 42 registered QA browser entry — the Team task and change-review UI, mounted for real in a
// real headless Chromium over a case-owned Vite dev server.
//
// Loaded by scripts/qa/runtime-v090-cases/task-42.mjs from a runner-served page and driven through
// the REAL rendered DOM (data-testid / data-* reads and genuine button clicks). The REAL landed
// code executes here:
//   * app/components/runtime/CollaborationPanel.vue — the modal root, the captured Thread target
//     and team identity, the readable error surface;
//   * app/components/runtime/{TeamEditor,TaskGraph,AttemptDetails,ArtifactReview}.vue — the team
//     members and budgets, the task DAG with its derived phase chips, the attempt ladder with the
//     native-end action, and the change review with the writer path, the posture and the explicit
//     apply-approve;
//   * app/composables/useRuntimeCollaboration.ts — the app-side seat: deriveTaskPhase, the frozen
//     read models, the Thread-target capture and every operation;
//   * bridge/runtime/collaboration/{coordinator,delegationService,mailbox,fanoutService}.js — the
//     REAL landed services (tasks 37 / 39 / 38), composed exactly as a container will compose
//     them, with only their own declared native seams injected (the coordinator's deliver, the
//     fan-out service's deliver). No live harness is contacted.
//
// The controlled boundaries are:
//   * `node:crypto` is aliased to app/dev/runtime-v090/task-35-browser-shim.mjs, because the real
//     bridge services import it at module scope and cannot execute in a browser realm without it
//     (the same seam tasks 26-29 and 35 use); the shim supplies randomUUID from the browser's own
//     crypto and createHash('sha256') from the product's own pure SHA-256, so every line of
//     service LOGIC under test is the real landed code. `@iconify/vue` is aliased to the same
//     shim's inert Icon (the real one fetches the Iconify API at runtime; icons are decorative and
//     no assertion reads one). Both aliases are ANCHORED to the exact raw specifier (the task-27
//     lesson).
//   * the writer port is a case-owned pass-through of the WORKER-observed lease: task 40's
//     writerLeases.js imports node:crypto / node:fs / node:path / node:child_process plus
//     processTree.js, so the REAL allocate against the REAL private git repository runs in the
//     Node worker only (the same split tasks 37-41 disclosed), and this entry renders the observed
//     lease and the observed posture verbatim through the real composable and the real
//     ArtifactReview component. The port RECORDS the allocate input it was handed, so the case
//     observes that the UI really asked for the real repository, the real task and the real owner.
//   * the three imported theme presets (soft-white, anime-night, anime-dream) are applied through
//     the REAL token pipeline (app/utils/{regionTheme,themeTokens}.ts) and measured with real
//     computed colours in this realm — happy-dom cannot resolve CSS custom properties, which is
//     exactly the gap this QA layer closes.
//
// This entry makes no claim that the running app already renders the collaboration UI — no
// container provides RUNTIME_COLLABORATION_STATE_KEY yet (App.vue is outside the owned paths), so
// this entry IS the container, wired exactly as the landed CollaborationPanel.test.ts wires it.
// It authors no PASS verdict.
import { createApp, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

import CollaborationPanel from '../../components/runtime/CollaborationPanel.vue';
import type {
  CoordinatorTaskSnapshot,
  RuntimeCollaborationPorts,
  RuntimeCollaborationState,
} from '../../composables/useRuntimeCollaboration';
import { createRuntimeCollaborationState } from '../../composables/useRuntimeCollaboration';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../../shared/runtime/capabilities.js';
import { ANIME_DREAM_PRESET, ANIME_NIGHT_PRESET, SOFT_WHITE_PRESET } from '../../utils/regionTheme';
import type { RegionThemeConfig } from '../../utils/regionTheme';
import {
  SEMANTIC_THEME_TOKENS,
  THEME_ROOT_ATTRIBUTE,
  createSemanticTokenSnapshot,
  extractSemanticTokenOverrides,
  regionThemeToStorage,
  semanticTokenCssVariable,
} from '../../utils/themeTokens';

type AnyRecord = Record<string, any>;

// ── the declaration-less JS modules: the same `await import` + @ts-ignore boundary task 35 uses ──
const coordinatorModule = await import(
  // @ts-ignore JS module without declarations
  '../../../bridge/runtime/collaboration/coordinator.js'
) as unknown as {
  createCollaborationCoordinator(options?: { deliver?: (payload: unknown) => Promise<{ ackId: string }> }): CollaborationCoordinatorService;
};
const delegationModule = await import(
  // @ts-ignore JS module without declarations
  '../../../bridge/runtime/collaboration/delegationService.js'
) as unknown as {
  createDelegationService(options: { mailbox: unknown; deliver: (payload: unknown) => Promise<{ ackId: string }> }): RuntimeCollaborationPorts['delegation'] & object;
};
const mailboxModule = await import(
  // @ts-ignore JS module without declarations
  '../../../bridge/runtime/collaboration/mailbox.js'
) as unknown as { createMailbox(): unknown };
const fanoutModule = await import(
  // @ts-ignore JS module without declarations
  '../../../bridge/runtime/collaboration/fanoutService.js'
) as unknown as {
  createFanoutService(options: { deliver: (target: { participantId: string; session: SessionRef; attachmentPath: string | null; prompt: string }) => Promise<{ ackId: string }> }): RuntimeCollaborationPorts['fanout'] & object;
};

/** The narrowed fan-out port the composable declares, in its non-optional form. */
type FanoutPort = NonNullable<RuntimeCollaborationPorts['fanout']>;

/** The landed task-37 coordinator: the narrowed surface the composable drives, plus the mailbox. */
type CollaborationCoordinatorService = RuntimeCollaborationPorts['coordinator'] & {
  // The RECEIVER's contract: taskGraph.addDependency parses `dependsOn` with parseTaskId, which
  // requires ONE uuid STRING (shared/runtime/collaboration.js:94) — never an array.
  addDependency(input: { taskId: string; dependsOn: string; at?: number }): CoordinatorTaskSnapshot;
  postMessage(input: { teamId: string; from: string; to: string; text: string; at?: number }): { messageId: string };
  mailbox(teamId: string): readonly { messageId: string }[];
};

/** The writer lease as task 40's service freezes it (the fields the composable and UI read). */
interface WriterLeaseView {
  leaseId: string;
  worktree: string;
  nativeCwd: string;
  baseCommit: string;
  policy: { worktreeAccess: string; userRepository: string };
}

// ── the fixed world the case drives ─────────────────────────────────────────────────────────────────
const ENV = '11111111-1111-4111-8111-111111111111';
const H_LEAD = '22222222-2222-4222-8222-222222222222';
const H_WORKER = '33333333-3333-4333-8333-333333333333';
const H_ACP = '44444444-4444-4444-8444-444444444444';
const LEAD_P = 'aaaaaaaa-1111-4111-8111-111111111111';
const WORKER_P = 'bbbbbbbb-2222-4222-8222-222222222222';
const ACP_P = 'cccccccc-3333-4333-8333-333333333333';
const THREAD_1 = 'dddddddd-1111-4111-8111-111111111111';
const THREAD_2 = 'eeeeeeee-2222-4222-8222-222222222222';
const LEASE_OWNER = 'ffffffff-3333-4333-8333-333333333333';
const LEASE_EXPIRES_AT = 9_999_999_999_999;
// A well-formed identity no attempt ever uses: the unknown-attempt refusal is driven with it.
const UNKNOWN_ATTEMPT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CRITERIA = Object.freeze([Object.freeze({ id: 'c1', text: 'the change renders as three distinct phases', required: true })]);

const session = (harnessInstanceId: string, nativeSessionId: string): SessionRef =>
  parseSessionRef({ environmentId: ENV, harnessInstanceId, nativeSessionId });
const SESSIONS: Record<string, SessionRef> = Object.freeze({
  lead: session(H_LEAD, 'lead-session'),
  worker: session(H_WORKER, 'worker-session'),
  acp: session(H_ACP, 'acp-session'),
});
const OWNER = Object.freeze({ participantId: LEAD_P, session: SESSIONS.lead });
const LEASE = Object.freeze({ ownerId: LEASE_OWNER, expiresAt: LEASE_EXPIRES_AT });

// ── observation channels ────────────────────────────────────────────────────────────────────────────
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`);
});

const domHost = document.createElement('pre');
domHost.id = 'qa42-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

/**
 * Captures a typed CollaborationError's code/field without swallowing anything else. The SAME
 * envelope is emitted on EVERY path, success included: { code: null, field: null } on success, so
 * the worker's capture and this one are comparable key-for-key (the task-32/33 lesson).
 */
function capture(run: () => unknown): { code: string | null; field: string | null } {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      const record = error as AnyRecord;
      if (typeof record.code === 'string' && typeof record.field === 'string') return { code: record.code, field: record.field };
    }
    return { code: 'not-a-CollaborationError', field: String(error) };
  }
}

// ── per-boot product instances and accumulators ────────────────────────────────────────────────────
let coordinator: CollaborationCoordinatorService;
let delegation: RuntimeCollaborationPorts['delegation'] & object;
let fanout: RuntimeCollaborationPorts['fanout'] & object;
let state: RuntimeCollaborationState;
let app: ReturnType<typeof createApp> | null = null;
let pending: Promise<unknown> | null = null;
// Every module-scope accumulator is scoped to the boot that fills it, and boot() resets each one,
// so a later boot never observes an earlier boot's records (the task-35 lesson).
// Every typed refusal code observed ANYWHERE in this case. Deliberately CASE-WIDE and never reset
// by boot(): the final membership check needs every code the whole run observed, not only the last
// world's (the task-35 accumulator lesson, applied in the opposite direction).
const observedCodes = new Set<string>();
const coordinatorDeliverCalls: AnyRecord[] = [];
const fanoutDeliverCalls: AnyRecord[] = [];
const writerAllocateCalls: AnyRecord[] = [];
const emitted = new Map<string, unknown[]>();
/** participantIds whose fan-out delivery fails, to exercise the partial state. */
const fanoutFailFor = new Set<string>();
/** The WORKER-observed lease + posture this realm renders verbatim (see the header). */
let seededLease: WriterLeaseView | null = null;
let seededPosture: Readonly<Record<string, unknown>> | null = null;

function track(value: unknown): void {
  if (value !== null && typeof value === 'object' && typeof (value as Promise<unknown>).then === 'function') {
    pending = value as Promise<unknown>;
  }
}

async function flush(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await nextTick();
}

/** Await the composable action a click started, then let Vue re-render. */
async function settle(): Promise<void> {
  await flush();
  const started = pending;
  pending = null;
  if (started !== null) await started;
  await flush();
}

// ── the container: every CollaborationPanel event forwarded into the REAL composable ────────────────
// The refs are read inside render, so they are tracked on the render effect; a `boot()` remounts a
// fresh app, which re-runs this render against the NEW composable instance.
const Container = {
  render() {
    const current = state;
    return h(CollaborationPanel as never, {
      open: true,
      threadId: current.threadId.value,
      team: current.team.value,
      tasks: current.tasks.value,
      selectedTaskId: current.selectedTaskId.value,
      selectedTask: current.selectedTask.value,
      attempts: current.attempts.value,
      budgets: current.budgets.value,
      fanout: current.fanout.value,
      writer: current.writer.value,
      busy: current.busy.value,
      error: current.error.value,
      onClose: () => emitted.set('close', []),
      'onSelect-task': (taskId: string) => { current.selectTask(taskId); emitted.set('select-task', [taskId]); },
      'onAdd-member': (input: unknown) => { current.addMember(input as Parameters<RuntimeCollaborationState['addMember']>[0]); },
      'onCreate-task': (input: unknown) => { current.createTask(input as Parameters<RuntimeCollaborationState['createTask']>[0]); },
      // The product emits ONE object `{ prompt, targets }`; the composable takes TWO positional
      // arguments — the payload is bridged by destructuring, exactly like every sibling handler
      // (spreading the object as an arguments tuple throws a TypeError: the wiring the landed
      // unit test declares but never drives, because it calls fanOut directly).
      'onFan-out': (input: { prompt: string; targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[] }) => { track(current.fanOut(input.prompt, input.targets)); },
      onDispatch: (taskId: string) => { track(current.dispatchTask(taskId)); },
      onSend: (taskId: string) => { track(current.sendTask(taskId)); },
      'onFinish': (input: { taskId: string; nativeEventId: string }) => { current.finishTask(input.taskId, input.nativeEventId); },
      'onRegister-deliverable': (input: { taskId: string; deliverable: unknown }) => { current.registerDeliverable(input.taskId, input.deliverable as Parameters<RuntimeCollaborationState['registerDeliverable']>[1]); },
      'onSubmit-review': (input: { taskId: string; reviewer: string }) => { current.submitForReview(input.taskId, input.reviewer); },
      onReview: (input: { taskId: string; decision: string; reviewer: string }) => { current.reviewTask(input.taskId, input.decision, input.reviewer); },
      onAccept: (input: { taskId: string; deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }) => { current.acceptTask(input.taskId, input); },
      onReject: (input: { taskId: string; reason: string }) => { current.rejectTask(input.taskId, input.reason); },
      onCancel: (input: { taskId: string; reason?: string }) => { current.cancelTask(input.taskId, input.reason); },
      'onAllocate-writer': (input: { taskId: string; repository: string }) => { track(current.allocateWriter(input.taskId, input.repository)); },
      onApprove: (input: { taskId: string; reviewerId: string }) => { current.approveReview(input.taskId, input.reviewerId); },
    });
  },
};

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });

/**
 * The case-owned writer port: a pass-through of the WORKER-observed lease and posture. `allocate`
 * RECORDS the input the composable handed it (the real repository, the real task, the real owner)
 * and answers with the observed lease; `posture` answers with the observed WRITER_ISOLATION
 * contents. The REAL allocate against the REAL private git repository happens in the Node worker —
 * writerLeases.js imports node:fs / node:path / node:child_process and cannot run here at all.
 */
const writerPort = {
  allocate: async (input: { repository: string; taskId: string; ownerId: string }): Promise<WriterLeaseView> => {
    writerAllocateCalls.push({ repository: input.repository, taskId: input.taskId, ownerId: input.ownerId });
    if (seededLease === null) throw new Error('task42 browser entry: no worker-observed lease was seeded');
    return seededLease;
  },
  lease: (leaseId: string): WriterLeaseView | null => (seededLease !== null && seededLease.leaseId === leaseId ? seededLease : null),
  posture: (leaseId: string) => {
    if (seededLease === null || seededLease.leaseId !== leaseId) {
      throw new Error('task42 browser entry: no worker-observed posture was seeded for this lease');
    }
    return seededPosture as Readonly<Record<string, unknown>>;
  },
  close: () => {},
};

/**
 * Rebuild the REAL services, the REAL composable state and the mount. `failFor` names the
 * participantIds whose fan-out delivery fails; `members` are added through the REAL delegation
 * service; the case-owned view options survive so the container props stay under the case's
 * control.
 */
async function boot(options: {
  threadId: string;
  teamName?: string;
  members: readonly { key: string; role: 'lead' | 'worker'; harnessKind: string; participantId: string }[];
  failFor?: readonly string[];
}): Promise<AnyRecord> {
  if (app !== null) { app.unmount(); app = null; }
  coordinatorDeliverCalls.length = 0;
  fanoutDeliverCalls.length = 0;
  writerAllocateCalls.length = 0;
  emitted.clear();
  fanoutFailFor.clear();
  for (const participantId of options.failFor ?? []) fanoutFailFor.add(participantId);
  seededLease = null;
  seededPosture = null;

  let ack = 0;
  coordinator = coordinatorModule.createCollaborationCoordinator({
    deliver: async (payload) => {
      coordinatorDeliverCalls.push({ ...(payload as AnyRecord) });
      ack += 1;
      return { ackId: `ack-${ack}` };
    },
  });
  delegation = delegationModule.createDelegationService({
    mailbox: mailboxModule.createMailbox(),
    deliver: async () => ({ ackId: `delegation-ack-${(ack += 1)}` }),
  });
  const fanoutService = fanoutModule.createFanoutService({
    deliver: async (target) => {
      fanoutDeliverCalls.push({
        participantId: target.participantId,
        attachmentPath: target.attachmentPath ?? null,
        prompt: target.prompt,
      });
      if (fanoutFailFor.has(target.participantId)) {
        throw Object.assign(new Error('source unavailable'), { code: 'source_unavailable', field: 'fanout_send' });
      }
      ack += 1;
      return { ackId: `ack-${target.participantId}` };
    },
  }) as unknown as FanoutPort;
  // The contract conversion — task 38's `resolution` OBJECT ({ code, field }) to the flat
  // `resolutionCode` the composable's CollaborationRecipientView declares — lives in the PRODUCT
  // port (the composable's own fanOut adapter), not in this case-owned seam. The service therefore
  // crosses verbatim: the rendered failure code is produced by product code reading the service's
  // own real resolution, and no case-specific patch stands between them.
  fanout = fanoutService;
  state = createRuntimeCollaborationState({ coordinator, delegation, fanout, writer: writerPort });
  await state.openTeam({
    threadId: options.threadId,
    teamName: options.teamName ?? 'Team Alpha',
    environmentId: ENV,
    owner: OWNER,
    lease: LEASE,
  });
  for (const member of options.members) {
    state.addMember({
      role: member.role,
      harnessKind: member.harnessKind,
      session: SESSIONS[member.key],
      participantId: member.participantId,
    });
  }
  app = createApp(Container as never);
  app.use(i18n);
  app.mount('#app');
  await settle();
  return observe();
}

// ── observation helpers (every value spread into a PLAIN object; readonly proxies serialize to {}) ──
function stateSnapshot(): AnyRecord {
  const team = state.team.value;
  const writer = state.writer.value;
  const fanoutView = state.fanout.value;
  return {
    available: state.available,
    threadId: state.threadId.value,
    team: team === null ? null : {
      teamId: team.teamId,
      name: team.name,
      members: team.members.map((member) => ({
        memberId: member.memberId,
        participantId: member.participantId,
        role: member.role,
        harnessKind: member.harnessKind,
        session: { ...member.session },
        sessionKey: member.sessionKey,
      })),
    },
    tasks: state.tasks.value.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      phase: task.phase,
      depth: task.depth,
      review: { ...task.review },
      acceptance: { ...task.acceptance, criteria: [...task.acceptance.criteria] },
      deliverables: task.deliverables.map((entry) => ({ ...entry })),
      criteria: task.criteria.map((entry) => ({ ...entry })),
      dependsOn: [...task.dependsOn],
      children: [...task.children],
      blockedBy: [...task.blockedBy],
      ambiguous: task.ambiguous,
      pausedReasons: [...task.pausedReasons],
    })),
    selectedTaskId: state.selectedTaskId.value,
    selectedTask: state.selectedTask.value === null ? null : { ...state.selectedTask.value },
    attempts: state.attempts.value.map((entry) => ({ ...entry })),
    budgets: state.budgets.value === null ? null : { limits: { ...state.budgets.value.limits }, used: { ...state.budgets.value.used } },
    fanout: fanoutView === null ? null : {
      fanoutId: fanoutView.fanoutId,
      state: fanoutView.state,
      stats: { ...fanoutView.stats },
      targets: fanoutView.targets.map((target) => ({ ...target })),
      retryable: [...fanoutView.retryable],
    },
    writer: writer === null ? null : {
      leaseId: writer.leaseId,
      worktree: writer.worktree,
      nativeCwd: writer.nativeCwd,
      baseCommit: writer.baseCommit,
      policy: { ...writer.policy },
      posture: {
        ...writer.posture,
        guarantees: [...(writer.posture.guarantees as readonly string[])],
        notProvided: [...(writer.posture.notProvided as readonly string[])],
      },
    },
    busy: state.busy.value,
    error: state.error.value,
  };
}

function element(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}
/** The action buttons carry no data-task-id; the parent row does, so every per-task driver scopes to it. */
function taskRow(taskId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="task-row"][data-task-id="${taskId}"]`);
}
function allOf(testId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}
function textOf(testId: string): string | null {
  return element(testId)?.textContent ?? null;
}
function disabledOf(testId: string): boolean | null {
  const node = element(testId) as HTMLButtonElement | null;
  return node === null ? null : node.disabled;
}
function attrOf(testId: string, name: string): string | null {
  return element(testId)?.getAttribute(name) ?? null;
}
function buttonOf(scope: HTMLElement, testId: string): HTMLButtonElement | null {
  return scope.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
}
/** Set a component-internal v-model input the way a real keystroke does, then let Vue re-render. */
async function typeInto(testId: string, value: string): Promise<boolean> {
  const node = element(testId) as HTMLInputElement | null;
  if (node === null) return false;
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  return true;
}

function probe(): AnyRecord {
  const dialog = element('collaboration-panel');
  const panel = dialog === null ? null : dialog;
  return {
    panelPresent: panel !== null,
    threadIdAttr: attrOf('collaboration-panel', 'data-thread-id'),
    teamIdAttr: attrOf('collaboration-panel', 'data-team-id'),
    teamMeta: textOf('collab-team-meta')?.trim() ?? null,
    error: (() => {
      const node = element('collab-error');
      return node === null ? null : { role: node.getAttribute('role'), text: (node.textContent ?? '').trim() };
    })(),
    members: allOf('member-row').map((node) => ({
      memberId: node.getAttribute('data-member-id'),
      role: node.getAttribute('data-role'),
      harness: node.getAttribute('data-harness'),
      sessionTitle: node.querySelector('.member-session')?.getAttribute('title') ?? null,
    })),
    teamEmpty: textOf('team-empty'),
    budgets: allOf('budget-row').map((node) => ({
      key: node.getAttribute('data-budget-key'),
      keyText: node.querySelector('.budget-key')?.textContent ?? null,
      usedText: node.querySelector('.budget-used')?.textContent?.trim() ?? null,
    })),
    fanout: (() => {
      const stateNode = element('fanout-state');
      return {
        idle: textOf('fanout-idle'),
        resultPresent: element('fanout-result') !== null,
        state: stateNode?.getAttribute('data-state') ?? null,
        stateText: stateNode?.textContent?.trim() ?? null,
        stats: textOf('fanout-stats')?.trim() ?? null,
        recipients: allOf('fanout-recipient').map((node) => {
          const text = (node.textContent ?? '').trim();
          return {
            participantId: node.getAttribute('data-participant-id'),
            outcome: node.getAttribute('data-outcome'),
            // Whether THIS row rendered a resolution code. A recipient that settled has none, so
            // `sent` rows must render nothing; a `failed` row must render the service's OWN code.
            // Read from the rendered text, never assumed.
            resolutionCodeRendered: /source_unavailable|fanout_send|reconcile_required/.test(text),
          };
        }),
        promptDisabled: disabledOf('fanout-prompt'),
        triggerDisabled: disabledOf('fanout-trigger'),
      };
    })(),
    tasks: allOf('task-row').map((node) => ({
      taskId: node.getAttribute('data-task-id'),
      phase: node.getAttribute('data-phase'),
      depth: node.getAttribute('data-depth'),
      chip: node.querySelector('[data-testid="phase-chip"]')?.textContent ?? null,
      title: node.querySelector('.task-title')?.textContent ?? null,
      blocked: node.querySelector('[data-testid="task-blocked"]')?.textContent ?? null,
      paused: node.querySelector('[data-testid="task-paused"]')?.textContent ?? null,
      ambiguous: node.querySelector('[data-testid="task-ambiguous"]')?.textContent ?? null,
      selected: node.classList.contains('is-selected'),
      dispatchDisabled: buttonOf(node, 'task-dispatch')?.disabled ?? null,
      submitReviewDisabled: buttonOf(node, 'task-submit-review')?.disabled ?? null,
      acceptDisabled: buttonOf(node, 'task-accept')?.disabled ?? null,
      rejectDisabled: buttonOf(node, 'task-reject')?.disabled ?? null,
      cancelDisabled: buttonOf(node, 'task-cancel')?.disabled ?? null,
    })),
    taskGraphEmpty: textOf('task-graph-empty'),
    attempt: (() => {
      const section = element('attempt-details');
      if (section === null) return null;
      return {
        taskId: section.getAttribute('data-task-id'),
        phase: section.getAttribute('data-phase'),
        phaseNote: section.querySelector('.attempt-phase-note')?.textContent ?? null,
        empty: textOf('attempt-empty'),
        rows: allOf('attempt-row').map((node) => ({
          attemptId: node.getAttribute('data-attempt-id'),
          state: node.getAttribute('data-state'),
          flags: node.querySelector('.attempt-flags')?.textContent ?? null,
          reason: node.querySelector('[data-testid="attempt-reason"]')?.textContent ?? null,
          sends: node.querySelector('.attempt-sends')?.textContent ?? null,
        })),
        dispatchDisabled: disabledOf('attempt-dispatch'),
        sendDisabled: disabledOf('attempt-send'),
        finishDisabled: disabledOf('attempt-finish'),
        registerDisabled: disabledOf('register-deliverable'),
        submitDisabled: disabledOf('submit-review'),
        nativeEventInputDisabled: disabledOf('native-event-input'),
      };
    })(),
    deliverables: allOf('deliverable-row').map((node) => ({
      deliverableId: node.getAttribute('data-deliverable-id'),
      hash: node.querySelector('.deliverable-hash')?.getAttribute('title') ?? null,
      hashText: node.querySelector('.deliverable-hash')?.textContent ?? null,
      bytes: node.querySelector('.deliverable-bytes')?.textContent ?? null,
      paths: node.querySelector('.deliverable-paths')?.textContent ?? null,
    })),
    writer: (() => {
      const block = element('writer-block');
      if (block === null) return { present: false, idle: textOf('writer-idle') };
      return {
        present: true,
        idle: null,
        worktree: textOf('writer-worktree'),
        worktreeTitle: attrOf('writer-worktree', 'title'),
        nativeCwd: textOf('writer-native-cwd'),
        baseCommit: attrOf('writer-base-commit', 'title'),
        baseCommitText: textOf('writer-base-commit'),
        worktreeAccess: textOf('writer-worktree-access'),
        userRepository: textOf('writer-user-repository'),
      };
    })(),
    posture: (() => {
      const block = element('posture-block');
      if (block === null) return null;
      return {
        sandboxAttr: block.getAttribute('data-sandbox'),
        sandboxValue: textOf('posture-sandbox-value'),
        mechanism: textOf('posture-mechanism'),
        guarantees: [...block.querySelectorAll('[data-testid="posture-guarantees"] li')].map((node) => node.textContent ?? ''),
        notProvided: [...block.querySelectorAll('[data-testid="posture-not-provided"] li')].map((node) => node.textContent ?? ''),
        statement: textOf('posture-statement'),
      };
    })(),
    approve: {
      disabled: disabledOf('approve-integration'),
      note: textOf('approve-note')?.trim() ?? null,
    },
    // The whole surface, scanned for any push/remote affordance (criterion 3).
    pushLikeButtons: [...document.querySelectorAll('button')]
      .filter((node) => /push|remote/i.test(node.textContent ?? '')).length,
    pushLikeTestIds: [...document.querySelectorAll('[data-testid]')]
      .filter((node) => /push|remote/i.test(node.getAttribute('data-testid') ?? '')).length,
    buttonCount: document.querySelectorAll('button').length,
  };
}

function observe(): AnyRecord {
  return { probe: probe(), snapshot: stateSnapshot() };
}

/** The coordinator's OWN frozen task view, spread into a plain object for the JSON boundary. */
function productTask(taskId: string): AnyRecord {
  const view = coordinator.task(taskId) as unknown as AnyRecord;
  return {
    taskId: view.taskId,
    title: view.title,
    state: view.state,
    depth: view.depth,
    review: { ...view.review },
    acceptance: { ...view.acceptance, criteria: [...(view.acceptance.criteria ?? [])] },
    deliverables: (view.deliverables ?? []).map((entry: AnyRecord) => ({ ...entry })),
    attempts: [...(view.attempts ?? [])],
    dependsOn: [...(view.dependsOn ?? [])],
    children: [...(view.children ?? [])],
    blockedBy: [...(view.blockedBy ?? [])],
    ambiguous: view.ambiguous,
    paused: view.paused === null ? null : { reasons: [...(view.paused.reasons ?? [])] },
    criteria: (view.criteria ?? []).map((entry: AnyRecord) => ({ ...entry })),
    owner: { participantId: view.owner.participantId, session: { ...view.owner.session } },
  };
}

function productBudgets(): AnyRecord {
  const view = coordinator.budgets();
  return { limits: { ...view.limits }, used: { ...view.used } };
}

// ── UI drivers: a real click, then await the composable action and the re-render ───────────────────
async function clickNode(node: HTMLElement | null): Promise<boolean> {
  if (node === null) return false;
  (node as HTMLButtonElement).click();
  await settle();
  return true;
}
/**
 * One UI action: the real click, the awaited composable action, the re-render, and then the FULL
 * observation — so a driver's return value carries `clicked` plus the post-action probe and
 * snapshot the case asserts against (a bare boolean cannot be read for the rendered state).
 */
async function act(node: HTMLElement | null): Promise<AnyRecord> {
  const clicked = await clickNode(node);
  return { clicked, ...observe() };
}

const api: AnyRecord = {
  ready: true,
  constants: {
    ENV, H_LEAD, H_WORKER, H_ACP, LEAD_P, WORKER_P, ACP_P, THREAD_1, THREAD_2, LEASE_OWNER,
    UNKNOWN_ATTEMPT_ID, CRITERIA,
  },
  errors: () => [...errors],
  domText: () => `${document.body.innerText}\n${domHost.textContent ?? ''}`,
  boot,
  observe,
  probe,
  productTask,
  productBudgets,
  /**
   * The coordinator's OWN budget view, with its frozen-ness observed WHERE THE OBJECT LIVES:
   * every other observation is spread into a plain object to survive the evaluate boundary, and a
   * spread copy can never carry `Object.isFrozen` across it — so the booleans are computed in THIS
   * realm and only the booleans cross (the same in-realm pattern as `tables`'s `errorCodesFrozen`).
   */
  budgetsFrozen: () => {
    const view = coordinator.budgets();
    return { view: Object.isFrozen(view), limits: Object.isFrozen(view.limits), used: Object.isFrozen(view.used) };
  },
  productMailboxDepth: () => coordinator.mailbox(state.team.value?.teamId ?? '').length,

  /** The frozen shared contract every collaboration rejection travels through, recomputed here. */
  tables: (shared: AnyRecord) => {
    const shape = shared.errorShape as { code: ErrorCode; field: string; detail: AnyRecord };
    const payload = {
      errorCodes: [...ERROR_CODES],
      errorCodeCount: ERROR_CODES.length,
      errorCodesFrozen: Object.isFrozen(ERROR_CODES),
      collaborationErrorShape: (() => {
        const error = new CollaborationError(shape.code, shape.field, shape.detail);
        return {
          name: error.name,
          code: error.code,
          field: error.field,
          reason: error.reason,
          message: error.message,
          detail: error.detail === null ? null : { ...error.detail },
          isProtocolError: error instanceof ProtocolError,
          isTypeError: error instanceof TypeError,
        };
      })(),
      collaborationCodesInTable: (shared.collaborationCodes as readonly string[])
        .every((code) => ERROR_CODES.includes(code as never)),
      atExplicit: parseAt(shared.at.explicit as number),
      atZero: capture(() => parseAt(shared.at.zero as number)),
      atNegative: capture(() => parseAt(shared.at.negative as number)),
      atFractional: capture(() => parseAt(shared.at.fractional as number)),
      atNonNumber: capture(() => parseAt(shared.at.nonNumber as unknown as number)),
    };
    domHost.textContent = JSON.stringify(payload, null, 2);
    return payload;
  },
  /** Every rejection code this realm observed is a member of the frozen canonical table. */
  codeMembership: (codes: readonly string[]) => {
    const missing = codes.filter((code) => !ERROR_CODES.includes(code as never));
    domHost.textContent = JSON.stringify({ observedCount: codes.length, missing }, null, 2);
    return {
      observedCount: codes.length,
      missing,
      allObservedCodesInTable: missing.length === 0,
      distinctObserved: new Set(codes).size,
    };
  },

  // ── container actions the product renders no button for (mirrors the landed unit test) ──
  openTeam: async (input: { threadId: string; teamName?: string }) => {
    track(state.openTeam({
      threadId: input.threadId,
      teamName: input.teamName ?? 'Team Beta',
      environmentId: ENV,
      owner: OWNER,
      lease: LEASE,
    }));
    await settle();
    return observe();
  },
  addMember: async (input: { key: string; role: 'lead' | 'worker'; harnessKind: string; participantId: string }) => {
    state.addMember({ role: input.role, harnessKind: input.harnessKind, session: SESSIONS[input.key], participantId: input.participantId });
    await settle();
    return observe();
  },
  createTask: async (input: { title: string; criteria?: readonly { id: string; text: string; required?: boolean }[] }) => {
    state.createTask({ title: input.title, criteria: input.criteria ?? CRITERIA });
    // A container action is synchronous, but the RENDER is not: await the re-render before
    // observing, or every probe reads the DOM one tick behind the state (the task-31/32 lesson).
    await settle();
    return observe();
  },
  /**
   * A task created through the composable (so the Thread-target capture registers it) and then
   * given a REAL dependency edge through the coordinator's own addDependency — the composable's
   * createTask exposes no dependsOn, so the container adds the edge on the service it owns. A
   * following UI action syncs the composable's read model.
   *
   * `dependsOn` is the SINGLE task id the entry's own parameter declares and the case passes, and
   * it is forwarded BARE: the receiver parses it with parseTaskId, which requires a uuid string.
   * Wrapping it in an array made the entry disagree with both its own declaration and the
   * receiver's contract, and the product refused the array with a readable invalid_request.
   */
  createDependentTask: (input: { title: string; dependsOn: string }) => {
    state.createTask({ title: input.title, criteria: CRITERIA });
    const created = state.tasks.value[state.tasks.value.length - 1];
    if (created === undefined) throw new Error('task42 browser entry: createTask produced no task');
    const view = coordinator.addDependency({ taskId: created.taskId, dependsOn: input.dependsOn }) as unknown as AnyRecord;
    return { taskId: created.taskId, dependsOn: [...(view.dependsOn ?? [])] };
  },
  registerDeliverable: async (input: { taskId: string; deliverable: { deliverableId: string; artifactHash: string; bytes: number; paths: readonly string[] } }) => {
    state.registerDeliverable(input.taskId, input.deliverable);
    await settle();
    return observe();
  },
  acceptTask: async (input: { taskId: string; deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }) => {
    state.acceptTask(input.taskId, input);
    await settle();
    return observe();
  },
  cancelTask: async (input: { taskId: string; reason?: string }) => {
    state.cancelTask(input.taskId, input.reason);
    await settle();
    return observe();
  },
  sendTaskWithoutAttempt: async (taskId: string) => { void state.sendTask(taskId); await settle(); return observe(); },
  finishTaskWithoutAttempt: async (input: { taskId: string; nativeEventId: string }) => { state.finishTask(input.taskId, input.nativeEventId); await settle(); return observe(); },
  allocateWriter: async (input: { taskId: string; repository: string }) => { track(state.allocateWriter(input.taskId, input.repository)); await settle(); return observe(); },
  seedWriterLease: (input: { lease: WriterLeaseView; posture: AnyRecord }) => {
    seededLease = { ...input.lease, policy: { ...input.lease.policy } };
    seededPosture = Object.freeze({
      ...input.posture,
      guarantees: Object.freeze([...(input.posture.guarantees ?? [])]),
      notProvided: Object.freeze([...(input.posture.notProvided ?? [])]),
    });
    return { seeded: true, leaseId: seededLease.leaseId, postureKeys: Object.keys(seededPosture) };
  },
  writerAllocateCalls: () => writerAllocateCalls.map((entry) => ({ ...entry })),

  // ── the coordinator's own surfaces the composable does not expose ──
  postMessages: (input: { count: number }) => {
    const teamId = state.team.value?.teamId ?? '';
    const results: { code: string | null; field: string | null }[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const envelope = capture(() => coordinator.postMessage({ teamId, from: LEAD_P, to: WORKER_P, text: `message-${index}` }));
      if (envelope.code !== null) observedCodes.add(envelope.code);
      results.push(envelope);
    }
    return { attempted: input.count, depth: coordinator.mailbox(teamId).length, refusals: results.filter((entry) => entry.code !== null) };
  },
  attemptOf: (attemptId: string) => {
    const envelope = capture(() => coordinator.attempt(attemptId));
    if (envelope.code !== null) observedCodes.add(envelope.code);
    return envelope;
  },
  observedCodes: () => [...observedCodes],
  deliverCalls: () => ({
    coordinator: coordinatorDeliverCalls.map((entry) => ({ ...entry })),
    fanout: fanoutDeliverCalls.map((entry) => ({ ...entry })),
  }),

  // ── UI drivers ──
  selectTaskViaUi: (taskId: string) => act(buttonOf(taskRow(taskId) as HTMLElement, 'task-select')),
  dispatchViaUi: (taskId: string) => act(buttonOf(taskRow(taskId) as HTMLElement, 'task-dispatch')),
  sendViaUi: () => act(element('attempt-send')),
  typeNativeEventId: (value: string) => typeInto('native-event-input', value),
  finishViaUi: () => act(element('attempt-finish')),
  registerDeliverableViaUi: () => act(element('register-deliverable')),
  submitReviewViaUi: (taskId: string) => act(buttonOf(taskRow(taskId) as HTMLElement, 'task-submit-review')),
  approveViaUi: () => act(element('approve-integration')),
  acceptViaUi: (taskId: string) => act(buttonOf(taskRow(taskId) as HTMLElement, 'task-accept')),
  rejectViaUi: (taskId: string) => act(buttonOf(taskRow(taskId) as HTMLElement, 'task-reject')),
  cancelViaUi: (taskId: string) => act(buttonOf(taskRow(taskId) as HTMLElement, 'task-cancel')),
  typeFanoutPrompt: (value: string) => typeInto('fanout-prompt', value),
  fanOutViaUi: () => act(element('fanout-trigger')),

  // ── the imported-theme token pipeline, measured with real computed colours ──
  applyTheme: (kind: 'soft-white' | 'anime-night' | 'anime-dream') => {
    const preset: RegionThemeConfig = kind === 'soft-white' ? SOFT_WHITE_PRESET : kind === 'anime-night' ? ANIME_NIGHT_PRESET : ANIME_DREAM_PRESET;
    const storage = regionThemeToStorage(preset);
    const snapshot = createSemanticTokenSnapshot(extractSemanticTokenOverrides(storage));
    const root = document.documentElement;
    for (const token of SEMANTIC_THEME_TOKENS) {
      const value = snapshot[token];
      if (value) root.style.setProperty(semanticTokenCssVariable(token), value);
    }
    root.setAttribute(THEME_ROOT_ATTRIBUTE, kind);
    return {
      kind,
      preset: storage?.preset ?? null,
      tokenCount: SEMANTIC_THEME_TOKENS.filter((token) => Boolean(snapshot[token])).length,
    };
  },
  styleProbe: () => {
    const modal = document.querySelector('[data-testid="collaboration-panel"] .modal') as HTMLElement | null;
    const style = modal === null ? null : getComputedStyle(modal);
    return {
      themeAttribute: document.documentElement.getAttribute(THEME_ROOT_ATTRIBUTE),
      modalPresent: modal !== null,
      modalColor: style?.color ?? null,
      modalBackground: style?.backgroundColor ?? null,
      expectedSoftWhiteModalText: rgbOf(SOFT_WHITE_PRESET.regions.modalPanel?.text),
      expectedAnimeNightModalText: rgbOf(ANIME_NIGHT_PRESET.regions.modalPanel?.text),
      expectedAnimeDreamModalText: rgbOf(ANIME_DREAM_PRESET.regions.modalPanel?.text),
    };
  },
  layoutProbe: () => {
    const modal = document.querySelector('[data-testid="collaboration-panel"] .modal') as HTMLElement | null;
    const doc = document.documentElement;
    const buttons = [...document.querySelectorAll('[data-testid="collaboration-panel"] button')] as HTMLButtonElement[];
    const modalRect = modal?.getBoundingClientRect() ?? null;
    const reach = buttons.map((button) => {
      // Scroll the button into the modal's own viewport, then measure where it actually landed.
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      return {
        testId: button.getAttribute('data-testid'),
        text: (button.textContent ?? '').trim(),
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        withinModalHorizontally: modalRect === null ? null : rect.left >= modalRect.left - 1 && rect.right <= modalRect.right + 1,
        withinModalVertically: modalRect === null ? null : rect.top >= modalRect.top - 1 && rect.bottom <= modalRect.bottom + 1,
        disabled: button.disabled,
      };
    });
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      docHorizontalOverflow: doc.scrollWidth - doc.clientWidth,
      modalPresent: modal !== null,
      modalScrollWidth: modal?.scrollWidth ?? null,
      modalClientWidth: modal?.clientWidth ?? null,
      modalHorizontalOverflow: modal === null ? null : modal.scrollWidth - modal.clientWidth,
      buttonCount: buttons.length,
      buttons: reach,
    };
  },
};

function rgbOf(hex: string | undefined): string | null {
  if (typeof hex !== 'string') return null;
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (match === null) return null;
  const value = Number.parseInt(match[1], 16);
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`;
}

(window as unknown as AnyRecord).task42 = api;
