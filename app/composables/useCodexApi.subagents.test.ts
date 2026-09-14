import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { CodexJsonRpcError } from '../backends/codex/jsonRpcClient';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('does not unsubscribe a newer child subscription when an older resume finishes late', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const parent = api.activeThreadId.value;
    let finishOld: ((value: { thread: { id: string } }) => void) | undefined;
    const oldResume = new Promise<{ thread: { id: string } }>((resolve) => {
      finishOld = resolve;
    });
    let childResumes = 0;
    mock.adapter.readThread = vi.fn(async ({ threadId }) => ({
      thread: { id: threadId, turns: [] },
    }));
    mock.adapter.resumeThread = vi.fn(({ threadId }) =>
      threadId === 'child' && childResumes++ === 0
        ? oldResume
        : Promise.resolve({ thread: { id: threadId, turns: [] } }),
    );
    const spawn = () =>
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: parent,
          turnId: 'parent-turn',
          item: {
            id: 'spawn',
            type: 'subAgentActivity',
            kind: 'started',
            agentThreadId: 'child',
            agentPath: '/root/reviewer',
          },
        },
      });
    spawn();
    await vi.waitFor(() => expect(childResumes).toBe(1));
    await api.selectThread('other');
    await api.selectThread(parent);
    spawn();
    await vi.waitFor(() => expect(childResumes).toBe(2));
    vi.mocked(mock.adapter.unsubscribeThread).mockClear();
    finishOld?.({ thread: { id: 'child' } });
    await oldResume;
    await Promise.resolve();
    expect(mock.adapter.unsubscribeThread).not.toHaveBeenCalled();
    api.disconnect();
  });

  it('subscribes linked children and forwards their real work without replacing parent history', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const parent = api.activeThreadId.value;
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: { id: 'review-child', model: 'review-model', modelProvider: 'codex', turns: [] },
    });
    mock.adapter.resumeThread = vi.fn().mockResolvedValue({
      thread: { id: 'review-child', model: 'review-model', modelProvider: 'codex', turns: [] },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: parent,
        turnId: 'parent-turn',
        item: {
          id: 'spawn',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'review-child',
          agentPath: '/root/review_agent_protocol',
        },
      },
    });
    await vi.waitFor(() =>
      expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'review-child' }),
    );
    mock.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'review-child',
        turnId: 'review-turn',
        itemId: 'answer',
        delta: 'Reviewing changes',
      },
    });
    expect(api.realtimeSubagentPart.value).toMatchObject({
      parentThreadId: parent,
      info: { sessionID: 'review-child', agent: 'review_agent_protocol', modelID: 'review-model' },
      part: { type: 'text', text: 'Reviewing changes' },
    });
    expect(api.activeThreadId.value).toBe(parent);
    expect(api.realtimeHistoryQueue.value.every((entry) => entry.info.sessionID === parent)).toBe(
      true,
    );
    api.disconnect();
  });

  it('subscribes a child before its history is materialized', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const parent = api.activeThreadId.value;
    mock.adapter.readThread = vi
      .fn()
      .mockRejectedValueOnce(
        new CodexJsonRpcError(
          -32600,
          'thread child is not materialized yet; includeTurns is unavailable before first user message',
        ),
      )
      .mockResolvedValue({ thread: { id: 'child', turns: [] } });
    mock.adapter.resumeThread = vi.fn().mockResolvedValue({ thread: { id: 'child', turns: [] } });

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: parent,
        turnId: 'parent-turn',
        item: { id: 'spawn', type: 'subAgentActivity', agentThreadId: 'child' },
      },
    });

    await vi.waitFor(() =>
      expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'child' }),
    );
    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'child',
      includeTurns: false,
    });
    mock.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        itemId: 'answer',
        delta: 'Working',
      },
    });
    expect(api.realtimeSubagentPart.value).toMatchObject({
      parentThreadId: parent,
      info: { sessionID: 'child' },
      part: { text: 'Working' },
    });
    api.disconnect();
  });

  it('catches up child commentary when resume returns metadata without turns', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const parent = api.activeThreadId.value;
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'child',
        turns: [
          {
            id: 'child-turn',
            status: 'completed',
            items: [
              {
                id: 'answer',
                type: 'agentMessage',
                phase: 'commentary',
                text: 'Finished checking',
              },
            ],
          },
        ],
      },
    });
    mock.adapter.resumeThread = vi.fn().mockResolvedValue({
      thread: { id: 'child', model: 'resumed-model', turns: [] },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: parent,
        turnId: 'parent-turn',
        item: { id: 'spawn', type: 'subAgentActivity', agentThreadId: 'child' },
      },
    });

    await vi.waitFor(() =>
      expect(api.realtimeSubagentPart.value).toMatchObject({
        parentThreadId: parent,
        info: { sessionID: 'child', modelID: 'resumed-model' },
        part: { text: 'Finished checking' },
      }),
    );
    api.disconnect();
  });

  it('keeps historical child commentary quiet when selecting a parent', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.readThread = vi.fn(async ({ threadId }) => ({
      thread: {
        id: threadId,
        status: { type: 'active' },
        turns: [
          {
            id: `${threadId}-turn`,
            status: 'completed',
            items:
              threadId === 'child'
                ? [
                    {
                      id: 'answer',
                      type: 'agentMessage',
                      phase: 'commentary',
                      text: 'Historical answer',
                    },
                  ]
                : [{ id: 'spawn', type: 'subAgentActivity', agentThreadId: 'child' }],
          },
        ],
      },
    }));
    mock.adapter.resumeThread = vi.fn(async ({ threadId }) => ({
      thread: { id: threadId, turns: [] },
    }));

    await api.selectThread('historical-parent');
    await vi.waitFor(() =>
      expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'child' }),
    );
    await Promise.resolve();

    expect(api.realtimeSubagentPart.value).toBeNull();
    api.disconnect();
  });

  it('retries a failed child resume when later activity rediscovers it', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const parent = api.activeThreadId.value;
    mock.adapter.readThread = vi.fn().mockResolvedValue({ thread: { id: 'child', turns: [] } });
    mock.adapter.resumeThread = vi
      .fn()
      .mockRejectedValueOnce(new CodexJsonRpcError(-32603, 'Child temporarily unavailable'))
      .mockResolvedValue({ thread: { id: 'child', turns: [] } });
    const spawn = () =>
      mock.emit({
        method: 'item/completed',
        params: {
          threadId: parent,
          turnId: 'parent-turn',
          item: { id: 'spawn', type: 'subAgentActivity', agentThreadId: 'child' },
        },
      });
    spawn();
    await vi.waitFor(() => expect(mock.adapter.resumeThread).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    spawn();

    await vi.waitFor(() => expect(mock.adapter.resumeThread).toHaveBeenCalledTimes(2));
    mock.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'child',
        turnId: 'child-turn',
        itemId: 'answer',
        delta: 'Recovered',
      },
    });
    expect(api.realtimeSubagentPart.value?.part).toMatchObject({ text: 'Recovered' });
    api.disconnect();
  });

  it('bridges subAgentActivity notifications and restores reviewer history after hydration', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const item = {
      type: 'subAgentActivity',
      id: 'review-start',
      kind: 'started',
      agentThreadId: 'child-review',
      agentPath: '/root/code_review',
    };
    mock.emit({
      method: 'item/started',
      params: { threadId: 'thr_existing', turnId: 'turn-review', item },
    });
    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      tool: 'task',
      state: { metadata: { sessionId: 'child-review' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { threadId: 'thr_existing', turnId: 'turn-review', item },
    });
    expect(api.realtimeCompletedPart.value?.part).toMatchObject({
      tool: 'task',
      state: { metadata: { agentPath: '/root/code_review' } },
    });
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', turns: [{ id: 'turn-review', items: [item] }] },
    });
    await api.selectThread('thr_existing');
    expect(api.canonicalHistory.value.flatMap((entry) => entry.parts)).toContainEqual(
      expect.objectContaining({ tool: 'task' }),
    );
  });

  it('reads child history without changing the selected parent session', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const parentHistory = api.canonicalHistory.value;
    const result = await api.readSubagentHistory('thr_child');
    expect(result.every((entry) => entry.info.sessionID === 'thr_child')).toBe(true);
    expect(
      result
        .flatMap((entry) => entry.parts)
        .some((part) => part.type === 'text' && part.text.includes('thr_child answer')),
    ).toBe(true);
    expect(api.activeThreadId.value).toBe('thr_existing');
    expect(api.canonicalHistory.value).toBe(parentHistory);
  });
});
