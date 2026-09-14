import { describe, expect, it } from 'vitest';
import { normalizeCodexTurnItems } from './normalize';

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
      messageID: 'turn-1:user:user-item',
      text: 'hello codex',
    });
    expect(result.parts[1]).toMatchObject({
      type: 'text',
      messageID: 'turn-1:assistant:agent-item',
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
      id: 'turn-time:assistant:cmd-1',
      time: { created: 120, completed: 120 },
      parentID: 'turn-time:user:user-item',
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

    expect(result.messages).toHaveLength(2);
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

    const singlePatch =
      '## File changed\n\nPath: empty.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    const multiPatchA =
      '## File changed\n\nPath: empty-a.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    const multiPatchB =
      '## File changed\n\nPath: empty-b.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
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
        tool: 'task',
        state: expect.objectContaining({
          status: 'completed',
          input: expect.objectContaining({ operation: 'spawnAgent', prompt: 'Inspect the parser' }),
          metadata: expect.objectContaining({
            sessionIds: ['thread-child'],
            agentsStates: { 'thread-child': { status: 'completed' } },
          }),
        }),
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
    expect(result.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'file',
          url: '/tmp/screenshot.png',
          filename: 'screenshot.png',
        }),
      ]),
    );
    expect(
      result.parts.some(
        (part) => part.type === 'text' && 'text' in part && part.text.includes('review mode'),
      ),
    ).toBe(false);
    expect(
      result.parts.some(
        (part) =>
          part.type === 'text' && 'text' in part && part.text.includes('Review: looks good'),
      ),
    ).toBe(false);
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
    expect(result.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'look at this' }),
        expect.objectContaining({
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,AAA=',
        }),
        expect.objectContaining({
          type: 'file',
          mime: 'image/jpeg',
          url: '/tmp/local-shot.jpg',
          filename: 'local-shot.jpg',
        }),
      ]),
    );
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
          input: expect.objectContaining({
            query: 'vite docs',
            action: 'openPage',
            url: 'https://vite.dev',
          }),
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

    expect(result.parts[0]?.id).toBe('turn-stable:user:stable-user-id:text');
    expect(result.parts[1]?.id).toBe('turn-stable:assistant:stable-agent-id:text');
    expect(result.parts[2]?.id).toBe('stable-cmd-id');
  });
});
