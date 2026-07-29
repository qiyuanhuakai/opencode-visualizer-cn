import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnection, SseConnectionCallbacks } from '../utils/sseConnection';
import type { TabToWorkerMessage, WorkerToTabMessage } from '../types/sse-worker';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type WorkerPort = { readonly port: MessagePort; readonly messages: WorkerToTabMessage[] };

const mocks = vi.hoisted(() => {
  const callbacks: SseConnectionCallbacks[] = [];
  const adapter = {
    configure: vi.fn(),
    listProjects: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getSessionStatusMap: vi.fn(),
    getVcsInfo: vi.fn(),
  };
  const createConnection = vi.fn((next: SseConnectionCallbacks): SseConnection => {
    callbacks.push(next);
    return { connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true };
  });
  return { adapter, callbacks, createConnection };
});

vi.mock('../backends/openCodeAdapter', () => ({
  createOpenCodeAdapter: () => mocks.adapter,
}));
vi.mock('../utils/sseConnection', () => ({ createSseConnection: mocks.createConnection }));

const workerSelf: { onconnect: ((event: MessageEvent) => void) | null } = { onconnect: null };
const openPorts: MessagePort[] = [];

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function project(directories: readonly string[]) {
  const worktree = directories[0] ?? '/project';
  return { id: 'project', worktree, sandboxes: directories, time: { created: 1, updated: 1 } };
}

function messagesOf<T extends WorkerToTabMessage['type']>(
  messages: readonly WorkerToTabMessage[],
  type: T,
): Extract<WorkerToTabMessage, { type: T }>[] {
  return messages.filter(
    (message): message is Extract<WorkerToTabMessage, { type: T }> => message.type === type,
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connectWorker(): Promise<WorkerPort> {
  await import('./sse-shared-worker');
  const connectionCount = mocks.callbacks.length;
  const channel = new MessageChannel();
  const messages: WorkerToTabMessage[] = [];
  channel.port2.onmessage = (event: MessageEvent<WorkerToTabMessage>) => messages.push(event.data);
  channel.port2.start();
  openPorts.push(channel.port1, channel.port2);
  const onconnect = workerSelf.onconnect;
  if (!onconnect) throw new Error('Expected SharedWorker onconnect handler');
  onconnect(new MessageEvent('connect', { ports: [channel.port1] }));
  channel.port1.onmessage?.(
    new MessageEvent<TabToWorkerMessage>('message', {
      data: { type: 'connect', baseUrl: 'http://server' },
    }),
  );
  if (mocks.callbacks.length > connectionCount) {
    const callbacks = mocks.callbacks.at(-1);
    if (!callbacks) throw new Error('Expected SSE connection callbacks');
    callbacks.onOpen(false);
  }
  return { port: channel.port1, messages };
}

function post(worker: WorkerPort, message: TabToWorkerMessage): void {
  worker.port.onmessage?.(new MessageEvent<TabToWorkerMessage>('message', { data: message }));
}

function latestCallbacks(): SseConnectionCallbacks {
  const callbacks = mocks.callbacks.at(-1);
  if (!callbacks) throw new Error('Expected SSE connection callbacks');
  return callbacks;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.callbacks.length = 0;
  workerSelf.onconnect = null;
  vi.stubGlobal('self', workerSelf);
  mocks.adapter.listProjects.mockResolvedValue([project(['/a', '/b'])]);
  mocks.adapter.listSessions.mockResolvedValue([]);
  mocks.adapter.getSession.mockResolvedValue(undefined);
  mocks.adapter.getSessionStatusMap.mockResolvedValue({});
  mocks.adapter.getVcsInfo.mockResolvedValue({ branch: 'main' });
});

afterEach(() => {
  openPorts.splice(0).forEach((port) => port.close());
  vi.unstubAllGlobals();
});

describe('SSE SharedWorker hydration', () => {
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

  it('emits topology bootstrap before any directory request resolves', async () => {
    const sessions = deferred<unknown>();
    mocks.adapter.listSessions.mockReturnValue(sessions.promise);

    const worker = await connectWorker();

    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(mocks.adapter.listSessions).not.toHaveBeenCalled();
    expect(messagesOf(worker.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/a': { status: 'unloaded' },
      '/b': { status: 'unloaded' },
    });
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
    expect(mocks.adapter.listSessions).toHaveBeenCalledWith({ directory: '/a', roots: true });
    expect(mocks.adapter.getVcsInfo).not.toHaveBeenCalled();
    expect(
      messagesOf(worker.messages, 'state.directory-hydration-updated').map(
        ({ hydration }) => hydration.status,
      ),
    ).toEqual(['loading', 'loaded']);
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

  it('gives a warm-attached port the current hydration snapshot', async () => {
    const first = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(first.messages, 'state.bootstrap')).toHaveLength(1));
    const second = await connectWorker();

    await vi.waitFor(() => expect(messagesOf(second.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(second.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
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
    expect(mocks.adapter.getVcsInfo).toHaveBeenCalledTimes(4);
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

  it('suppresses stale background completion after a new connection generation', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(1));
    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    await vi.waitFor(() => expect(mocks.adapter.listSessions).toHaveBeenCalledTimes(2));
    first.resolve([]);
    await flush();
    expect(messagesOf(worker.messages, 'state.background-hydration-complete')).toHaveLength(0);
    second.resolve([]);
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.background-hydration-complete')).toHaveLength(1),
    );
  });

  it('flushes an SSE packet buffered before topology installation', async () => {
    const projects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValue(projects.promise);
    const worker = await connectWorker();
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.created',
        properties: {
          info: {
            id: 'session',
            slug: 'session',
            projectID: 'project',
            directory: '/a',
            title: 'Session',
            version: '1',
            time: { created: 1, updated: 1 },
          },
        },
      },
    });
    projects.resolve([project(['/a'])]);

    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.project-updated')).toHaveLength(1),
    );
  });

  it('suppresses a stale VCS read that resolves after a reconnect bootstrap', async () => {
    mocks.adapter.listProjects.mockResolvedValue([project(['/a'])]);
    const staleVcs = deferred<unknown>();
    const freshVcs = deferred<unknown>();
    mocks.adapter.getVcsInfo.mockReset();
    mocks.adapter.getVcsInfo
      .mockReturnValueOnce(staleVcs.promise)
      .mockReturnValueOnce(freshVcs.promise);

    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'session',
      directory: '/a',
    });
    await vi.waitFor(() => expect(mocks.adapter.getVcsInfo).toHaveBeenCalledTimes(1));

    latestCallbacks().onOpen(true);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    await vi.waitFor(() => expect(mocks.adapter.getVcsInfo).toHaveBeenCalledTimes(2));

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
      '/x': { status: 'unloaded' },
    });
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
      '/fresh': { status: 'unloaded' },
    });
  });
});
