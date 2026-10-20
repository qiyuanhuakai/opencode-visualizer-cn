import { randomUUID } from 'node:crypto';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import {
  ThreadError,
  parseParticipantId,
  parseThreadRole,
  threadBindingKey,
} from '../../../shared/runtime/thread.js';

function asSession(value) {
  try {
    return parseSessionRef(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ThreadError('invalid_request', 'participant_session');
    throw error;
  }
}

/** Participants reference native SessionRefs; native sub-agents stay native — they are never promoted to Host participants. */
export function createParticipantService({ resolveSession } = {}) {
  if (typeof resolveSession !== 'function') throw new ThreadError('invalid_request', 'participant_source');
  const stats = { joins: 0, leaves: 0, resumes: 0, orphans: 0 };

  function requireThread(thread) {
    if (thread === null || typeof thread !== 'object' || Array.isArray(thread)
      || typeof thread.environmentId !== 'string' || typeof thread.repoKey !== 'string'
      || !Array.isArray(thread.participants)) {
      throw new ThreadError('invalid_request', 'participant_thread');
    }
    return thread;
  }

  function requireParticipant(thread, participantId) {
    const id = parseParticipantId(participantId);
    const participant = thread.participants.find((entry) => entry.participantId === id);
    if (participant === undefined) throw new ThreadError('invalid_request', 'participant_unknown');
    return participant;
  }

  async function join({ thread, session, repoKey, role = 'participant', summary, assertLive } = {}) {
    const target = requireThread(thread);
    const parsedRole = parseThreadRole(role);
    const ref = asSession(session);
    if (typeof repoKey !== 'string' || repoKey.length === 0) throw new ThreadError('invalid_request', 'thread_repo');
    if (ref.environmentId !== target.environmentId) throw new ThreadError('unauthorized', 'thread_environment_mismatch');
    if (repoKey !== target.repoKey) throw new ThreadError('conflict', 'thread_repo_mismatch');
    const binding = threadBindingKey(ref);
    if (target.participants.some((entry) => threadBindingKey(entry.session) === binding)) {
      throw new ThreadError('conflict', 'participant_duplicate');
    }
    const resolved = summary ?? (await resolveSession(ref));
    if (typeof assertLive === 'function') assertLive();
    if (resolved === null || resolved === undefined) throw new ThreadError('source_unavailable', 'participant_session_missing');
    if (resolved.archived === true) throw new ThreadError('conflict', 'participant_session_archived');
    const participant = {
      participantId: randomUUID(),
      role: parsedRole,
      state: 'active',
      session: ref,
      nativeParent: resolved.parentSession ?? null,
      harnessInstanceId: ref.harnessInstanceId,
      joinedAt: Date.now(),
      leftAt: null,
      orphanReason: null,
      operation: 0,
    };
    target.participants.push(participant);
    target.revision += 1;
    stats.joins += 1;
    return participant;
  }

  /** Leaving marks the participant left; the native session is never deleted. */
  function leave({ thread, participantId } = {}) {
    const target = requireThread(thread);
    const participant = requireParticipant(target, participantId);
    participant.operation += 1;
    if (participant.state === 'left') return participant;
    participant.state = 'left';
    participant.leftAt = Date.now();
    participant.orphanReason = null;
    target.revision += 1;
    stats.leaves += 1;
    return participant;
  }

  /** Resume rebinds the same native session; a vanished native session becomes an explicit orphan. */
  async function resume({ thread, participantId, assertLive } = {}) {
    const target = requireThread(thread);
    const participant = requireParticipant(target, participantId);
    if (participant.state === 'active') return participant;
    participant.operation += 1;
    const operation = participant.operation;
    const resolved = await resolveSession(participant.session);
    if (typeof assertLive === 'function') assertLive();
    if (participant.operation !== operation) return participant;
    if (resolved === null || resolved === undefined) {
      participant.state = 'orphaned';
      participant.orphanReason = 'participant_session_missing';
      target.revision += 1;
      stats.orphans += 1;
      return participant;
    }
    if (resolved.archived === true) {
      participant.state = 'orphaned';
      participant.orphanReason = 'participant_session_archived';
      target.revision += 1;
      stats.orphans += 1;
      return participant;
    }
    participant.state = 'active';
    participant.leftAt = null;
    participant.orphanReason = null;
    target.revision += 1;
    stats.resumes += 1;
    return participant;
  }

  return {
    join,
    leave,
    resume,
    get(thread, participantId) {
      return requireParticipant(requireThread(thread), participantId);
    },
    get state() {
      return { joins: stats.joins, leaves: stats.leaves, resumes: stats.resumes, orphans: stats.orphans };
    },
  };
}
