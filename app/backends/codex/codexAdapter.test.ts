import { describe, expect, it, vi } from 'vitest';
import {
  createCodexAdapter,
  extractStatusType,
  getCodexWeeklyRateLimitWindow,
  normalizeCodexMcpServerInfo,
  normalizeCodexStatus,
} from './codexAdapter';

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

  reject(id: number, message: string, code = -32000) {
    this.emitMessage(JSON.stringify({ id, error: { code, message } }));
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
  it('selects only the weekly rate-limit window when a removed short window is still present', () => {
    const weekly = {
      usedPercent: 42,
      windowDurationMins: 10_080,
      resetsAt: 1_730_947_200,
    };

    expect(getCodexWeeklyRateLimitWindow({
      limitId: 'codex',
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1_730_900_000,
      },
      secondary: weekly,
    })).toEqual(weekly);
  });

  it('does not label a longer rate-limit window as weekly', () => {
    const weekly = {
      usedPercent: 42,
      windowDurationMins: 10_080,
      resetsAt: 1_730_947_200,
    };

    expect(getCodexWeeklyRateLimitWindow({
      limitId: 'codex',
      primary: {
        usedPercent: 7,
        windowDurationMins: 43_200,
        resetsAt: 1_733_539_200,
      },
      secondary: weekly,
    })).toEqual(weekly);
  });

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

    const initializeResult = {
      userAgent: 'vis/0.145.0 (Linux 6.6; x86_64) codex_cli_rs/0.145.0 (vis_test; 0.0.0)',
    };
    socket.respond(1, initializeResult);
    await expect(initialized).resolves.toEqual(initializeResult);
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({ method: 'initialized', params: {} });
    await expect(adapter.getGlobalHealth()).resolves.toEqual({ healthy: true, version: '0.145.0' });
  });

  it('treats an already-initialized transport as initialized', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const initialized = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.emitMessage(JSON.stringify({
      id: 1,
      error: { code: -32600, message: 'Already initialized' },
    }));
    await expect(initialized).resolves.toEqual({});

    const list = adapter.listThreads({ limit: 1 });
    await waitForSent(socket, 2);
    socket.respond(2, { data: [], nextCursor: null });
    await expect(list).resolves.toEqual({ data: [], nextCursor: null });
  });

  it('advertises bridge-backed interactive PTY terminal support', () => {
    const adapter = createCodexAdapter({ url: 'ws://localhost:4500' });
    expect(adapter.capabilities.terminal).toBe(true);
    expect(adapter.createPtyWebSocketUrl('/pty/abc/connect', { directory: '/repo' })).toBe(
      'ws://localhost:4500/pty/abc/connect?directory=%2Frepo',
    );
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

  it('forwards collaborationMode to turn/start when supplied via sendPrompt', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({
      threadId: 'thr_collab',
      text: 'Plan this refactor.',
      model: 'gpt-5.5',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.5', developer_instructions: null },
      },
    });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_collab' } });
    await waitForSent(socket, 4);
    socket.respond(3, { turn: { id: 'turn_collab', status: 'inProgress' } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_collab',
      thread: undefined,
      turn: { id: 'turn_collab', status: 'inProgress' },
    });
    const sentParams = (JSON.parse(socket.sent[3] ?? '{}') as { params?: Record<string, unknown> }).params;
    expect(sentParams).toMatchObject({
      threadId: 'thr_collab',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.5', developer_instructions: null },
      },
    });
  });

  it('does NOT include collaborationMode key when not supplied to sendPrompt', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({
      threadId: 'thr_nomode',
      text: 'No collaboration mode here.',
    });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_nomode' } });
    await waitForSent(socket, 4);
    socket.respond(3, { turn: { id: 'turn_nomode', status: 'inProgress' } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_nomode',
      thread: undefined,
      turn: { id: 'turn_nomode', status: 'inProgress' },
    });
    const sentParams = (JSON.parse(socket.sent[3] ?? '{}') as { params?: Record<string, unknown> }).params;
    expect(sentParams).not.toHaveProperty('collaborationMode');
  });

  it('passes image input items to turn/start', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({
      text: 'Review this image.',
      cwd: '/repo',
      input: [
        { type: 'text', text: 'Review this image.' },
        { type: 'image', url: 'data:image/png;base64,AA==' },
      ],
    });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_image', preview: '' } });
    await waitForSent(socket, 4);
    socket.respond(3, { turn: { id: 'turn_image', status: 'inProgress', items: [], error: null } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_image',
      thread: { id: 'thr_image', preview: '' },
      turn: { id: 'turn_image', status: 'inProgress', items: [], error: null },
    });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_image',
        input: [
          { type: 'text', text: 'Review this image.' },
          { type: 'image', url: 'data:image/png;base64,AA==' },
        ],
        cwd: '/repo',
      },
    });
  });

  it('writes Codex config patches through batchWriteConfig', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const update = adapter.updateGlobalConfig({
      model_provider: 'proxy',
      'model_providers.proxy': { name: 'Proxy', base_url: 'https://proxy.example.com/v1', wire_api: 'responses' },
    });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'config/batchWrite',
      params: {
        edits: [
          { keyPath: 'model_provider', value: 'proxy', mergeStrategy: 'replace' },
          {
            keyPath: 'model_providers.proxy',
            value: { name: 'Proxy', base_url: 'https://proxy.example.com/v1', wire_api: 'responses' },
            mergeStrategy: 'replace',
          },
        ],
      },
    });
    socket.respond(2, {});
    await waitForSent(socket, 4);
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({ id: 3, method: 'config/read', params: {} });
    socket.respond(3, { config: { model_provider: 'proxy' } });

    await expect(update).resolves.toEqual({ model_provider: 'proxy' });
  });

  it('keeps global config methods bound for shared provider UI destructuring', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const updateGlobalConfig = adapter.updateGlobalConfig;
    const update = updateGlobalConfig({ model_provider: 'proxy' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'config/batchWrite',
      params: { edits: [{ keyPath: 'model_provider', value: 'proxy', mergeStrategy: 'replace' }] },
    });
    socket.respond(2, {});
    await waitForSent(socket, 4);
    socket.respond(3, { config: { model_provider: 'proxy' } });

    await expect(update).resolves.toEqual({ model_provider: 'proxy' });
  });

  it('translates shared permission and question replies into Codex server responses', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const initialized = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await expect(initialized).resolves.toEqual({});

    await adapter.replyPermission('codex:42', { reply: 'always' });
    await adapter.replyPermission('codex:"req-1"', { reply: 'reject' });
    await adapter.replyQuestion(
      'codex-tool:{"id":43,"questionIds":["question-a"]}',
      { answers: [['Use this value']] },
    );
    await adapter.replyQuestion('codex-dynamic:44', { answers: [['Dynamic result']] });
    await adapter.rejectQuestion('codex-tool:{"id":45,"questionIds":["question-b"]}');
    await adapter.rejectQuestion('codex-dynamic:46');

    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({ id: 42, result: { decision: 'acceptForSession' } });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({ id: 'req-1', result: { decision: 'decline' } });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 43,
      result: { answers: { 'question-a': { answers: ['Use this value'] } } },
    });
    expect(JSON.parse(socket.sent[5] ?? '{}')).toEqual({
      id: 44,
      result: {
        contentItems: [{ type: 'inputText', text: 'Dynamic result' }],
        success: true,
      },
    });
    expect(JSON.parse(socket.sent[6] ?? '{}')).toEqual({ id: 45, result: { answers: {} } });
    expect(JSON.parse(socket.sent[7] ?? '{}')).toEqual({
      id: 46,
      result: { contentItems: [], success: false },
    });
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

  it('passes cwd when resuming an existing thread and starting a prompt turn', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({ threadId: 'thr_1', text: 'Continue here.', cwd: '/repo' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_1', cwd: '/repo' } });
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
      params: { threadId: 'thr_1', cwd: '/repo' },
    });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_1',
        input: [{ type: 'text', text: 'Continue here.' }],
        cwd: '/repo',
      },
    });
  });

  it('replaces an empty no-rollout thread when sending a prompt', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({ threadId: 'thr_empty', text: 'Start now.', cwd: '/repo', model: 'gpt-5.4' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.reject(2, 'no rollout found for thread id thr_empty');
    await waitForSent(socket, 4);
    socket.respond(3, { thread: { id: 'thr_recovered', cwd: '/repo', preview: '' } });
    await waitForSent(socket, 5);
    socket.respond(4, { turn: { id: 'turn_3', status: 'inProgress' } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_recovered',
      thread: { id: 'thr_recovered', cwd: '/repo', preview: '' },
      turn: { id: 'turn_3', status: 'inProgress' },
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/resume',
      params: { threadId: 'thr_empty', model: 'gpt-5.4', cwd: '/repo' },
    });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'thread/start',
      params: { model: 'gpt-5.4', cwd: '/repo' },
    });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 4,
      method: 'turn/start',
      params: {
        threadId: 'thr_recovered',
        input: [{ type: 'text', text: 'Start now.' }],
        cwd: '/repo',
        model: 'gpt-5.4',
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

  it('exposes BackendAdapter wrapper methods', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const createSession = adapter.createSession('/repo');
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_new', preview: '', cwd: '/repo' } });
    await expect(createSession).resolves.toMatchObject({
      id: 'thr_new',
      projectID: 'codex',
      directory: '/repo',
      status: 'unknown',
    });
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'thread/start',
      params: { cwd: '/repo' },
    });

    const forkSession = adapter.forkSession('thr_1', 'msg_1', '/repo');
    await waitForSent(socket, 4);
    socket.respond(3, { thread: { id: 'thr_fork', preview: '', cwd: '/repo' } });
    await expect(forkSession).resolves.toMatchObject({
      id: 'thr_fork',
      projectID: 'codex',
      directory: '/repo',
      status: 'unknown',
    });

    const revertSession = adapter.revertSession('thr_1', 'msg_1');
    await waitForSent(socket, 5);
    socket.respond(4, { thread: { id: 'thr_1', cwd: '/repo' } });
    await expect(revertSession).resolves.toMatchObject({
      id: 'thr_1',
      projectID: 'codex',
      directory: '/repo',
      status: 'unknown',
    });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 4,
      method: 'thread/rollback',
      params: { threadId: 'thr_1', numTurns: 1 },
    });

    const deleteSession = adapter.deleteSession('thr_1');
    await waitForSent(socket, 6);
    expect(JSON.parse(socket.sent[5] ?? '{}')).toEqual({
      id: 5,
      method: 'thread/archive',
      params: { threadId: 'thr_1' },
    });
    socket.respond(5, {});
    await expect(deleteSession).resolves.toBeUndefined();

    const listFiles = adapter.listFiles;
    await expect(listFiles({ directory: '/repo', path: '../secret' })).rejects.toThrow(
      'Codex file paths cannot contain parent-directory segments.',
    );
    await expect(adapter.readFileContent({ directory: '/repo', path: '/etc/passwd' })).rejects.toThrow(
      'Codex file path is outside the active directory.',
    );
    const readFileContent = adapter.readFileContent({ directory: '/repo', path: 'README.md' });
    await waitForSent(socket, 7);
    socket.respond(6, { dataBase64: 'aGVsbG8=' });
    await expect(readFileContent).resolves.toEqual({ content: 'hello', encoding: 'utf-8', type: 'text' });

    const readPlainContent = adapter.readFileContent({ directory: '/repo', path: 'plain.txt' });
    await waitForSent(socket, 8);
    socket.respond(7, { content: 'plain text' });
    await expect(readPlainContent).resolves.toEqual({ content: 'plain text', encoding: 'utf-8', type: 'text' });
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(adapter.writeFileContent({ directory: '/repo', path: 'README.md', content: 'updated' })).resolves.toEqual({});
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toEqual([
      {
        input: 'http://localhost:4500/fs/writeFile',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/repo/README.md', root: '/repo', content: 'updated' }),
        },
      },
    ]);
    const getLspStatus = adapter.getLspStatus;
    await expect(getLspStatus()).resolves.toEqual([]);
  });

  it('allows listFiles under root "/" for subdirectory paths', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const result = adapter.listFiles({ directory: '/', path: 'subdir' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { entries: [{ fileName: 'index.ts', isDirectory: false }] });

    await expect(result).resolves.toEqual([
      { name: 'index.ts', path: 'subdir/index.ts', type: 'file' },
    ]);
  });

  it('maps Codex models to provider options for the shared UI', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const listProviders = adapter.listProviders;
    const providers = listProviders();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, {
      data: [
        {
          id: 'gpt-5.5-codex',
          model: 'gpt-5.5-codex',
          displayName: 'GPT-5.5 Codex',
          isDefault: true,
          inputModalities: ['text', 'image'],
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' },
          ],
        },
        { id: 'hidden-model', model: 'hidden-model', displayName: 'Hidden', hidden: true },
      ],
      nextCursor: null,
    });
    await waitForSent(socket, 4);
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({ id: 3, method: 'config/read', params: { includeLayers: true } });
    socket.respond(3, {
      config: {
        model_provider: 'proxy',
        model: 'proxy-model',
        model_providers: {
          proxy: { name: 'Proxy', base_url: 'https://proxy.example.com/v1', wire_api: 'responses' },
          omniroute: { name: 'omniroute', base_url: 'http://localhost:20128/v1', wire_api: 'responses', env_key: 'OPENAI_API_KEY' },
        },
        vis: {
          model_providers: {
            proxy: { models: { 'proxy-model': { name: 'Proxy Model' } } },
          },
        },
      },
      layers: [
        {
          source: 'config.toml',
          config: {
            vis: {
              model_providers: {
                omniroute: { models: { 'mimo/mimo-v2.5': { name: 'mimo-v2.5' } } },
              },
            },
          },
        },
      ],
    });

    await expect(providers).resolves.toEqual({
      all: [
        {
          id: 'codex',
          name: 'Codex',
          source: 'codex-app-server',
          models: {
            'gpt-5.5-codex': {
              id: 'gpt-5.5-codex',
              name: 'GPT-5.5 Codex',
              providerID: 'codex',
              status: 'connected',
              variants: {
                low: { description: 'Fast' },
                high: { description: 'Deep' },
              },
              capabilities: {
                attachment: true,
                reasoning: true,
                toolcall: true,
              },
            },
            'hidden-model': {
              id: 'hidden-model',
              name: 'Hidden',
              providerID: 'codex',
              status: 'connected',
              variants: {},
              capabilities: {
                attachment: true,
                reasoning: false,
                toolcall: true,
              },
            },
          },
        },
        {
          id: 'proxy',
          name: 'Proxy',
          source: 'config',
          models: {
            'proxy-model': {
              id: 'proxy-model',
              name: 'Proxy Model',
              providerID: 'proxy',
              status: 'connected',
              variants: {},
              capabilities: {
                attachment: true,
                reasoning: true,
                toolcall: true,
              },
            },
          },
        },
        {
          id: 'omniroute',
          name: 'omniroute',
          source: 'config',
          models: {
            'mimo/mimo-v2.5': {
              id: 'mimo/mimo-v2.5',
              name: 'mimo-v2.5',
              providerID: 'omniroute',
              status: 'connected',
              variants: {},
              capabilities: {
                attachment: true,
                reasoning: true,
                toolcall: true,
              },
            },
          },
        },
      ],
      connected: ['codex', 'proxy', 'omniroute'],
      default: { codex: 'gpt-5.5-codex', proxy: 'proxy-model' },
    });
    await expect(adapter.listProviderAuthMethods()).resolves.toEqual({ codex: [] });
  });

 describe('CodexAdapter extended APIs', () => {
   it('starts a review for a thread', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const review = adapter.reviewStart({
       threadId: 'thr_1',
       delivery: 'inline',
       target: { type: 'uncommittedChanges' },
     });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {
       turn: { id: 'turn_review', status: 'inProgress' },
       reviewThreadId: 'thr_1',
     });

     await expect(review).resolves.toEqual({
       turn: { id: 'turn_review', status: 'inProgress' },
       reviewThreadId: 'thr_1',
     });
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'review/start',
       params: {
         threadId: 'thr_1',
         delivery: 'inline',
         target: { type: 'uncommittedChanges' },
       },
     });
   });

   it('executes a standalone command', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const command = adapter.commandExec({
       command: ['ls', '-la'],
       cwd: '/tmp',
     });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {
       exitCode: 0,
       stdout: 'file1\nfile2',
       stderr: '',
     });

     await expect(command).resolves.toEqual({
       exitCode: 0,
       stdout: 'file1\nfile2',
       stderr: '',
     });
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'command/exec',
       params: { command: ['ls', '-la'], cwd: '/tmp' },
     });
   });

   it('reads account info', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const account = adapter.readAccount({ refreshToken: false });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {
       account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
       requiresOpenaiAuth: true,
     });

     await expect(account).resolves.toEqual({
       account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
       requiresOpenaiAuth: true,
     });
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'account/read',
       params: { refreshToken: false },
     });
   });

   it('starts account login with API key', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const login = adapter.startAccountLogin({
       type: 'apiKey',
       apiKey: 'sk-test123',
     });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, { type: 'apiKey' });

     await expect(login).resolves.toEqual({ type: 'apiKey' });
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'account/login/start',
       params: { type: 'apiKey', apiKey: 'sk-test123' },
     });
   });

   it('starts account login with ChatGPT browser flow', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const login = adapter.startAccountLogin({ type: 'chatgpt' });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {
       type: 'chatgpt',
       loginId: 'login-123',
       authUrl: 'https://chatgpt.com/auth?...',
     });

     await expect(login).resolves.toEqual({
       type: 'chatgpt',
       loginId: 'login-123',
       authUrl: 'https://chatgpt.com/auth?...',
     });
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'account/login/start',
       params: { type: 'chatgpt' },
     });
   });

   it('starts account login with device code', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const login = adapter.startAccountLogin({
       type: 'chatgptDeviceCode',
     });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {
       type: 'chatgptDeviceCode',
       loginId: 'login-456',
       verificationUrl: 'https://auth.openai.com/codex/device',
       userCode: 'ABCD-1234',
     });

     await expect(login).resolves.toEqual({
       type: 'chatgptDeviceCode',
       loginId: 'login-456',
       verificationUrl: 'https://auth.openai.com/codex/device',
       userCode: 'ABCD-1234',
     });
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'account/login/start',
       params: { type: 'chatgptDeviceCode' },
     });
   });

   it('cancels a pending login', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const cancel = adapter.cancelAccountLogin({ loginId: 'login-123' });
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {});

     await expect(cancel).resolves.toEqual({});
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'account/login/cancel',
       params: { loginId: 'login-123' },
     });
   });

   it('logs out', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const logout = adapter.logoutAccount();
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {});

     await expect(logout).resolves.toEqual({});
     expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
       id: 2,
       method: 'account/logout',
       params: {},
     });
   });

    it('reads account rate limits', async () => {
     MockWebSocket.instances = [];
     const adapter = createCodexAdapter({
       url: 'ws://localhost:4500',
       webSocketCtor: MockWebSocket,
     });

     const rateLimits = adapter.readAccountRateLimits();
     const socket = MockWebSocket.instances[0]!;
     socket.emitOpen();
     await waitForSent(socket, 1);
     socket.respond(1, {});
     await waitForSent(socket, 3);
     socket.respond(2, {
       rateLimits: {
         limitId: 'codex',
         primary: {
           usedPercent: 25,
           windowDurationMins: 15,
           resetsAt: 1730947200,
         },
         secondary: null,
         rateLimitReachedType: null,
       },
     });

     await expect(rateLimits).resolves.toEqual({
       rateLimits: {
         limitId: 'codex',
         primary: {
           usedPercent: 25,
           windowDurationMins: 15,
           resetsAt: 1730947200,
         },
         secondary: null,
         rateLimitReachedType: null,
       },
     });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'account/rateLimits/read',
        params: {},
      });
    });

    it('uses current wire methods for goals, usage, provider capabilities, and permission profiles', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const goal = adapter.getThreadGoal({ threadId: 'thread-1' });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { goal: null });
      await expect(goal).resolves.toEqual({ goal: null });

      const usage = adapter.readAccountUsage();
      await waitForSent(socket, 4);
      socket.respond(3, { summary: { lifetimeTokens: 12 }, dailyUsageBuckets: [] });
      await usage;

      const providerCapabilities = adapter.readModelProviderCapabilities();
      await waitForSent(socket, 5);
      socket.respond(4, { namespaceTools: true, imageGeneration: false, webSearch: true });
      await providerCapabilities;

      const profiles = adapter.listPermissionProfiles({ cwd: '/workspace' });
      await waitForSent(socket, 6);
      socket.respond(5, { data: [{ id: 'default', description: null }], nextCursor: null });
      await profiles;

      expect(socket.sent.slice(2).map((message) => JSON.parse(message))).toEqual([
        { id: 2, method: 'thread/goal/get', params: { threadId: 'thread-1' } },
        { id: 3, method: 'account/usage/read', params: {} },
        { id: 4, method: 'modelProvider/capabilities/read', params: {} },
        { id: 5, method: 'permissionProfile/list', params: { cwd: '/workspace' } },
      ]);
    });
  });

  describe('updateSkill', () => {
    it('sends skills/config/write with the supplied path and enabled flag', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const update = adapter.updateSkill({
        path: '/Users/me/.codex/skills/skill-creator/SKILL.md',
        enabled: false,
      });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {});

      await expect(update).resolves.toEqual({
        path: '/Users/me/.codex/skills/skill-creator/SKILL.md',
        enabled: false,
      });
      expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
        id: 2,
        method: 'skills/config/write',
        params: {
          path: '/Users/me/.codex/skills/skill-creator/SKILL.md',
          enabled: false,
        },
      });
    });

    it('throws when path is missing (Codex keys the write by path)', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      await expect(
        adapter.updateSkill({ path: '', enabled: true })
      ).rejects.toThrow(/path/);
    });
  });

  describe('getMcpStatus', () => {
    it('normalizes the current MCP wire inventory for the manager UI', () => {
      expect(
        normalizeCodexMcpServerInfo({
          name: 'officecli',
          serverInfo: { name: 'officecli', version: '1.0.0' },
          tools: { convert_to_pdf: { name: 'convert_to_pdf', description: 'Convert a file.' } },
          resources: [{ name: 'templates', description: 'Office templates' }],
          resourceTemplates: [],
          authStatus: 'unsupported',
        }),
      ).toEqual({
        name: 'officecli',
        status: 'connected',
        tools: [{ name: 'convert_to_pdf', description: 'Convert a file.' }],
        resources: [{ name: 'templates', description: 'Office templates' }],
        auth: { type: 'none', status: 'completed' },
      });
    });

    it('normalizes notLoggedIn as an OAuth action requirement', () => {
      expect(
        normalizeCodexMcpServerInfo({
          name: 'remote',
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'notLoggedIn',
        }),
      ).toEqual({
        name: 'remote',
        status: 'needs_auth',
        tools: [],
        resources: [],
        auth: { type: 'oauth', status: 'required' },
      });
    });

    async function expectMcpListStatus(
      entry: Record<string, unknown>,
      expected: 'connected' | 'configured' | 'needs_auth',
    ) {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const status = adapter.getMcpStatus();
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { config: {} });
      await waitForSent(socket, 4);
      socket.respond(3, { data: [{ name: 'server-a', ...entry }], nextCursor: null });

      const result = await status;
      expect(result['server-a']?.status).toBe(expected);
    }

    it('maps the current inventory wire shape to connected', async () => {
      await expectMcpListStatus(
        {
          serverInfo: { name: 'officecli', version: '1.0.0' },
          tools: { convert_to_pdf: { name: 'convert_to_pdf' } },
          resources: [],
          resourceTemplates: [],
          authStatus: 'unsupported',
        },
        'connected',
      );
    });

    it('maps notLoggedIn auth status to needs_auth', async () => {
      await expectMcpListStatus(
        {
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'notLoggedIn',
        },
        'needs_auth',
      );
    });

    it('keeps an inventory entry without connection evidence as configured', async () => {
      await expectMcpListStatus(
        {
          serverInfo: null,
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'unsupported',
        },
        'configured',
      );
    });

    it('falls back to configured MCP entries when the supported status call does not terminate', async () => {
      vi.useFakeTimers();
      try {
        MockWebSocket.instances = [];
        const adapter = createCodexAdapter({
          url: 'ws://localhost:4500',
          webSocketCtor: MockWebSocket,
          mcpStatusTimeoutMs: 20,
        });

        const status = adapter.getMcpStatus();
        const socket = MockWebSocket.instances[0]!;
        socket.emitOpen();
        await waitForSent(socket, 1);
        socket.respond(1, {});
        await waitForSent(socket, 3);
        expect(JSON.parse(socket.sent[2] ?? '{}')).toMatchObject({
          method: 'config/read',
        });
        socket.respond(2, {
          config: {
            mcp_servers: {
              officecli: { command: 'officecli', args: ['mcp'], enabled: true },
            },
          },
        });
        await waitForSent(socket, 4);
        expect(JSON.parse(socket.sent[3] ?? '{}')).toMatchObject({
          method: 'mcpServerStatus/list',
          params: { detail: 'toolsAndAuthOnly' },
        });

        await vi.advanceTimersByTimeAsync(20);

        await expect(status).resolves.toEqual({
          officecli: { status: 'configured' },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves method-not-found so the UI can render MCP as unsupported', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const status = adapter.getMcpStatus();
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { config: {} });
      await waitForSent(socket, 4);
      socket.reject(3, 'Method not found', -32601);

      await expect(status).rejects.toMatchObject({ code: -32601 });
    });
  });

  it('normalizes the current plugin/list wire fields at the adapter boundary', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({ url: 'ws://localhost:4500', webSocketCtor: MockWebSocket });
    const plugins = adapter.listPlugins();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 2);
    socket.respond(2, {
      marketplaces: [{ name: 'sisyphuslabs', path: '/home/test/.codex/plugins/cache/sisyphuslabs/marketplace.json', interface: null, plugins: [
        { id: 'omo@sisyphuslabs', remotePluginId: null, version: null, localVersion: '4.19.1', name: 'omo', source: { type: 'local', path: '/home/test/.codex/plugins/omo/4.19.1' }, installed: true, enabled: true, availability: 'AVAILABLE', interface: { displayName: 'OMO', shortDescription: 'Unified local Codex components', logoUrl: 'https://example.test/omo.png' }, keywords: ['codex', 'mcp'] },
        { id: 'admin-disabled@sisyphuslabs', name: 'admin-disabled', source: { type: 'remote' }, installed: true, enabled: true, availability: 'DISABLED_BY_ADMIN', interface: { shortDescription: 'Disabled by policy' }, keywords: [] },
      ] }, { name: 'openai-curated-remote', path: null, interface: null, plugins: [] }],
      marketplaceLoadErrors: [{ marketplaceName: 'broken-marketplace', error: 'unavailable' }], featuredPluginIds: ['omo@sisyphuslabs'],
    });
    await expect(plugins).resolves.toEqual({
      marketplaces: [{ name: 'sisyphuslabs', path: '/home/test/.codex/plugins/cache/sisyphuslabs/marketplace.json', plugins: [
        expect.objectContaining({ id: 'omo@sisyphuslabs', name: 'omo', description: 'Unified local Codex components', logoUrl: 'https://example.test/omo.png', isAccessible: true, isEnabled: true, state: 'installed' }),
        expect.objectContaining({ id: 'admin-disabled@sisyphuslabs', isAccessible: false, isEnabled: false, state: 'installed' }),
      ] }, { name: 'openai-curated-remote', path: null, plugins: [] }],
      errors: [{ marketplaceName: 'broken-marketplace', error: 'unavailable' }], featured: ['omo@sisyphuslabs'],
    });
  });

  it('writes MCP config under the live mcp_servers key', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({ url: 'ws://localhost:4500', webSocketCtor: MockWebSocket });
    const update = adapter.updateMcp({ name: 'officecli', config: { command: 'officecli', enabled: false } });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({ id: 2, method: 'config/value/write', params: { keyPath: 'mcp_servers.officecli', value: { command: 'officecli', enabled: false }, mergeStrategy: 'replace' } });
    socket.respond(2, {});
    await waitForSent(socket, 4);
    socket.respond(3, {});
    await expect(update).resolves.toEqual({});
  });

  describe('normalizeCodexStatus / extractStatusType', () => {
    it('extracts the type field from a structured codex status object', () => {
      expect(extractStatusType({ type: 'notLoaded' })).toBe('notLoaded');
      expect(extractStatusType({ type: 'active', activeFlags: ['some'] })).toBe('active');
      expect(extractStatusType({ type: 'systemError' })).toBe('systemError');
    });

    it('returns the value directly when status is a plain string', () => {
      expect(extractStatusType('running')).toBe('running');
      expect(extractStatusType('idle')).toBe('idle');
    });

    it('returns undefined for missing or invalid status values', () => {
      expect(extractStatusType(undefined)).toBeUndefined();
      expect(extractStatusType(null)).toBeUndefined();
      expect(extractStatusType({})).toBeUndefined();
      expect(extractStatusType({ type: 123 })).toBeUndefined();
    });

    it('maps structured codex "active" status (with activeFlags) to "busy"', () => {
      expect(
        normalizeCodexStatus({ type: 'active', activeFlags: ['streaming', 'awaitingApproval'] }),
      ).toBe('busy');
    });

    it('maps structured codex "systemError" status to "retry"', () => {
      expect(normalizeCodexStatus({ type: 'systemError' })).toBe('retry');
    });

    it('maps structured codex "notLoaded" / "idle" status to "unknown" (gray hollow, matches opencode)', () => {
      expect(normalizeCodexStatus({ type: 'notLoaded' })).toBe('unknown');
      expect(normalizeCodexStatus({ type: 'idle' })).toBe('unknown');
    });

    it('maps unknown / missing status values to "unknown"', () => {
      expect(normalizeCodexStatus(undefined)).toBe('unknown');
      expect(normalizeCodexStatus(null)).toBe('unknown');
      expect(normalizeCodexStatus({})).toBe('unknown');
    });

    it('preserves string aliases for busy / retry (opencode-shaped payloads)', () => {
      expect(normalizeCodexStatus('running')).toBe('busy');
      expect(normalizeCodexStatus('inProgress')).toBe('busy');
      expect(normalizeCodexStatus('busy')).toBe('busy');
      expect(normalizeCodexStatus('retry')).toBe('retry');
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
