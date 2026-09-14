import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnection, SseConnectionCallbacks } from '../utils/sseConnection';
import {
  createSseWorkerTestHarness,
  type MutationSnapshotToken,
  type MutationSnapshotTracker,
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

describe('SSE SharedWorker reconnect and topology', () => {
  it('removes retired directories after repeated project rotations', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    for (const directories of [
      ['/b', '/c'],
      ['/c', '/d'],
      ['/d', '/e'],
    ] as const) {
      latestCallbacks().onPacket(projectUpdatedPacket(project(directories)));
      await vi.waitFor(() =>
        expect(
          messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes[
            directories[0]
          ],
        ).toBeDefined(),
      );
    }

    mocks.adapter.getCurrentProject.mockClear();
    latestCallbacks().onPacket(
      sessionPacket('session.created', sessionInfo('retired', 'Retired', undefined, '/a')),
    );

    await vi.waitFor(() =>
      expect(mocks.adapter.getCurrentProject).toHaveBeenCalledWith(
        '/a',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it('preserves known directories belonging to other projects after a project update', async () => {
    mocks.adapter.listProjects.mockResolvedValue([
      project(['/a', '/a-sandbox']),
      project(['/other', '/other-sandbox'], 'other'),
    ]);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket(projectUpdatedPacket(project(['/b'], 'project')));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/b'],
      ).toBeDefined(),
    );
    mocks.adapter.getCurrentProject.mockClear();

    const otherSession = {
      ...sessionInfo('other-session', 'Other session', undefined, '/other'),
      projectID: 'other',
    };
    latestCallbacks().onPacket(sessionPacket('session.created', otherSession));
    await flush();

    expect(mocks.adapter.getCurrentProject).not.toHaveBeenCalled();
  });

  it('retains a resolved unknown directory while another project updates', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a']), project(['/other'], 'other')]);
    mocks.adapter.getCurrentProject.mockResolvedValue(project(['/a', '/resolved']));
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const resolvedSession = {
      ...sessionInfo('resolved', 'Resolved', undefined, '/resolved'),
      projectID: 'project',
    };
    latestCallbacks().onPacket(sessionPacket('session.created', resolvedSession));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
          Boolean(updated.sandboxes['/resolved']?.sessions.resolved),
        ),
      ).toBe(true),
    );

    latestCallbacks().onPacket(projectUpdatedPacket(project(['/other', '/other-new'], 'other')));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes[
          '/other-new'
        ],
      ).toBeDefined(),
    );
    mocks.adapter.getCurrentProject.mockClear();

    const followUpSession = {
      ...sessionInfo('resolved-again', 'Resolved again', undefined, '/resolved'),
      projectID: 'project',
    };
    latestCallbacks().onPacket(sessionPacket('session.created', followUpSession));
    await flush();

    expect(mocks.adapter.getCurrentProject).not.toHaveBeenCalled();
  });

  it('isolates events from a disconnected connection generation', async () => {
    const first = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(first.messages, 'state.bootstrap')).toHaveLength(1));
    const disconnectedCallbacks = latestCallbacks();

    post(first, { type: 'disconnect' });
    const second = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(1));
    second.messages.splice(0);

    disconnectedCallbacks.onPacket(sessionCreatedPacket('stale-after-disconnect'));
    disconnectedCallbacks.onOpen(true);
    await flush();

    expect(messagesOf(second.messages, 'packet')).toHaveLength(0);
    expect(messagesOf(second.messages, 'state.project-updated')).toHaveLength(0);
    expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(0);
  });

  it('suppresses a stale VCS read that resolves after a reconnect bootstrap', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const staleVcs = deferred<unknown>();
    const freshVcs = deferred<unknown>();
    let directoryACalls = 0;
    let staleSignal: AbortSignal | undefined;
    let freshSignal: AbortSignal | undefined;
    mocks.adapter.getVcsInfo.mockReset();
    mocks.adapter.getVcsInfo.mockImplementation(
      (directory: string, options?: { signal?: AbortSignal }) => {
        if (directory !== '/a') return Promise.resolve({ branch: 'main' });
        directoryACalls += 1;
        if (directoryACalls === 1) {
          staleSignal = options?.signal;
          return staleVcs.promise;
        }
        freshSignal = options?.signal;
        return freshVcs.promise;
      },
    );

    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

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

    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    await vi.waitFor(() => expect(directoryACalls).toBe(2));
    expect(staleSignal?.aborted).toBe(true);
    expect(freshSignal?.aborted).toBe(false);

    // The generation-1 VCS read resolves late: it must not mutate or broadcast.
    staleVcs.resolve({ branch: 'stale-branch' });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staleUpdates = messagesOf(worker.messages, 'state.project-updated').filter(
      ({ project: updated }) => updated.sandboxes['/a']?.name === 'stale-branch',
    );
    expect(staleUpdates).toHaveLength(0);

    // The current generation's VCS read still applies.
    freshVcs.resolve({ branch: 'main' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => updated.sandboxes['/a']?.name === 'main',
        ),
      ).toBe(true),
    );
  });

  it('ignores a retired VCS read after the directory is re-added', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const staleVcs = deferred<unknown>();
    const freshVcs = deferred<unknown>();
    let directoryACalls = 0;
    let staleSignal: AbortSignal | undefined;
    mocks.adapter.getVcsInfo.mockReset();
    mocks.adapter.getVcsInfo.mockImplementation(
      (directory: string, options?: { signal?: AbortSignal }) => {
        if (directory !== '/a') return Promise.resolve({ branch: 'global' });
        directoryACalls += 1;
        if (directoryACalls === 1) {
          staleSignal = options?.signal;
          return staleVcs.promise;
        }
        return freshVcs.promise;
      },
    );

    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });
    await vi.waitFor(() => expect(directoryACalls).toBe(1));

    latestCallbacks().onPacket(projectUpdatedPacket(project(['/b'])));
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.directory-hydration-removed')).toContainEqual({
        type: 'state.directory-hydration-removed',
        directory: '/a',
      }),
    );
    expect(staleSignal?.aborted).toBe(true);

    latestCallbacks().onPacket(projectUpdatedPacket(project(['/a'])));
    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    await vi.waitFor(() => expect(directoryACalls).toBe(2));

    staleVcs.resolve({ branch: 'stale-branch' });
    await flush();
    expect(
      messagesOf(worker.messages, 'state.project-updated').some(
        ({ project: updated }) => updated.sandboxes['/a']?.name === 'stale-branch',
      ),
    ).toBe(false);

    freshVcs.resolve({ branch: 'fresh-branch' });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => updated.sandboxes['/a']?.name === 'fresh-branch',
        ),
      ).toBe(true),
    );
  });

  it('abandons a stale bootstrap whose listProjects resolves after the connection was replaced', async () => {
    const staleProjects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValue(staleProjects.promise);
    const first = await connectWorker();

    post(first, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/stale',
    });
    post(first, { type: 'disconnect' });

    mocks.adapter.listProjects.mockResolvedValue([project(['/x'])]);
    const second = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(1));

    mocks.adapter.listSessions.mockClear();
    mocks.adapter.getVcsInfo.mockClear();
    staleProjects.resolve([project(['/stale'])]);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The stale run must not apply topology or kick off hydration for its directories.
    expect(mocks.adapter.listSessions).not.toHaveBeenCalledWith({
      directory: '/stale',
      roots: true,
    });
    expect(mocks.adapter.getVcsInfo).not.toHaveBeenCalledWith('/stale');
    expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(1);
    expect(messagesOf(second.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/x': { status: 'unloaded' },
    });
  });

  it('retries a rejected bootstrap and applies packets received during the successful retry', async () => {
    const firstProjects = deferred<unknown>();
    const retryProjects = deferred<unknown>();
    mocks.adapter.listProjects
      .mockReturnValueOnce(firstProjects.promise)
      .mockReturnValueOnce(retryProjects.promise);
    const worker = await connectWorker();
    latestCallbacks().onPacket(sessionCreatedPacket('discarded-before-retry'));

    firstProjects.reject(new Error('transient project failure'));
    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    latestCallbacks().onPacket(sessionCreatedPacket('kept-during-retry'));
    retryProjects.resolve([project(['/a'])]);

    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) =>
            updated.sandboxes['/a']?.sessions['kept-during-retry']?.title === 'kept-during-retry',
        ),
      ).toBe(true),
    );
  });

  it('invalidates an in-flight bootstrap when a same-state reconnect fires', async () => {
    const staleProjects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValueOnce(staleProjects.promise);
    const worker = await connectWorker();

    mocks.adapter.listProjects.mockResolvedValue([project(['/fresh'])]);
    latestCallbacks().onOpen(true);

    staleProjects.resolve([project(['/stale'])]);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The pre-reconnect run must not broadcast its topology; the fresh run wins.
    expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(worker.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/fresh': { status: 'unloaded' },
    });
  });

  it('queues selection and direct session hydration behind a reconnect topology barrier', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const reconnectProjects = deferred<unknown>();
    let reconnecting = true;
    mocks.adapter.listProjects.mockReturnValueOnce(reconnectProjects.promise);
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions.mockImplementation(
      ({ directory, signal }: { directory: string; signal?: AbortSignal }) => {
        if (reconnecting) {
          throw new Error(`Session hydration escaped reconnect barrier: ${String(signal)}`);
        }
        return Promise.resolve(directory === '/a' ? [sessionInfo('reconnected-session')] : []);
      },
    );
    mocks.adapter.getSessionStatusMap.mockReset();
    mocks.adapter.getSessionStatusMap.mockResolvedValue({});
    mocks.adapter.getVcsInfo.mockReset();
    mocks.adapter.getVcsInfo.mockImplementation(
      (directory: string, options?: { signal?: AbortSignal }) => {
        if (reconnecting) {
          throw new Error(`VCS hydration escaped reconnect barrier: ${String(options?.signal)}`);
        }
        return Promise.resolve({ branch: directory === '/a' ? 'reconnected-branch' : 'main' });
      },
    );

    latestCallbacks().onOpen(true);
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });
    post(worker, { type: 'load-sessions', directory: '/a' });
    await flush();

    expect(mocks.adapter.listSessions).not.toHaveBeenCalled();
    expect(mocks.adapter.getVcsInfo).not.toHaveBeenCalled();

    reconnecting = false;
    reconnectProjects.resolve([project(['/a'])]);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-updated')
          .filter(({ directory }) => directory === '/a')
          .at(-1)?.hydration,
      ).toEqual({ status: 'loaded' }),
    );

    expect(
      mocks.adapter.listSessions.mock.calls.filter(([options]) => options.directory === '/a'),
    ).toHaveLength(1);
    expect(
      mocks.adapter.getVcsInfo.mock.calls.filter(([directory]) => directory === '/a'),
    ).toHaveLength(1);
    expect(
      messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
        Boolean(updated.sandboxes['/a']?.sessions['reconnected-session']),
      ),
    ).toBe(true);
  });
});
