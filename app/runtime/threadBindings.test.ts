// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PARTICIPANT_STATES,
  THREAD_ROLES,
  ThreadError,
  parseThreadBinding,
  parseThreadId,
  parseThreadRole,
  threadBindingKey,
} from '../../shared/runtime/thread.js';
import { createParticipantService } from '../../bridge/runtime/threads/participantService.js';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId, RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import type { ThreadSessionView } from '../../shared/runtime/thread.js';
import type { ParticipantRecord, ParticipantThread } from '../../bridge/runtime/threads/participantService.js';
import type { ThreadRecord, ThreadService } from '../../bridge/runtime/threads/threadService.js';

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const ENV_B = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const HARNESS_A = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HARNESS_B = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

function sessionRef(
  environmentId: EnvironmentId,
  harnessInstanceId: HarnessInstanceId,
  nativeSessionId: string,
): SessionRef {
  return { environmentId, harnessInstanceId, nativeSessionId };
}

function repoRef(environmentId: EnvironmentId, canonicalCommonDir: string): RepoRef {
  return {
    environmentId,
    canonicalCommonDir,
    pathPolicy: { platform: 'posix', volumeId: 'vol-1', caseSensitive: true },
  };
}

function view(
  session: SessionRef,
  overrides: { parent?: SessionRef | null; archived?: boolean } = {},
): ThreadSessionView {
  return { session, archived: overrides.archived ?? false, parentSession: overrides.parent ?? null };
}

const catalogKey = (session: SessionRef): string =>
  `${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`;

function makeHarness(views: ThreadSessionView[] = []) {
  const catalog = new Map(views.map((entry) => [catalogKey(entry.session), entry]));
  let resolutions = 0;
  const resolveSession = async (session: SessionRef): Promise<ThreadSessionView | null> => {
    resolutions += 1;
    return catalog.get(catalogKey(session)) ?? null;
  };
  const service: ThreadService = createThreadService({ resolveSession });
  return { service, catalog, resolveSession, resolutions: () => resolutions };
}

