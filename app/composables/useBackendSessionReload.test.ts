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
      getMessageCacheNamespace: () => 'codex:http://127.0.0.1:4500:/repo',
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

    expect(msg.saveSessionState).not.toHaveBeenCalled();
    expect(selectThread).toHaveBeenCalledWith('thread-1');
    expect(msg.reset).toHaveBeenCalled();
    expect(msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }]);
  });

  it('does NOT call msg.reset on Codex page refresh (no oldId)', async () => {
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
      getMessageCacheNamespace: () => 'codex:http://127.0.0.1:4500:/repo',
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
        activeThreadId: ref('thread-1'),
        selectThread,
      },
      codexHistory: ref([{ id: 'history-1' }, { id: 'history-2' }]),
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

    await reload.reloadSelectedSessionState('thread-1', undefined);

    expect(msg.saveSessionState).not.toHaveBeenCalled();
    expect(selectThread).not.toHaveBeenCalled();
    expect(msg.reset).not.toHaveBeenCalled();
    expect(msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }, { id: 'history-2' }]);
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
      activeBackendKind: ref<'opencode'>('opencode'),
      activeDirectory: ref('/repo'),
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      uiInitState: ref<'ready'>('ready'),
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

    expect(msg.tryLoadFromCache).toHaveBeenCalledWith({
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
    const options = {
      activeBackendKind: ref<'opencode'>('opencode'),
      activeDirectory: ref('/repo'),
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      uiInitState: ref<'ready'>('ready'),
      isBootstrapping: ref(false),
      isLoadingHistory: ref(false),
      deferredSessionReloadId: ref<string | null>(null),
      sessionReloadRequestId,
      hydratedDescendantSessionIds: new Set<string>(),
      msg: {
        saveSessionState: vi.fn(),
        reset: vi.fn(),
        loadHistory: vi.fn(),
        tryLoadFromCache: vi.fn().mockReturnValue(true),
      },
      fwCloseAll: vi.fn(),
      resetFollow: vi.fn(),
      reasoningReset: vi.fn(),
      subagentWindowsReset: vi.fn(),
      clearRetryStatus: vi.fn(),
      codexApi: { activeThreadId: ref(''), selectThread: vi.fn() },
      codexHistory: ref([]),
      codexReapplyBackfill: vi.fn(),
      fetchRootSessionHistory: vi.fn(),
      waitForPendingRenders: vi.fn(),
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(12),
      scheduleDescendantSessionHistoryHydration,
      hydrateReferencedSubagents,
      anchorOutputToBottom: vi.fn().mockResolvedValue(undefined),
      restoreShellSessions: vi.fn().mockResolvedValue(undefined),
      reloadTodosForAllowedSessions: vi.fn(),
      fetchPendingPermissions: vi.fn(),
      fetchPendingQuestions: vi.fn(),
      focusInput: vi.fn(),
    };
    const reload = useBackendSessionReload(options);

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
    const options = {
      activeBackendKind: ref<'opencode'>('opencode'),
      activeDirectory: ref('/repo'),
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      uiInitState: ref<'ready'>('ready'),
      isBootstrapping: ref(false),
      isLoadingHistory: ref(false),
      deferredSessionReloadId: ref<string | null>(null),
      sessionReloadRequestId,
      hydratedDescendantSessionIds: new Set<string>(),
      msg: {
        saveSessionState: vi.fn(),
        reset: vi.fn(),
        loadHistory: vi.fn(),
        tryLoadFromCache: vi.fn().mockReturnValue(true),
      },
      fwCloseAll: vi.fn(),
      resetFollow: vi.fn(),
      reasoningReset: vi.fn(),
      subagentWindowsReset: vi.fn(),
      clearRetryStatus: vi.fn(),
      codexApi: { activeThreadId: ref(''), selectThread: vi.fn() },
      codexHistory: ref([]),
      codexReapplyBackfill: vi.fn(),
      fetchRootSessionHistory: vi.fn(),
      waitForPendingRenders: vi.fn(),
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(3),
      scheduleDescendantSessionHistoryHydration,
      hydrateReferencedSubagents: () =>
        new Promise<string[]>((resolve) => {
          finishHydration = resolve;
        }),
      anchorOutputToBottom: vi.fn().mockResolvedValue(undefined),
      restoreShellSessions: vi.fn().mockResolvedValue(undefined),
      reloadTodosForAllowedSessions: vi.fn(),
      fetchPendingPermissions: vi.fn(),
      fetchPendingQuestions: vi.fn(),
      focusInput: vi.fn(),
    };
    const reload = useBackendSessionReload(options);

    const pendingReload = reload.reloadSelectedSessionState('root-session');
    await vi.waitFor(() => expect(options.reserveRootHistoryRequestId).toHaveBeenCalled());
    sessionReloadRequestId.value += 1;
    finishHydration(['stale-child']);
    await pendingReload;

    expect(scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();
  });

  it('saves the old materialized view under its original backend identity', async () => {
    const activeBackendKind = ref<'opencode' | 'acp'>('opencode');
    const activeDirectory = ref('/repo-a');
    let namespace = 'opencode:http://127.0.0.1:4096:/repo-a';
    const msg = {
      saveSessionState: vi.fn(),
      reset: vi.fn(),
      loadHistory: vi.fn(),
      tryLoadFromCache: vi.fn().mockReturnValue(true),
    };
    const reload = useBackendSessionReload({
      activeBackendKind,
      activeDirectory,
      getMessageCacheNamespace: () => namespace,
      uiInitState: ref<'ready'>('ready'),
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
      codexApi: { activeThreadId: ref(''), selectThread: vi.fn() },
      codexHistory: ref([]),
      codexReapplyBackfill: vi.fn(),
      fetchRootSessionHistory: vi.fn(),
      waitForPendingRenders: vi.fn(),
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(1),
      scheduleDescendantSessionHistoryHydration: vi.fn(),
      anchorOutputToBottom: vi.fn().mockResolvedValue(undefined),
      restoreShellSessions: vi.fn().mockResolvedValue(undefined),
      reloadTodosForAllowedSessions: vi.fn(),
      fetchPendingPermissions: vi.fn(),
      fetchPendingQuestions: vi.fn(),
      focusInput: vi.fn(),
    });

    await reload.reloadSelectedSessionState('shared-session');
    activeBackendKind.value = 'acp';
    activeDirectory.value = '/repo-b';
    namespace = 'acp:agent-b:/repo-b';
    await reload.reloadSelectedSessionState('next-session', 'shared-session');

    expect(msg.saveSessionState).toHaveBeenCalledWith({
      namespace: 'opencode:http://127.0.0.1:4096:/repo-a',
      sessionId: 'shared-session',
    });
    expect(msg.tryLoadFromCache).toHaveBeenLastCalledWith({
      namespace: 'acp:agent-b:/repo-b',
      sessionId: 'next-session',
    });
  });
});
