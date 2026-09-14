import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

const response = {
  reviewThreadId: 'thr_existing',
  turn: {
    id: 'review-turn', status: 'inProgress',
    items: [{ id: 'review-user', type: 'userMessage', content: [{ type: 'text', text: 'Review current changes' }] }],
  },
};

describe('Codex review lifecycle', () => {
  beforeEach(resetCodexApiTestState);

  it('projects the review response turn and prompt before item notifications arrive', async () => {
    const mock = createAdapterMock();
    mock.adapter.reviewStart = vi.fn().mockResolvedValue(response);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.reviewThread({ type: 'uncommittedChanges' });
    expect(api.activeTurn.value).toMatchObject({ id: 'review-turn', status: 'inProgress' });
    expect(api.threads.value.find(thread => thread.id === 'thr_existing')?.status).toBe('active');
    expect(api.reviewState.value).toBe('reviewing');
    expect(api.realtimeHistoryQueue.value).toContainEqual(expect.objectContaining({
      info: expect.objectContaining({ id: 'review-turn:user:review-user', role: 'user' }),
      parts: [expect.objectContaining({ type: 'text', text: 'Review current changes' })],
    }));
    mock.emit({ method: 'item/started', params: { threadId: 'thr_existing', turnId: 'review-turn',
      item: { id: 'review-command', type: 'commandExecution', command: 'git diff', status: 'inProgress' } } });
    expect(api.realtimeToolParts.value[0]?.info).toMatchObject({ parentID: 'review-turn:user:review-user' });
  });

  it('does not reopen a completed review when its start response arrives late', async () => {
    const mock = createAdapterMock();
    const started = deferred<typeof response>();
    mock.adapter.reviewStart = vi.fn(() => started.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const pending = api.reviewThread({ type: 'uncommittedChanges' });
    mock.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: response.turn } });
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'review-turn',
      item: { id: 'review-exit', type: 'exitedReviewMode', review: 'Looks good' } } });
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { ...response.turn, status: 'completed' } } });
    started.resolve(response);
    await pending;
    expect(api.activeTurn.value?.status).toBe('completed');
    expect(api.threads.value.find(thread => thread.id === 'thr_existing')?.status).toBe('idle');
    expect(api.reviewState.value).toBe('completed');
  });

  it('does not publish a review response into a different selected thread', async () => {
    const mock = createAdapterMock();
    const started = deferred<typeof response>();
    mock.adapter.reviewStart = vi.fn(() => started.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const pending = api.reviewThread({ type: 'uncommittedChanges' });
    await api.selectThread('thr_other');
    started.resolve(response);
    await pending;
    expect(api.activeThreadId.value).toBe('thr_other');
    expect(api.activeTurn.value).toBeNull();
    expect(api.realtimeHistoryQueue.value.some(entry => entry.info.sessionID === 'thr_existing')).toBe(false);
  });
});
