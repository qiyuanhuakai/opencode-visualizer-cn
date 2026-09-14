import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnection, SseConnectionCallbacks } from '../utils/sseConnection';
import {
  createSseWorkerTestHarness,
  type MutationSnapshotToken,
  type MutationSnapshotTracker,
  type Deferred,
  deferred,
  project,
  sessionInfo,
  sessionPacket,
  sessionCreatedPacket,
  projectUpdatedPacket,
  messagesOf,
  flush,
} from './sse-shared-worker.test-helpers';

const mocks = vi.hoisted(() => {
  const callbacks: SseConnectionCallbacks[] = [];
  const adapter = {
    configure: vi.fn(),
    listProjects: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getCurrentProject: vi.fn(),
    getSessionStatusMap: vi.fn(),
    getVcsInfo: vi.fn(),
  };
  const createConnection = vi.fn((next: SseConnectionCallbacks): SseConnection => {
    callbacks.push(next);
    return { connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true };
  });
  return { adapter, callbacks, createConnection };
});

const stateBuilderTrackers = vi.hoisted(() => {
  const trackers: MutationSnapshotTracker[] = [];
  return { trackers };
});

vi.mock('../backends/openCodeAdapter', () => ({
  createOpenCodeAdapter: () => mocks.adapter,
  createOpenCodeWorkerAdapter: () => mocks.adapter,
}));
vi.mock('../utils/sseConnection', () => ({ createSseConnection: mocks.createConnection }));
vi.mock('../utils/stateBuilder', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/stateBuilder')>('../utils/stateBuilder');
  return {
    ...actual,
    createStateBuilder: () => {
      const builder = actual.createStateBuilder();
      const active = new Set<MutationSnapshotToken>();
      const originalBegin = builder.beginMutationSnapshot;
      const originalComplete = builder.completeMutationSnapshot;
      const trackedBuilder = {
        ...builder,
        beginMutationSnapshot() {
          const token = originalBegin();
          active.add(token);
          return token;
        },
        completeMutationSnapshot(token: MutationSnapshotToken) {
          originalComplete(token);
          active.delete(token);
        },
      };
      stateBuilderTrackers.trackers.push({ active });
      return trackedBuilder;
    },
  };
});

const harness = createSseWorkerTestHarness(mocks.callbacks);
const { connectWorker, post, latestCallbacks, reset, cleanup } = harness;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.callbacks.length = 0;
  stateBuilderTrackers.trackers.length = 0;
  reset();
  mocks.adapter.listProjects.mockResolvedValue([project(['/a', '/b'])]);
  mocks.adapter.listSessions.mockResolvedValue([]);
  mocks.adapter.getSession.mockResolvedValue(undefined);
  mocks.adapter.getCurrentProject.mockResolvedValue(project(['/a', '/b']));
  mocks.adapter.getSessionStatusMap.mockResolvedValue({});
  mocks.adapter.getVcsInfo.mockResolvedValue({ branch: 'main' });
});

afterEach(() => {
  cleanup();
});

