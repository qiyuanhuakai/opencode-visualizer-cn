import { ref } from 'vue';
import { vi } from 'vitest';
import { useBackendSessionReload } from './useBackendSessionReload';

export type ReloadOptions = Parameters<typeof useBackendSessionReload>[0];

export function createSessionReloadFixture(overrides: Partial<ReloadOptions> = {}) {
  const msg = {
    saveSessionState: vi.fn<ReloadOptions['msg']['saveSessionState']>(),
    reset: vi.fn<ReloadOptions['msg']['reset']>(),
    loadHistory: vi.fn<ReloadOptions['msg']['loadHistory']>(),
    tryLoadFromCache: vi.fn<ReloadOptions['msg']['tryLoadFromCache']>(() => false),
  };
  const fetchRootSessionHistory = vi.fn<ReloadOptions['fetchRootSessionHistory']>(async () => ({
    requestId: 1,
    loaded: true,
  }));
  const waitForPendingRenders = vi.fn<ReloadOptions['waitForPendingRenders']>(async () => {});
  const reserveRootHistoryRequestId = vi.fn<ReloadOptions['reserveRootHistoryRequestId']>(() => 1);
  const scheduleDescendantSessionHistoryHydration =
    vi.fn<ReloadOptions['scheduleDescendantSessionHistoryHydration']>();
  const selectThread = vi.fn<ReloadOptions['codexApi']['selectThread']>(async () => {});
  const options = {
    activeBackendKind: ref('opencode'),
    activeDirectory: ref('/repo'),
    getMessageCacheNamespace: () => 'test:/repo',
    uiInitState: ref('ready'),
    isBootstrapping: ref(false),
    isLoadingHistory: ref(false),
    deferredSessionReloadId: ref<string | null>(null),
    sessionReloadRequestId: ref(0),
    hydratedDescendantSessionIds: new Set<string>(),
    msg,
    fwCloseAll: vi.fn<ReloadOptions['fwCloseAll']>(),
    resetFollow: vi.fn<ReloadOptions['resetFollow']>(),
    reasoningReset: vi.fn<ReloadOptions['reasoningReset']>(),
    subagentWindowsReset: vi.fn<ReloadOptions['subagentWindowsReset']>(),
    clearRetryStatus: vi.fn<ReloadOptions['clearRetryStatus']>(),
    codexApi: {
      activeThreadId: ref(''),
      selectThread,
    },
    codexHistory: ref<unknown[]>([]),
    codexReapplyBackfill: vi.fn<ReloadOptions['codexReapplyBackfill']>(),
    fetchRootSessionHistory,
    waitForPendingRenders,
    reserveRootHistoryRequestId,
    scheduleDescendantSessionHistoryHydration,
    anchorOutputToBottom: vi.fn<ReloadOptions['anchorOutputToBottom']>(async () => {}),
    restoreShellSessions: vi.fn<ReloadOptions['restoreShellSessions']>(async () => {}),
    reloadTodosForAllowedSessions: vi.fn<ReloadOptions['reloadTodosForAllowedSessions']>(),
    fetchPendingPermissions: vi.fn<ReloadOptions['fetchPendingPermissions']>(),
    fetchPendingQuestions: vi.fn<ReloadOptions['fetchPendingQuestions']>(),
    focusInput: vi.fn<ReloadOptions['focusInput']>(),
    ...overrides,
  } satisfies ReloadOptions;

  return {
    options,
    reload: useBackendSessionReload(options),
    mocks: {
      msg,
      fetchRootSessionHistory,
      waitForPendingRenders,
      reserveRootHistoryRequestId,
      scheduleDescendantSessionHistoryHydration,
      selectThread,
    },
  };
}
