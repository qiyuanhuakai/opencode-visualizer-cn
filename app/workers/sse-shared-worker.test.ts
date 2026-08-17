import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnection, SseConnectionCallbacks } from '../utils/sseConnection';
import type { SsePacket } from '../types/sse';
import type { TabToWorkerMessage, WorkerToTabMessage } from '../types/sse-worker';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type WorkerPort = { readonly port: MessagePort; readonly messages: WorkerToTabMessage[] };

type MutationSnapshotToken = {
  readonly id: symbol;
  readonly baseline: number;
  readonly sequence: number;
};

type MutationSnapshotTracker = {
  readonly active: Set<MutationSnapshotToken>;
};

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
  const actual = await vi.importActual<typeof import('../utils/stateBuilder')>(
    '../utils/stateBuilder',
  );
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

function project(directories: readonly string[], id = 'project') {
  const worktree = directories[0] ?? '/project';
  return { id, worktree, sandboxes: directories, time: { created: 1, updated: 1 } };
}

function sessionInfo(id: string, title = id, parentID?: string, directory = '/a') {
  return {
    id,
    slug: id,
    projectID: 'project',
    directory,
    ...(parentID ? { parentID } : {}),
    title,
    version: '1',
    time: { created: 1, updated: 1 },
  };
}

function sessionPacket(
  type: 'session.created' | 'session.updated' | 'session.deleted',
  info: ReturnType<typeof sessionInfo>,
): SsePacket {
  return {
    directory: info.directory,
    payload: {
      type,
      properties: { info },
    },
  };
}

function sessionCreatedPacket(
  id: string,
  title = id,
  parentID?: string,
  directory = '/a',
): SsePacket {
  return {
    directory,
    payload: {
      type: 'session.created',
      properties: {
        info: sessionInfo(id, title, parentID, directory),
      },
    },
  };
}

function projectUpdatedPacket(projectInfo: ReturnType<typeof project>): SsePacket {
  return {
    directory: projectInfo.worktree,
    payload: {
      type: 'project.updated',
      properties: projectInfo,
    },
  };
}

function permissionAskedPacket(id: string, sessionID: string, directory = '/a'): SsePacket {
  return {
    directory,
    payload: {
      type: 'permission.asked',
      properties: {
        id,
        sessionID,
        permission: 'edit',
        patterns: ['*'],
        metadata: {},
        always: [],
      },
    },
  };
}

function questionAskedPacket(id: string, sessionID: string, directory = '/a'): SsePacket {
  return {
    directory,
    payload: {
      type: 'question.asked',
      properties: {
        id,
        sessionID,
        questions: [
          {
            question: 'Continue?',
            header: 'Continue',
            options: [{ label: 'Yes', description: 'Continue the task.' }],
          },
        ],
      },
    },
  };
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

async function connectWorker(baseUrl = 'http://server', authorization?: string): Promise<WorkerPort> {
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
      data: { type: 'connect', baseUrl, authorization },
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
  stateBuilderTrackers.trackers.length = 0;
  workerSelf.onconnect = null;
  vi.stubGlobal('self', workerSelf);
  mocks.adapter.listProjects.mockResolvedValue([project(['/a', '/b'])]);
  mocks.adapter.listSessions.mockResolvedValue([]);
  mocks.adapter.getSession.mockResolvedValue(undefined);
  mocks.adapter.getCurrentProject.mockResolvedValue(project(['/a', '/b']));
  mocks.adapter.getSessionStatusMap.mockResolvedValue({});
  mocks.adapter.getVcsInfo.mockResolvedValue({ branch: 'main' });
});

afterEach(() => {
  openPorts.splice(0).forEach((port) => port.close());
  vi.unstubAllGlobals();
});

