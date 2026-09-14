import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexPromptResult } from '../backends/codex/codexAdapter';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('rolls back the selected historical message and all later turns, without counting supplemental users twice', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_existing',
        turns: ['a', 'b', 'c'].map((id) => ({
          id,
          items: [
            { type: 'userMessage', id: 'first', content: [{ type: 'text', text: id }] },
            {
              type: 'userMessage',
              id: 'supplement',
              content: [{ type: 'text', text: 'Supplement' }],
            },
          ],
        })),
      },
    });
    await api.rollbackThread('thr_existing', 'b:user:supplement');
    expect(mock.adapter.rollbackThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      numTurns: 2,
    });
    vi.mocked(mock.adapter.rollbackThread).mockClear();
    await expect(api.rollbackThread('thr_existing', 'missing:user:first')).rejects.toThrow();
    expect(mock.adapter.rollbackThread).not.toHaveBeenCalled();
  });

  it('preserves item-start order when an earlier assistant finishes after later tools', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      mock.emit({
        method: 'item/started',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          item: { type: 'agentMessage', id: 'z-first' },
        },
      });
      mock.emit({
        method: 'item/started',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'a-second', command: 'pwd' },
        },
      });
      now.mockReturnValue(200);
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          item: { type: 'agentMessage', id: 'z-first', text: 'Delayed response' },
        },
      });
      const assistant = api.realtimeHistoryQueue.value.find(
        (entry) => entry.info.id === 'turn_1:assistant:z-first',
      );
      const tool = api.realtimeToolParts.value.find(
        (entry) => entry.info.id === 'turn_1:assistant:a-second',
      );
      expect(assistant?.info.time.created).toBeLessThan(tool?.info.time.created ?? 0);
    } finally {
      now.mockRestore();
      api.disconnect();
    }
  });

  it('keeps supplemental echoes, item parents and card identities stable through history reload', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Same text', { effort: 'high' });
    const firstClient = vi.mocked(mock.adapter.sendPrompt).mock.calls[0]?.[0].clientUserMessageId;
    const firstUser = {
      type: 'userMessage',
      id: 'wire-a',
      clientId: firstClient,
      content: [{ type: 'text', text: 'Same text' }],
    };
    const emit = (method: string, item: Record<string, unknown>) =>
      mock.emit({ method, params: { threadId: 'thr_existing', turnId: 'turn_1', item } });
    emit('item/completed', firstUser);
    emit('item/started', { type: 'agentMessage', id: 'old-answer' });
    emit('item/started', { type: 'commandExecution', id: 'old-tool', command: 'echo old' });
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const pending = api.sendPrompt('Same text', { effort: 'low' });
    const secondClient = vi.mocked(mock.adapter.sendPrompt).mock.calls[0]?.[0].clientUserMessageId;
    expect(secondClient).not.toBe(firstClient);
    const secondUser = {
      type: 'userMessage',
      id: 'wire-b',
      clientId: secondClient,
      content: [{ type: 'text', text: 'Same text' }],
    };
    emit('item/started', secondUser);
    emit('item/completed', secondUser);
    expect(
      api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'user'),
    ).toHaveLength(2);
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'turn_1', status: 'inProgress' } });
    await pending;
    const oldAnswer = { type: 'agentMessage', id: 'old-answer', text: 'Old response, delayed' };
    const oldTool = {
      type: 'commandExecution',
      id: 'old-tool',
      command: 'echo old',
      status: 'completed',
    };
    const newAnswer = { type: 'agentMessage', id: 'new-answer', text: 'New response' };
    const newTool = {
      type: 'commandExecution',
      id: 'new-tool',
      command: 'echo new',
      status: 'completed',
    };
    const reasoning = {
      type: 'reasoning',
      id: 'new-reasoning',
      summary: [{ type: 'summary_text', text: 'New reasoning' }],
    };
    for (const item of [oldAnswer, oldTool, newAnswer, newTool, reasoning])
      emit('item/completed', item);
    const identity = (entries: typeof api.canonicalHistory.value) =>
      entries
        .map((entry) => ({
          id: entry.info.id,
          parent: entry.info.role === 'assistant' ? entry.info.parentID : '',
          variant: entry.info.variant,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const live = identity(api.realtimeHistoryQueue.value);
    expect(live.find((entry) => entry.id === 'turn_1:assistant:old-answer')?.parent).toBe(
      `turn_1:user:${firstClient}`,
    );
    expect(live.find((entry) => entry.id === 'turn_1:assistant:old-tool')?.parent).toBe(
      `turn_1:user:${firstClient}`,
    );
    expect(live.find((entry) => entry.id === 'turn_1:assistant:new-answer')?.parent).toBe(
      `turn_1:user:${secondClient}`,
    );
    vi.mocked(mock.adapter.readThread).mockResolvedValue({
      thread: {
        id: 'thr_existing',
        turns: [
          {
            id: 'turn_1',
            status: 'completed',
            items: [firstUser, oldAnswer, oldTool, secondUser, newAnswer, newTool, reasoning],
          },
        ],
      },
    });
    await api.selectThread('thr_existing');
    expect(identity(api.canonicalHistory.value)).toEqual(live);
    emit('item/completed', firstUser);
    emit('item/completed', {
      type: 'agentMessage',
      id: 'after-reload',
      text: 'Still follows the latest user',
    });
    expect(
      api.realtimeHistoryQueue.value.find(
        (entry) => entry.info.id === 'turn_1:assistant:after-reload',
      )?.info,
    ).toMatchObject({ parentID: `turn_1:user:${secondClient}` });
    api.disconnect();
  });

  it('keeps supplemental users and their replies distinct within a reused active turn', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Original request', { effort: 'high' });
    const first = api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user');
    mock.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        itemId: 'answer-a',
        delta: 'Original reply',
      },
    });
    await api.sendPrompt('Supplemental request', { effort: 'low' });
    const users = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'user');
    expect(users).toHaveLength(2);
    expect(users.map((entry) => entry.parts.find((part) => part.type === 'text')?.text)).toEqual([
      'Original request',
      'Supplemental request',
    ]);
    mock.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        itemId: 'answer-b',
        delta: 'Supplemental reply',
      },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: { id: 'answer-a', type: 'agentMessage', text: 'Original reply completed late' },
      },
    });
    const parent = (id: string) =>
      api.realtimeHistoryQueue.value.find((entry) => entry.info.id === `turn_1:assistant:${id}`)
        ?.info;
    expect(parent('answer-a')).toMatchObject({ parentID: first?.info.id });
    expect(parent('answer-b')).toMatchObject({ parentID: users[1]?.info.id });
    expect(users.map((entry) => entry.info.variant)).toEqual(['high', 'low']);
    api.disconnect();
  });

  it('keeps restored replies attached to their original user across tool events', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const original = api.canonicalHistory.value.find((entry) => entry.info.role === 'assistant')!;
    mock.emit({
      method: 'item/started',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_old',
        item: { id: 'command-live', type: 'commandExecution', command: 'pwd' },
      },
    });
    expect(api.realtimeToolParts.value[0]?.info).toMatchObject({
      parentID: 'turn_old:user:u1',
      id: 'turn_old:assistant:command-live',
    });
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_old',
        item: {
          id: 'command-live',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/repo',
        },
      },
    });
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'assistant')?.info,
    ).toMatchObject({ parentID: 'turn_old:user:u1' });
    expect(api.canonicalHistory.value.find((entry) => entry.info.id === original.info.id)).toEqual(
      original,
    );
  });

  it('retains streamed reasoning when completion contains no summary and separates consecutive items', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    for (const [itemId, delta] of [
      ['reason-1', 'First summary'],
      ['reason-2', 'Second summary'],
    ]) {
      mock.emit({
        method: 'item/reasoning/summaryTextDelta',
        params: { threadId: 'thr_existing', turnId: 'turn_old', itemId, delta },
      });
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_old',
          item: { id: itemId, type: 'reasoning', summary: [], content: [] },
        },
      });
    }
    const reasoning = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === 'reasoning');
    expect(reasoning.map((part) => [part.id, part.text])).toEqual([
      ['reason-1', 'First summary'],
      ['reason-2', 'Second summary'],
    ]);
  });

  it('does not revive completed reasoning when this or a later turn finishes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn-a',
          item: { id: 'reason-a', type: 'reasoning', summary: ['Finished thought'], content: [] },
        },
      });
      const finishedPart = api.realtimeReasoningPart.value?.part;
      clock.mockReturnValue(200);
      mock.emit({
        method: 'turn/completed',
        params: { threadId: 'thr_existing', turn: { id: 'turn-a', status: 'completed' } },
      });
      expect(api.realtimeReasoningPart.value?.part).toBe(finishedPart);
      clock.mockReturnValue(300);
      mock.emit({
        method: 'turn/started',
        params: { threadId: 'thr_existing', turn: { id: 'turn-b', status: 'inProgress' } },
      });
      mock.emit({
        method: 'turn/completed',
        params: { threadId: 'thr_existing', turn: { id: 'turn-b', status: 'completed' } },
      });
      expect(api.realtimeReasoningPart.value?.part).toBe(finishedPart);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps authoritative completed reasoning through the turn completion event', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-live',
        itemId: 'reason-final',
        delta: 'Draft',
      },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-live',
        item: { id: 'reason-final', type: 'reasoning', summary: ['Final summary'], content: [] },
      },
    });
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn-live', status: 'completed' } },
    });
    expect(api.realtimeReasoningPart.value?.part).toMatchObject({
      id: 'reason-final',
      text: 'Final summary',
    });
  });

  it('reparents early tool events when the optimistic user receives its final ID', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const sending = api.sendPrompt('Continue');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    mock.emit({
      method: 'item/started',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-race',
        item: { id: 'early-tool', type: 'commandExecution', command: 'pwd' },
      },
    });
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'turn-race', status: 'inProgress' } });
    await sending;
    mock.emit({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-race',
        itemId: 'early-tool',
        delta: '/repo',
      },
    });
    expect(api.realtimeToolParts.value[0]?.info).toMatchObject({
      parentID: `turn-race:user:${clientId}`,
    });
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-race',
        item: { id: 'early-tool', type: 'commandExecution', command: 'pwd', status: 'completed' },
      },
    });
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'assistant')?.info,
    ).toMatchObject({ parentID: `turn-race:user:${clientId}` });
  });

  it('publishes completed-only reasoning and collaboration notifications to live window sources', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-c',
        item: { id: 'reason-only', type: 'reasoning', summary: ['Decision'] },
      },
    });
    expect(api.realtimeReasoningPart.value?.part).toMatchObject({
      id: 'reason-only',
      text: 'Decision',
      time: { end: expect.any(Number) },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-c',
        item: {
          id: 'spawn-only',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'thr_existing',
          receiverThreadIds: ['child'],
          prompt: 'Review',
          agentsStates: { child: { status: 'running' } },
        },
      },
    });
    expect(api.realtimeCompletedPart.value?.part).toMatchObject({
      tool: 'task',
      state: { metadata: { sessionIds: ['child'] } },
    });
    await api.selectThread('thr_existing');
    expect(api.realtimeReasoningPart.value).toBeNull();
    expect(api.realtimeToolParts.value).toEqual([]);
  });

  it('sends prompts to the active thread and records user transcript entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const result = await api.sendPrompt('  Summarize this repo.  ');

    expect(mock.adapter.sendPrompt).toHaveBeenCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
      threadId: 'thr_existing',
      text: 'Summarize this repo.',
    });
    expect(result?.threadId).toBe('thr_existing');
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'Summarize this repo.' }),
    ]);
  });

  it('sends prompts with the selected thread and cwd snapshot', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.sendPrompt('Continue here.', { threadId: 'thr_existing', cwd: '~/repo' });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
      threadId: 'thr_existing',
      text: 'Continue here.',
      cwd: '/home/codex/repo',
    });
  });

  it('pushes completed items to realtimeHistoryQueue for OutputPanel bridge', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Test realtime.');

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Test realtime.' });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'agent-realtime-1',
          type: 'agentMessage',
          text: 'Realtime answer',
        },
      },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter(
      (e) => e.info.role === 'assistant',
    );
    expect(assistantEntries.length).toBeGreaterThan(0);
    expect(
      assistantEntries.some((e) =>
        e.parts.some((p) => p.type === 'text' && 'text' in p && p.text === 'Realtime answer'),
      ),
    ).toBe(true);
  });

  it('pushes user message to realtimeHistoryQueue immediately on sendPrompt', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    expect(api.realtimeHistoryQueue.value).toEqual([]);

    await api.sendPrompt('Hello immediately.');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    const userId = `turn_1:user:${clientId}`;

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.role).toBe('user');
    expect(clientId).toMatch(/^client-user:/u);
    expect(userEntries[0]?.info.id).toBe(userId);
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:')),
    ).toBe(true);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain(userId);
    expect(userEntries[0]?.parts).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Hello immediately.' });
  });

  it('does not reuse the previous active turn id for a new provisional user message', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockResolvedValue({
      threadId: 'thr_existing',
      turn: { id: 'turn_2', status: 'inProgress' },
    } satisfies CodexPromptResult);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.activeTurn.value = { id: 'turn_old', status: 'completed' } as never;

    await api.sendPrompt('Fresh turn please.');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;

    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('turn_old:')),
    ).toBe(false);
    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('pending-turn:')),
    ).toBe(true);
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info.id,
    ).toBe(`turn_2:user:${clientId}`);
  });

  it('removes provisional realtime user history if sendPrompt fails', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockRejectedValue(new Error('send failed'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await expect(api.sendPrompt('Will fail.')).rejects.toThrow('send failed');

    expect(api.realtimeHistoryQueue.value).toEqual([]);
  });

  it('finalizes the provisional user entry even if another realtime entry lands before sendPrompt resolves', async () => {
    const mock = createAdapterMock();
    let resolveSend: ((result: CodexPromptResult) => void) | null = null;
    mock.adapter.sendPrompt = vi.fn().mockImplementation(
      () =>
        new Promise<CodexPromptResult>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Race test.');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    const userId = `turn_race:user:${clientId}`;
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Early' } });
    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_race', status: 'inProgress' },
    });
    await pendingSend;

    const userEntries = api.realtimeHistoryQueue.value.filter(
      (entry) => entry.info.role === 'user',
    );
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.id).toBe(userId);
    expect(userEntries[0]?.parts[0]).toMatchObject({
      id: `${userId}:text`,
      text: 'Race test.',
    });
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain(userId);
  });

  it('keeps successive streamed assistant items independently through completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Multiple replies');
    for (const [itemId, text] of [
      ['a1', 'First reply'],
      ['a2', 'Second reply'],
    ]) {
      mock.emit({
        method: 'item/agentMessage/delta',
        params: { itemId, turnId: 'turn_1', delta: text },
      });
      expect(api.realtimeStreamingPart.value?.part.text).toBe(text);
      mock.emit({
        method: 'item/completed',
        params: { turnId: 'turn_1', item: { id: itemId, type: 'agentMessage', text } },
      });
    }
    const replies = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === 'text' && part.text.endsWith('reply'));
    expect(replies.map((part) => (part.type === 'text' ? part.text : ''))).toEqual([
      'First reply',
      'Second reply',
    ]);
    expect(new Set(replies.map((part) => part.messageID)).size).toBe(2);
    mock.emit({
      method: 'item/completed',
      params: {
        turnId: 'turn_1',
        item: { id: 'a1', type: 'agentMessage', text: 'First reply amended' },
      },
    });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Second reply');
    expect(
      api.transcript.value
        .filter((entry) => entry.role === 'assistant')
        .slice(-2)
        .map((entry) => entry.text),
    ).toEqual(['First reply amended', 'Second reply']);
  });

  it('updates realtimeStreamingPart on agent message deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Stream test.');

    expect(api.realtimeStreamingPart.value).toBeNull();

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Hello');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', world!' } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Hello, world!');
  });

  it('marks realtimeStreamingPart completed when agent message completes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete test.');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Partial' } });
    expect(api.realtimeStreamingPart.value).not.toBeNull();

    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Final answer' } },
    });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Final answer');
    expect(api.realtimeStreamingPart.value?.part.time?.end).toEqual(expect.any(Number));
  });

  it('uses one canonical assistant text part across streaming and completed history', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a file');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', world!' } });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Hello, world!' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter(
      (entry) => entry.info.role === 'assistant',
    );
    expect(assistantEntries).toHaveLength(1);
    const textParts = assistantEntries[0]?.parts.filter((part) => part.type === 'text') ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.id).toBe('turn_1:assistant:agent-1:text');
    expect(textParts[0]).toMatchObject({
      messageID: 'turn_1:assistant:agent-1',
      text: 'Hello, world!',
    });
  });

  it('merges completed tool parts into the existing assistant entry instead of duplicating assistant history rows', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a file');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Done' } });
    mock.emit({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: ['ls'], cwd: '/repo' } },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['ls'],
          cwd: '/repo',
          aggregatedOutput: 'file.txt',
        },
      },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Done' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter(
      (entry) => entry.info.role === 'assistant',
    );
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0]?.parts.some((part) => part.type === 'tool')).toBe(true);
    expect(
      assistantEntries[1]?.parts.some(
        (part) => part.type === 'text' && 'text' in part && part.text === 'Done',
      ),
    ).toBe(true);
  });

  it('updates realtimeReasoningPart on reasoning deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Reasoning test.');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: 'Thinking...' },
    });

    expect(api.realtimeReasoningPart.value).not.toBeNull();
    expect(api.realtimeReasoningPart.value?.part.type).toBe('reasoning');
    expect(api.realtimeReasoningPart.value?.part.text).toBe('Thinking...');
    expect(api.realtimeReasoningPart.value?.info.id).toContain(':assistant');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: ' more thoughts' },
    });
    expect(api.realtimeReasoningPart.value?.part.text).toBe('Thinking... more thoughts');
  });

  it('keeps summary and raw reasoning separate and displays the summary with separators', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Interleave reasoning.');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'summary one' },
    });
    mock.emit({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'raw one' },
    });
    mock.emit({
      method: 'item/reasoning/summaryPartAdded',
      params: { itemId: 'reasoning-interleaved' },
    });
    mock.emit({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'raw two' },
    });
    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'summary two' },
    });

    expect(api.reasoningStreams.value['reasoning-interleaved']).toEqual({
      summary: 'summary one\n---\nsummary two',
      raw: 'raw oneraw two',
    });
    expect(api.realtimeReasoningPart.value?.part).toMatchObject({
      id: 'reasoning-interleaved',
      text: 'summary one\n---\nsummary two',
      sessionID: 'thr_existing',
      type: 'reasoning',
    });
    expect(api.realtimeReasoningPart.value?.info.role).toBe('assistant');
  });

  it('clears realtimeStreamingPart and realtimeToolParts when selecting a thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Test.');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'streaming' } });
    mock.emit({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' } },
    });

    expect(api.realtimeStreamingPart.value).not.toBeNull();
    expect(api.realtimeToolParts.value).toHaveLength(1);

    await api.selectThread('thr_existing');

    expect(api.realtimeStreamingPart.value).toBeNull();
    expect(api.realtimeReasoningPart.value).toBeNull();
    expect(api.realtimeToolParts.value).toEqual([]);
  });

  it('clears provisional realtime aliases and history when selecting a different thread', async () => {
    const mock = createAdapterMock();
    let resolveSend: ((result: CodexPromptResult) => void) | null = null;
    mock.adapter.sendPrompt = vi.fn().mockImplementation(
      () =>
        new Promise<CodexPromptResult>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Pending thread switch');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;

    expect(
      api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:')),
    ).toBe(true);

    await api.selectThread('thr_existing');

    expect(
      api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:')),
    ).toBe(false);
    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:')),
    ).toBe(false);

    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_after_switch', status: 'inProgress' },
    });
    await pendingSend;

    expect(
      api.realtimeHistoryQueue.value.some(
        (entry) => entry.info.id === `turn_after_switch:user:${clientId}`,
      ),
    ).toBe(false);
  });
});