function ownerParticipant(thread: ThreadRecord): ParticipantRecord {
  const participant = thread.participants[0];
  if (!participant) throw new Error('thread has no owner participant');
  return participant;
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('shared runtime thread identity', () => {
  it('normalizes Thread UUIDs, rejects malformed identifiers and enumerates the fixed roles', () => {
    expect(parseThreadId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(() => parseThreadId('not-a-uuid')).toThrow(ThreadError);
    expect(() => parseThreadId(42)).toThrow(ThreadError);
    expect(THREAD_ROLES).toEqual(['owner', 'participant']);
    expect(parseThreadRole('owner')).toBe('owner');
    expect(parseThreadRole('participant')).toBe('participant');
    expect(() => parseThreadRole('observer')).toThrow(ThreadError);
    expect(errorOf(() => parseThreadRole('observer'))).toMatchObject({ code: 'invalid_request', field: 'thread_role' });
    expect(PARTICIPANT_STATES).toEqual(['active', 'left', 'orphaned']);
  });

  it('derives one canonical binding key per native SessionRef so the same session resolves to the same Thread', () => {
    const session = sessionRef(ENV_A, HARNESS_A, 'native:1');
    const duplicate = sessionRef(ENV_A, HARNESS_A, 'native:1');
    const sibling = sessionRef(ENV_A, HARNESS_A, 'native:2');
    const otherHarness = sessionRef(ENV_A, HARNESS_B, 'native:1');

    expect(threadBindingKey(session)).toBe(threadBindingKey(duplicate));
    expect(threadBindingKey(session)).not.toBe(threadBindingKey(sibling));
    expect(threadBindingKey(session)).not.toBe(threadBindingKey(otherHarness));
    expect(() => threadBindingKey({ environmentId: ENV_A, harnessInstanceId: HARNESS_A })).toThrow(ThreadError);
  });

  it('parses a receiver-side binding with its preserved native parent and rejects a malformed one', () => {
    const session = sessionRef(ENV_A, HARNESS_A, 'native:child');
    const parent = sessionRef(ENV_A, HARNESS_A, 'native:parent');
    expect(parseThreadBinding({ role: 'participant', session, nativeParent: parent })).toEqual({
      role: 'participant',
      session,
      nativeParent: parent,
    });
    expect(parseThreadBinding({ role: 'owner', session, nativeParent: null }).nativeParent).toBeNull();
    expect(errorOf(() => parseThreadBinding({ role: 'observer', session, nativeParent: null }))).toMatchObject({ code: 'invalid_request', field: 'thread_role' });
    expect(() => parseThreadBinding({ role: 'participant', session })).toThrow(ThreadError);
  });
});

describe('thread binding laziness and canonical identity', () => {
  it('does not materialize threads for 10k existing sessions until one is explicitly bound', async () => {
    const bulk: ThreadSessionView[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      bulk.push(view(sessionRef(ENV_A, HARNESS_A, `native:${index}`)));
    }
    const harness = makeHarness(bulk);

    expect(harness.service.state.threads).toBe(0);
    expect(harness.service.state.bindings).toBe(0);
    expect(harness.resolutions()).toBe(0);

    const thread = await harness.service.bind({
      session: bulk[5].session,
      repo: repoRef(ENV_A, '/srv/repo'),
    });

    expect(harness.service.state.threads).toBe(1);
    expect(harness.service.state.bindings).toBe(1);
    expect(harness.resolutions()).toBe(1);
    expect(thread.participants).toHaveLength(1);
    expect(thread.participants[0]?.role).toBe('owner');
  });

  it('returns the same wrapper identity when the same native session binds from two windows', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');

    const first = await harness.service.bind({ session: owner, repo });
    const second = await harness.service.bind({ session: sessionRef(ENV_A, HARNESS_A, 'native:owner'), repo });

    expect(second).toBe(first);
    expect(second.threadId).toBe(first.threadId);
    expect(harness.service.state.threads).toBe(1);
    expect(harness.service.state.bindings).toBe(1);
    expect(first.participants).toHaveLength(1);
    expect(() => parseThreadId(first.threadId)).not.toThrow();
  });

  it('does not create a thread when the bound session is missing or archived, and keeps history intact', async () => {
    const missing = sessionRef(ENV_A, HARNESS_A, 'native:missing');
    const archived = sessionRef(ENV_A, HARNESS_A, 'native:archived');
    const harness = makeHarness([view(archived, { archived: true })]);

    await expect(
      harness.service.bind({ session: missing, repo: repoRef(ENV_A, '/srv/repo') }),
    ).rejects.toMatchObject({ code: 'source_unavailable', field: 'thread_session_missing' });
    await expect(
      harness.service.bind({ session: archived, repo: repoRef(ENV_A, '/srv/repo') }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'thread_session_archived' });
    expect(harness.service.state.threads).toBe(0);
    expect(harness.catalog.get(catalogKey(archived))).toMatchObject({ archived: true });
  });
});

describe('multi-harness threads and native history separation', () => {
  it('switches active harness on one thread while each participant keeps its own native session', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const second = sessionRef(ENV_A, HARNESS_B, 'native:second');
    const harness = makeHarness([view(owner), view(second)]);
    const repo = repoRef(ENV_A, '/srv/repo');

    const thread = await harness.service.bind({ session: owner, repo });
    const added = await harness.service.join({ threadId: thread.threadId, session: second, repo });

    expect(added.role).toBe('participant');
    expect(harness.service.get(thread.threadId).harnessInstanceIds).toEqual([HARNESS_A, HARNESS_B]);
    expect(harness.service.state.threads).toBe(1);
    expect(harness.service.state.bindings).toBe(2);

    harness.service.activate({ threadId: thread.threadId, participantId: added.participantId });
    expect(harness.service.active(thread.threadId)?.session.nativeSessionId).toBe('native:second');

    const history = harness.service.history(thread.threadId);
    expect(history.participants).toHaveLength(2);
    expect(new Set(history.participants.map((entry) => entry.session.nativeSessionId)).size).toBe(2);
    expect(history.participants.map((entry) => entry.harnessInstanceId)).toEqual([HARNESS_A, HARNESS_B]);

    harness.service.activate({ threadId: thread.threadId, participantId: ownerParticipant(thread).participantId });
    expect(harness.service.active(thread.threadId)?.session.nativeSessionId).toBe('native:owner');
    expect(harness.service.nativeHistory(thread.threadId, ownerParticipant(thread).participantId).session.nativeSessionId).toBe('native:owner');
    expect(harness.service.nativeHistory(thread.threadId, added.participantId).session.nativeSessionId).toBe('native:second');
    expect(harness.service.get(thread.threadId).participants).toHaveLength(2);
  });

  it('binds the same session to the same thread from a second harness without creating a second thread', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');

    const thread = await harness.service.bind({ session: owner, repo });
    const second = await harness.service.bind({ session: owner, repo });
    expect(second).toBe(thread);
    expect(harness.service.state.threads).toBe(1);
  });
});