describe('SSE SharedWorker hydration', () => {
  it('passes an explicit undefined authorization into an unauthenticated worker read', async () => {
    const authenticated = await connectWorker('http://authenticated', 'Bearer TOP-SECRET');
    await vi.waitFor(() =>
      expect(messagesOf(authenticated.messages, 'state.bootstrap')).toHaveLength(1),
    );
    mocks.adapter.configure.mockClear();

    const anonymous = await connectWorker('http://anonymous');
    await vi.waitFor(() => expect(messagesOf(anonymous.messages, 'state.bootstrap')).toHaveLength(1));

    expect(mocks.adapter.configure).toHaveBeenCalledWith({
      baseUrl: 'http://anonymous',
      authorization: undefined,
    });
  });

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
  });

  it('hydrates the synthetic global root through the normal bootstrap lifecycle', async () => {
    const worker = await connectWorker();

    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(messagesOf(worker.messages, 'state.bootstrap')[0]?.sessionHydrationByDirectory).toEqual({
      '/': { status: 'unloaded' },
      '/a': { status: 'unloaded' },
      '/b': { status: 'unloaded' },
    });

    mocks.adapter.listSessions.mockImplementation(
      ({ directory }: { directory: string }) =>
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
        messagesOf(worker.messages, 'state.directory-hydration-updated').filter(
          ({ directory }) => directory === '/',
        ).map(({ hydration }) => hydration.status),
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

    expect(mocks.adapter.getVcsInfo.mock.calls.filter(([directory]) => directory === '/a')).toHaveLength(
      1,
    );
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
          ({ directory, hydration }) =>
            directory === '/b' && hydration.status === 'unloaded',
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
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/b']?.sessions[
        'session-b'
      ],
    ).toBeDefined();

    post(worker, { type: 'load-sessions', directory: '/a' });
    await vi.waitFor(() =>
      expect(mocks.adapter.listSessions).toHaveBeenCalledWith(
        expect.objectContaining({ directory: '/a', roots: true, signal: expect.any(AbortSignal) }),
      ),
    );
    latestCallbacks().onPacket(projectUpdatedPacket(project(['/b'])));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.directory-hydration-removed'),
      ).toContainEqual({ type: 'state.directory-hydration-removed', directory: '/a' }),
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
    mocks.adapter.listProjects.mockResolvedValue([
      project([...busyDirectories, targetDirectory]),
    ]);
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
    expect(messagesOf(second.messages, 'state.bootstrap')[0]?.projects.project.sandboxes['/priority']).toBeDefined();

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
      expect(messagesOf(worker.messages, 'state.directory-hydration-updated').at(-1)?.hydration).toEqual({
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

    for (let index = 0; index < 12; index += 1) {
      latestCallbacks().onOpen(true);
      await vi.waitFor(() =>
        expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(index + 2),
      );
    }
    expect(signals.slice(0, -1).every((signal) => signal?.aborted)).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);

    worker.messages.splice(0);
    latestCallbacks().onPacket(sessionCreatedPacket('buffered-during-reconnect'));
    expect(messagesOf(worker.messages, 'state.project-updated')).toHaveLength(0);

    const replacement = reads.at(-1);
    if (!replacement) throw new Error('Expected the replacement bootstrap read');
    replacement.resolve([project(['/a'])]);
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    expect(
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/a']?.sessions[
        'buffered-during-reconnect'
      ],
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
      messagesOf(worker.messages, 'state.project-updated').some(
        ({ project: updated }) => Boolean(updated.sandboxes['/a']?.sessions['stale-after-overflow']),
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
      latestCallbacks().onPacket(sessionPacket('session.deleted', sessionInfo(`overflow-${index}`)));
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

  it('reconciles an idle notification after an idle status arrives before session.created', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'new-root', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket(sessionCreatedPacket('new-root', 'New root'));

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.notifications-updated').some(
          ({ notifications }) => notifications['new-root']?.requestIds.includes('idle:project:new-root'),
        ),
      ).toBe(true),
    );
    expect(messagesOf(worker.messages, 'notification.show')).toContainEqual({
      type: 'notification.show',
      projectId: 'project',
      sessionId: 'new-root',
      kind: 'idle',
    });
  });

  it('does not resolve a known session when an identical update is unchanged', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    const info = sessionInfo('known');
    latestCallbacks().onPacket(sessionPacket('session.created', info));
    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => Boolean(updated.sandboxes['/a']?.sessions.known),
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
      expect(messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/missing']?.sessions.late)
        .toBeUndefined(),
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
      messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/missing']?.sessions
        .unknown,
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
    expect(new Set(mocks.adapter.getCurrentProject.mock.calls.map(([directory]) => directory)).size).toBeLessThanOrEqual(32);
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
      await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
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
        await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
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
        await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
        await flush();
      } else {
        post(worker, { type: 'disconnect' });
        worker = await connectWorker();
        await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
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
          messagesOf(worker.messages, 'state.project-updated').some(
            ({ project: updated }) => Boolean(updated.sandboxes['/future']?.sessions['future-1999']),
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

  it('notifies the parent when deleting its busy child leaves the tree idle', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket(sessionCreatedPacket('root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket(sessionCreatedPacket('child', 'Child', 'root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'child', status: { type: 'busy' } },
      },
    });
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.notifications-updated').length).toBeGreaterThan(0),
    );
    expect(messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root).toBeUndefined();
    worker.messages.splice(0);
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.deleted',
        properties: { info: sessionInfo('child', 'Child', 'root') },
      },
    });

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'notification.show'),
      ).toContainEqual({
        type: 'notification.show',
        projectId: 'project',
        sessionId: 'root',
        kind: 'idle',
      }),
    );
  });

  it('preserves a sibling permission when deleting a busy child re-adds root idle', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket(sessionCreatedPacket('root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket(sessionCreatedPacket('sibling', 'Sibling', 'root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sibling', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'permission-sibling',
          sessionID: 'sibling',
          permission: 'edit',
          patterns: ['*'],
          metadata: {},
          always: [],
        },
      },
    });
    latestCallbacks().onPacket(sessionCreatedPacket('busy-child', 'Busy child', 'root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'busy-child', status: { type: 'busy' } },
      },
    });
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root)
        .toMatchObject({ requestIds: ['permission-sibling'] }),
    );

    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.deleted',
        properties: { info: sessionInfo('busy-child', 'Busy child', 'root') },
      },
    });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root)
        .toMatchObject({ requestIds: ['permission-sibling', 'idle:project:root'] }),
    );
  });

  it('clears every root notification when deleting the root session', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket(sessionCreatedPacket('root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket(permissionAskedPacket('permission-root', 'root'));
    latestCallbacks().onPacket(questionAskedPacket('question-root', 'root'));

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root)
        .toMatchObject({
          requestIds: expect.arrayContaining([
            'idle:project:root',
            'permission-root',
            'question-root',
          ]),
        }),
    );
    worker.messages.splice(0);

    latestCallbacks().onPacket(sessionPacket('session.deleted', sessionInfo('root')));

    await vi.waitFor(() => {
      const updates = messagesOf(worker.messages, 'state.notifications-updated');
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1)?.notifications.root).toBeUndefined();
    });
  });

  it('preserves root and sibling permission/question notifications when deleting a child', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    latestCallbacks().onPacket(sessionCreatedPacket('root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket(sessionCreatedPacket('sibling', 'Sibling', 'root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'sibling', status: { type: 'idle' } },
      },
    });
    latestCallbacks().onPacket(permissionAskedPacket('permission-root', 'root'));
    latestCallbacks().onPacket(questionAskedPacket('question-sibling', 'sibling'));
    latestCallbacks().onPacket(sessionCreatedPacket('busy-child', 'Busy child', 'root'));
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'busy-child', status: { type: 'busy' } },
      },
    });
    latestCallbacks().onPacket(permissionAskedPacket('permission-child', 'busy-child'));
    latestCallbacks().onPacket(questionAskedPacket('question-child', 'busy-child'));

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root)
        .toMatchObject({
          requestIds: expect.arrayContaining([
            'permission-root',
            'question-sibling',
            'permission-child',
            'question-child',
          ]),
        }),
    );

    latestCallbacks().onPacket(sessionPacket('session.deleted', sessionInfo('busy-child', 'Busy child', 'root')));

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root)
        .toMatchObject({
          requestIds: expect.arrayContaining([
            'permission-root',
            'question-sibling',
            'idle:project:root',
          ]),
        }),
    );
    const requestIds = messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications
      .root?.requestIds;
    expect(requestIds).not.toContain('permission-child');
    expect(requestIds).not.toContain('question-child');
  });

  it('removes retired directories after repeated project rotations', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));

    for (const directories of [['/b', '/c'], ['/c', '/d'], ['/d', '/e']] as const) {
      latestCallbacks().onPacket(projectUpdatedPacket(project(directories)));
      await vi.waitFor(() =>
        expect(messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes[directories[0]])
          .toBeDefined(),
      );
    }

    mocks.adapter.getCurrentProject.mockClear();
    latestCallbacks().onPacket(sessionPacket('session.created', sessionInfo('retired', 'Retired', undefined, '/a')));

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
      expect(messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/b'])
        .toBeDefined(),
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
    mocks.adapter.listProjects.mockResolvedValue([
      project(['/a']),
      project(['/other'], 'other'),
    ]);
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
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => Boolean(updated.sandboxes['/resolved']?.sessions.resolved),
        ),
      ).toBe(true),
    );

    latestCallbacks().onPacket(projectUpdatedPacket(project(['/other', '/other-new'], 'other')));
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'state.project-updated').at(-1)?.project.sandboxes['/other-new'])
        .toBeDefined(),
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

  it('does not let streaming packets evict a buffered worker-state packet', async () => {
    const projects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValue(projects.promise);
    const worker = await connectWorker();

    latestCallbacks().onPacket(sessionCreatedPacket('state-first'));
    for (let index = 0; index <= 2_000; index += 1) {
      latestCallbacks().onPacket({
        directory: '/a',
        payload: { type: 'message.part.delta', properties: { delta: `chunk-${index}` } },
      });
    }
    projects.resolve([project(['/a'])]);

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => Boolean(updated.sandboxes['/a']?.sessions['state-first']),
        ),
      ).toBe(true),
    );
  });

  it('schedules one authoritative bootstrap after buffered state overflows', { timeout: 15_000 }, async () => {
    const projects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValueOnce(projects.promise).mockResolvedValueOnce([
      project(['/a']),
    ]);
    const worker = await connectWorker();

    for (let index = 0; index <= 2_000; index += 1) {
      latestCallbacks().onPacket(sessionCreatedPacket(`overflow-${index}`));
    }
    projects.resolve([project(['/a'])]);

    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    const secondBootstrap = messagesOf(worker.messages, 'state.bootstrap')[1];
    expect(secondBootstrap?.projects.project?.sandboxes['/a']?.sessions).toEqual({});
  });

  it('restarts from authoritative state after the packet count reaches its cap', { timeout: 15_000 }, async () => {
    const projects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValueOnce(projects.promise).mockResolvedValueOnce([
      project(['/a']),
    ]);
    const worker = await connectWorker();

    for (let index = 0; index <= 2_000; index += 1) {
      latestCallbacks().onPacket(sessionCreatedPacket(`buffered-${index}`));
    }
    projects.resolve([project(['/a'])]);

    await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2));
    const finalProject = messagesOf(worker.messages, 'state.bootstrap')[1]?.projects.project;
    expect(finalProject?.sandboxes['/a']?.sessions).toEqual({});
  });

  it('evicts oldest bootstrap packets when their serialized bytes exceed the cap', async () => {
    const projects = deferred<unknown>();
    mocks.adapter.listProjects.mockReturnValue(projects.promise);
    const worker = await connectWorker();
    const largeTitle = 'x'.repeat(2_100_000);

    latestCallbacks().onPacket(sessionCreatedPacket('large-0', largeTitle));
    latestCallbacks().onPacket(sessionCreatedPacket('large-1', largeTitle));
    projects.resolve([project(['/a'])]);

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.project-updated').some(
          ({ project: updated }) => Boolean(updated.sandboxes['/a']?.sessions['large-1']),
        ),
      ).toBe(true),
    );
    const finalProject = messagesOf(worker.messages, 'state.project-updated').at(-1)?.project;
    expect(finalProject?.sandboxes['/a']?.sessions['large-0']).toBeUndefined();
    expect(finalProject?.sandboxes['/a']?.sessions['large-1']).toBeDefined();
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
            updated.sandboxes['/a']?.sessions['kept-during-retry']?.title ===
            'kept-during-retry',
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
    const staleSessions = deferred<unknown>();
    const staleVcs = deferred<unknown>();
    let reconnecting = true;
    mocks.adapter.listProjects.mockReturnValueOnce(reconnectProjects.promise);
    mocks.adapter.listSessions.mockReset();
    mocks.adapter.listSessions.mockImplementation(
      ({ directory, signal }: { directory: string; signal?: AbortSignal }) => {
        if (reconnecting) {
          signal?.addEventListener('abort', () => staleSessions.resolve([]), { once: true });
          return staleSessions.promise;
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
          options?.signal?.addEventListener('abort', () => staleVcs.resolve({}), { once: true });
          return staleVcs.promise;
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

    expect(mocks.adapter.listSessions.mock.calls.filter(([options]) => options.directory === '/a')).toHaveLength(1);
    expect(mocks.adapter.getVcsInfo.mock.calls.filter(([directory]) => directory === '/a')).toHaveLength(1);
    expect(
      messagesOf(worker.messages, 'state.project-updated').some(
        ({ project: updated }) => Boolean(updated.sandboxes['/a']?.sessions['reconnected-session']),
      ),
    ).toBe(true);
  });
});
