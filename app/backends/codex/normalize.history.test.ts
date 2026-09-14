import { describe, expect, it } from 'vitest';
import { normalizeCodexTurnItems, normalizeCodexTurnsToHistory } from './normalize';

describe('normalizeCodexTurnItems', () => {
  it('keeps wire user identities identical for batch and incremental normalization', () => {
    const items = [
      {
        id: 'wire-a',
        clientId: 'client-a',
        type: 'userMessage',
        content: [{ type: 'text', text: 'A' }],
      },
      { id: 'wire-b', type: 'userMessage', content: [{ type: 'text', text: 'B' }] },
    ];
    const batch = normalizeCodexTurnItems({ sessionId: 's', turnId: 't', items });
    const incremental = items.flatMap(
      (item) => normalizeCodexTurnItems({ sessionId: 's', turnId: 't', items: [item] }).messages,
    );
    expect(batch.messages.map((message) => message.id)).toEqual([
      't:user:client-a',
      't:user:wire-b',
    ]);
    expect(incremental.map((message) => message.id)).toEqual(
      batch.messages.map((message) => message.id),
    );
  });

  it('keeps auxiliary item identities and parents stable across supplemental user segments', () => {
    const tool = { id: 'tool-a', type: 'commandExecution', command: 'echo A', status: 'completed' };
    const reasoning = { id: 'reasoning-b', type: 'reasoning', summary: [{ text: 'Think B' }] };
    const result = normalizeCodexTurnItems({
      sessionId: 's',
      turnId: 't',
      items: [
        { id: 'user-a', type: 'userMessage', content: [{ type: 'text', text: 'A' }] },
        tool,
        { id: 'user-b', type: 'userMessage', content: [{ type: 'text', text: 'B' }] },
        reasoning,
      ],
    });
    expect(
      result.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => [message.id, message.parentID]),
    ).toEqual([
      ['t:assistant:tool-a', 't:user:user-a'],
      ['t:assistant:reasoning-b', 't:user:user-b'],
    ]);
    const late = normalizeCodexTurnItems({
      sessionId: 's',
      turnId: 't',
      items: [tool],
      parentMessageId: 't:user:user-a',
    });
    expect(late.messages[0]).toMatchObject({ id: 't:assistant:tool-a', parentID: 't:user:user-a' });
  });

  it('retains each assistant item as a separate chronological message around tools', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 's',
      turnId: 't',
      createdAt: 100,
      items: [
        { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'request' }] },
        { id: 'a1', type: 'agentMessage', text: 'first' },
        { id: 'cmd', type: 'commandExecution', command: ['ls'] },
        { id: 'a2', type: 'agentMessage', text: 'second' },
      ],
    });
    const replies = result.parts.filter((part) => part.type === 'text' && part.text !== 'request');
    expect(new Set(replies.map((part) => part.id)).size).toBe(2);
    expect(new Set(replies.map((part) => part.messageID)).size).toBe(2);
    expect(
      result.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.time.created),
    ).toEqual([101, 102, 103]);
    expect(
      result.messages
        .filter((message) => message.role === 'assistant')
        .every((message) => message.parentID === 't:user:u'),
    ).toBe(true);
    const reloaded = normalizeCodexTurnsToHistory({
      sessionId: 's',
      turns: [
        {
          id: 't',
          items: [
            { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'request' }] },
            { id: 'a1', type: 'agentMessage', text: 'first' },
            { id: 'cmd', type: 'commandExecution', command: ['ls'] },
            { id: 'a2', type: 'agentMessage', text: 'second' },
          ],
        },
      ],
    });
    expect(
      reloaded
        .flatMap((entry) => entry.parts)
        .filter((part) => part.type === 'text' && part.text !== 'request')
        .map((part) => part.id),
    ).toEqual(replies.map((part) => part.id));
  });

  it('groups canonical parts by message for useMessages history loading', () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 'thread-3',
      createdAt: 200,
      turns: [
        {
          id: 'turn-3',
          items: [
            { id: 'u3', type: 'userMessage', content: [{ type: 'text', text: 'inspect repo' }] },
            { id: 'cmd3', type: 'commandExecution', command: 'ls', aggregatedOutput: 'app' },
            { id: 'a3', type: 'agentMessage', text: 'done' },
          ],
        },
      ],
    });

    expect(history.map((entry) => entry.info.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(history[0]?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'inspect repo' }),
    ]);
    expect(history[1]?.parts).toEqual([expect.objectContaining({ type: 'tool', tool: 'bash' })]);
    expect(history[2]?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'done' })]);
    const assistantInfo = history[1]?.info;
    expect(assistantInfo?.role).toBe('assistant');
    if (!assistantInfo || assistantInfo.role !== 'assistant')
      throw new Error('Expected assistant history entry');
    expect(assistantInfo.time.completed).toBeDefined();
  });

  it('includes reasoning and compaction in history', () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 'thread-4',
      createdAt: 300,
      turns: [
        {
          id: 'turn-4',
          items: [
            { id: 'u4', type: 'userMessage', content: [{ type: 'text', text: 'fix bug' }] },
            { id: 'r4', type: 'reasoning', summary: ['analyzing code'], content: [] },
            { id: 'a4', type: 'agentMessage', text: 'fixed' },
            { id: 'c4', type: 'contextCompaction' },
          ],
        },
      ],
    });

    expect(history).toHaveLength(4);
    expect(history[0]?.info.role).toBe('user');
    expect(history[1]?.info.role).toBe('assistant');
    expect(history.flatMap((entry) => entry.parts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', text: 'analyzing code' }),
        expect.objectContaining({ type: 'text', text: 'fixed' }),
        expect.objectContaining({ type: 'compaction' }),
      ]),
    );
  });

  it('sets time.completed when turnStatus is completed', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-completed',
      turnId: 'turn-completed',
      createdAt: 100,
      items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        {
          id: 'cmd1',
          type: 'commandExecution',
          createdAt: 120,
          command: 'ls',
          aggregatedOutput: 'ok',
        },
        { id: 'a1', type: 'agentMessage', createdAt: 150, text: 'done' },
      ],
      turnStatus: 'completed',
      turn: { completedAt: 160 },
    });

    const assistant = result.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (!assistant || assistant.role !== 'assistant') throw new Error('Expected assistant');
    expect(assistant.time.created).toBe(120);
    expect(assistant.time.completed).toBe(160);
  });

  it('falls back to max item time.end when turn has no completedAt', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-item-end',
      turnId: 'turn-item-end',
      createdAt: 100,
      items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        {
          id: 'cmd1',
          type: 'commandExecution',
          createdAt: 120,
          command: 'ls',
          aggregatedOutput: 'ok',
          time: { end: 140 },
        },
        { id: 'a1', type: 'agentMessage', createdAt: 150, text: 'done', time: { end: 155 } },
      ],
      turnStatus: 'completed',
      turn: {},
    });

    const assistant = result.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (!assistant || assistant.role !== 'assistant') throw new Error('Expected assistant');
    expect(assistant.time.completed).toBe(155);
  });

  it('does not set time.completed when turnStatus is inProgress', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-inprogress',
      turnId: 'turn-inprogress',
      createdAt: 100,
      items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        {
          id: 'cmd1',
          type: 'commandExecution',
          createdAt: 120,
          command: 'ls',
          aggregatedOutput: 'ok',
        },
        { id: 'a1', type: 'agentMessage', createdAt: 130, text: 'working...' },
      ],
      turnStatus: 'inProgress',
    });

    const assistant = result.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (!assistant || assistant.role !== 'assistant') throw new Error('Expected assistant');
    expect(assistant.time.created).toBe(120);
    expect(assistant.time.completed).toBeUndefined();
  });

  it('normalizeCodexTurnsToHistory passes turn status for duration display', () => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 'thread-status',
      createdAt: 100,
      turns: [
        {
          id: 'turn-done',
          status: 'completed',
          createdAt: 100,
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'go' }] },
            { id: 'a1', type: 'agentMessage', createdAt: 110, text: 'done', time: { end: 115 } },
          ],
        },
        {
          id: 'turn-wip',
          status: 'inProgress',
          createdAt: 200,
          items: [
            { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'next' }] },
            { id: 'a2', type: 'agentMessage', createdAt: 210, text: 'working' },
          ],
        },
      ],
    });

    const doneAssistant = history.find(
      (e) => e.info.role === 'assistant' && e.info.id.includes('turn-done'),
    );
    const wipAssistant = history.find(
      (e) => e.info.role === 'assistant' && e.info.id.includes('turn-wip'),
    );

    expect(doneAssistant).toBeDefined();
    expect(wipAssistant).toBeDefined();

    if (doneAssistant?.info.role === 'assistant') {
      expect(doneAssistant.info.time.completed).toBe(115);
    }
    if (wipAssistant?.info.role === 'assistant') {
      expect(wipAssistant.info.time.completed).toBeUndefined();
    }
  });

  it('maps wire startedAt/completedAt seconds to millisecond message times', () => {
    // Real thread/read wire shape (codex app-server): turns carry startedAt/completedAt
    // in Unix SECONDS and no createdAt; items carry no timestamps.
    const history = normalizeCodexTurnsToHistory({
      sessionId: 'thread-wire',
      turns: [
        {
          id: 'turn-wire',
          status: 'completed',
          startedAt: 1778509222,
          completedAt: 1778509256,
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'go' }] },
            { id: 'a1', type: 'agentMessage', text: 'done' },
          ],
        },
      ],
    });
    const user = history.find((entry) => entry.info.role === 'user');
    const assistant = history.find((entry) => entry.info.role === 'assistant');
    expect(user?.info.time.created).toBe(1778509222 * 1000);
    expect(assistant).toBeDefined();
    if (!assistant || assistant.info.role !== 'assistant')
      throw new Error('Expected assistant entry');
    expect(assistant.info.time.created).toBeGreaterThanOrEqual(1778509222 * 1000);
    expect(assistant.info.time.created).toBeLessThan(1778509222 * 1000 + 60_000);
    expect(assistant.info.time.completed).toBe(1778509256 * 1000);
  });
});
