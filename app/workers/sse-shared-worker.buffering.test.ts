import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnection, SseConnectionCallbacks } from '../utils/sseConnection';
import {
  createSseWorkerTestHarness,
  type MutationSnapshotToken,
  type MutationSnapshotTracker,
  deferred,
  project,
  sessionCreatedPacket,
  messagesOf,
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
const { connectWorker, latestCallbacks, reset, cleanup } = harness;

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

describe('SSE SharedWorker buffering', () => {
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
        messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
          Boolean(updated.sandboxes['/a']?.sessions['state-first']),
        ),
      ).toBe(true),
    );
  });

  // Overflowing the 2000-packet production cap is CPU-bound and slows down
  // sharply on contended CI runners, so this needs generous headroom.

  it(
    'schedules one authoritative bootstrap after buffered state overflows',
    { timeout: 60_000 },
    async () => {
      const projects = deferred<unknown>();
      mocks.adapter.listProjects
        .mockReturnValueOnce(projects.promise)
        .mockResolvedValueOnce([project(['/a'])]);
      const worker = await connectWorker();

      for (let index = 0; index <= 2_000; index += 1) {
        latestCallbacks().onPacket(sessionCreatedPacket(`overflow-${index}`));
      }
      projects.resolve([project(['/a'])]);

      await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2),
      );
      const secondBootstrap = messagesOf(worker.messages, 'state.bootstrap')[1];
      expect(secondBootstrap?.projects.project?.sandboxes['/a']?.sessions).toEqual({});
    },
  );

  it(
    'restarts from authoritative state after the packet count reaches its cap',
    { timeout: 60_000 },
    async () => {
      const projects = deferred<unknown>();
      mocks.adapter.listProjects
        .mockReturnValueOnce(projects.promise)
        .mockResolvedValueOnce([project(['/a'])]);
      const worker = await connectWorker();

      for (let index = 0; index <= 2_000; index += 1) {
        latestCallbacks().onPacket(sessionCreatedPacket(`buffered-${index}`));
      }
      projects.resolve([project(['/a'])]);

      await vi.waitFor(() => expect(mocks.adapter.listProjects).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(messagesOf(worker.messages, 'state.bootstrap')).toHaveLength(2),
      );
      const finalProject = messagesOf(worker.messages, 'state.bootstrap')[1]?.projects.project;
      expect(finalProject?.sandboxes['/a']?.sessions).toEqual({});
    },
  );

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
        messagesOf(worker.messages, 'state.project-updated').some(({ project: updated }) =>
          Boolean(updated.sandboxes['/a']?.sessions['large-1']),
        ),
      ).toBe(true),
    );
    const finalProject = messagesOf(worker.messages, 'state.project-updated').at(-1)?.project;
    expect(finalProject?.sandboxes['/a']?.sessions['large-0']).toBeUndefined();
    expect(finalProject?.sandboxes['/a']?.sessions['large-1']).toBeDefined();
  });
});
