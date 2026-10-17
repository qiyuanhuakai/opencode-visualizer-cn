import { randomUUID } from 'node:crypto';
import { encodeRepoKey, parseRepoRef, parseSessionRef } from '../../../shared/runtime/identity.js';
import { ThreadError, parseThreadId, threadBindingKey } from '../../../shared/runtime/thread.js';
import { createParticipantService } from './participantService.js';

function asSession(value) {
  try {
    return parseSessionRef(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ThreadError('invalid_request', 'thread_session');
    throw error;
  }
}

function asRepo(value) {
  try {
    return parseRepoRef(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ThreadError('invalid_request', 'thread_repo');
    throw error;
  }
}

function view(participant) {
  return Object.freeze({
    participantId: participant.participantId,
    role: participant.role,
    state: participant.state,
    session: participant.session,
    nativeParent: participant.nativeParent,
    harnessInstanceId: participant.harnessInstanceId,
  });
}

/**
 * Canonical Thread service. Threads are created lazily on the first explicit bind; an index of
 * existing sessions never materializes threads by itself. The same native SessionRef always
 * resolves to the same wrapper, and every participant keeps its own native history.
 */
export function createThreadService({ resolveSession } = {}) {
  const participants = createParticipantService({ resolveSession });
  const threadsById = new Map();
  const threadsByBinding = new Map();
  const stats = { threads: 0, bindings: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new ThreadError('cancelled', 'thread_closed');
  }

  function requireThread(threadId) {
    const id = parseThreadId(threadId);
    const thread = threadsById.get(id);
    if (thread === undefined) throw new ThreadError('invalid_request', 'thread_unknown');
    return thread;
  }

  function requireRepoForSession(repo, ref) {
    const repoRef = asRepo(repo);
    if (repoRef.environmentId !== ref.environmentId) throw new ThreadError('invalid_request', 'thread_repo_environment');
    return encodeRepoKey(repoRef);
  }

  async function bind({ session, repo } = {}) {
    assertOpen();
    const ref = asSession(session);
    const repoKey = requireRepoForSession(repo, ref);
    const binding = threadBindingKey(ref);
    const existing = threadsByBinding.get(binding);
    if (existing !== undefined) {
      if (existing.repoKey !== repoKey) throw new ThreadError('conflict', 'thread_repo_mismatch');
      return existing;
    }
    const summary = await resolveSession(ref);
    if (summary === null || summary === undefined) throw new ThreadError('source_unavailable', 'thread_session_missing');
    if (summary.archived === true) throw new ThreadError('conflict', 'thread_session_archived');
    const thread = {
      threadId: randomUUID(),
      environmentId: ref.environmentId,
      repoKey,
      createdAt: Date.now(),
      participants: [],
      activeParticipantId: null,
      revision: 0,
    };
    const participant = await participants.join({ thread, session: ref, repoKey, role: 'owner', summary });
    thread.activeParticipantId = participant.participantId;
    threadsById.set(thread.threadId, thread);
    threadsByBinding.set(binding, thread);
    stats.threads += 1;
    stats.bindings += 1;
    return thread;
  }

  async function join({ threadId, session, repo } = {}) {
    assertOpen();
    const thread = requireThread(threadId);
    const ref = asSession(session);
    const repoKey = requireRepoForSession(repo, ref);
    const participant = await participants.join({ thread, session: ref, repoKey, role: 'participant' });
    threadsByBinding.set(threadBindingKey(ref), thread);
    stats.bindings += 1;
    return participant;
  }

  function leave({ threadId, participantId } = {}) {
    assertOpen();
    return participants.leave({ thread: requireThread(threadId), participantId });
  }

  async function resume({ threadId, participantId } = {}) {
    assertOpen();
    return participants.resume({ thread: requireThread(threadId), participantId });
  }

  function activate({ threadId, participantId } = {}) {
    assertOpen();
    const thread = requireThread(threadId);
    const participant = participants.get(thread, participantId);
    if (thread.activeParticipantId !== participant.participantId) {
      thread.activeParticipantId = participant.participantId;
      thread.revision += 1;
    }
    return participant;
  }

  function active(threadId) {
    const thread = requireThread(threadId);
    if (thread.activeParticipantId === null) return null;
    return participants.get(thread, thread.activeParticipantId);
  }

  function get(threadId) {
    const thread = requireThread(threadId);
    const harnessInstanceIds = [];
    for (const participant of thread.participants) {
      if (!harnessInstanceIds.includes(participant.harnessInstanceId)) harnessInstanceIds.push(participant.harnessInstanceId);
    }
    return Object.freeze({
      threadId: thread.threadId,
      environmentId: thread.environmentId,
      repoKey: thread.repoKey,
      revision: thread.revision,
      activeParticipantId: thread.activeParticipantId,
      harnessInstanceIds: Object.freeze(harnessInstanceIds),
      participants: Object.freeze(thread.participants.map(view)),
    });
  }

  /** Per-participant native sessions; histories are listed side by side and never merged. */
  function history(threadId) {
    const thread = requireThread(threadId);
    return Object.freeze({ threadId: thread.threadId, participants: Object.freeze(thread.participants.map(view)) });
  }

  function nativeHistory(threadId, participantId) {
    return view(participants.get(requireThread(threadId), participantId));
  }

  async function close() {
    closed = true;
    threadsById.clear();
    threadsByBinding.clear();
  }

  return {
    bind,
    join,
    leave,
    resume,
    activate,
    active,
    get,
    history,
    nativeHistory,
    close,
    get state() {
      let activeCount = 0;
      for (const thread of threadsById.values()) {
        for (const participant of thread.participants) if (participant.state === 'active') activeCount += 1;
      }
      return { threads: stats.threads, bindings: stats.bindings, active: activeCount, closed };
    },
  };
}