describe('native participant join, leave, resume and sub-agent preservation', () => {
  it('preserves the native parent (sub-agent) relation on bind and join', async () => {
    const parent = sessionRef(ENV_A, HARNESS_A, 'native:parent');
    const child = sessionRef(ENV_A, HARNESS_A, 'native:child');
    const grandchild = sessionRef(ENV_A, HARNESS_B, 'native:grandchild');
    const harness = makeHarness([view(child, { parent }), view(grandchild, { parent: child })]);
    const repo = repoRef(ENV_A, '/srv/repo');

    const thread = await harness.service.bind({ session: child, repo });
    expect(ownerParticipant(thread).nativeParent).toEqual(parent);

    const added = await harness.service.join({ threadId: thread.threadId, session: grandchild, repo });
    expect(added.nativeParent).toEqual(child);
    expect(harness.service.nativeHistory(thread.threadId, added.participantId).nativeParent).toEqual(child);
  });

  it('leaves without deleting the native session and resumes the same native binding', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });
    const participant = ownerParticipant(thread);

    const left = harness.service.leave({ threadId: thread.threadId, participantId: participant.participantId });
    expect(left.state).toBe('left');
    expect(harness.catalog.has(catalogKey(owner))).toBe(true);
    expect(harness.service.leave({ threadId: thread.threadId, participantId: participant.participantId }).state).toBe('left');

    const resumed = await harness.service.resume({ threadId: thread.threadId, participantId: participant.participantId });
    expect(resumed.state).toBe('active');
    expect(resumed.session.nativeSessionId).toBe('native:owner');
    expect(harness.service.get(thread.threadId).participants).toHaveLength(1);
  });

  it('marks a participant orphaned instead of throwing or destroying history when its native session disappears', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });
    const participant = ownerParticipant(thread);

    harness.service.leave({ threadId: thread.threadId, participantId: participant.participantId });
    harness.catalog.delete(catalogKey(owner));

    const orphaned = await harness.service.resume({ threadId: thread.threadId, participantId: participant.participantId });
    expect(orphaned.state).toBe('orphaned');
    expect(orphaned.orphanReason).toBe('participant_session_missing');
    expect(harness.service.get(thread.threadId).participants).toHaveLength(1);
    expect(harness.service.history(thread.threadId).participants).toHaveLength(1);
  });

  it('rejects a duplicate participant, a missing session and an archived session with explicit codes', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const missing = sessionRef(ENV_A, HARNESS_B, 'native:missing');
    const archived = sessionRef(ENV_A, HARNESS_B, 'native:archived');
    const harness = makeHarness([view(owner), view(archived, { archived: true })]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });

    await expect(harness.service.join({ threadId: thread.threadId, session: owner, repo })).rejects.toMatchObject({
      code: 'conflict',
      field: 'participant_duplicate',
    });
    await expect(harness.service.join({ threadId: thread.threadId, session: missing, repo })).rejects.toMatchObject({
      code: 'source_unavailable',
      field: 'participant_session_missing',
    });
    await expect(harness.service.join({ threadId: thread.threadId, session: archived, repo })).rejects.toMatchObject({
      code: 'conflict',
      field: 'participant_session_archived',
    });
  });
});

