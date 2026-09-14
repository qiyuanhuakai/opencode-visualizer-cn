import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('Codex paginated conversation revert', () => {
  beforeEach(resetCodexApiTestState);

  it('preserves displayed history when a server rejects paginated revert', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const before = api.transcript.value;
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', historyMode: 'paginated', turns: [{ id: 'review', items: [] }] },
    });
    vi.mocked(mock.adapter.revertThread).mockRejectedValue(new Error('Method not found'));
    await expect(api.rollbackThread('thr_existing', 1)).rejects.toThrow('Method not found');
    expect(api.transcript.value).toBe(before);
    expect(mock.adapter.rollbackThread).not.toHaveBeenCalled();
    api.disconnect();
  });

  it.each(['review:user:request', 2])('reverts before the selected review turn for target %s', async (target) => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_existing',
        historyMode: 'paginated',
        turns: ['earlier', 'review', 'later'].map((id) => ({
          id,
          items: [{ type: 'userMessage', id: 'request', content: [{ type: 'text', text: id }] }],
        })),
      },
    });
    vi.mocked(mock.adapter.rollbackThread).mockRejectedValue(new Error('paginated threads do not support thread/rollback'));

    await expect(api.rollbackThread('thr_existing', target)).resolves.toMatchObject({ id: 'thr_existing' });

    expect(mock.adapter.revertThread).toHaveBeenCalledWith({ threadId: 'thr_existing', beforeTurnId: 'review' });
    expect(mock.adapter.rollbackThread).not.toHaveBeenCalled();
    api.disconnect();
  });
});
