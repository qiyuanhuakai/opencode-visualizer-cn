import { describe, expect, it } from 'vitest';
import { normalizeCodexTurnItems, normalizeCodexTurnsToHistory } from './normalize';

describe('normalizeCodexTurnItems', () => {
  it('maps user and agent messages to canonical message parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-1',
      turnId: 'turn-1',
      createdAt: 100,
      items: [
        {
          id: 'user-item',
          type: 'userMessage',
          content: [{ type: 'text', text: 'hello codex' }],
        },
        {
          id: 'agent-item',
          type: 'agentMessage',
          text: 'hello vis',
        },
      ],
    });

    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toMatchObject({
      type: 'text',
      messageID: 'turn-1:user:0',
      text: 'hello codex',
    });
    expect(result.parts[1]).toMatchObject({
      type: 'text',
      messageID: 'turn-1:assistant',
      text: 'hello vis',
    });
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      time: { created: 101, completed: 101 },
    });
  });

  it('tracks assistant completed time from the latest assistant-side item in the turn', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-time',
      turnId: 'turn-time',
      createdAt: 100,
      items: [
        {
          id: 'user-item',
          type: 'userMessage',
          createdAt: 110,
          content: [{ type: 'text', text: 'hello codex' }],
        },
        {
          id: 'cmd-1',
          type: 'commandExecution',
          createdAt: 120,
          command: ['pnpm', 'test'],
          aggregatedOutput: 'passed',
        },
        {
          id: 'agent-item',
          type: 'agentMessage',
          createdAt: 135,
          text: 'done',
        },
      ],
    });

    expect(result.messages.find((message) => message.role === 'assistant')).toMatchObject({
      id: 'turn-time:assistant',
      time: { created: 120, completed: 135 },
      parentID: 'turn-time:user:0',
    });
  });

  it('maps command and file change items to canonical tool parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-2',
      turnId: 'turn-2',
      items: [
        {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
          aggregatedOutput: 'passed',
        },
        {
          id: 'files-1',
          type: 'fileChange',
          changes: [{ path: 'a.ts', diff: '@@ patch' }],
        },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: 'passed' },
    });
    expect(result.parts[1]).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: { status: 'completed', output: '@@ patch' },
    });
  });

  it('maps reasoning items to canonical reasoning parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-r',
      turnId: 'turn-r',
      items: [
        {
          id: 'reasoning-1',
          type: 'reasoning',
          summary: 'Thinking about the problem',
          text: 'Detailed reasoning text',
        },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'reasoning',
      id: 'reasoning-1',
      text: 'Thinking about the problem',
    });
  });

  it('maps plan items to canonical text parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-p',
      turnId: 'turn-p',
      items: [
        {
          id: 'plan-1',
          type: 'plan',
          text: 'Step 1: Analyze\nStep 2: Fix',
        },
      ],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'text',
      text: 'Step 1: Analyze\nStep 2: Fix',
    });
  });

  it('maps mcpToolCall items to canonical tool parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-mcp',
      turnId: 'turn-mcp',
      items: [
        {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'my-server',
          tool: 'search',
          arguments: { query: 'test' },
          result: 'found 3 results',
          status: 'completed',
        },
      ],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'search',
      state: {
        status: 'completed',
        output: 'found 3 results',
      },
    });
  });

  it('maps dynamicToolCall items to canonical tool parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-dyn',
      turnId: 'turn-dyn',
      items: [
        {
          id: 'dyn-1',
          type: 'dynamicToolCall',
          tool: 'custom_tool',
          arguments: { input: 'value' },
          status: 'completed',
          contentItems: [{ type: 'text', text: 'tool output' }],
        },
      ],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'custom_tool',
      state: {
        status: 'completed',
        output: 'tool output',
      },
    });
  });

  it('maps contextCompaction items to canonical compaction parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-compact',
      turnId: 'turn-compact',
      items: [
        {
          id: 'compact-1',
          type: 'contextCompaction',
        },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'compaction',
      id: 'compact-1',
    });
  });

  it('maps imageView and review mode items into assistant text history', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-extra',
      turnId: 'turn-extra',
      items: [
        { id: 'img-1', type: 'imageView', path: '/tmp/screenshot.png' },
        { id: 'review-start', type: 'enteredReviewMode', review: 'current changes' },
        { id: 'review-end', type: 'exitedReviewMode', review: 'looks good' },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Image: /tmp/screenshot.png' }),
      expect.objectContaining({ type: 'text', text: 'Entered review mode: current changes' }),
      expect.objectContaining({ type: 'text', text: 'Review: looks good' }),
    ]));
  });

  it('uses stable item ids when available', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-stable',
      turnId: 'turn-stable',
      items: [
        { id: 'stable-user-id', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        { id: 'stable-agent-id', type: 'agentMessage', text: 'hello' },
        { id: 'stable-cmd-id', type: 'commandExecution', command: 'ls', aggregatedOutput: 'file' },
      ],
    });

    expect(result.parts[0]?.id).toBe('stable-user-id:text');
    expect(result.parts[1]?.id).toBe('turn-stable:assistant:text');
    expect(result.parts[2]?.id).toBe('stable-cmd-id');
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

    expect(history.map((entry) => entry.info.role)).toEqual(['user', 'assistant']);
    expect(history[0]?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'inspect repo' }),
    ]);
    expect(history[1]?.parts).toEqual([
      expect.objectContaining({ type: 'tool', tool: 'bash' }),
      expect.objectContaining({ type: 'text', text: 'done' }),
    ]);
    const assistantInfo = history[1]?.info;
    expect(assistantInfo?.role).toBe('assistant');
    if (!assistantInfo || assistantInfo.role !== 'assistant') throw new Error('Expected assistant history entry');
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
            { id: 'r4', type: 'reasoning', summary: 'analyzing code' },
            { id: 'a4', type: 'agentMessage', text: 'fixed' },
            { id: 'c4', type: 'contextCompaction' },
          ],
        },
      ],
    });

    expect(history).toHaveLength(2);
    expect(history[0]?.info.role).toBe('user');
    expect(history[1]?.info.role).toBe('assistant');
    expect(history[1]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', text: 'analyzing code' }),
        expect.objectContaining({ type: 'text', text: 'fixed' }),
        expect.objectContaining({ type: 'compaction' }),
      ]),
    );
  });
});
