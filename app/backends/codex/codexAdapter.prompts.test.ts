import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  it('starts a new thread and turn for simple prompts', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({
      text: 'Summarize this repo.',
      cwd: '/repo',
      model: 'gpt-5.4',
    });
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

  it('preserves distinct client message IDs when supplemental input returns the active turn ID', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const firstInput = { text: 'Initial task', clientUserMessageId: 'client-first' };
    const first = adapter.sendPrompt(firstInput);
    const socket = MockWebSocket.instances[0];
    if (!socket) throw new Error('Expected an opened adapter socket');
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_active' } });
    await waitForSent(socket, 4);
    socket.respond(3, { turn: { id: 'turn_active', status: 'inProgress', items: [] } });
    const firstResult = await first;

    const followupInput = {
      threadId: 'thr_active',
      text: 'Supplement',
      clientUserMessageId: 'client-followup',
    };
    const followup = adapter.sendPrompt(followupInput);
    await waitForSent(socket, 5);
    socket.respond(4, { thread: { id: 'thr_active' } });
    await waitForSent(socket, 6);
    socket.respond(5, { turn: { id: 'turn_active', status: 'inProgress', items: [] } });
    const followupResult = await followup;

    expect(followupResult.turn.id).toBe(firstResult.turn.id);
    expect(JSON.parse(socket.sent[3] ?? '{}')).toMatchObject({
      method: 'turn/start',
      params: {
        clientUserMessageId: 'client-first',
        input: [{ type: 'text', text: 'Initial task' }],
      },
    });
    expect(JSON.parse(socket.sent[5] ?? '{}')).toMatchObject({
      method: 'turn/start',
      params: {
        clientUserMessageId: 'client-followup',
        input: [{ type: 'text', text: 'Supplement' }],
      },
    });
  });

  it('starts the first turn on an adapter-created thread without trying to resume it', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const started = adapter.startThread({ cwd: '/repo' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, { thread: { id: 'thr_empty', cwd: '/repo' } });
    await expect(started).resolves.toEqual({ thread: { id: 'thr_empty', cwd: '/repo' } });

    const prompt = adapter.sendPrompt({
      threadId: 'thr_empty',
      text: 'First prompt.',
      cwd: '/repo',
    });
    await waitForSent(socket, 4);

    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_empty',
        input: [{ type: 'text', text: 'First prompt.' }],
        cwd: '/repo',
      },
    });
    socket.respond(3, { turn: { id: 'turn_first', status: 'inProgress' } });
    await expect(prompt).resolves.toEqual({
      threadId: 'thr_empty',
      thread: undefined,
      turn: { id: 'turn_first', status: 'inProgress' },
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
    const sentParams = (JSON.parse(socket.sent[3] ?? '{}') as { params?: Record<string, unknown> })
      .params;
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
    const sentParams = (JSON.parse(socket.sent[3] ?? '{}') as { params?: Record<string, unknown> })
      .params;
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
    await adapter.replyQuestion('codex-tool:{"id":43,"questionIds":["question-a"]}', {
      answers: [['Use this value']],
    });
    await adapter.replyQuestion('codex-dynamic:44', { answers: [['Dynamic result']] });
    await adapter.rejectQuestion('codex-tool:{"id":45,"questionIds":["question-b"]}');
    await adapter.rejectQuestion('codex-dynamic:46');

    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 42,
      result: { decision: 'acceptForSession' },
    });
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 'req-1',
      result: { decision: 'decline' },
    });
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

  it('retries existing-thread resume without history when legacy hydration is unsupported', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({ threadId: 'thr_paginated', text: 'Continue.' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.reject(2, 'list_turns is not supported yet', -32601);
    await waitForSent(socket, 4);

    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'thread/resume',
      params: { threadId: 'thr_paginated', excludeTurns: true },
    });
    socket.respond(3, { thread: { id: 'thr_paginated', turns: [] } });
    await waitForSent(socket, 5);
    socket.respond(4, { turn: { id: 'turn_paginated', status: 'inProgress' } });

    await expect(prompt).resolves.toEqual({
      threadId: 'thr_paginated',
      thread: undefined,
      turn: { id: 'turn_paginated', status: 'inProgress' },
    });
  });

  it('propagates unrelated existing-thread resume errors without starting a turn', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const prompt = adapter.sendPrompt({ threadId: 'thr_missing', text: 'Continue.' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.reject(2, 'thread not found', -32600);

    await expect(prompt).rejects.toThrow('thread not found');
    expect(socket.sent).toHaveLength(3);
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

    const prompt = adapter.sendPrompt({
      threadId: 'thr_empty',
      text: 'Start now.',
      cwd: '/repo',
      model: 'gpt-5.4',
    });
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
  });
});
