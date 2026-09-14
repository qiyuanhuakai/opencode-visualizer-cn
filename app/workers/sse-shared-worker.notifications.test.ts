import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnection, SseConnectionCallbacks } from '../utils/sseConnection';
import {
  createSseWorkerTestHarness,
  type MutationSnapshotToken,
  type MutationSnapshotTracker,
  project,
  sessionInfo,
  sessionPacket,
  sessionCreatedPacket,
  permissionAskedPacket,
  questionAskedPacket,
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

describe('SSE SharedWorker notifications', () => {
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
        messagesOf(worker.messages, 'state.notifications-updated').some(({ notifications }) =>
          notifications['new-root']?.requestIds.includes('idle:project:new-root'),
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

  it('identifies a real successful busy-to-idle completion separately from idle badges', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const deliver = latestCallbacks().onPacket;
    deliver(sessionCreatedPacket('native-root', 'Native root'));
    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'native-root', status: { type: 'busy' } },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'native-result-1',
            sessionID: 'native-root',
            role: 'assistant',
            finish: 'stop',
            time: { created: 1, completed: 2 },
          },
        },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'native-root', status: { type: 'idle' } },
      },
    });
    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'notification.show')).toContainEqual({
        type: 'notification.show',
        projectId: 'project',
        sessionId: 'native-root',
        kind: 'idle',
        completionId: 'native-result-1',
      }),
    );
  });

  it('emits a successful completion for a selected root with a native notification consumer', async () => {
    const worker = await connectWorker();
    const browserWorker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    await vi.waitFor(() =>
      expect(messagesOf(browserWorker.messages, 'state.bootstrap')).toHaveLength(1),
    );
    const deliver = latestCallbacks().onPacket;
    deliver(sessionCreatedPacket('foreground-root', 'Foreground root'));
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'foreground-root',
      directory: '/a',
      nativeCompletionNotifications: true,
    });
    worker.messages.splice(0);
    browserWorker.messages.splice(0);

    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'foreground-root', status: { type: 'busy' } },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'foreground-result',
            sessionID: 'foreground-root',
            role: 'assistant',
            finish: 'stop',
            time: { created: 1, completed: 2 },
          },
        },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'foreground-root', status: { type: 'idle' } },
      },
    });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'notification.show')).toContainEqual({
        type: 'notification.show',
        projectId: 'project',
        sessionId: 'foreground-root',
        kind: 'idle',
        completionId: 'foreground-result',
      }),
    );
    expect(messagesOf(browserWorker.messages, 'notification.show')).toHaveLength(0);
    expect(messagesOf(worker.messages, 'state.notifications-updated')).toHaveLength(0);
  });

  it('keeps a selected root completion suppressed for browser-only consumers', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const deliver = latestCallbacks().onPacket;
    deliver(sessionCreatedPacket('browser-root', 'Browser root'));
    post(worker, {
      type: 'selection.active',
      projectId: 'project',
      sessionId: 'browser-root',
      directory: '/a',
    });
    worker.messages.splice(0);

    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'browser-root', status: { type: 'busy' } },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'browser-result',
            sessionID: 'browser-root',
            role: 'assistant',
            finish: 'stop',
            time: { created: 1, completed: 2 },
          },
        },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'browser-root', status: { type: 'idle' } },
      },
    });
    await flush();

    expect(messagesOf(worker.messages, 'notification.show')).toHaveLength(0);
    expect(messagesOf(worker.messages, 'state.notifications-updated')).toHaveLength(0);
  });

  it('does not identify an aborted OpenCode message as a successful native completion', async () => {
    const worker = await connectWorker();
    await vi.waitFor(() => expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(1));
    const deliver = latestCallbacks().onPacket;
    deliver(sessionCreatedPacket('aborted-root', 'Aborted root'));
    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'aborted-root', status: { type: 'busy' } },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'aborted-result',
            sessionID: 'aborted-root',
            role: 'assistant',
            error: { name: 'MessageAbortedError' },
            time: { created: 1, completed: 2 },
          },
        },
      },
    });
    deliver({
      directory: '/a',
      payload: {
        type: 'session.status',
        properties: { sessionID: 'aborted-root', status: { type: 'idle' } },
      },
    });
    await flush();
    expect(
      messagesOf(worker.messages, 'notification.show').filter(
        (message) => 'completionId' in message,
      ),
    ).toEqual([]);
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
    expect(
      messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root,
    ).toBeUndefined();
    worker.messages.splice(0);
    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.deleted',
        properties: { info: sessionInfo('child', 'Child', 'root') },
      },
    });

    await vi.waitFor(() =>
      expect(messagesOf(worker.messages, 'notification.show')).toContainEqual({
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
      expect(
        messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root,
      ).toMatchObject({ requestIds: ['permission-sibling'] }),
    );

    latestCallbacks().onPacket({
      directory: '/a',
      payload: {
        type: 'session.deleted',
        properties: { info: sessionInfo('busy-child', 'Busy child', 'root') },
      },
    });

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root,
      ).toMatchObject({ requestIds: ['permission-sibling', 'idle:project:root'] }),
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
      expect(
        messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root,
      ).toMatchObject({
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
      expect(
        messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root,
      ).toMatchObject({
        requestIds: expect.arrayContaining([
          'permission-root',
          'question-sibling',
          'permission-child',
          'question-child',
        ]),
      }),
    );

    latestCallbacks().onPacket(
      sessionPacket('session.deleted', sessionInfo('busy-child', 'Busy child', 'root')),
    );

    await vi.waitFor(() =>
      expect(
        messagesOf(worker.messages, 'state.notifications-updated').at(-1)?.notifications.root,
      ).toMatchObject({
        requestIds: expect.arrayContaining([
          'permission-root',
          'question-sibling',
          'idle:project:root',
        ]),
      }),
    );
    const requestIds = messagesOf(worker.messages, 'state.notifications-updated').at(-1)
      ?.notifications.root?.requestIds;
    expect(requestIds).not.toContain('permission-child');
    expect(requestIds).not.toContain('question-child');
  });
});
