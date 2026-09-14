import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createSessionReloadFixture } from './useBackendSessionReload.test-helpers';

describe('useBackendSessionReload', () => {
  it('keeps a completed root snapshot cacheable when child hydration fails', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const activeBackendKind = ref<'opencode'>('opencode');
    const activeDirectory = ref('/repo');
    const sessionReloadRequestId = ref(0);
    const deferredSessionReloadId = ref<string | null>(null);
    const hydrateReferencedSubagents = vi
      .fn()
      .mockRejectedValue(new Error('child hydration failed'));
    const fetchRootSessionHistory = vi.fn().mockResolvedValue({ requestId: 42, loaded: true });
    const {
      reload: { reloadSelectedSessionState },
      mocks,
    } = createSessionReloadFixture({
      activeBackendKind,
      activeDirectory,
      getMessageCacheNamespace: () => 'opencode:primary:/repo',
      sessionReloadRequestId,
      deferredSessionReloadId,
      fetchRootSessionHistory,
      hydrateReferencedSubagents,
    });

    try {
      await reloadSelectedSessionState('session-1');
      expect(hydrateReferencedSubagents).toHaveBeenCalledWith('session-1', 1);
      expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();

      await reloadSelectedSessionState('session-2', 'session-1');

      expect(mocks.msg.saveSessionState).toHaveBeenCalledWith({
        namespace: 'opencode:primary:/repo',
        sessionId: 'session-1',
      });

      fetchRootSessionHistory.mockResolvedValue({ requestId: 43, loaded: false });
      await reloadSelectedSessionState('session-failed', 'session-2');
      mocks.msg.saveSessionState.mockClear();

      await reloadSelectedSessionState('session-3', 'session-failed');

      expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads Codex session history through unified reload runtime', async () => {
    const selectThread = vi.fn().mockResolvedValue(undefined);
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref('codex'),
      getMessageCacheNamespace: () => 'codex:http://127.0.0.1:4500:/repo',
      codexApi: {
        activeThreadId: ref('other-thread'),
        selectThread,
      },
      codexHistory: ref([{ id: 'history-1' }]),
    });

    await reload.reloadSelectedSessionState('thread-1', 'thread-old');

    expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();
    expect(selectThread).toHaveBeenCalledWith('thread-1');
    expect(mocks.msg.reset).toHaveBeenCalled();
    expect(mocks.msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }]);
  });

  it.each([false, true])(
    'resets Codex same-session history only when explicitly requested: %s',
    async (forceReset) => {
      const selectThread = vi.fn().mockResolvedValue(undefined);
      const { reload, mocks } = createSessionReloadFixture({
        activeBackendKind: ref('codex'),
        getMessageCacheNamespace: () => 'codex:http://127.0.0.1:4500:/repo',
        codexApi: {
          activeThreadId: ref('thread-1'),
          selectThread,
        },
        codexHistory: ref([{ id: 'history-1' }, { id: 'history-2' }]),
      });

      await reload.reloadSelectedSessionState('thread-1', undefined, forceReset);

      expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();
      expect(selectThread).not.toHaveBeenCalled();
      expect(mocks.msg.reset).toHaveBeenCalledTimes(forceReset ? 1 : 0);
      expect(mocks.msg.loadHistory).toHaveBeenCalledWith([
        { id: 'history-1' },
        { id: 'history-2' },
      ]);
    },
  );

  it('uses cache for OpenCode session reload and skips root fetch', async () => {
    const fetchRootSessionHistory = vi.fn();
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'opencode'>('opencode'),
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      fetchRootSessionHistory,
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(7),
      scheduleDescendantSessionHistoryHydration,
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    await reload.reloadSelectedSessionState('session-1');

    expect(mocks.msg.tryLoadFromCache).toHaveBeenCalledWith({
      namespace: 'opencode:http://127.0.0.1:4096:/repo',
      sessionId: 'session-1',
    });
    expect(fetchRootSessionHistory).not.toHaveBeenCalled();
    expect(scheduleDescendantSessionHistoryHydration).toHaveBeenCalledWith('session-1', 7, 1);
  });

  it('waits for referenced subagent metadata before hydrating exact child histories', async () => {
    let finishHydration: (sessionIds: string[]) => void = () => {};
    const hydrateReferencedSubagents = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finishHydration = resolve;
        }),
    );
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const sessionReloadRequestId = ref(0);
    const { reload, mocks } = createSessionReloadFixture({
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      sessionReloadRequestId,
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(12),
      scheduleDescendantSessionHistoryHydration,
      hydrateReferencedSubagents,
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    const pendingReload = reload.reloadSelectedSessionState('root-session');
    await vi.waitFor(() =>
      expect(hydrateReferencedSubagents).toHaveBeenCalledWith('root-session', 1),
    );
    expect(scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();

    finishHydration(['child-a', 'child-b']);
    await pendingReload;

    expect(scheduleDescendantSessionHistoryHydration).toHaveBeenCalledWith('root-session', 12, 1, [
      'child-a',
      'child-b',
    ]);
  });

  it('does not schedule child history after a metadata wait is superseded', async () => {
    let finishHydration: (sessionIds: string[]) => void = () => {};
    const sessionReloadRequestId = ref(0);
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const reserveRootHistoryRequestId = vi.fn().mockReturnValue(3);
    const { reload, mocks } = createSessionReloadFixture({
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      sessionReloadRequestId,
      reserveRootHistoryRequestId,
      scheduleDescendantSessionHistoryHydration,
      hydrateReferencedSubagents: () =>
        new Promise<string[]>((resolve) => {
          finishHydration = resolve;
        }),
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    const pendingReload = reload.reloadSelectedSessionState('root-session');
    await vi.waitFor(() => expect(reserveRootHistoryRequestId).toHaveBeenCalled());
    sessionReloadRequestId.value += 1;
    finishHydration(['stale-child']);
    await pendingReload;

    expect(scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();
  });

  it('saves the old materialized view under its original backend identity', async () => {
    const activeBackendKind = ref<'opencode' | 'acp'>('opencode');
    const activeDirectory = ref('/repo-a');
    let namespace = 'opencode:http://127.0.0.1:4096:/repo-a';
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind,
      activeDirectory,
      getMessageCacheNamespace: () => namespace,
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    await reload.reloadSelectedSessionState('shared-session');
    activeBackendKind.value = 'acp';
    activeDirectory.value = '/repo-b';
    namespace = 'acp:agent-b:/repo-b';
    await reload.reloadSelectedSessionState('next-session', 'shared-session');

    expect(mocks.msg.saveSessionState).toHaveBeenCalledWith({
      namespace: 'opencode:http://127.0.0.1:4096:/repo-a',
      sessionId: 'shared-session',
    });
    expect(mocks.msg.tryLoadFromCache).toHaveBeenLastCalledWith({
      namespace: 'acp:agent-b:/repo-b',
      sessionId: 'next-session',
    });
  });
});