describe('SSE SharedWorker bootstrap and hydration', () => {
  it('passes an explicit undefined authorization into an unauthenticated worker read', async () => {
    const authenticated = await connectWorker('http://authenticated', 'Bearer TOP-SECRET');
    await vi.waitFor(() =>
      expect(messagesOf(authenticated.messages, 'state.bootstrap')).toHaveLength(1),
    );
    mocks.adapter.configure.mockClear();

    const anonymous = await connectWorker('http://anonymous');
    await vi.waitFor(() =>
      expect(messagesOf(anonymous.messages, 'state.bootstrap')).toHaveLength(1),
    );

    expect(mocks.adapter.configure).toHaveBeenCalledWith({
      baseUrl: 'http://anonymous',
      authorization: undefined,
    });
  });

  it('emits topology bootstrap before any directory request resolves', async () => {
    const sessions = deferred<unknown>();
    mocks.adapter.listSessions.mockReturnValue(sessions.promise);

    const worker = await connectWorker();

    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(mocks.adapter.listSessions).not.toHaveBeenCalled();
    expect(messagesOf(worker.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/a': { status: 'unloaded' },
      '/b': { status: 'unloaded' },
    });
    sessions.resolve([]);
    await flush();
  });

  it('hydrates the synthetic global root through the normal bootstrap lifecycle', async () => {
    const worker = await connectWorker();

    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(worker.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/a': { status: 'unloaded' },
      '/b': { status: 'unloaded' },
    });

    mocks.adapter.listSessions.mockImplementation(({ directory }: { directory: string }) =>
      directory === '/'
        ? Promise.resolve([
            {
              ...sessionInfo('global-session', 'Global session', undefined, '/'),
              projectID: 'global',
            },
          ])
        : Promise.resolve([]),
    );

    post(worker, { type: 'load-sessions', directory: '/' });

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated')
          .filter(({ directory }) => directory === '/')
          .map(({ hydration }) => hydration.status),
      ).toEqual(['loading', 'loaded']),
    );
    expect(
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/']?.sessions[
        'global-session'
      ],
    ).toBeDefined();
  });

  it('loads only the requested directory once and never reads targeted VCS', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    mocks.adapter.listSessions.mockClear();
    mocks.adapter.getVcsInfo.mockClear();

    post(worker, { type: 'load-sessions', directory: '/a' });
    post(worker, { type: 'load-sessions', directory: '/a' });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.directory-hydration-updated')).toHaveLength(2),
    );
    expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(1);
    expect(mocks.adapter.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/a', roots: true, signal: expect.any(AbortSignal) }),
    );
    expect(mocks.adapter.getSessionStatusMap).toHaveBeenCalledWith(
      '/a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.adapter.getVcsInfo).not.toHaveBeenCalled();
    expect(
      messagesOf(worker.messages, 'state.directory-hydration-updated').map(
        ({ hydration }) => hydration.status,
      ),
    ).toEqual(['loading', 'loaded']);
  });

  it('hydrates VCS on priority selection after sessions are loaded without duplicate reads', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated')
          .filter(({ directory }) => directory === '/a')
          .at(-1)?.hydration,
      ).toEqual({ status: 'loaded' }),
    );

    mocks.adapter.getVcsInfo.mockClear();
    mocks.adapter.getVcsInfo.mockImplementation((directory: string) =>
      Promise.resolve({ branch: directory === '/a' ? 'priority-branch' : 'background-branch' }),
    );
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });

    await vi.waitFor(() =>
      expect(mocks.adapter.getVcsInfo).toHaveBeenCalledWith(
        '/a',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => updated.sandboxes['/a']?.name === 'priority-branch',
        ),
      ).toBe(true),
    );

    expect(
      mocks.adapter.getVcsInfo.mock.calls.filter(([directory]) => directory === '/a'),
    ).toHaveLength(1);
  });

  it('reconciles hydration with project updates and ignores a retired directory read', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(worker.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/a': { status: 'unloaded' },
    });

    const retiredRead = deferred<unknown>();
    let retiredSignal: AbortSignal | undefined;
    mocks.adapter.listSessions.mockImplementation(
      ({ directory, signal }: { directory: string; signal?: AbortSignal }) => {
        if (directory === '/a') {
          retiredSignal = signal;
          return retiredRead.promise;
        }
        return Promise.resolve([sessionInfo('session-b', 'Session B', undefined, '/b')]);
      },
    );
    latestCallbacks().onPacket(projectUpdatedPacket(project(['/a', '/b'])));

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated').some(
          ({ directory, hydration }) => directory === '/b' && hydration.status === 'unloaded',
        ),
      ).toBe(true),
    );

    post(worker, { type: 'load-sessions', directory: '/b' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated')
          .filter(({ directory }) => directory === '/b')
          .map(({ hydration }) => hydration.status),
      ).toEqual(['unloaded', 'loading', 'loaded']),
    );
    expect(
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/b']
        ?.sessions['session-b'],
    ).toBeDefined();

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() =>
      expect(mocks.adapter.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ directory: '/a', roots: true, signal: expect.any(AbortSignal) }),
      ),
    );
    latestCallbacks().onPacket(projectUpdatedPacket(project(['/b'])));
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.directory-hydration-removed')).toContainEqual({
        type: 'state.directory-hydration-removed',
        directory: '/a',
      }),
    );
    const retiredHydrationUpdateCount = messagesOf(
      worker.messages,
      'state.directory-hydration-updated',
    ).filter(({ directory }) => directory === '/a').length;
    expect(retiredSignal?.aborted).toBe(true);

    retiredRead.resolve([sessionInfo('retired', 'Retired', undefined, '/a')]);
    await flush();
    expect(
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/a'],
    ).toBeUndefined();
    expect(
      messagesOf(worker.messages, 'state.directory-hydration-updated').filter(
        ({ directory }) => directory === '/a',
      ),
    ).toHaveLength(retiredHydrationUpdateCount);
  });

  it('reports an error and permits a later retry', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated').at(-1)?.hydration,
      ).toEqual({
        status: 'error',
        error: 'offline',
      }),
    );
    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated').at(-1)?.hydration,
      ).toEqual({ status: 'loaded' }),
    );
    expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(2);
  });

  it('reports queue-capacity rejection and permits a later directory retry', async () => {
    const busyDirectories = Array.from({ length: 268 }, (_, index) => `/busy-${index}`);
    const targetDirectory = '/capacity-target';
    mocks.adapter.listProjects.mockResolvedValue([project([...busyDirectories, targetDirectory])]);
    const activeReads = Array.from({ length: 12 }, () => deferred<unknown>());
    let readCalls = 0;
    mocks.adapter.listSessions.mockImplementation(() => {
      const activeRead = activeReads[readCalls];
      readCalls += 1;
      return activeRead ? activeRead.promise : Promise.resolve([]);
    });

    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    for (const directory of busyDirectories.slice(0, 12)) {
      post(worker, { type: 'load-sessions', directory });
    }
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(12));
    for (const directory of busyDirectories.slice(12)) {
      post(worker, { type: 'load-sessions', directory });
    }
    await flush();

    post(worker, { type: 'load-sessions', directory: targetDirectory });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated')
          .filter(({ directory }) => directory === targetDirectory)
          .map(({ hydration }) => hydration.status),
      ).toEqual(['loading', 'error']),
    );

    for (const activeRead of activeReads) activeRead.resolve([]);
    await vi.waitFor(() => expect(readCalls).toBe(268));

    post(worker, { type: 'load-sessions', directory: targetDirectory });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated')
          .filter(({ directory }) => directory === targetDirectory)
          .map(({ hydration }) => hydration.status),
      ).toEqual(['loading', 'error', 'loading', 'loaded']),
    );
  });

  it('prioritizes a bootstrap behind a full normal read queue without releasing its barrier', async () => {
    const busyDirectories = Array.from({ length: 268 }, (_, index) => `/normal-${index}`);
    mocks.adapter.listProjects.mockResolvedValue([project(busyDirectories)]);
    const activeReads = Array.from({ length: 12 }, () => deferred<unknown>());
    let readCalls = 0;
    mocks.adapter.listSessions.mockImplementation(() => {
      const activeRead = activeReads[readCalls];
      readCalls += 1;
      return activeRead ? activeRead.promise : Promise.resolve([]);
    });

    const first = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(first.messages, 'state.bootstrap')).toHaveLength(1));
    for (const directory of busyDirectories.slice(0, 12)) {
      post(first, { type: 'load-sessions', directory });
    }
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(12));
    for (const directory of busyDirectories.slice(12)) {
      post(first, { type: 'load-sessions', directory });
    }
    await flush();

    const replacementProjects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValue(replacementProjects.promise);
    const second = await connectWorker('http://bootstrap-priority');
    activeReads[0]?.resolve([]);
    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(0);

    replacementProjects.resolve([project(['/priority'])]);
    await vi.waitFor(() => expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(1));
    expect(
      messagesOf(second.messages, 'state.bootstrap')[0]?.projects.project.sandboxes['/priority'],
    ).toBeDefined();

    for (const activeRead of activeReads.slice(1)) activeRead.resolve([]);
  });

  it('finishes directory hydration for 2,001 sessions with an empty status snapshot', async () => {
    const sessions = Array.from({ length: 2_001 }, (_, index) =>
      sessionInfo(`snapshot-${index}`, `Snapshot ${index}`),
    );
    mocks.adapter.listSessions.mockResolvedValue(sessions);
    mocks.adapter.getSessionStatusMap.mockResolvedValue({});
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    post(worker, { type: 'load-sessions', directory: '/a' });

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated').at(-1)?.hydration,
      ).toEqual({
        status: 'loaded',
      }),
    );
    expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(1);
    const updated = messagesOf(worker.messages, 'state.project-updated').at(-1)?.project;
    expect(updated?.sandboxes['/a']?.sessions['snapshot-0']?.status).toBeUndefined();
    expect(updated?.sandboxes['/a']?.sessions['snapshot-2000']?.status).toBeUndefined();
  });

  it('aborts superseded bootstrap reads and keeps the replacement barrier until its owner completes', async () => {
    const reads: Deferred<unknown>[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    mocks.adapter.listProjects.mockImplementation(
      (_directory: string | undefined, options?: { signal?: AbortSignal }) => {
        const read = deferred<unknown>();
        reads.push(read);
        signals.push(options?.signal);
        return read.promise;
      },
    );
    const worker = await connectWorker();
    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(1));

    for (let index = 0; index < 11; index += 1) {
      latestCallbacks().onOpen(true);
      await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(index + 2));
    }
    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(12));
    expect(signals.every((signal) => signal?.aborted)).toBe(true);

    reads[0]?.resolve([]);
    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(13));
    expect(signals.at(-1)?.aborted).toBe(false);

    worker.messages.splice(0);
    latestCallbacks().onPacket(sessionCreatedPacket('buffered-during-reconnect'));
    expect(messagesOf(worker.messages, 'state.project-updated')).toHaveLength(0);

    const replacement = reads.at(-1);
    if (!replacement) throw new Error('Expected the replacement bootstrap read');
    replacement.resolve([project(['/a'])]);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(worker.messages, 'connection.error')).toHaveLength(0);
    expect(
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/a']
        ?.sessions['buffered-during-reconnect'],
    ).toBeDefined();

    const finalRead = deferred<unknown>();
    mocks.adapter.listProjects.mockImplementationOnce(
      (_directory: string | undefined, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        return finalRead.promise;
      },
    );
    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(14));
    post(worker, { type: 'disconnect' });
    expect(signals.at(-1)?.aborted).toBe(true);

    reads.slice(0, -1).forEach((read) => read.resolve([]));
    finalRead.resolve([]);
    await flush();
  });

  it('gives a warm-attached port the current hydration snapshot', async () => {
    const first = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(first.messages, 'state.bootstrap')).toHaveLength(1));
    const second = await connectWorker();

    await vi.waitFor(() => expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(second.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/a': { status: 'unloaded' },
      '/b': { status: 'unloaded' },
    });
  });

  it('starts one background queue with at most two active directories and completes once', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a', '/b', '/c', '/d'])]);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(mocks.adapter.listSessions).not.toHaveBeenCalled();

    let active = 0;
    let maxActive = 0;
    const pending: Deferred<unknown>[] = [];
    mocks.adapter.listSessions.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const next = deferred<unknown>();
      pending.push(next);
      try {
        return await next.promise;
      } finally {
        active -= 1;
      }
    });
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });

    for (
      let round = 0;
      round < 12 && messagesOf(worker.messages, 'state.background-hydration-complete').length === 0;
      round += 1
    ) {
      pending.splice(0).forEach((item) => item.resolve([]));
      await flush();
    }
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.background-hydration-complete')).toHaveLength(1),
    );
    console.info(`observed max active directory count: ${maxActive}`);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(mocks.adapter.getVcsInfo).toHaveBeenCalledTimes(5);
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'other',
      directory: '/b',
    });
    await flush();
    expect(messagesOf(worker.messages, 'state.background-hydration-complete')).toHaveLength(1);
  });

  it('does not resurrect a sandbox after its in-flight directory request resolves', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const sessions = deferred<unknown>();
    mocks.adapter.listSessions.mockReturnValue(sessions.promise);
    post(worker, { type: 'load-sessions', directory: '/a' });
    post(worker, { type: 'sandbox.deleted', projectId: 'project', directory: '/a' });
    sessions.resolve([]);

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/a'],
      ).toBeUndefined(),
    );
    expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(1);
  });

  it('resyncs once when active snapshot trackers overflow during held hydration', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const staleSessions = deferred<unknown>();
    let staleSignal: AbortSignal | undefined;
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions
      .mockImplementationOnce((options: { signal?: AbortSignal }) => {
        staleSignal = options.signal;
        return staleSessions.promise;
      })
      .mockResolvedValue([]);

    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const hydrationTracker = stateBuilderTrackers.trackers.at(-1);
    if (!hydrationTracker) throw new Error('Expected the hydration state builder tracker');

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(1));

    for (let index = 0; index <= 2_000; index += 1) {
      latestCallbacks().onPacket(sessionPacket('session.deleted', sessionInfo(`deleted-${index}`)));
    }
    for (let index = 0; index <= 2_000; index += 1) {
      latestCallbacks().onPacket({
        directory: '/a',
        payload: {
          type: 'session.status',
          properties: { sessionID: `status-${index}`, status: { type: 'busy' } },
        },
      });
    }

    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    expect(staleSignal?.aborted).toBe(true);
    expect(hydrationTracker.active.size).toBe(1);

    staleSessions.resolve([sessionInfo('stale-after-overflow')]);
    await flush();
    expect(
      messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
        Boolean(updated.sandboxes['/a']?.sessions['stale-after-overflow']),
      ),
    ).toBe(false);

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated').at(-1)?.hydration,
      ).toEqual({ status: 'loaded' }),
    );
    expect(hydrationTracker.active.size).toBe(0);
    expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(2);
  });

  it('cancels every deferred read synchronously when snapshot overflow requests a bootstrap', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const staleSessions = deferred<unknown>();
    const referencedSession = deferred<unknown>();
    const unknownProject = deferred<unknown>();
    let staleSignal: AbortSignal | undefined;
    let referencedSignal: AbortSignal | undefined;
    let unknownSignal: AbortSignal | undefined;
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions.mockImplementation((options: { signal?: AbortSignal }) => {
      staleSignal = options.signal;
      options.signal?.addEventListener('abort', () => staleSessions.resolve([]), { once: true });
      return staleSessions.promise;
    });
    mocks.adapter.getSession.mockImplementation(
      (_sessionId: string, _directory: string, options?: { signal?: AbortSignal }) => {
        referencedSignal = options?.signal;
        options?.signal?.addEventListener('abort', () => referencedSession.resolve(undefined), {
          once: true,
        });
        return referencedSession.promise;
      },
    );
    mocks.adapter.getCurrentProject.mockImplementation(
      (_directory: string, options?: { signal?: AbortSignal }) => {
        unknownSignal = options?.signal;
        options?.signal?.addEventListener('abort', () => unknownProject.resolve(null), {
          once: true,
        });
        return unknownProject.promise;
      },
    );

    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const hydrationTracker = stateBuilderTrackers.trackers.at(-1);
    if (!hydrationTracker) throw new Error('Expected the hydration state builder tracker');

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(1));
    post(worker, {
      type: 'hydrate-referenced-subagents',
      requestId: 'overflow-subagent',
      rootSessionId: 'root',
      directory: '/a',
      sessionIds: ['child'],
    });
    await vi.waitFor(() => expect(mocks.adapter.getSession).toHaveBeenCalledTimes(1));
    latestCallbacks().onPacket(
      sessionPacket('session.created', {
        ...sessionInfo('overflow-unknown'),
        directory: '/unknown',
        projectID: 'not-indexed-yet',
      }),
    );
    await vi.waitFor(() => expect(mocks.adapter.getCurrentProject).toHaveBeenCalledTimes(1));

    for (let index = 0; index <= 2_000; index += 1) {
      latestCallbacks().onPacket(
        sessionPacket('session.deleted', sessionInfo(`overflow-${index}`)),
      );
    }

    expect(staleSignal?.aborted).toBe(true);
    expect(referencedSignal?.aborted).toBe(true);
    expect(unknownSignal?.aborted).toBe(true);

    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hydrationTracker.active.size).toBe(0));
  });

  it('suppresses stale background completion after a new connection generation', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const freshFirst = deferred<unknown>();
    const freshSecond = deferred<unknown>();
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(freshFirst.promise)
      .mockReturnValueOnce(freshSecond.promise);
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(2));
    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(4));
    first.resolve([]);
    second.resolve([]);
    await flush();
    expect(messagesOf(worker.messages, 'state.background-hydration-complete')).toHaveLength(0);
    freshFirst.resolve([]);
    freshSecond.resolve([]);
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.background-hydration-complete')).toHaveLength(1),
    );
  });
});
