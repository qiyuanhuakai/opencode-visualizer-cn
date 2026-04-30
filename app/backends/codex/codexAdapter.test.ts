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

    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({ id: 42, result: 'acceptForSession' });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({ id: 'req-1', result: 'decline' });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 43,
      result: { responses: [{ questionId: 'question-a', response: 'Use this value' }] },
    });
    expect(JSON.parse(socket.sent[5] ?? '{}')).toEqual({
      id: 44,
      result: { contentItems: [{ type: 'text', text: 'Dynamic result' }] },
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
      params: { threadId: 'thr_empty' },
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

    const fork = adapter.forkThread({ threadId: 'thr_1' });
    await waitForSent(socket, 8);
    socket.respond(7, { thread: { id: 'thr_2', preview: '' } });
    await expect(fork).resolves.toEqual({ thread: { id: 'thr_2', preview: '' } });
    expect(JSON.parse(socket.sent[7] ?? '{}')).toEqual({
      id: 7,
      method: 'thread/fork',
      params: { threadId: 'thr_1' },
    });

    const rollback = adapter.rollbackThread({ threadId: 'thr_1', numTurns: 1 });
    await waitForSent(socket, 9);
    socket.respond(8, { thread: { id: 'thr_1', name: 'Renamed' } });
    await expect(rollback).resolves.toEqual({ thread: { id: 'thr_1', name: 'Renamed' } });
    expect(JSON.parse(socket.sent[8] ?? '{}')).toEqual({
      id: 8,
      method: 'thread/rollback',
      params: { threadId: 'thr_1', numTurns: 1 },
    });

    const readDir = adapter.readDirectory({ path: '/tmp' });
    await waitForSent(socket, 10);
    socket.respond(9, { entries: [{ name: 'file.txt', type: 'file' }] });
    await expect(readDir).resolves.toEqual({ entries: [{ name: 'file.txt', type: 'file' }] });
    expect(JSON.parse(socket.sent[9] ?? '{}')).toEqual({
      id: 9,
      method: 'fs/readDirectory',
      params: { path: '/tmp' },
    });

    const readFile = adapter.readFile({ path: '/tmp/file.txt' });
    await waitForSent(socket, 11);
    socket.respond(10, { content: 'hello' });
    await expect(readFile).resolves.toEqual({ content: 'hello' });
    expect(JSON.parse(socket.sent[10] ?? '{}')).toEqual({
      id: 10,
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
      status: 'idle',
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
      status: 'idle',
    });

    const revertSession = adapter.revertSession('thr_1', 'msg_1');
    await waitForSent(socket, 5);
    socket.respond(4, { thread: { id: 'thr_1', cwd: '/repo' } });
    await expect(revertSession).resolves.toMatchObject({
      id: 'thr_1',
      projectID: 'codex',
      directory: '/repo',
      status: 'idle',
    });
    expect(JSON.parse(socket.sent[4] ?? '{}')).toEqual({
      id: 4,
      method: 'thread/rollback',
      params: { threadId: 'thr_1', numTurns: 1 },
    });

    await expect(adapter.deleteSession('thr_1')).rejects.toThrow(
      'Codex does not support deleteSession; hide the thread locally or archive it instead.',
    );

    const listFiles = adapter.listFiles;
    await expect(listFiles({ directory: '/repo', path: '../secret' })).rejects.toThrow(
      'Codex file paths cannot contain parent-directory segments.',
    );
    await expect(adapter.readFileContent({ directory: '/repo', path: '/etc/passwd' })).rejects.toThrow(
      'Codex file path is outside the active directory.',
    );
    const readFileContent = adapter.readFileContent({ directory: '/repo', path: 'README.md' });
    await waitForSent(socket, 6);
    socket.respond(5, { dataBase64: 'aGVsbG8=' });
    await expect(readFileContent).resolves.toEqual({ content: 'hello', encoding: 'utf-8', type: 'text' });

    const readPlainContent = adapter.readFileContent({ directory: '/repo', path: 'plain.txt' });
    await waitForSent(socket, 7);
    socket.respond(6, { content: 'plain text' });
    await expect(readPlainContent).resolves.toEqual({ content: 'plain text', encoding: 'utf-8', type: 'text' });
    const getLspStatus = adapter.getLspStatus;
    await expect(getLspStatus()).resolves.toEqual([]);
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
                attachment: false,
                reasoning: false,
                toolcall: true,
              },
            },
          },
        },
      ],
      connected: ['codex'],
      default: { codex: 'gpt-5.5-codex' },
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
 });
});
