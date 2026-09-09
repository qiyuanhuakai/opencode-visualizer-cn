import { describe, expect, it, vi } from 'vitest';
import type { CodexAdapter } from './codexAdapter';
import { CodexJsonRpcError } from './jsonRpcClient';
import { createCodexHistoryReader } from './history';

type HistorySource = Pick<CodexAdapter, 'listThreadTurns' | 'readThread'>;

function createSource(): HistorySource {
  return {
    readThread: vi.fn<HistorySource['readThread']>(),
    listThreadTurns: vi.fn<HistorySource['listThreadTurns']>(),
  };
}

describe('createCodexHistoryReader', () => {
  it('falls back from unsupported hydrated reads and retrieves every full turn page', async () => {
    const source = createSource();
    vi.mocked(source.readThread)
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValueOnce({
        thread: { id: 'thr_paginated', name: 'Paginated', historyMode: 'paginated' },
      });
    vi.mocked(source.listThreadTurns)
      .mockResolvedValueOnce({
        data: [{ id: 'turn_1', items: [{ type: 'userMessage' }] }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'turn_2', items: [{ type: 'agentMessage' }] }],
        nextCursor: null,
      });

    const readHistory = createCodexHistoryReader(source);
    const result = await readHistory('thr_paginated');

    expect(result).toEqual({
      thread: {
        id: 'thr_paginated',
        name: 'Paginated',
        historyMode: 'paginated',
        turns: [
          { id: 'turn_1', items: [{ type: 'userMessage' }] },
          { id: 'turn_2', items: [{ type: 'agentMessage' }] },
        ],
      },
    });
    expect(source.listThreadTurns).toHaveBeenNthCalledWith(1, {
      threadId: 'thr_paginated',
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    });
    expect(source.listThreadTurns).toHaveBeenNthCalledWith(2, {
      threadId: 'thr_paginated',
      cursor: 'page-2',
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    });
  });

  it('scopes unsupported hydrated-read capability to one reader runtime', async () => {
    const firstSource = createSource();
    vi.mocked(firstSource.readThread)
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValueOnce({ thread: { id: 'thr_1' } })
      .mockResolvedValueOnce({ thread: { id: 'thr_2' } });
    vi.mocked(firstSource.listThreadTurns).mockResolvedValue({ data: [], nextCursor: null });
    const firstRuntimeReader = createCodexHistoryReader(firstSource);

    await firstRuntimeReader('thr_1');
    await firstRuntimeReader('thr_2');

    expect(firstSource.readThread).toHaveBeenNthCalledWith(3, {
      threadId: 'thr_2',
      includeTurns: false,
    });

    const secondSource = createSource();
    vi.mocked(secondSource.readThread).mockResolvedValue({
      thread: { id: 'thr_3', turns: [{ id: 'turn_3' }] },
    });

    await createCodexHistoryReader(secondSource)('thr_3');

    expect(secondSource.readThread).toHaveBeenCalledWith({
      threadId: 'thr_3',
      includeTurns: true,
    });
  });

  it('treats an unmaterialized thread as empty without disabling hydrated reads', async () => {
    const source = createSource();
    vi.mocked(source.readThread)
      .mockRejectedValueOnce(
        new CodexJsonRpcError(
          -32600,
          'thread thr_empty is not materialized yet; includeTurns is unavailable before first user message',
        ),
      )
      .mockResolvedValueOnce({ thread: { id: 'thr_empty', historyMode: 'paginated' } })
      .mockResolvedValueOnce({ thread: { id: 'thr_existing', turns: [{ id: 'turn_1' }] } });

    const readHistory = createCodexHistoryReader(source);

    await expect(readHistory('thr_empty')).resolves.toEqual({
      thread: { id: 'thr_empty', historyMode: 'paginated', turns: [] },
    });
    await readHistory('thr_existing');

    expect(source.listThreadTurns).not.toHaveBeenCalled();
    expect(source.readThread).toHaveBeenNthCalledWith(3, {
      threadId: 'thr_existing',
      includeTurns: true,
    });
  });

  it('propagates real hydrated-read failures without replacing stored history with empty turns', async () => {
    const source = createSource();
    const failure = new CodexJsonRpcError(-32600, 'invalid params: malformed thread id');
    vi.mocked(source.readThread).mockRejectedValue(failure);

    await expect(createCodexHistoryReader(source)('thr_bad')).rejects.toBe(failure);
    expect(source.readThread).toHaveBeenCalledOnce();
    expect(source.listThreadTurns).not.toHaveBeenCalled();
  });

  it('propagates an unsupported paginated read instead of reporting empty history', async () => {
    const source = createSource();
    vi.mocked(source.readThread)
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValueOnce({ thread: { id: 'thr_history', historyMode: 'paginated' } });
    const failure = new CodexJsonRpcError(-32601, 'Method not found');
    vi.mocked(source.listThreadTurns).mockRejectedValue(failure);

    await expect(createCodexHistoryReader(source)('thr_history')).rejects.toBe(failure);
  });
});
