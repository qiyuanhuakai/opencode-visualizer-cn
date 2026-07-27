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
      state: {
        status: 'completed',
        input: { filePath: 'a.ts' },
        output: '@@ patch',
        metadata: { filediff: { patch: '@@ patch' } },
      },
    });
  });

  it('maps multi-file fileChange items to multiedit tool parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-2b',
      turnId: 'turn-2b',
      items: [
        {
          id: 'files-2',
          type: 'fileChange',
          changes: [
            { path: 'a.ts', diff: '@@ patch a' },
            { path: 'b.ts', diff: '@@ patch b' },
          ],
        },
      ],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'multiedit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts', 'b.ts'] },
        metadata: {
          results: [
            { path: 'a.ts', filediff: { patch: '@@ patch a' } },
            { path: 'b.ts', filediff: { patch: '@@ patch b' } },
          ],
        },
      },
    });
  });

  it('keeps edit and multiedit visible even when Codex omits diff text', () => {
    const single = normalizeCodexTurnItems({
      sessionId: 'thread-2c',
      turnId: 'turn-2c',
      items: [
        {
          id: 'files-3',
          type: 'fileChange',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      ],
    });
    const multi = normalizeCodexTurnItems({
      sessionId: 'thread-2d',
      turnId: 'turn-2d',
      items: [
        {
          id: 'files-4',
          type: 'fileChange',
          changes: [
            { path: 'empty-a.ts', diff: '' },
            { path: 'empty-b.ts', diff: '' },
          ],
        },
      ],
    });

    const singlePatch = '## File changed\n\nPath: empty.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    const multiPatchA = '## File changed\n\nPath: empty-a.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    const multiPatchB = '## File changed\n\nPath: empty-b.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    expect(single.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        output: singlePatch,
        metadata: { filediff: { patch: singlePatch } },
      },
    });
    expect(multi.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'multiedit',
      state: {
        output: `${multiPatchA}\n${multiPatchB}`,
        metadata: {
          results: [
            { path: 'empty-a.ts', filediff: { patch: multiPatchA } },
            { path: 'empty-b.ts', filediff: { patch: multiPatchB } },
          ],
        },
      },
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
          summary: ['Thinking about the problem', 'Checking the result'],
          content: ['Detailed reasoning text'],
        },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      type: 'reasoning',
      id: 'reasoning-1',
      text: 'Thinking about the problem\n\nChecking the result',
    });
  });

  it('does not map plan items into assistant-visible parts', () => {
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

    expect(result.parts).toEqual([]);
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
          result: {
            content: [{ type: 'text', text: 'found 3 results' }],
            structuredContent: null,
            _meta: null,
          },
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

  it('maps current collabAgentToolCall items to canonical tool parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-collab',
      turnId: 'turn-collab',
      items: [
        {
          id: 'collab-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'thread-collab',
          receiverThreadIds: ['thread-child'],
          prompt: 'Inspect the parser',
          model: null,
          reasoningEffort: null,
          agentsStates: { 'thread-child': { status: 'completed' } },
        },
      ],
    });

    expect(result.parts).toEqual([
      expect.objectContaining({
        type: 'tool',
        tool: 'spawnAgent',
        state: expect.objectContaining({ status: 'completed' }),
      }),
    ]);
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

  it('maps imageView items into assistant history and excludes review-mode text from assistant bubbles', () => {
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
      expect.objectContaining({ type: 'file', url: '/tmp/screenshot.png', filename: 'screenshot.png' }),
    ]));
    expect(result.parts.some((part) => part.type === 'text' && 'text' in part && part.text.includes('review mode'))).toBe(false);
    expect(result.parts.some((part) => part.type === 'text' && 'text' in part && part.text.includes('Review: looks good'))).toBe(false);
  });

  it('maps user message images into canonical file parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-user-files',
      turnId: 'turn-user-files',
      items: [
        {
          id: 'user-with-image',
          type: 'userMessage',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', url: 'data:image/png;base64,AAA=' },
            { type: 'localImage', path: '/tmp/local-shot.jpg' },
          ],
        },
      ],
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: 'user' });
    expect(result.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'look at this' }),
      expect.objectContaining({ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAA=' }),
      expect.objectContaining({ type: 'file', mime: 'image/jpeg', url: '/tmp/local-shot.jpg', filename: 'local-shot.jpg' }),
    ]));
  });

  it('maps webSearch items into canonical websearch tool parts', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-web',
      turnId: 'turn-web',
      items: [
        {
          id: 'web-1',
          type: 'webSearch',
          query: 'vite docs',
          action: { type: 'openPage', url: 'https://vite.dev' },
        },
      ],
    });

    expect(result.parts).toEqual([
      expect.objectContaining({
        type: 'tool',
        tool: 'websearch',
        state: expect.objectContaining({
          input: expect.objectContaining({ query: 'vite docs', action: 'openPage', url: 'https://vite.dev' }),
        }),
      }),
    ]);
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

    expect(result.parts[0]?.id).toBe('turn-stable:user:0:text');
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
            { id: 'r4', type: 'reasoning', summary: ['analyzing code'], content: [] },
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

  it('sets time.completed when turnStatus is completed', () => {
    const result = normalizeCodexTurnItems({
      sessionId: 'thread-completed',
      turnId: 'turn-completed',
      createdAt: 100,
      items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        { id: 'cmd1', type: 'commandExecution', createdAt: 120, command: 'ls', aggregatedOutput: 'ok' },
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
        { id: 'cmd1', type: 'commandExecution', createdAt: 120, command: 'ls', aggregatedOutput: 'ok', time: { end: 140 } },
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
        { id: 'cmd1', type: 'commandExecution', createdAt: 120, command: 'ls', aggregatedOutput: 'ok' },
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

    const doneAssistant = history.find((e) => e.info.role === 'assistant' && e.info.id.includes('turn-done'));
    const wipAssistant = history.find((e) => e.info.role === 'assistant' && e.info.id.includes('turn-wip'));

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
    if (!assistant || assistant.info.role !== 'assistant') throw new Error('Expected assistant entry');
    expect(assistant.info.time.created).toBeGreaterThanOrEqual(1778509222 * 1000);
    expect(assistant.info.time.created).toBeLessThan(1778509222 * 1000 + 60_000);
    expect(assistant.info.time.completed).toBe(1778509256 * 1000);
  });
});
