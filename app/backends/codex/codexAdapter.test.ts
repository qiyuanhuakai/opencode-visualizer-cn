import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';

type ListenerMap = {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  error: Array<() => void>;
  close: Array<(event: { reason?: string }) => void>;
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners: ListenerMap = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener<T extends keyof ListenerMap>(type: T, listener: ListenerMap[T][number]) {
    this.listeners[type].push(listener as never);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    for (const listener of this.listeners.close) listener({});
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners.open) listener();
  }

  emitMessage(data: unknown) {
    for (const listener of this.listeners.message) listener({ data });
  }

  respond(id: number, result: unknown) {
    this.emitMessage(JSON.stringify({ id, result }));
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForSent(socket: MockWebSocket, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (socket.sent.length >= count) return;
    await flushPromises();
  }
  throw new Error(`Expected ${count} sent messages, received ${socket.sent.length}.`);
}

describe('CodexAdapter', () => {
  it('initializes with client metadata and sends initialized notification', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
      clientInfo: { name: 'vis_test', title: 'Vis Test', version: '0.0.0' },
    });

    const initialized = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);

    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'vis_test', title: 'Vis Test', version: '0.0.0' },
        capabilities: { experimentalApi: false },
      },
    });

    socket.respond(1, { userAgent: 'codex-test' });
    await expect(initialized).resolves.toEqual({ userAgent: 'codex-test' });
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({ method: 'initialized', params: {} });
  });

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

  it('starts a new thread and turn for simple prompts', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({ text: 'Summarize this repo.', cwd: '/repo', model: 'gpt-5.4' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_1', preview: '' } });
    await waitForSent(socket, 4);
    socket.respond(3, { turn: { id: 'turn_1', status: 'inProgress', items: [], error: null } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_1',
      thread: { id: 'thr_1', preview: '' },
      turn: { id: 'turn_1', status: 'inProgress', items: [], error: null },
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/start',
      params: { model: 'gpt-5.4', cwd: '/repo' },
    });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_1',
        input: [{ type: 'text', text: 'Summarize this repo.' }],
        cwd: '/repo',
        model: 'gpt-5.4',
      },
    });
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

  it('resumes an existing thread before starting a prompt turn', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({ threadId: 'thr_1', text: 'Continue.' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_1' } });
    await waitForSent(socket, 4);
    socket.respond(3, { turn: { id: 'turn_2', status: 'inProgress' } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_1',
      thread: undefined,
      turn: { id: 'turn_2', status: 'inProgress' },
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/resume',
      params: { threadId: 'thr_1' },
    });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_1',
        input: [{ type: 'text', text: 'Continue.' }],
      },
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

    const unarchive = adapter.unarchiveThread({ threadId: 'thr_1' });
    await waitForSent(socket, 5);
    socket.respond(4, { thread: { id: 'thr_1', name: 'Renamed' } });
    await expect(unarchive).resolves.toEqual({ thread: { id: 'thr_1', name: 'Renamed' } });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 4,
      method: 'thread/unarchive',
      params: { threadId: 'thr_1' },
    });

    const unsubscribe = adapter.unsubscribeThread({ threadId: 'thr_1' });
    await waitForSent(socket, 6);
    socket.respond(5, {});
    await expect(unsubscribe).resolves.toEqual({});
    expect(JSON.parse(socket.sent[5] ?? '{}')).toEqual({
      id: 5,
      method: 'thread/unsubscribe',
      params: { threadId: 'thr_1' },
    });

    const interrupt = adapter.interruptTurn({ threadId: 'thr_1', turnId: 'turn_1' });
    await waitForSent(socket, 7);
    socket.respond(6, {});
    await expect(interrupt).resolves.toEqual({});
    expect(JSON.parse(socket.sent[6] ?? '{}')).toEqual({
      id: 6,
      method: 'turn/interrupt',
      params: { threadId: 'thr_1', turnId: 'turn_1' },
    });
  });
});