describe('same environment and repository restriction', () => {
  it('rejects a cross-environment join as unauthorized and a cross-repository join as a conflict', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const foreignEnv = sessionRef(ENV_B, HARNESS_B, 'native:foreign');
    const foreignRepo = sessionRef(ENV_A, HARNESS_B, 'native:other-repo');
    const harness = makeHarness([view(owner), view(foreignEnv), view(foreignRepo)]);
    const thread = await harness.service.bind({ session: owner, repo: repoRef(ENV_A, '/srv/repo') });

    await expect(
      harness.service.join({ threadId: thread.threadId, session: foreignEnv, repo: repoRef(ENV_B, '/srv/repo') }),
    ).rejects.toMatchObject({ code: 'unauthorized', field: 'thread_environment_mismatch' });
    await expect(
      harness.service.join({ threadId: thread.threadId, session: foreignRepo, repo: repoRef(ENV_A, '/srv/other-repo') }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'thread_repo_mismatch' });
    expect(harness.service.get(thread.threadId).participants).toHaveLength(1);
  });

  it('rejects a repository that does not belong to the bound session environment', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    await expect(
      harness.service.bind({ session: owner, repo: repoRef(ENV_B, '/srv/repo') }),
    ).rejects.toMatchObject({ code: 'invalid_request', field: 'thread_repo_environment' });
    expect(harness.service.state.threads).toBe(0);
  });

  it('rejects unknown thread and participant identifiers and refuses work after close', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const thread = await harness.service.bind({ session: owner, repo: repoRef(ENV_A, '/srv/repo') });

    expect(() => harness.service.activate({ threadId: '99999999-9999-4999-8999-999999999999', participantId: ownerParticipant(thread).participantId })).toThrow(ThreadError);
    expect(() => harness.service.activate({ threadId: thread.threadId, participantId: '99999999-9999-4999-8999-999999999999' })).toThrow(ThreadError);
    await harness.service.close();
    expect(harness.service.state.closed).toBe(true);
    await expect(harness.service.bind({ session: owner, repo: repoRef(ENV_A, '/srv/repo') })).rejects.toMatchObject({
      code: 'cancelled',
      field: 'thread_closed',
    });
    await expect(harness.service.close()).resolves.toBeUndefined();
  });
});

describe('participant service in isolation', () => {
  it('never deletes or re-creates a native participant record while leaving and resuming', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const participants = createParticipantService({ resolveSession: harness.resolveSession });
    const thread: ParticipantThread = {
      environmentId: ENV_A,
      repoKey: 'repo-key',
      participants: [],
      revision: 0,
    };

    const joined = await participants.join({
      thread,
      session: owner,
      repoKey: 'repo-key',
      role: 'owner',
    });
    expect(joined.state).toBe('active');
    expect(thread.participants).toHaveLength(1);

    const left = participants.leave({ thread, participantId: joined.participantId });
    expect(left.state).toBe('left');
    expect(harness.catalog.has(catalogKey(owner))).toBe(true);

    harness.catalog.delete(catalogKey(owner));
    const orphaned = await participants.resume({ thread, participantId: joined.participantId });
    expect(orphaned.state).toBe('orphaned');
    expect(thread.participants).toHaveLength(1);
    expect(participants.state).toMatchObject({ joins: 1, leaves: 1, orphans: 1 });
  });

  it('accepts one session per canonical binding and rejects the duplicate', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = makeHarness([view(owner)]);
    const participants = createParticipantService({ resolveSession: harness.resolveSession });
    const thread: ParticipantThread = {
      environmentId: ENV_A,
      repoKey: 'repo-key',
      participants: [],
      revision: 0,
    };
    await participants.join({ thread, session: owner, repoKey: 'repo-key', role: 'owner' });
    await expect(
      participants.join({ thread, session: sessionRef(ENV_A, HARNESS_A, 'native:owner'), repoKey: 'repo-key', role: 'participant' }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'participant_duplicate' });
  });
});

type SessionGate = { promise: Promise<ThreadSessionView | null>; resolve: (value: ThreadSessionView | null) => void };

function gatedHarness(views: ThreadSessionView[] = []) {
  const catalog = new Map(views.map((entry) => [catalogKey(entry.session), entry]));
  const gates = new Map<string, SessionGate>();
  const park = (session: SessionRef): void => {
    const key = catalogKey(session);
    if (gates.has(key)) return;
    let resolve!: (value: ThreadSessionView | null) => void;
    const promise = new Promise<ThreadSessionView | null>((res) => {
      resolve = res;
    });
    gates.set(key, { promise, resolve });
  };
  const resolveSession = (session: SessionRef): Promise<ThreadSessionView | null> => {
    const gate = gates.get(catalogKey(session));
    if (gate !== undefined) return gate.promise;
    return Promise.resolve(catalog.get(catalogKey(session)) ?? null);
  };
  const release = (session: SessionRef, resolved: ThreadSessionView | null = catalog.get(catalogKey(session)) ?? null): void => {
    gates.get(catalogKey(session))?.resolve(resolved);
  };
  const service: ThreadService = createThreadService({ resolveSession });
  return { service, catalog, park, release, resolveSession };
}

