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

describe('SSE SharedWorker subagent resolution', () => {
  it('hydrates only referenced subagents before acknowledging the caller', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    mocks.adapter.listSessions.mockClear();
    mocks.adapter.getSession
      .mockResolvedValueOnce({
        id: 'child-a',
        slug: 'child-a',
        projectID: 'project',
        directory: '/a',
        parentID: 'root',
        title: 'Research persistence',
        version: '1',
        time: { created: 1, updated: 2 },
      })
      .mockResolvedValueOnce({
        id: 'foreign-child',
        slug: 'foreign-child',
        projectID: 'project',
        directory: '/a',
        parentID: 'other-root',
        title: 'Foreign',
        version: '1',
        time: { created: 1, updated: 2 },
      });

    post(worker, {
      type: 'hydrate-referenced-subagents',
      requestId: 'hydrate-1',
      rootSessionId: 'root',
      directory: '/a',
      sessionIds: ['child-a', 'foreign-child', 'child-a'],
    });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.referenced-subagents-hydrated')).toHaveLength(1),
    );

    expect(mocks.adapter.getSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'child-a',
      'foreign-child',
    ]);
    expect(mocks.adapter.listSessions).not.toHaveBeenCalled();
    const completion = messagesOf(worker.messages, 'state.referenced-subagents-hydrated')[0];
    expect(completion).toMatchObject({
      requestId: 'hydrate-1',
      rootSessionId: 'root',
      sessionIds: ['child-a'],
      cancelled: false,
    });
    const projectUpdateIndex = worker.messages.findIndex(
      (message) =>
        message.type === 'state.project-updated' &&
        message.project.sandboxes['/a']?.sessions['child-a']?.title === 'Research persistence',
    );
    const completionIndex = worker.messages.indexOf(completion);
    expect(projectUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(projectUpdateIndex);
  });

  it('caps referenced subagent hydration before scheduling backend reads', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    mocks.adapter.getSession.mockResolvedValue(undefined);

    post(worker, {
      type: 'hydrate-referenced-subagents',
      requestId: 'hydrate-capped',
      rootSessionId: 'root',
      directory: '/a',
      sessionIds: Array.from({ length: 129 }, (_, index) => `child-${index}`),
    });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.referenced-subagents-hydrated')).toContainEqual({
        type: 'state.referenced-subagents-hydrated',
        requestId: 'hydrate-capped',
        rootSessionId: 'root',
        sessionIds: [],
        cancelled: false,
      }),
    );
    expect(mocks.adapter.getSession).toHaveBeenCalledTimes(128);
  });

  it('cancels referenced subagent hydration when the selected root changes', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const child = deferred<unknown>();
    mocks.adapter.getSession.mockReturnValue(child.promise);

    post(worker, {
      type: 'hydrate-referenced-subagents',
      requestId: 'hydrate-stale',
      rootSessionId: 'root',
      directory: '/a',
      sessionIds: ['child'],
    });
    await vi.waitFor(() => expect(mocks.adapter.getSession).toHaveBeenCalledTimes(1));
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'other-root',
      directory: '/a',
    });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.referenced-subagents-hydrated')).toContainEqual({
        type: 'state.referenced-subagents-hydrated',
        requestId: 'hydrate-stale',
        rootSessionId: 'root',
        sessionIds: [],
        cancelled: true,
      }),
    );
    child.resolve({
      id: 'child',
      slug: 'child',
      projectID: 'project',
      directory: '/a',
      parentID: 'root',
      title: 'Stale child',
      version: '1',
      time: { created: 1, updated: 2 },
    });
    await flush();

    expect(
      messagesOf(worker.messages, 'state.project-updated').some(
        ({ project: updated }) => updated.sandboxes['/a']?.sessions.child?.title === 'Stale child',
      ),
    ).toBe(false);
  });

  it('buffers a status from an unindexed packet directory until the session hydrates', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket({
      directory: '/not-indexed-yet',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'late-child', status: { type: 'busy' } },
      },
    });
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.created',
        properties: {
          info: {
            id: 'late-child',
            slug: 'late-child',
            projectID: 'project',
            directory: '/a',
            parentID: 'root',
            title: 'Late child',
            version: '1',
            time: { created: 1, updated: 1 },
          },
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/a']
          ?.sessions['late-child']?.status,
      ).toBe('busy'),
    );
  });

  it('does not resolve a known session when an identical update is unchanged', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const info = sessionInfo('known');
    latestCallbacks().onPacket(sessionPacket('session.created', info));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
          Boolean(updated.sandboxes['/a']?.sessions.known),
        ),
      ).toBe(true),
    );
    mocks.adapter.getCurrentProject.mockClear();

    latestCallbacks().onPacket(sessionPacket('session.updated', info));
    await flush();

    expect(mocks.adapter.getCurrentProject).not.toHaveBeenCalled();
  });

  it('does not resurrect an unknown session after deletion invalidates delayed resolution', async () => {
    const lookup = deferred<unknown>();
    mocks.adapter.getCurrentProject.mockReturnValue(lookup.promise);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const info = { ...sessionInfo('late'), directory: '/missing' };
    latestCallbacks().onPacket(sessionPacket('session.created', info));
    await vi.waitFor(() =>
      expect(mocks.adapter.getCurrentProject).toHaveBeenCalledWith(
        '/missing',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    latestCallbacks().onPacket(sessionPacket('session.deleted', info));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/missing']
          ?.sessions.late,
      ).toBeUndefined(),
    );
    lookup.resolve(project(['/a', '/missing']));
    await flush();
    expect(messagesOf(worker.messages, 'state.project-updated')).toHaveLength(2);

    const latestProject = messagesOf(worker.messages, 'state.project-updated').at(-1)?.project;
    expect(latestProject?.sandboxes['/missing']?.sessions.late).toBeUndefined();
  });

  it('resolves a genuinely unknown session directory', async () => {
    const lookup = deferred<unknown>();
    mocks.adapter.getCurrentProject.mockReturnValue(lookup.promise);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const info = { ...sessionInfo('unknown'), directory: '/missing' };
    latestCallbacks().onPacket(sessionPacket('session.created', info));
    await vi.waitFor(() =>
      expect(mocks.adapter.getCurrentProject).toHaveBeenCalledWith(
        '/missing',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    lookup.resolve(project(['/a', '/missing']));
    await flush();

    expect(
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/missing']
        ?.sessions.unknown,
    ).toBeDefined();
  });

  it('deduplicates one directory lookup while retaining every pending session', async () => {
    const lookup = deferred<unknown>();
    mocks.adapter.getCurrentProject.mockReturnValue(lookup.promise);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const first = { ...sessionInfo('unknown-1', 'First'), directory: '/missing' };
    const second = {
      ...sessionInfo('unknown-2', 'Second'),
      directory: '/missing',
    };
    latestCallbacks().onPacket(sessionPacket('session.created', first));
    latestCallbacks().onPacket(sessionPacket('session.created', second));

    await vi.waitFor(() => expect(mocks.adapter.getCurrentProject).toHaveBeenCalledTimes(1));
    lookup.resolve(project(['/a', '/missing']));

    await vi.waitFor(() => {
      const updated = messagesOf(worker.messages, 'state.project-updated').at(-1)?.project;
      expect(updated?.sandboxes['/missing']?.sessions['unknown-1']?.title).toBe('First');
      expect(updated?.sandboxes['/missing']?.sessions['unknown-2']?.title).toBe('Second');
    });
  });

  it('schedules one authoritative rebootstrap when unknown resolution caps overflow', async () => {
    const lookups = new Map<string, Deferred<unknown>>();
    mocks.adapter.getCurrentProject.mockImplementation(
      (directory: string, options?: { signal?: AbortSignal }) => {
        const lookup = deferred<unknown>();
        lookups.set(directory, lookup);
        options?.signal?.addEventListener('abort', () => lookup.resolve(null), { once: true });
        return lookup.promise;
      },
    );
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    for (let index = 0; index < 33; index += 1) {
      const directory = `/unknown-${index}`;
      latestCallbacks().onPacket(
        sessionPacket('session.created', {
          ...sessionInfo(`unknown-${index}`),
          directory,
          projectID: 'not-indexed-yet',
        }),
      );
    }

    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    await flush();
    expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2);
    expect(
      new Set(mocks.adapter.getCurrentProject.mock.calls.map(([directory]) => directory)).size,
    ).toBeLessThanOrEqual(32);
    expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2);
  });

  it('aborts a deferred unknown lookup on disconnect and does not resurrect its session', async () => {
    const lookup = deferred<unknown>();
    mocks.adapter.getCurrentProject.mockReturnValue(lookup.promise);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const info = { ...sessionInfo('disconnecting'), directory: '/missing' };
    latestCallbacks().onPacket(sessionPacket('session.created', info));
    await vi.waitFor(() => expect(mocks.adapter.getCurrentProject).toHaveBeenCalledTimes(1));
    const signal = mocks.adapter.getCurrentProject.mock.calls[0]?.[1]?.signal;
    worker.messages.splice(0);
    post(worker, { type: 'disconnect' });
    expect(signal?.aborted).toBe(true);

    lookup.resolve(project(['/a', '/missing']));
    await flush();
    expect(messagesOf(worker.messages, 'state.project-updated')).toHaveLength(0);
  });

  it.each(['reconnect', 'bootstrap', 'disconnect'] as const)(
    'cleans pending unknown sessions and mutation snapshots after %s aborts resolution',
    async (abortMode) => {
      const lookup = deferred<unknown>();
      mocks.adapter.getCurrentProject.mockImplementation(
        (_directory: string, options?: { signal?: AbortSignal }) => {
          options?.signal?.addEventListener('abort', () => lookup.resolve(null), { once: true });
          return lookup.promise;
        },
      );
      let worker = await connectWorker();
      await vi.waitFor(() =>
        expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1),
      );
      const initialTracker = stateBuilderTrackers.trackers.at(-1);
      if (!initialTracker) throw new Error('Expected the initial state builder tracker');

      latestCallbacks().onPacket(
        sessionPacket('session.created', {
          ...sessionInfo(`${abortMode}-pending`),
          directory: '/missing',
        }),
      );
      await vi.waitFor(() => expect(mocks.adapter.getCurrentProject).toHaveBeenCalledTimes(1));

      if (abortMode === 'reconnect') {
        latestCallbacks().onOpen(true);
        await vi.waitFor(() =>
          expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2),
        );
        await flush();
      } else if (abortMode === 'bootstrap') {
        for (let index = 0; index < 33; index += 1) {
          latestCallbacks().onPacket(
            sessionPacket('session.created', {
              ...sessionInfo(`bootstrap-${index}`),
              directory: `/bootstrap-${index}`,
            }),
          );
        }
        await vi.waitFor(() =>
          expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2),
        );
        await flush();
      } else {
        post(worker, { type: 'disconnect' });
        worker = await connectWorker();
        await vi.waitFor(() =>
          expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1),
        );
      }

      expect(initialTracker.active.size).toBe(0);

      const futureLookup = deferred<unknown>();
      mocks.adapter.getCurrentProject.mockReset();
      mocks.adapter.getCurrentProject.mockImplementation(
        (_directory: string, options?: { signal?: AbortSignal }) => {
          options?.signal?.addEventListener('abort', () => futureLookup.resolve(null), {
            once: true,
          });
          return futureLookup.promise;
        },
      );
      mocks.adapter.listProjects.mockClear();
      worker.messages.splice(0);

      for (let index = 0; index < 1_999; index += 1) {
        latestCallbacks().onPacket(
          sessionPacket('session.created', {
            ...sessionInfo(`future-${index}`),
            projectID: 'constructor',
            directory: '/future',
          }),
        );
      }
      latestCallbacks().onPacket(
        sessionPacket('session.created', {
          ...sessionInfo('future-1999'),
          directory: '/future',
        }),
      );

      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mocks.adapter.listProjects).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.adapter.getCurrentProject).toHaveBeenCalledTimes(1));
      futureLookup.resolve(project(['/a', '/future']));
      await vi.waitFor(() =>
        expect(
          messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
            Boolean(updated.sandboxes['/future']?.sessions['future-1999']),
          ),
        ).toBe(true),
      );

      const currentTracker = stateBuilderTrackers.trackers.at(-1);
      if (!currentTracker) throw new Error('Expected the active state builder tracker');
      await vi.waitFor(() => expect(currentTracker.active.size).toBe(0));
    },
  );

  it('drops queued stale unknown reads before reconnect can issue them', async () => {
    const lookups = new Map<string, Deferred<unknown>>();
    mocks.adapter.getCurrentProject.mockImplementation(
      (directory: string, options?: { signal?: AbortSignal }) => {
        const lookup = deferred<unknown>();
        lookups.set(directory, lookup);
        options?.signal?.addEventListener('abort', () => lookup.resolve(null), { once: true });
        return lookup.promise;
      },
    );
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const directories = Array.from({ length: 13 }, (_, index) => `/queued-${index}`);
    for (const [index, directory] of directories.entries()) {
      latestCallbacks().onPacket(
        sessionPacket('session.created', {
          ...sessionInfo(`queued-${index}`),
          directory,
          projectID: 'not-indexed-yet',
        }),
      );
    }
    await vi.waitFor(() => expect(mocks.adapter.getCurrentProject).toHaveBeenCalledTimes(12));

    latestCallbacks().onOpen(true);
    for (const lookup of lookups.values()) lookup.resolve(null);

    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    expect(
      mocks.adapter.getCurrentProject.mock.calls.some(
        ([directory]) => directory === directories[12],
      ),
    ).toBe(false);
  });
});
