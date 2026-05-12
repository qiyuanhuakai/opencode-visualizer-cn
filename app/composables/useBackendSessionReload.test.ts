import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionReload } from './useBackendSessionReload';

describe('useBackendSessionReload', () => {
  it('reloads Codex session history through unified reload runtime', async () => {
    const msg = {
      saveSessionState: vi.fn(),
      reset: vi.fn(),
      loadHistory: vi.fn(),
      tryLoadFromCache: vi.fn().mockReturnValue(false),
    };
    const selectThread = vi.fn().mockResolvedValue(undefined);
    const reload = useBackendSessionReload({
      activeBackendKind: ref('codex'),
      activeDirectory: ref('/repo'),
      uiInitState: ref('ready'),
      isBootstrapping: ref(false),
      isLoadingHistory: ref(false),
      deferredSessionReloadId: ref<string | null>(null),
      sessionReloadRequestId: ref(0),
      hydratedDescendantSessionIds: new Set<string>(),
      msg,
      fwCloseAll: vi.fn(),
      resetFollow: vi.fn(),
      reasoningReset: vi.fn(),
      subagentWindowsReset: vi.fn(),
      clearRetryStatus: vi.fn(),
      codexApi: {
        activeThreadId: ref('other-thread'),
        selectThread,
      },
      codexHistory: ref([{ id: 'history-1' }]),
      codexReapplyBackfill: vi.fn(),
      fetchRootSessionHistory: vi.fn(),
      waitForPendingRenders: vi.fn(),
      reserveRootHistoryRequestId: vi.fn(),
      scheduleDescendantSessionHistoryHydration: vi.fn(),
      anchorOutputToBottom: vi.fn().mockResolvedValue(undefined),
      restoreShellSessions: vi.fn().mockResolvedValue(undefined),
      reloadTodosForAllowedSessions: vi.fn(),
      fetchPendingPermissions: vi.fn(),
      fetchPendingQuestions: vi.fn(),
      focusInput: vi.fn(),
    });

    await reload.reloadSelectedSessionState('thread-1', 'thread-old');

    expect(msg.saveSessionState).toHaveBeenCalledWith('thread-old');
    expect(selectThread).toHaveBeenCalledWith('thread-1');
    expect(msg.reset).toHaveBeenCalled();
    expect(msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }]);
  });

  it('uses cache for OpenCode session reload and skips root fetch', async () => {
    const msg = {
      saveSessionState: vi.fn(),
      reset: vi.fn(),
      loadHistory: vi.fn(),
      tryLoadFromCache: vi.fn().mockReturnValue(true),
    };
    const fetchRootSessionHistory = vi.fn();
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const reload = useBackendSessionReload({
      activeBackendKind: ref('opencode'),
      activeDirectory: ref('/repo'),
      uiInitState: ref('ready'),
      isBootstrapping: ref(false),
      isLoadingHistory: ref(false),
      deferredSessionReloadId: ref<string | null>(null),
      sessionReloadRequestId: ref(0),
      hydratedDescendantSessionIds: new Set<string>(),
      msg,
      fwCloseAll: vi.fn(),
      resetFollow: vi.fn(),
      reasoningReset: vi.fn(),
      subagentWindowsReset: vi.fn(),
      clearRetryStatus: vi.fn(),
      codexApi: {
        activeThreadId: ref(''),
        selectThread: vi.fn(),
      },
      codexHistory: ref([]),
      codexReapplyBackfill: vi.fn(),
      fetchRootSessionHistory,
      waitForPendingRenders: vi.fn(),
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(7),
      scheduleDescendantSessionHistoryHydration,
      anchorOutputToBottom: vi.fn().mockResolvedValue(undefined),
      restoreShellSessions: vi.fn().mockResolvedValue(undefined),
      reloadTodosForAllowedSessions: vi.fn(),
      fetchPendingPermissions: vi.fn(),
      fetchPendingQuestions: vi.fn(),
      focusInput: vi.fn(),
    });

    await reload.reloadSelectedSessionState('session-1');

    expect(msg.tryLoadFromCache).toHaveBeenCalledWith('session-1');
    expect(fetchRootSessionHistory).not.toHaveBeenCalled();
    expect(scheduleDescendantSessionHistoryHydration).toHaveBeenCalledWith('session-1', 7, 1);
  });
});
