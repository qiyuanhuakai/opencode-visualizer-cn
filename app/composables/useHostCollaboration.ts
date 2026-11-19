import { computed, ref } from 'vue';
import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import type { HostMutationCall } from '../../shared/runtime/hostWire.js';
import type { HostClient } from '../runtime/hostClient';
import {
  hostArray, hostAttempt, hostBudgets, hostFanout, hostObject, hostPage, hostString, hostTask, hostTeam, hostWriter,
} from '../runtime/hostCollaborationViews';
import type {
  RuntimeCollaborationState, CollaborationAttemptView, CollaborationBudgetView,
  CollaborationFanoutView, CollaborationTaskView, CollaborationTeamView, CollaborationWriterView,
} from './useRuntimeCollaboration';
import { createHostArtifactState } from './useHostArtifacts';
import type { HostPageView } from '../runtime/hostCollaborationViews';
import type { FanoutAction } from '../runtime/hostCollaborationViews';

export function createHostCollaborationState(getHost: () => HostClient | null) {
  const threadId = ref<string | null>(null);
  const team = ref<CollaborationTeamView | null>(null);
  const tasks = ref<readonly CollaborationTaskView[]>([]);
  const selectedTaskId = ref<string | null>(null);
  const attempts = ref<readonly CollaborationAttemptView[]>([]);
  const budgets = ref<CollaborationBudgetView | null>(null);
  const fanout = ref<CollaborationFanoutView | null>(null);
  const fanouts = ref<readonly CollaborationFanoutView[]>([]);
  const fanoutPage = ref<HostPageView>({ offset: 0, total: 0, nextCursor: null });
  const writer = ref<CollaborationWriterView | null>(null);
  const busy = ref(false);
  const error = ref('');
  const detail = ref<CollaborationTaskView | null>(null);
  const taskPage = ref<HostPageView>({ offset: 0, total: 0, nextCursor: null });
  const memberPage = ref<HostPageView>({ offset: 0, total: 0, nextCursor: null });
  const attemptPage = ref<HostPageView>({ offset: 0, total: 0, nextCursor: null });
  const selectedTask = computed(() => detail.value?.taskId === selectedTaskId.value ? detail.value : tasks.value.find((task) => task.taskId === selectedTaskId.value) ?? null);
  let generation = 0;
  let activeHost: HostClient | null = null;
  let snapshot: ReturnType<typeof hostObject> | null = null;
  let creation: Parameters<RuntimeCollaborationState['openTeam']>[0] | null = null;
  let pending = 0;
  let refreshSequence = 0;
  let unsubscribe = () => {};
  let scheduled = false;
  const artifacts = createHostArtifactState({
    selectedTaskId, error, current, run, refresh,
    task: (taskId) => tasks.value.find((task) => task.taskId === taskId) ?? null,
    leaseId: (taskId) => {
      return selectedTaskId.value === taskId ? writer.value?.leaseId ?? null : null;
    },
  });

  function current(host: HostClient, token: number): boolean {
    return token === generation && host === activeHost && host.isCurrent();
  }

  async function refresh(host = activeHost, token = generation): Promise<void> {
    const teamId = team.value?.teamId;
    if (!host || !teamId || !current(host, token)) return;
    const sequence = ++refreshSequence;
    const [raw, budget, membership, history] = await Promise.all([
      host.read({ domain: 'collaboration', operation: 'snapshot', args: { teamId, cursor: taskPage.value.offset } }, hostObject),
      host.read({ domain: 'collaboration', operation: 'budgets', args: {} }, hostBudgets),
      host.read({ domain: 'collaboration', operation: 'membersPage', args: { teamId, cursor: memberPage.value.offset } }, hostObject),
      host.read({ domain: 'fanout', operation: 'fanoutsPage', args: { teamId, cursor: fanoutPage.value.offset, limit: 50 } }, hostObject),
    ]);
    if (!current(host, token) || sequence !== refreshSequence) return;
    if (raw.threadId !== threadId.value) throw new ProtocolError('unauthorized', 'collaboration.thread');
    if (history.threadId !== threadId.value || history.teamId !== teamId) throw new ProtocolError('unauthorized', 'collaboration.fanout');
    const nextFanouts = hostArray(history.fanouts).map(hostFanout);
    const selectedFanout = nextFanouts.find(entry => entry.fanoutId === fanout.value?.fanoutId) ?? nextFanouts[0] ?? null;
    const fanoutDetail = selectedFanout ? await host.read({ domain: 'fanout', operation: 'fanout', args: { fanoutId: selectedFanout.fanoutId } }, hostFanout) : null;
    if (!current(host, token) || sequence !== refreshSequence) return;
    fanouts.value = nextFanouts;
    fanoutPage.value = hostPage(history.pagination, 'fanouts');
    fanout.value = fanoutDetail;
    const allAttempts = hostArray(raw.attempts).map(hostAttempt);
    const nextTasks = hostArray(raw.tasks).map((task) => hostTask(task, allAttempts));
    const nextTeam = hostTeam({ ...hostObject(raw.team), members: membership.members });
    snapshot = raw;
    team.value = nextTeam;
    tasks.value = nextTasks;
    taskPage.value = hostPage(raw.pagination, 'tasks');
    memberPage.value = hostPage(membership.pagination, 'members');
    budgets.value = budget;
    if (!nextTasks.some((task) => task.taskId === selectedTaskId.value)) selectedTaskId.value = null;
    attempts.value = [];
    writer.value = null;
    if (!selectedTaskId.value) { detail.value = null; return; }
    const selectedId = selectedTaskId.value;
    const details = await host.read({ domain: 'collaboration', operation: 'taskDetails', args: { taskId: selectedId, cursor: attemptPage.value.offset } }, hostObject);
    if (!current(host, token) || sequence !== refreshSequence || selectedTaskId.value !== selectedId) return;
    const taskAttempts = hostArray(details.attempts).map(hostAttempt);
    detail.value = hostTask(details.task, taskAttempts);
    attempts.value = taskAttempts;
    attemptPage.value = hostPage(details.pagination, 'attempts');
    const lease = hostArray(details.writers).find((value) => hostObject(value).taskId === selectedId);
    if (lease) {
      const leaseId = hostString(hostObject(lease).leaseId);
      const [posture, binding] = await Promise.all([
        host.read({ domain: 'writer', operation: 'posture', args: { leaseId } }, hostObject),
        host.read({ domain: 'writer', operation: 'binding', args: { leaseId } }, (value) => value),
      ]);
      if (current(host, token) && sequence === refreshSequence) writer.value = hostWriter(lease, posture, binding);
    }
  }

  async function run(action: (host: HostClient, token: number) => Promise<void>, background = false): Promise<void> {
    const host = activeHost;
    const token = generation;
    if (!host || !current(host, token)) { error.value = 'Connect to the Thread’s Bridge before continuing.'; return; }
    pending += 1;
    busy.value = true;
    if (!background) error.value = '';
    try { await action(host, token); }
    catch (failure) {
      if (token === generation && host === activeHost && (!background || !error.value)) error.value = failure instanceof Error ? failure.message : 'The Bridge operation failed.';
    } finally {
      if (token === generation) { pending -= 1; busy.value = pending > 0; }
    }
  }

  async function change(call: HostMutationCall): Promise<void> {
    await run(async (host, token) => {
      await host.mutate(call, (value) => value, crypto.randomUUID()).executed;
      await refresh(host, token);
    });
  }

  function taskAction(taskId: string, call: HostMutationCall): Promise<void> {
    if (!tasks.value.some((task) => task.taskId === taskId)) {
      error.value = 'This task does not belong to the current Thread.';
      return Promise.resolve();
    }
    return change(call);
  }

  async function openTeam(input: Parameters<RuntimeCollaborationState['openTeam']>[0]): Promise<void> {
    closeTeam();
    const host = getHost();
    if (!host || host.target !== input.owner.session.environmentId) {
      error.value = 'The Thread and Bridge target do not match.';
      return;
    }
    activeHost = host;
    const token = generation;
    subscribeHost(host, token);
    creation = input;
    threadId.value = input.threadId;
    await run(async (captured, token) => {
      const existing = await captured.read({ domain: 'collaboration', operation: 'teamForThread', args: { threadId: input.threadId } }, (value) => value);
      const opened = existing === null
        ? await captured.mutate({ domain: 'collaboration', operation: 'openTeam', args: { threadId: input.threadId, name: input.teamName } }, hostObject, `thread-team:${input.threadId}`).executed
        : hostObject(existing);
      if (!current(captured, token)) return;
      team.value = { teamId: hostString(opened.teamId), name: hostString(opened.name), members: [] };
      await refresh(captured, token);
    });
  }

  function subscribeHost(host: HostClient, token: number) {
    unsubscribe = host.onChanged(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (current(host, token)) void run((host, token) => refresh(host, token), true);
      });
    });
  }

  async function reconnectHost(host: HostClient): Promise<void> {
    if (!activeHost || !team.value) return;
    if (host.target !== activeHost.target || !host.isCurrent()) throw new Error('Reconnect the original team Bridge before continuing.');
    if (activeHost.isCurrent()) return;
    unsubscribe(); scheduled = false;
    const token = ++generation;
    refreshSequence++; pending = 0; busy.value = false;
    artifacts.reset();
    activeHost = host;
    subscribeHost(host, token);
    await run((host, token) => refresh(host, token));
  }

  function selectTask(taskId: string | null): void {
    artifacts.reset();
    detail.value = null;
    attemptPage.value = { offset: 0, total: 0, nextCursor: null };
    selectedTaskId.value = tasks.value.some((task) => task.taskId === taskId) ? taskId : null;
    attempts.value = selectedTask.value?.attempts ?? [];
    writer.value = null;
    void run((host, token) => refresh(host, token));
  }

  function closeTeam(): void {
    unsubscribe();
    unsubscribe = () => {};
    scheduled = false;
    generation += 1;
    activeHost = null;
    creation = null;
    snapshot = null;
    pending = 0;
    busy.value = false;
    threadId.value = null;
    team.value = null;
    tasks.value = [];
    selectedTaskId.value = null;
    attempts.value = [];
    budgets.value = null;
    fanout.value = null;
    fanouts.value = [];
    fanoutPage.value = { offset: 0, total: 0, nextCursor: null };
    writer.value = null;
    error.value = '';
    detail.value = null;
    taskPage.value = { offset: 0, total: 0, nextCursor: null };
    memberPage.value = { offset: 0, total: 0, nextCursor: null };
    attemptPage.value = { offset: 0, total: 0, nextCursor: null };
    artifacts.reset();
  }

  const state: RuntimeCollaborationState = {
    available: true, threadId, team, tasks, selectedTaskId, selectedTask, attempts, budgets, fanout, writer, busy, error,
    openTeam, selectTask, closeTeam,
    addMember: (input) => { if (team.value) void change({ domain: 'collaboration', operation: 'addMember', args: { ...input, teamId: team.value.teamId } }); },
    createTask: (input) => {
      if (!creation || !team.value || !snapshot) return;
      void change({ domain: 'collaboration', operation: 'createTask', args: {
        teamId: team.value.teamId, title: input.title, criteria: input.criteria.map((criterion) => ({ ...criterion, required: criterion.required !== false })),
        owner: creation.owner, lease: hostObject(snapshot.lease),
      } });
    },
    dispatchTask: (taskId) => taskAction(taskId, { domain: 'collaboration', operation: 'dispatch', args: { taskId } }),
    sendTask: (taskId) => run(async (host, token) => {
      if (!tasks.value.some((task) => task.taskId === taskId)) throw new ProtocolError('unauthorized', 'collaboration.task');
      const task = await host.read({ domain: 'collaboration', operation: 'task', args: { taskId } }, hostObject);
      const attemptId = hostArray(task.attempts).at(-1);
      if (attemptId === undefined) throw new Error('Dispatch this task before sending it.');
      await host.mutate({ domain: 'collaboration', operation: 'send', args: { attemptId: hostString(attemptId) } }, (value) => value, crypto.randomUUID()).executed;
      await refresh(host, token);
    }),
    finishTask: () => { error.value = 'Native completion is reported by the Agent through the Bridge.'; },
    registerDeliverable: (taskId, deliverable) => { void taskAction(taskId, { domain: 'collaboration', operation: 'registerDeliverable', args: { taskId, deliverable } }); },
    submitForReview: (taskId, reviewer) => { void taskAction(taskId, { domain: 'collaboration', operation: 'submitForReview', args: { taskId, reviewer } }); },
    reviewTask: (taskId, decision, reviewer) => { void taskAction(taskId, { domain: 'collaboration', operation: 'review', args: { taskId, decision, reviewer } }); },
    approveReview: (taskId, reviewer) => { void taskAction(taskId, { domain: 'collaboration', operation: 'review', args: { taskId, decision: 'approved', reviewer } }); },
    acceptTask: (taskId, input) => { void taskAction(taskId, { domain: 'collaboration', operation: 'accept', args: { taskId, ...input } }); },
    rejectTask: (taskId, reason) => { void taskAction(taskId, { domain: 'collaboration', operation: 'reject', args: { taskId, reason } }); },
    cancelTask: (taskId, reason) => { void taskAction(taskId, { domain: 'collaboration', operation: 'cancelTask', args: { taskId, ...(reason ? { reason } : {}) } }); },
    allocateWriter: (taskId, repository) => taskAction(taskId, { domain: 'writer', operation: 'allocate', args: { taskId, repository } }),
    fanOut: async (prompt, targets) => {
      await run(async (host, token) => {
        const teamId = team.value?.teamId, thread = threadId.value;
        if (!teamId || !thread || !targets.length || targets.some(target => !team.value?.members.some(member => member.participantId === target.participantId && member.sessionKey === encodeSessionKey(target.session)))) throw new ProtocolError('unauthorized', 'collaboration.fanout_targets');
        const created = await host.mutate({ domain: 'fanout', operation: 'createFanout', args: { teamId, threadId: thread, prompt, targets: targets.map((target) => ({ ...target })) } }, hostObject, crypto.randomUUID()).executed;
        const delivered = await host.mutate({ domain: 'fanout', operation: 'dispatch', args: { fanoutId: hostString(created.fanoutId) } }, hostFanout, crypto.randomUUID()).executed;
        if (current(host, token)) {
          fanout.value = delivered;
          fanoutPage.value = { ...fanoutPage.value, offset: 0 };
        }
        await refresh(host, token);
      });
    },
  };
  return {
    reconnectHost,
    ...state, artifacts, artifactStatus: artifacts.status, fanouts, fanoutPage,
    selectFanout: (fanoutId: string) => {
      if (busy.value || !fanouts.value.some(entry => entry.fanoutId === fanoutId)) return Promise.resolve();
      return run(async (host, token) => {
        const selected = await host.read({ domain: 'fanout', operation: 'fanout', args: { fanoutId } }, hostFanout);
        if (current(host, token)) fanout.value = selected;
      });
    },
    loadFanoutPage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= fanoutPage.value.total) return Promise.resolve();
      fanoutPage.value = { ...fanoutPage.value, offset }; fanout.value = null;
      return run((host, token) => refresh(host, token));
    },
    handleFanoutAction: async (action: FanoutAction) => {
      const selected = fanout.value;
      if (!selected) return;
      if ('recipientId' in action && !selected.targets.some((target) => target.recipientId === action.recipientId)) return;
      if (action.type === 'retry' && !selected.retryable.includes(action.recipientId)) return;
      await run(async (host, token) => {
        const call: HostMutationCall = action.type === 'reconcile'
          ? { domain: 'fanout', operation: 'reconcile', args: { fanoutId: selected.fanoutId } }
          : action.type === 'cancel'
            ? { domain: 'fanout', operation: 'cancelRecipient', args: { fanoutId: selected.fanoutId, recipientId: action.recipientId } }
            : { domain: 'fanout', operation: 'retry', args: { fanoutId: selected.fanoutId, recipientIds: [action.recipientId] } };
        const result = await host.mutate(call, hostFanout, crypto.randomUUID()).executed;
        if (current(host, token) && fanout.value?.fanoutId === selected.fanoutId) fanout.value = result;
      });
    },
    taskPage, attemptPage, memberPage,
    loadMemberPage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= memberPage.value.total) return Promise.resolve();
      memberPage.value = { ...memberPage.value, offset };
      return run((host, token) => refresh(host, token));
    },
    loadTaskPage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= taskPage.value.total) return Promise.resolve();
      selectTask(null);
      taskPage.value = { ...taskPage.value, offset };
      return run((host, token) => refresh(host, token));
    },
    loadAttemptPage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= attemptPage.value.total) return Promise.resolve();
      attemptPage.value = { ...attemptPage.value, offset };
      return run((host, token) => refresh(host, token));
    },
    recoverWriter: (input: { leaseId: string; action: 'reconcile' | 'create-missing' | 'reconnect' }) => {
      if (writer.value?.leaseId !== input.leaseId) { error.value = 'Select the task that owns this writer before recovery.'; return Promise.resolve(); }
      return change(input.action === 'reconnect'
        ? { domain: 'writer', operation: 'reconnect', args: { leaseId: input.leaseId } }
        : { domain: 'writer', operation: 'reconcile', args: { leaseId: input.leaseId, createMissing: input.action === 'create-missing' } });
    },
    captureDeliverable: artifacts.captureDeliverable, applyArtifact: artifacts.applyArtifact,
    refresh: () => run((host, token) => refresh(host, token)),
  };
}
