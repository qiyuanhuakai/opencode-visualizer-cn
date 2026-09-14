import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexAdapter } from '../backends/codex/codexAdapter';
import { CodexJsonRpcError } from '../backends/codex/jsonRpcClient';
import { StorageKeys, storageGet, storageGetJSON } from '../utils/storageKeys';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('redetects hydrated history support when the same adapter reconnects', async () => {
    // Given: this connection has already fallen back to paginated history.
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValue({ thread: { id: 'thr_existing' } });
    mock.adapter.listThreadTurns = vi.fn().mockResolvedValue({
      data: [{ id: 'turn_old', items: [{ type: 'agentMessage', id: 'old', text: 'Old runtime' }] }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    api.disconnect();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_existing',
        turns: [
          { id: 'turn_new', items: [{ type: 'agentMessage', id: 'new', text: 'New runtime' }] },
        ],
      },
    });
    mock.adapter.listThreadTurns = vi
      .fn()
      .mockRejectedValue(new CodexJsonRpcError(-32601, 'Method not found'));

    // When: the same adapter reconnects to a runtime supporting hydrated reads.
    await api.connect();
    await api.selectThread('thr_existing');

    // Then: old connection capabilities do not force unsupported pagination.
    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      includeTurns: true,
    });
    expect(mock.adapter.listThreadTurns).not.toHaveBeenCalled();
    expect(api.transcript.value.map((entry) => entry.text)).toEqual(['New runtime']);
  });

  it('falls back to reading unmaterialized threads without turns', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'thread thr_empty is not materialized yet; includeTurns is unavailable before first user message',
        ),
      )
      .mockResolvedValueOnce({ thread: { id: 'thr_empty', preview: 'Empty thread' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(1, {
      threadId: 'thr_empty',
      includeTurns: true,
    });
    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(2, {
      threadId: 'thr_empty',
      includeTurns: false,
    });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('loads paginated full history when legacy hydrated reads are unsupported', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValueOnce({
        thread: { id: 'thr_paginated', name: 'Paginated', historyMode: 'paginated' },
      });
    mock.adapter.listThreadTurns = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'turn_1',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'First prompt' }] },
            ],
          },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'turn_2', items: [{ type: 'agentMessage', id: 'a1', text: 'Final answer' }] }],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_paginated');

    expect(mock.adapter.listThreadTurns).toHaveBeenNthCalledWith(1, {
      threadId: 'thr_paginated',
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    });
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(api.transcript.value.map((entry) => entry.text)).toEqual([
      'First prompt',
      'Final answer',
    ]);
  });

  it('keeps the newest thread selection when an older read resolves last', async () => {
    const mock = createAdapterMock();
    const threadA = deferred<Awaited<ReturnType<CodexAdapter['readThread']>>>();
    mock.adapter.readThread = vi.fn((params: { threadId: string }) => {
      if (params.threadId === 'thread-a') return threadA.promise;
      return Promise.resolve({
        thread: {
          id: params.threadId,
          turns: [
            {
              id: `${params.threadId}:turn`,
              items: [
                {
                  type: 'userMessage',
                  id: `${params.threadId}:user`,
                  content: [{ type: 'text', text: `${params.threadId} prompt` }],
                },
                {
                  type: 'agentMessage',
                  id: `${params.threadId}:assistant`,
                  text: `${params.threadId} answer`,
                },
              ],
            },
          ],
        },
      });
    });
    mock.adapter.resumeThread = vi.fn((params: { threadId: string }) =>
      Promise.resolve({
        thread: { id: params.threadId },
      }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const selectingA = api.selectThread('thread-a');
    await vi.waitFor(() =>
      expect(mock.adapter.readThread).toHaveBeenCalledWith({
        threadId: 'thread-a',
        includeTurns: true,
      }),
    );
    await api.selectThread('thread-b');

    threadA.resolve({
      thread: {
        id: 'thread-a',
        turns: [
          {
            id: 'thread-a:turn',
            items: [
              {
                type: 'userMessage',
                id: 'thread-a:user',
                content: [{ type: 'text', text: 'thread-a prompt' }],
              },
              { type: 'agentMessage', id: 'thread-a:assistant', text: 'thread-a answer' },
            ],
          },
        ],
      },
    });
    await selectingA;

    expect(api.activeThreadId.value).toBe('thread-b');
    expect(api.transcript.value.map((entry) => entry.text)).toEqual([
      'thread-b prompt',
      'thread-b answer',
    ]);
  });

  it('maps every supported history item through the public transcript path', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_variants',
        turns: [
          {
            id: 'turn_variants',
            items: [
              {
                type: 'userMessage',
                content: [{ type: 'text', text: 'user prompt' }],
              },
              { type: 'agentMessage', text: 'agent answer' },
              { type: 'plan', text: 'plan text' },
              {
                type: 'commandExecution',
                command: ['pnpm', 'test'],
                cwd: '/repo',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: 'passed',
              },
              {
                type: 'fileChange',
                changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
                status: 'completed',
              },
              { type: 'reasoning', summary: 'reasoning text' },
              { type: 'enteredReviewMode' },
              { type: 'exitedReviewMode', review: 'current changes' },
              {
                type: 'webSearch',
                query: 'codex',
                action: { type: 'open', query: 'docs', url: 'https://example.test' },
              },
              { type: 'imageView', path: '/tmp/image.png' },
              {
                type: 'mcpToolCall',
                server: 'docs',
                tool: 'search',
                arguments: { query: 'codex' },
                status: 'completed',
              },
              { type: 'dynamicToolCall', tool: 'lookup', status: 'completed' },
              { type: 'collabToolCall', tool: 'delegate', status: 'completed' },
              { type: 'contextCompaction' },
              { type: 'reasoning', summary: '' },
              { type: 'exitedReviewMode' },
              { type: 'imageView' },
              { type: 'unknownItem', text: 'ignored' },
              null,
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_variants');

    expect(api.transcript.value.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'user prompt' },
      { role: 'assistant', text: 'agent answer' },
      { role: 'system', text: 'plan text' },
      {
        role: 'system',
        text: '$ pnpm test\ncwd: /repo\nstatus: completed\nexit code: 0\n\npassed',
      },
      {
        role: 'system',
        text: 'File changes (2):\n  src/a.ts\n  src/b.ts\nstatus: completed',
      },
      { role: 'system', text: 'Reasoning: reasoning text' },
      { role: 'system', text: 'Entered review mode: current changes' },
      { role: 'system', text: 'Review: current changes' },
      {
        role: 'system',
        text: 'Web search: codex\naction: open\nquery: docs\nurl: https://example.test',
      },
      { role: 'system', text: 'Image: /tmp/image.png' },
      {
        role: 'system',
        text: 'Tool call: docs.search\narguments:\n{\n  "query": "codex"\n}\nstatus: completed',
      },
      { role: 'system', text: 'Tool call: lookup\nstatus: completed' },
      { role: 'system', text: 'Tool call: delegate\nstatus: completed' },
      { role: 'system', text: 'Context compaction completed' },
    ]);
  });

  it('preserves item fallbacks when history fields are missing or malformed', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_fallbacks',
        turns: [
          {
            id: 'turn_fallbacks',
            items: [
              null,
              {},
              { type: 'unknownItem' },
              { type: 'userMessage', content: [{ type: 'image', path: '/tmp/image.png' }] },
              { type: 'agentMessage', text: '' },
              { type: 'plan', text: '' },
              { type: 'commandExecution' },
              { type: 'fileChange', changes: [] },
              { type: 'reasoning', summary: 42 },
              { type: 'enteredReviewMode', review: 42 },
              { type: 'exitedReviewMode' },
              { type: 'webSearch', action: {} },
              { type: 'imageView' },
              { type: 'mcpToolCall' },
              { type: 'dynamicToolCall' },
              { type: 'collabToolCall' },
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_fallbacks');

    expect(api.transcript.value.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'system', text: 'File changes' },
      { role: 'system', text: 'Entered review mode: current changes' },
    ]);
  });

  it('restores background supplemental auxiliary records under their observed user', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('other');
    const users = ['first', 'supplement'].map((id) => ({
      type: 'userMessage',
      id,
      clientId: id,
      content: [{ type: 'text', text: id }],
    }));
    const emit = (item: Record<string, unknown>, phase = 'completed') =>
      mock.emit({
        method: `item/${phase}`,
        params: { threadId: 'background', turnId: 'shared', item },
      });
    for (const user of users) {
      emit(user);
      if (user.id === 'first')
        emit({ type: 'commandExecution', id: 'old-tool', command: 'pwd' }, 'started');
    }
    emit({ type: 'reasoning', id: 'new-reason', summary: ['Supplement reasoning'] });
    emit({ type: 'commandExecution', id: 'old-tool', command: 'pwd', status: 'completed' });
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: { id: 'background', turns: [{ id: 'shared', status: 'completed', items: users }] },
    });
    await api.selectThread('background');
    expect(
      api.realtimeHistoryQueue.value.find((entry) =>
        entry.parts.some((part) => part.id === 'new-reason'),
      )?.info,
    ).toMatchObject({ parentID: 'shared:user:supplement' });
    expect(
      api.realtimeHistoryQueue.value.find((entry) =>
        entry.parts.some((part) => part.id === 'old-tool'),
      )?.info,
    ).toMatchObject({ parentID: 'shared:user:first' });
  });

  it('persists a delayed completed item under its notification thread instead of the active thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thread-b');

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-a',
        turnId: 'thread-a:turn',
        item: {
          id: 'thread-a:command',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo-a',
          status: 'completed',
          aggregatedOutput: '/repo-a\n',
        },
      },
    });

    const threadAKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thread-a')}`;
    const threadBKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thread-b')}`;
    await vi.waitFor(() => {
      const snapshot = storageGetJSON<{ entries?: Array<{ parts?: Array<{ id?: string }> }> }>(
        threadAKey,
      );
      expect(
        snapshot?.entries?.flatMap((entry) => entry.parts ?? []).map((part) => part.id),
      ).toContain('thread-a:command');
    });
    expect(storageGetJSON(threadBKey)).toBeNull();
    expect(
      api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id),
    ).not.toContain('thread-a:command');
  });

  it('loads thread history and resumes when selecting a thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_existing');

    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      includeTurns: true,
    });
    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.threads.value[0]).toEqual(
      expect.objectContaining({
        id: 'thr_existing',
        name: 'Existing named thread',
      }),
    );
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('keeps all turns in canonicalHistory when readThread returns multi-turn history (page refresh regression)', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_multi',
        name: 'Multi-turn thread',
        turns: [
          {
            id: 'turn_1',
            items: [
              {
                type: 'userMessage',
                id: 'u1',
                content: [{ type: 'text', text: 'First user prompt' }],
              },
              { type: 'agentMessage', id: 'a1', text: 'First agent answer' },
            ],
          },
          {
            id: 'turn_2',
            items: [
              {
                type: 'userMessage',
                id: 'u2',
                content: [{ type: 'text', text: 'Second user prompt' }],
              },
              { type: 'agentMessage', id: 'a2', text: 'Second agent answer' },
            ],
          },
          {
            id: 'turn_3',
            items: [
              {
                type: 'userMessage',
                id: 'u3',
                content: [{ type: 'text', text: 'Third user prompt' }],
              },
              { type: 'agentMessage', id: 'a3', text: 'Third agent answer' },
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_multi');

    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_multi',
      includeTurns: true,
    });
    expect(api.canonicalHistory.value.length).toBeGreaterThanOrEqual(6);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('keeps selecting an empty thread when resume reports no rollout', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_empty', preview: 'Empty', turns: [] } });
    mock.adapter.resumeThread = vi
      .fn()
      .mockRejectedValue(new Error('no rollout found for thread id thr_empty'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_empty' });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('clears persisted auxiliary history when a thread is rolled back', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a cached tool turn.');
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'rollback-command',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/repo\n',
        },
      },
    });
    const cacheKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thr_existing')}`;
    await vi.waitFor(() => expect(storageGet(cacheKey)).not.toBeNull());

    await api.rollbackThread('thr_existing', 1);

    expect(storageGet(cacheKey)).toBeNull();
    expect(
      api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id),
    ).not.toContain('rollback-command');

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'rollback-command-late',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/stale\n',
        },
      },
    });

    expect(storageGet(cacheKey)).toBeNull();
    expect(
      api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id),
    ).not.toContain('rollback-command-late');
  });

  it('ignores delayed items after rollback even when no turn notification arrived', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Rollback before notifications.');
    await api.rollbackThread('thr_existing', 1);

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'late-without-notification',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/stale\n',
        },
      },
    });

    const cacheKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thr_existing')}`;
    expect(storageGet(cacheKey)).toBeNull();
  });

  it('restores persisted reasoning and non-web tool parts when server history omits them', async () => {
    const firstMock = createAdapterMock();
    const firstApi = useCodexApi({ adapterFactory: () => firstMock.adapter });
    await firstApi.connect();
    await firstApi.sendPrompt('Persist auxiliary history.');

    firstMock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'reasoning-persisted',
          type: 'reasoning',
          summary: ['Inspecting the command'],
          content: [],
        },
      },
    });
    firstMock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'command-persisted',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          status: 'inProgress',
        },
      },
    });
    firstMock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'command-persisted',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          status: 'completed',
          aggregatedOutput: '/repo\n',
        },
      },
    });

    const cacheKey = 'state.codexAuxiliaryHistory.v1.thr_existing';
    await vi.waitFor(() => {
      const cached = storageGetJSON<{ entries?: Array<{ parts?: Array<{ id?: string }> }> }>(
        cacheKey,
      );
      expect(cached?.entries?.flatMap((entry) => entry.parts ?? []).map((part) => part.id)).toEqual(
        expect.arrayContaining(['reasoning-persisted', 'command-persisted']),
      );
    });
    firstApi.disconnect();

    const secondMock = createAdapterMock();
    const secondApi = useCodexApi({ adapterFactory: () => secondMock.adapter });
    await secondApi.connect();
    await secondApi.selectThread('thr_existing');

    const restoredParts = secondApi.realtimeHistoryQueue.value.flatMap((entry) => entry.parts);
    expect(restoredParts.filter((part) => part.id === 'reasoning-persisted')).toHaveLength(1);
    expect(restoredParts.filter((part) => part.id === 'command-persisted')).toHaveLength(1);
    expect(restoredParts.find((part) => part.id === 'command-persisted')).toMatchObject({
      type: 'tool',
      state: { status: 'completed', output: '/repo\n' },
    });
  });
});
