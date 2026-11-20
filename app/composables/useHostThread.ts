import { computed, ref, shallowRef, shallowReadonly } from 'vue';
import type { RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import type { ThreadSummary } from '../../bridge/runtime/threads/threadService.js';
import type { HostMutationCall } from '../../shared/runtime/hostWire.js';
import type { HostClient } from '../runtime/hostClient';
import { hostArray, hostObject, hostPage, hostString } from '../runtime/hostCollaborationViews';
import type { HostPageView } from '../runtime/hostCollaborationViews';
import { hostHandoff, hostHandoffOps, hostParticipant, hostThread, hostTimeline } from '../runtime/hostThreadViews';
import type { TimelinePage } from '../runtime/timeline';
import { effectiveTargetParticipants } from './useRuntimeThread';
import type { RuntimeThreadState, RuntimeHandoffView, RuntimeHandoffOpView } from './useRuntimeThread';
import { MAX_CHECKPOINT_ENTRIES, parseCheckpoint, parseTarget } from '../../shared/runtime/context.js';
import type { ContextCheckpointView, EvidenceRecordView, EvidenceTarget } from '../../shared/runtime/context.js';
import { hostEvidencePage, hostEvidenceRecord } from '../runtime/hostEvidenceViews';
import type { EvidenceCaptureInput, EvidencePageRequest } from '../runtime/hostEvidenceViews';

export function createHostThreadState(getHost: () => HostClient | null) {
  const owner = shallowRef<Readonly<{ host: HostClient; target: HostClient['target']; generation: number; session: SessionRef; repo: RepoRef }> | null>(null);
  const threadId = ref<string | null>(null);
  const summary = ref<ThreadSummary | null>(null);
  const targets = ref<readonly string[]>([]);
  const handoff = ref<RuntimeHandoffView | null>(null);
  const handoffOps = ref<readonly RuntimeHandoffOpView[]>([]);
  const handoffs = ref<readonly RuntimeHandoffView[]>([]);
  const handoffPage = ref<HostPageView>({ offset: 0, total: 0, nextCursor: null });
  const checkpoint = ref<ContextCheckpointView | null>(null);
  const currentTarget = ref<EvidenceTarget | null>(null);
  const evidenceTargetError = ref('');
  const capturedEvidence = ref<readonly EvidenceRecordView[]>([]);
  const selectedSession = ref<SessionRef | null>(null);
  const resolvedSelected = ref<ThreadSummary['participants'][number] | null>(null);
  const targetSession = ref<SessionRef | null>(null);
  const busy = ref(false);
  const error = ref('');
  const timelinePage = ref<TimelinePage | null>(null);
  const timelineOffset = ref(0);
  const participantPage = ref<HostPageView>({ offset: 0, total: 0, nextCursor: null });
  let repo: RepoRef | null = null;
  let host: HostClient | null = null;
  let generation = 0;
  let sequence = 0;
  let latestRefresh: Promise<void> | undefined;
  let pending = 0;
  let unsubscribe = () => {};
  let scheduled = false;

  function threadForSession(session: SessionRef) {
    const participant = summary.value?.participants.find((participant) => encodeSessionKey(participant.session) === encodeSessionKey(session))
      ?? (resolvedSelected.value && encodeSessionKey(resolvedSelected.value.session) === encodeSessionKey(session) ? resolvedSelected.value : null);
    return participant && threadId.value ? { threadId: threadId.value, participantId: participant.participantId } : null;
  }
  const selectedSessionResolution = computed(() => selectedSession.value ? threadForSession(selectedSession.value) : null);
  function current(captured: HostClient, token: number): boolean {
    return captured === host && generation === token && captured.isCurrent();
  }

  async function refresh(captured = host, token = generation): Promise<void> {
    const id = threadId.value;
    if (!captured || !id || !current(captured, token)) return;
    const turn = ++sequence;
    const reading = readThread(captured, token, id, turn);
    latestRefresh = reading;
    try {
      await reading;
    } catch (failure) {
      if (turn === sequence) throw failure;
    }
    // A change event may supersede a user action's read before it publishes.
    // Wait for the replacement before the caller uses the Thread summary.
    while (current(captured, token) && latestRefresh && latestRefresh !== reading) {
      const replacement: Promise<void> = latestRefresh;
      try {
        await replacement;
      } catch (failure) {
        if (replacement === latestRefresh) throw failure;
      }
      if (replacement === latestRefresh) break;
    }
  }

  async function readThread(captured: HostClient, token: number, id: string, turn: number): Promise<void> {
    const selected = selectedSession.value;
    const target = targetSession.value;
    const resolve = (session: SessionRef | null) => session
      ? captured.read({ domain: 'thread', operation: 'resolveSession', args: { threadId: id, session } }, (value) => value === null ? null : hostParticipant(value))
      : Promise.resolve(null);
    const [raw, membership, active, timeline, selectedParticipant, targetParticipant, handoffHistory] = await Promise.all([
      captured.read({ domain: 'thread', operation: 'snapshot', args: { threadId: id } }, hostObject),
      captured.read({ domain: 'thread', operation: 'participants', args: { threadId: id, cursor: participantPage.value.offset } }, hostObject),
      captured.read({ domain: 'thread', operation: 'active', args: { threadId: id } }, (value) => value === null ? null : hostParticipant(value)),
      captured.read({ domain: 'thread', operation: 'timeline', args: { threadId: id, cursor: timelineOffset.value, limit: 50 } }, hostTimeline),
      resolve(selected), resolve(target),
      captured.read({ domain: 'thread', operation: 'handoffs', args: { threadId: id, cursor: handoffPage.value.offset, limit: 50 } }, hostObject),
    ]);
    if (!current(captured, token) || turn !== sequence) return;
    const participants = hostArray(membership.participants).map(hostParticipant);
    for (const participant of [active, selectedParticipant, targetParticipant]) {
      if (participant && !participants.some((existing) => existing.participantId === participant.participantId)) participants.push(participant);
    }
    const next = hostThread({ ...hostObject(raw.thread), participants });
    if (next.threadId !== id || next.environmentId !== captured.target) throw new Error('The Bridge returned a different Thread.');
    const history = hostArray(handoffHistory.handoffs).map(hostHandoff);
    handoffs.value = history;
    handoffPage.value = hostPage(handoffHistory.pagination, 'handoffs');
    summary.value = next;
    if (selectedSession.value === selected) resolvedSelected.value = selectedParticipant;
    participantPage.value = hostPage(membership.pagination, 'participants');
    targets.value = targets.value.filter((id) => next.participants.some((participant) => participant.participantId === id && participant.state === 'active'));
    handoff.value = history.find((entry) => entry.handoffId === handoff.value?.handoffId) ?? history[0] ?? null;
    timelinePage.value = timeline;
    if (handoff.value) {
      const handoffId = handoff.value.handoffId;
      const [ops, context] = await Promise.all([
        captured.read({ domain: 'handoff', operation: 'ops', args: { handoffId } }, hostHandoffOps),
        captured.read({ domain: 'handoff', operation: 'checkpoint', args: { handoffId } }, parseCheckpoint),
      ]);
      let target: EvidenceTarget | null = null, unavailable = '';
      if (context.evidence.length) {
        try { target = await captured.read({ domain: 'handoff', operation: 'evidenceTarget', args: { handoffId } }, parseTarget); }
        catch { unavailable = 'Evidence is unavailable at the current target. Recover its writer or reconnect the source.'; }
      }
      if (current(captured, token) && turn === sequence) { handoffOps.value = ops; checkpoint.value = context; currentTarget.value = target; evidenceTargetError.value = unavailable; }
    } else { handoffOps.value = []; checkpoint.value = null; currentTarget.value = null; evidenceTargetError.value = ''; }
  }

  async function run(action: (captured: HostClient, token: number) => Promise<void>, background = false): Promise<void> {
    const captured = host;
    const token = generation;
    if (!captured || !current(captured, token)) { error.value = 'Connect to this Thread’s Bridge before continuing.'; return; }
    if (!background) {
      pending += 1;
      busy.value = true;
      error.value = '';
    }
    try { await action(captured, token); }
    catch (failure) { if (token === generation && captured === host && (!background || !error.value)) error.value = failure instanceof Error ? failure.message : 'The Thread operation failed.'; }
    finally { if (!background && token === generation) { pending -= 1; busy.value = pending > 0; } }
  }

  async function change(call: HostMutationCall): Promise<void> {
    await run(async (captured, token) => {
      await captured.mutate(call, (value) => value, crypto.randomUUID()).executed;
      await refresh(captured, token);
    });
  }

  async function openThread(input: { session: SessionRef; repo: RepoRef }, targetHost = getHost()): Promise<void> {
    closeThread();
    const captured = targetHost;
    if (!captured || captured.target !== input.session.environmentId) { error.value = 'The session and Bridge target do not match.'; return; }
    host = captured;
    repo = input.repo;
    const token = generation;
    owner.value = Object.freeze({ host: captured, target: captured.target, generation: token, session: Object.freeze({ ...input.session }), repo: Object.freeze({ ...input.repo }) });
    subscribeHost(captured, token);
    await run(async (captured, token) => {
      const binding = await captured.mutate({ domain: 'thread', operation: 'bind', args: input }, hostObject, `thread-bind:${encodeSessionKey(input.session)}`).executed;
      if (!current(captured, token)) return;
      threadId.value = hostString(binding.threadId);
      await refresh(captured, token);
    });
  }

  function subscribeHost(captured: HostClient, token: number) {
    unsubscribe = captured.onChanged(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (current(captured, token)) void run((captured, token) => refresh(captured, token), true);
      });
    });
  }

  async function reconnectHost(captured: HostClient): Promise<void> {
    const previous = owner.value;
    if (!previous || captured.target !== previous.target || !captured.isCurrent()) throw new Error('Reconnect the original Thread Bridge before continuing.');
    if (host?.isCurrent()) return;
    unsubscribe(); scheduled = false;
    const token = ++generation;
    sequence++; latestRefresh = undefined; pending = 0; busy.value = false;
    host = captured;
    owner.value = Object.freeze({ ...previous, host: captured, generation: token });
    subscribeHost(captured, token);
    await run((captured, token) => refresh(captured, token));
  }

  function closeThread(): void {
    unsubscribe();
    unsubscribe = () => {};
    scheduled = false;
    generation += 1;
    sequence += 1;
    latestRefresh = undefined;
    host = null;
    owner.value = null;
    repo = null;
    pending = 0;
    threadId.value = null;
    summary.value = null;
    targets.value = [];
    targetSession.value = null;
    resolvedSelected.value = null;
    handoff.value = null;
    handoffOps.value = [];
    handoffs.value = [];
    handoffPage.value = { offset: 0, total: 0, nextCursor: null };
    evidenceTargetError.value = '';
    checkpoint.value = null;
    currentTarget.value = null;
    capturedEvidence.value = [];
    busy.value = false;
    error.value = '';
    timelinePage.value = null;
    timelineOffset.value = 0;
    participantPage.value = { offset: 0, total: 0, nextCursor: null };
  }

  const state: RuntimeThreadState = {
    available: true, threadId, summary, targets, handoff, handoffOps, selectedSession, busy, error, timelinePage, selectedSessionResolution,
    openThread, closeThread, threadForSession,
    effectiveTargets: computed(() => effectiveTargetParticipants(summary.value, targets.value)),
    locateSession(session) {
      if (session && !threadForSession(session)) return null;
      state.setSelectedSession(session);
      return selectedSessionResolution.value;
    },
    joinThread: async (session) => {
      if (!threadId.value || !repo) { error.value = 'Open a Thread before joining a session.'; return; }
      if (threadForSession(session)) return;
      await change({ domain: 'thread', operation: 'join', args: { threadId: threadId.value, session, repo } });
    },
    leaveParticipant: async (participantId) => { if (threadId.value) await change({ domain: 'thread', operation: 'leave', args: { threadId: threadId.value, participantId } }); },
    resumeParticipant: async (participantId) => { if (threadId.value) await change({ domain: 'thread', operation: 'resume', args: { threadId: threadId.value, participantId } }); },
    activateParticipant: async (participantId) => { if (threadId.value) await change({ domain: 'thread', operation: 'activate', args: { threadId: threadId.value, participantId } }); },
    setTarget: (participantId) => {
      const participant = summary.value?.participants.find((participant) => participant.participantId === participantId && participant.state === 'active');
      if (participant) { targets.value = [participantId]; targetSession.value = participant.session; }
      else error.value = 'This participant is not active in the current Thread.';
    },
    clearTarget: () => { targets.value = []; targetSession.value = null; },
    setSelectedSession: (session) => {
      selectedSession.value = session; resolvedSelected.value = null;
      if (host && threadId.value) void run((captured, token) => refresh(captured, token), true);
    },
    sessionOfParticipant: (participantId) => summary.value?.participants.find((participant) => participant.participantId === participantId)?.session ?? null,
    beginHandoff: async (input) => {
      if (handoff.value && !['active', 'failed', 'cancelled'].includes(handoff.value.state)) { error.value = 'Resolve the current handoff before starting another.'; return; }
      if (!threadId.value || !input.entries?.length || !input.prompt.trim()) { error.value = 'A handoff requires a prompt and a context checkpoint.'; return; }
      await run(async (captured, token) => {
        const entries = [...hostArray(input.entries), ...capturedEvidence.value.map((record) => ({ class: 'artifact', origin: { ...record.origin }, evidence: { hash: record.hash, bytes: record.bytes, target: { ...record.target } } }))];
        if (entries.length > MAX_CHECKPOINT_ENTRIES) throw new Error('Remove some selected evidence before preparing this handoff.');
        const begun = await captured.mutate({ domain: 'handoff', operation: 'begin', args: {
          sourceParticipantId: input.sourceParticipantId, targetParticipantId: input.targetParticipantId,
          entries, threadId: threadId.value ?? '',
        } }, hostHandoff, crypto.randomUUID()).executed;
        const attached = await captured.mutate({ domain: 'handoff', operation: 'attach', args: { handoffId: begun.handoffId } }, hostHandoff, crypto.randomUUID()).executed;
        if (!current(captured, token)) return;
        handoff.value = attached;
        handoffPage.value = { ...handoffPage.value, offset: 0 };
        await refresh(captured, token);
      });
    },
    prepareHandoff: async (prompt) => { if (handoff.value) await change({ domain: 'handoff', operation: 'prepare', args: { handoffId: handoff.value.handoffId, prompt } }); },
    deliverHandoff: async () => { if (handoff.value) await change({ domain: 'handoff', operation: 'deliver', args: { handoffId: handoff.value.handoffId } }); },
    cancelHandoff: async (reason) => { if (handoff.value) await change({ domain: 'handoff', operation: 'cancel', args: { handoffId: handoff.value.handoffId, ...(reason ? { reason } : {}) } }); },
    observeHandoff: async () => { error.value = 'The Agent reports native observations through the Bridge.'; },
  };
  return {
    ...state, openThread, reconnectHost, owner: shallowReadonly(owner), participantPage, timelineOffset, checkpoint, currentTarget, evidenceTargetError, capturedEvidence, handoffs, handoffPage,
    loadHandoffPage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= handoffPage.value.total) return Promise.resolve();
      handoffPage.value = { ...handoffPage.value, offset }; handoff.value = null;
      checkpoint.value = null; currentTarget.value = null; handoffOps.value = []; evidenceTargetError.value = '';
      return run((captured, token) => refresh(captured, token));
    },
    selectHandoff: (handoffId: string) => {
      const selected = handoffs.value.find(entry => entry.handoffId === handoffId);
      if (!selected || busy.value) return Promise.resolve();
      handoff.value = selected;
      checkpoint.value = null; currentTarget.value = null; handoffOps.value = []; evidenceTargetError.value = '';
      return run((captured, token) => refresh(captured, token));
    },
    captureEvidence: async (input: EvidenceCaptureInput): Promise<EvidenceRecordView | null> => {
      let result: EvidenceRecordView | null = null;
      await run(async (captured, token) => {
        const id = threadId.value;
        if (!id) throw new Error('Open a Thread before capturing evidence.');
        if (capturedEvidence.value.length >= MAX_CHECKPOINT_ENTRIES) throw new Error('Remove some selected evidence before capturing another file.');
        const record = await captured.mutate({ domain: 'handoff', operation: 'captureEvidence', args: { threadId: id, kind: input.kind, path: input.path } }, hostEvidenceRecord, crypto.randomUUID()).executed;
        if (!current(captured, token)) return;
        capturedEvidence.value = [...capturedEvidence.value.filter((previous) => !(
          previous.origin.kind === 'file' && record.origin.kind === 'file' && previous.origin.path === record.origin.path ||
          previous.origin.kind === 'diff' && record.origin.kind === 'diff' && previous.origin.path === record.origin.path && previous.origin.repoKey === record.origin.repoKey
        )), record];
        result = record;
      });
      return result;
    },
    removeCapturedEvidence: (hash: string) => { capturedEvidence.value = capturedEvidence.value.filter((record) => record.hash !== hash); },
    readEvidencePage: async (request: EvidencePageRequest) => {
      const captured = host, token = generation, handoffId = handoff.value?.handoffId;
      if (!captured || !handoffId || !current(captured, token)) throw new Error('Open the current handoff before reading evidence.');
      const value = await captured.read({ domain: 'handoff', operation: 'evidencePage', args: {
        handoffId, ref: request.ref, currentTarget: request.currentTarget,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.length === undefined ? {} : { length: request.length }),
      } }, hostEvidencePage);
      if (!current(captured, token) || handoff.value?.handoffId !== handoffId) throw new Error('The handoff changed before its evidence page arrived.');
      if (value.available && (value.hash !== request.ref.hash || value.target.repoKey !== request.currentTarget.repoKey || value.target.revision !== request.currentTarget.revision)) throw new Error('The Bridge returned evidence for a different target.');
      return value;
    },
    loadTimelinePage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= (timelinePage.value?.total ?? 0)) return Promise.resolve();
      timelineOffset.value = offset;
      return run((captured, token) => refresh(captured, token));
    },
    loadParticipantPage: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= participantPage.value.total) return Promise.resolve();
      participantPage.value = { ...participantPage.value, offset };
      return run((captured, token) => refresh(captured, token));
    },
    refresh: () => run((captured, token) => refresh(captured, token)),
  };
}
