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
      messageID: 'user-item',
      text: 'hello codex',
    });
    expect(result.parts[1]).toMatchObject({
      type: 'text',
      messageID: 'turn-1:assistant:0',
      text: 'hello vis',
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
  });
});
