import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexAdapter, CodexPromptResult } from '../backends/codex/codexAdapter';
import { StorageKeys, storageGet, storageKey } from '../utils/storageKeys';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('never requests native archived threads through the VIS session refresh flow', async () => {
    const mock = createAdapterMock();
    const listThreadsMock = vi.fn().mockResolvedValue({
      data: [{ id: 'thr_active', preview: 'Active thread' }],
      nextCursor: null,
    });
    mock.adapter.listThreads = listThreadsMock;
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    expect(api.threads.value.map((thread) => thread.id)).toEqual(['thr_active']);
    expect(listThreadsMock).not.toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it('requests all Codex model providers when refreshing threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    expect(mock.adapter.listThreads).toHaveBeenLastCalledWith({
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
    });
  });

  it('merges explicit provider thread lists when custom providers are configured', async () => {
    const mock = createAdapterMock();
    mock.adapter.readConfig = vi.fn().mockResolvedValue({
      config: {
        model_provider: 'omniroute',
        model_providers: { omniroute: { name: 'OmniRoute' } },
      },
    });
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: 'custom-null', preview: 'Null custom', modelProvider: 'omniroute', updatedAt: 2 },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'official', preview: 'OpenAI', modelProvider: 'openai', updatedAt: 3 }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'custom-explicit', preview: 'Custom', modelProvider: 'omniroute', updatedAt: 1 },
        ],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();

    await vi.waitFor(() => {
      expect(api.threads.value.map((thread) => thread.id)).toEqual([
        'official',
        'custom-null',
        'custom-explicit',
      ]);
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(1, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(2, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: ['openai'],
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(3, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: ['omniroute'],
    });
  });

  it('ignores provider discovery from an older connection generation when the adapter is reused', async () => {
    const mock = createAdapterMock();
    const staleProviderConfig = deferred<Awaited<ReturnType<CodexAdapter['readConfig']>>>();
    const stalePanelConfig = deferred<Awaited<ReturnType<CodexAdapter['readConfig']>>>();
    const currentConfig = {
      config: {
        model_provider: 'current',
        model_providers: { current: { name: 'Current' } },
      },
    };
    mock.adapter.readConfig = vi
      .fn()
      .mockImplementationOnce(() => staleProviderConfig.promise)
      .mockImplementationOnce(() => stalePanelConfig.promise)
      .mockResolvedValue(currentConfig);
    let baseListCount = 0;
    mock.adapter.listThreads = vi.fn(({ modelProviders }: { modelProviders?: string[] | null }) => {
      if (modelProviders === null) {
        baseListCount += 1;
        const id = baseListCount === 1 ? 'first-base' : 'current-base';
        return Promise.resolve({ data: [{ id, preview: id }], nextCursor: null });
      }
      const providerId = modelProviders?.[0] ?? 'unknown';
      return Promise.resolve({
        data: [{ id: `${providerId}-thread`, preview: providerId, modelProvider: providerId }],
        nextCursor: null,
      });
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await vi.waitFor(() => expect(mock.adapter.readConfig).toHaveBeenCalledTimes(2));
    await api.connect();
    await vi.waitFor(() => {
      expect(api.config.value).toEqual(currentConfig);
      expect(api.threads.value.map((thread) => thread.id)).toContain('current-thread');
    });

    staleProviderConfig.resolve({
      config: {
        model_provider: 'stale',
        model_providers: { stale: { name: 'Stale' } },
      },
    });
    stalePanelConfig.resolve({ config: { model_provider: 'stale-panel' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.config.value).toEqual(currentConfig);
    expect(api.threads.value.map((thread) => thread.id)).not.toContain('stale-thread');
  });

  it('ignores stale thread enrichment after the same adapter reconnects', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const staleVcs = deferred<Awaited<ReturnType<CodexAdapter['getVcsInfo']>>>();
    mock.adapter.getVcsInfo = vi
      .fn()
      .mockImplementationOnce(() => staleVcs.promise)
      .mockResolvedValue({ root: '/current', branch: 'main' });
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'stale-thread', preview: 'Stale', cwd: '/repo' }],
        nextCursor: null,
      })
      .mockResolvedValue({
        data: [{ id: 'current-thread', preview: 'Current', cwd: '/repo' }],
        nextCursor: null,
      });

    const staleRefresh = api.refreshThreads({}, false);
    await vi.waitFor(() => expect(mock.adapter.getVcsInfo).toHaveBeenCalledWith('/repo'));
    const currentConnect = api.connect();
    await vi.waitFor(() => expect(mock.adapter.getVcsInfo).toHaveBeenCalledTimes(2));
    await currentConnect;
    expect(api.threads.value.map((thread) => thread.id)).toContain('current-thread');
    expect(api.threads.value.map((thread) => thread.id)).not.toContain('stale-thread');

    staleVcs.resolve({ root: '/repo', branch: 'old' });
    await staleRefresh;

    expect(api.threads.value.map((thread) => thread.id)).toContain('current-thread');
    expect(api.threads.value.map((thread) => thread.id)).not.toContain('stale-thread');
  });

  it('can force a new thread instead of resuming the active thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.sendPrompt('Start on the selected provider.', {
      threadId: 'thr_existing',
      forceNewThread: true,
      model: 'mimo/mimo-v2.5',
      cwd: '/repo',
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
      text: 'Start on the selected provider.',
      model: 'mimo/mimo-v2.5',
      cwd: '/repo',
    });
  });

  it('preserves a newly materialized active thread when list refresh is temporarily stale', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockResolvedValue({
      threadId: 'thr_materialized',
      thread: { id: 'thr_materialized', preview: 'New prompt', cwd: '/repo' },
      turn: { id: 'turn_2', status: 'inProgress' },
    } satisfies CodexPromptResult);
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo' }],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('First prompt.', { threadId: 'thr_empty', cwd: '/repo' });
    await api.refreshThreads();

    expect(api.activeThreadId.value).toBe('thr_materialized');
    expect(api.threads.value.map((thread) => thread.id)).toContain('thr_materialized');
  });

  it('updates state from thread and agent delta notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({ method: 'thread/started', params: { thread: { id: 'thr_stream', preview: '' } } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', Codex.' } });

    expect(api.activeThreadId.value).toBe('thr_existing');
    await vi.waitFor(() => {
      expect(api.threads.value[0]).toEqual({ id: 'thr_stream', preview: '' });
    });
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'assistant', text: 'Hello, Codex.' }),
    ]);
    expect(api.events.value.map((event) => event.method)).toEqual([
      'thread/started',
      'item/agentMessage/delta',
      'item/agentMessage/delta',
    ]);
  });

  it('refreshes and updates thread names from notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({
      method: 'thread/name/updated',
      params: { threadId: 'thr_existing', name: 'Renamed' },
    });

    expect(api.threads.value[0]).toEqual(
      expect.objectContaining({
        id: 'thr_existing',
        name: 'Renamed',
      }),
    );
    await vi.waitFor(() => {
      expect(mock.adapter.listThreads).toHaveBeenCalledTimes(2);
    });
  });

  it('renames, archives, unsubscribes, and interrupts active Codex threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.setThreadName('thr_existing', '  Renamed by user  ');
    await api.sendPrompt('Continue.');
    await api.interruptActiveTurn();
    await api.unsubscribeThread('thr_existing');
    await api.archiveThread('thr_existing');

    expect(mock.adapter.setThreadName).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      name: 'Renamed by user',
    });
    expect(mock.adapter.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      turnId: 'turn_1',
    });
    expect(mock.adapter.unsubscribeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.activeThreadId.value).toBe('');
    expect(api.activeTurn.value).toBeNull();
  });

  it('hides empty no-rollout threads when archive is rejected by Codex', async () => {
    const mock = createAdapterMock();
    mock.adapter.archiveThread = vi
      .fn()
      .mockRejectedValue(new Error('no rollout found for thread id thr_existing'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.archiveThread('thr_existing');

    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value).toEqual([]);
    expect(api.activeThreadId.value).toBe('');
    expect(api.errorMessage.value).toBe('');
  });

  it('forks and rolls back threads through the adapter', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.forkThread('thr_existing');
    expect(api.activeThreadId.value).toBe('thr_fork');
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_fork prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_fork answer' }),
    ]);

    await api.selectThread('thr_existing');
    await api.rollbackThread('thr_existing', 1);

    expect(mock.adapter.forkThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.rollbackThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      numTurns: 1,
    });
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
  });

  it('locally hides threads with in-memory state', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.hideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value.length).toBe(0);

    api.unhideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(false);
    expect(api.visibleThreads.value.length).toBe(1);
  });

  describe('monotonic timestamp protection', () => {
    it('preserves existing createdAt/updatedAt when upsertThread receives older values', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_stale', preview: 'Stale', createdAt: 1000, updatedAt: 2000 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_stale', preview: 'Stale', createdAt: 1000, updatedAt: 2000 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_stale', preview: 'Stale', createdAt: 50, updatedAt: 150 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      expect(api.threads.value.find((t) => t.id === 'thr_stale')?.createdAt).toBe(1000);
      expect(api.threads.value.find((t) => t.id === 'thr_stale')?.updatedAt).toBe(2000);

      await api.refreshThreads();

      const thread = api.threads.value.find((t) => t.id === 'thr_stale');
      expect(thread?.createdAt).toBe(1000);
      expect(thread?.updatedAt).toBe(2000);
    });

    it('accepts incoming createdAt/updatedAt when they are larger than existing', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_growing', preview: 'Growing', createdAt: 100, updatedAt: 200 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_growing', preview: 'Growing', createdAt: 100, updatedAt: 200 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_growing', preview: 'Growing', createdAt: 150, updatedAt: 250 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      await api.refreshThreads();

      const thread = api.threads.value.find((t) => t.id === 'thr_growing');
      expect(thread?.createdAt).toBe(150);
      expect(thread?.updatedAt).toBe(250);
    });

    it('uses incoming createdAt/updatedAt when no existing value is present', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'thr_fresh', preview: 'Fresh', createdAt: 300, updatedAt: 400 }],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      const thread = api.threads.value.find((t) => t.id === 'thr_fresh');
      expect(thread?.createdAt).toBe(300);
      expect(thread?.updatedAt).toBe(400);
    });

    it('handles undefined existing timestamps without regressing incoming values', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_mixed', preview: 'Mixed' }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_mixed', preview: 'Mixed', createdAt: 10, updatedAt: 20 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      const thread = api.threads.value.find((t) => t.id === 'thr_mixed');
      expect(thread?.createdAt).toBe(10);
      expect(thread?.updatedAt).toBe(20);
    });

    it('does not regress timestamps when merging thread reads (mergeThreadReadResult)', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValue({
        data: [{ id: 'thr_read', preview: 'Read', createdAt: 500, updatedAt: 600 }],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.adapter.readThread = vi.fn().mockResolvedValue({
        thread: { id: 'thr_read', preview: 'Read', createdAt: 1, updatedAt: 2 },
        turns: [],
      });
      await api.selectThread('thr_read');

      const thread = api.threads.value.find((t) => t.id === 'thr_read');
      expect(thread?.createdAt).toBe(500);
      expect(thread?.updatedAt).toBe(600);
    });

    it('integration: refreshThreads does not regress previous session timestamps when the latest fetch returns older data for a known thread', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            { id: 'thr_latest', preview: 'Latest', createdAt: 1000, updatedAt: 5000 },
            { id: 'thr_middle', preview: 'Middle', createdAt: 500, updatedAt: 3000 },
            { id: 'thr_oldest', preview: 'Oldest', createdAt: 100, updatedAt: 1000 },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            { id: 'thr_latest', preview: 'Latest', createdAt: 0, updatedAt: 0 },
            { id: 'thr_middle', preview: 'Middle', createdAt: 0, updatedAt: 0 },
            { id: 'thr_oldest', preview: 'Oldest', createdAt: 0, updatedAt: 0 },
          ],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      const byId = (id: string) => api.threads.value.find((t) => t.id === id);
      expect(byId('thr_latest')?.createdAt).toBe(1000);
      expect(byId('thr_latest')?.updatedAt).toBe(5000);
      expect(byId('thr_middle')?.createdAt).toBe(500);
      expect(byId('thr_middle')?.updatedAt).toBe(3000);
      expect(byId('thr_oldest')?.createdAt).toBe(100);
      expect(byId('thr_oldest')?.updatedAt).toBe(1000);
    });

    it('preserves monotonic timestamps when merging threads across multiple providers', async () => {
      const mock = createAdapterMock();
      mock.adapter.readConfig = vi.fn().mockResolvedValue({
        config: {
          model_provider: 'omniroute',
          model_providers: { omniroute: { name: 'OmniRoute' } },
        },
      });
      mock.adapter.listThreads = vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              id: 'thr_shared',
              preview: 'Shared',
              modelProvider: 'openai',
              createdAt: 900,
              updatedAt: 950,
            },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'thr_shared',
              preview: 'Shared',
              modelProvider: 'openai',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'thr_shared',
              preview: 'Shared',
              modelProvider: 'omniroute',
              createdAt: 100,
              updatedAt: 200,
            },
          ],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      const shared = api.threads.value.find((t) => t.id === 'thr_shared');
      expect(shared?.createdAt).toBe(900);
      expect(shared?.updatedAt).toBe(950);
    });
  });

  describe('activeThreadId persistence', () => {
    it('restores the active thread from storage on init', () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_restored');

      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });

      expect(api.activeThreadId.value).toBe('thr_restored');
    });

    it('persists the active thread to storage when it changes to a non-empty value', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_one', preview: 'One' },
          { id: 'thr_two', preview: 'Two' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      await api.selectThread('thr_two');

      expect(api.activeThreadId.value).toBe('thr_two');
      expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_two');
    });

    it('does not overwrite the persisted active thread when it is cleared to empty', async () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_keep');

      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_keep', preview: 'Keep' },
          { id: 'thr_other', preview: 'Other' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      api.activeThreadId.value = '';

      expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_keep');
    });

    it('clears a stale persisted active thread and falls back to the first thread on refresh', async () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_deleted');

      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_alpha', preview: 'Alpha' },
          { id: 'thr_beta', preview: 'Beta' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      expect(api.activeThreadId.value).toBe('thr_alpha');
      expect(api.threads.value.map((t) => t.id)).toEqual(['thr_alpha', 'thr_beta']);
    });

    it('keeps the persisted active thread when the thread still exists in the refreshed list', async () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_persisted');

      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_other', preview: 'Other' },
          { id: 'thr_persisted', preview: 'Persisted' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      expect(api.activeThreadId.value).toBe('thr_persisted');
    });

    it('isolates codex activeThread from opencode session storage', async () => {
      localStorage.setItem(storageKey('state.sessionId'), 'opc_session');
      localStorage.setItem(storageKey('state.pinnedSessions'), JSON.stringify(['opc_session']));

      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });

      expect(api.activeThreadId.value).toBe('');
      expect(storageGet(StorageKeys.state.codexActiveThread)).toBeNull();
    });
  });
});