describe('canonical binding index survives concurrent bind, join and close', () => {
  it('serializes concurrent binds of one SessionRef so both windows receive the same wrapper', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = gatedHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');

    harness.park(owner);
    const first = harness.service.bind({ session: owner, repo });
    const second = harness.service.bind({ session: sessionRef(ENV_A, HARNESS_A, 'native:owner'), repo });
    harness.release(owner);
    const [a, b] = await Promise.all([first, second]);

    expect(b).toBe(a);
    expect(a.participants).toHaveLength(1);
    expect(harness.service.state).toMatchObject({ threads: 1, bindings: 1, active: 1 });
  });

  it('rejects a concurrent duplicate join instead of admitting a second participant for one session', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const guest = sessionRef(ENV_A, HARNESS_B, 'native:guest');
    const harness = gatedHarness([view(owner), view(guest)]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });

    harness.park(guest);
    const first = harness.service.join({ threadId: thread.threadId, session: guest, repo });
    const second = harness.service.join({ threadId: thread.threadId, session: sessionRef(ENV_A, HARNESS_B, 'native:guest'), repo });
    harness.release(guest);
    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict', field: 'participant_duplicate' },
    });
    expect(harness.service.get(thread.threadId).participants).toHaveLength(2);
    expect(harness.service.state.bindings).toBe(2);
  });

  it('refuses a join that would steal a canonical binding already owned by another thread', async () => {
    const first = sessionRef(ENV_A, HARNESS_A, 'native:first');
    const second = sessionRef(ENV_A, HARNESS_B, 'native:second');
    const harness = makeHarness([view(first), view(second)]);
    const repo = repoRef(ENV_A, '/srv/repo');

    const threadA = await harness.service.bind({ session: first, repo });
    const threadB = await harness.service.bind({ session: second, repo });

    await expect(harness.service.join({ threadId: threadB.threadId, session: first, repo })).rejects.toMatchObject({
      code: 'conflict',
      field: 'thread_binding_taken',
    });
    expect(harness.service.get(threadB.threadId).participants).toHaveLength(1);
    expect(await harness.service.bind({ session: first, repo })).toBe(threadA);
    expect(harness.service.state).toMatchObject({ threads: 2, bindings: 2 });
  });

  it('rejects a bind whose async submit lands after the service was closed', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = gatedHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');

    harness.park(owner);
    const pending = harness.service.bind({ session: owner, repo });
    await harness.service.close();
    harness.release(owner);

    await expect(pending).rejects.toMatchObject({ code: 'cancelled', field: 'thread_closed' });
    expect(harness.service.state).toMatchObject({ closed: true, threads: 0, bindings: 0, active: 0 });
  });

  it('rejects a join whose async submit lands after the service was closed', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const guest = sessionRef(ENV_A, HARNESS_B, 'native:guest');
    const harness = gatedHarness([view(owner), view(guest)]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });

    harness.park(guest);
    const joining = harness.service.join({ threadId: thread.threadId, session: guest, repo });
    await harness.service.close();
    harness.release(guest);

    await expect(joining).rejects.toMatchObject({ code: 'cancelled', field: 'thread_closed' });
    expect(harness.service.state).toMatchObject({ closed: true, active: 0 });
    expect(() => harness.service.get(thread.threadId)).toThrow(ThreadError);
    expect(errorOf(() => harness.service.get(thread.threadId))).toMatchObject({ code: 'invalid_request', field: 'thread_unknown' });
  });

  it('keeps the last leave when a resume was already in flight', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = gatedHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });
    const participantId = ownerParticipant(thread).participantId;

    harness.service.leave({ threadId: thread.threadId, participantId });
    harness.park(owner);
    const resuming = harness.service.resume({ threadId: thread.threadId, participantId });
    harness.service.leave({ threadId: thread.threadId, participantId });
    harness.release(owner);
    const resumed = await resuming;

    expect(resumed.state).toBe('left');
    expect(harness.service.get(thread.threadId).participants[0]?.state).toBe('left');
  });

  it('still resumes an unraced leave so the newer intent never blocks the older one', async () => {
    const owner = sessionRef(ENV_A, HARNESS_A, 'native:owner');
    const harness = gatedHarness([view(owner)]);
    const repo = repoRef(ENV_A, '/srv/repo');
    const thread = await harness.service.bind({ session: owner, repo });
    const participantId = ownerParticipant(thread).participantId;

    harness.service.leave({ threadId: thread.threadId, participantId });
    harness.park(owner);
    const resuming = harness.service.resume({ threadId: thread.threadId, participantId });
    harness.release(owner);

    expect((await resuming).state).toBe('active');
    expect(harness.service.get(thread.threadId).participants[0]?.state).toBe('active');
  });
});
