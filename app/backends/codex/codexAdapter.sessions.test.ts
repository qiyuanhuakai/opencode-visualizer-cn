import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  flushPromises,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  it('lists threads after initialization', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const list = adapter.listThreads({ limit: 2 });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, {
      data: [{ id: 'thr_1', preview: 'hello' }],
      nextCursor: null,
    });

    await expect(list).resolves.toEqual({
      data: [{ id: 'thr_1', preview: 'hello' }],
      nextCursor: null,
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/list',
      params: { limit: 2 },
    });
  });

  it('lists sessions across all model providers', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const sessions = adapter.listSessions({ limit: 2, directory: '/repo', search: 'hello' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);

    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/list',
      params: {
        limit: 2,
        modelProviders: null,
        cwd: '/repo',
        searchTerm: 'hello',
      },
    });

    socket.respond(2, { data: [], nextCursor: null });
    await expect(sessions).resolves.toEqual([]);
  });

  it('loads session statuses across all model providers', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const statuses = adapter.getSessionStatusMap('/repo');
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);

    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/list',
      params: {
        cwd: '/repo',
        limit: 100,
        sortKey: 'updated_at',
        modelProviders: null,
      },
    });

    socket.respond(2, { data: [{ id: 'thr_1', status: { type: 'notLoaded' } }], nextCursor: null });
    await expect(statuses).resolves.toEqual({ thr_1: 'unknown' });
  });

  it('rejects native Codex unarchive through the shared session update surface', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const restore = adapter.updateSession('thr_1', { time: { archived: 0 } });
    const socket = MockWebSocket.instances[0];
    if (socket) {
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { thread: { id: 'thr_1' } });
    }

    await expect(restore).rejects.toThrow('Codex native unarchive is disabled');
  });

  it('reads and resumes existing threads', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const read = adapter.readThread({ threadId: 'thr_1', includeTurns: true });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_1', turns: [] } });

    await expect(read).resolves.toEqual({ thread: { id: 'thr_1', turns: [] } });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/read',
      params: { threadId: 'thr_1', includeTurns: true },
    });

    const resume = adapter.resumeThread({ threadId: 'thr_1' });
    await waitForSent(socket, 4);
    socket.respond(3, { thread: { id: 'thr_1', name: 'Named' } });

    await expect(resume).resolves.toEqual({ thread: { id: 'thr_1', name: 'Named' } });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'thread/resume',
      params: { threadId: 'thr_1' },
    });
  });

  it('exposes Codex thread lifecycle and turn control methods', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const rename = adapter.setThreadName({ threadId: 'thr_1', name: 'Renamed' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, {});

    await expect(rename).resolves.toEqual({});
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/name/set',
      params: { threadId: 'thr_1', name: 'Renamed' },
    });

    const archive = adapter.archiveThread({ threadId: 'thr_1' });
    await waitForSent(socket, 4);
    socket.respond(3, {});
    await expect(archive).resolves.toEqual({});
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'thread/archive',
      params: { threadId: 'thr_1' },
    });

    const unsubscribe = adapter.unsubscribeThread({ threadId: 'thr_1' });
    await waitForSent(socket, 5);
    socket.respond(4, {});
    await expect(unsubscribe).resolves.toEqual({});
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 4,
      method: 'thread/unsubscribe',
      params: { threadId: 'thr_1' },
    });

    const interrupt = adapter.interruptTurn({ threadId: 'thr_1', turnId: 'turn_1' });
    await waitForSent(socket, 6);
    socket.respond(5, {});
    await expect(interrupt).resolves.toEqual({});
    expect(JSON.parse(socket.sent[5] ?? '{}')).toEqual({
      id: 5,
      method: 'turn/interrupt',
      params: { threadId: 'thr_1', turnId: 'turn_1' },
    });

    const fork = adapter.forkThread({ threadId: 'thr_1' });
    await waitForSent(socket, 7);
    socket.respond(6, { thread: { id: 'thr_2', preview: '' } });
    await expect(fork).resolves.toEqual({ thread: { id: 'thr_2', preview: '' } });
    expect(JSON.parse(socket.sent[6] ?? '{}')).toEqual({
      id: 6,
      method: 'thread/fork',
      params: { threadId: 'thr_1' },
    });

    const rollback = adapter.rollbackThread({ threadId: 'thr_1', numTurns: 1 });
    await waitForSent(socket, 8);
    socket.respond(7, { thread: { id: 'thr_1', name: 'Renamed' } });
    await expect(rollback).resolves.toEqual({ thread: { id: 'thr_1', name: 'Renamed' } });
    expect(JSON.parse(socket.sent[7] ?? '{}')).toEqual({
      id: 7,
      method: 'thread/rollback',
      params: { threadId: 'thr_1', numTurns: 1 },
    });

    const readDir = adapter.readDirectory({ path: '/tmp' });
    await waitForSent(socket, 9);
    socket.respond(8, { entries: [{ name: 'file.txt', type: 'file' }] });
    await expect(readDir).resolves.toEqual({ entries: [{ name: 'file.txt', type: 'file' }] });
    expect(JSON.parse(socket.sent[8] ?? '{}')).toEqual({
      id: 8,
      method: 'fs/readDirectory',
      params: { path: '/tmp' },
    });

    const readFile = adapter.readFile({ path: '/tmp/file.txt' });
    await waitForSent(socket, 10);
    socket.respond(9, { content: 'hello' });
    await expect(readFile).resolves.toEqual({ content: 'hello' });
    expect(JSON.parse(socket.sent[9] ?? '{}')).toEqual({
      id: 9,
      method: 'fs/readFile',
      params: { path: '/tmp/file.txt' },
    });
  });

  it('maps BackendAdapter deletion to Codex native thread/archive', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const deletion = adapter.deleteSession('thread-delete');
    void deletion.catch(() => undefined);
    await flushPromises();
    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);

    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/archive',
      params: { threadId: 'thread-delete' },
    });
    socket.respond(2, {});

    await expect(deletion).resolves.toBeUndefined();
  });
});
