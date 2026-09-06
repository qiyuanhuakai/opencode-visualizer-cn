import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useBackendSessionReload } from './useBackendSessionReload';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const options = {
    activeBackendKind: ref<'opencode' | 'codex'>('opencode'),
    activeDirectory: ref('/repo'),
    getMessageCacheNamespace: () => 'test:/repo',
    uiInitState: ref<'ready'>('ready'),
    isBootstrapping: ref(false),
    isLoadingHistory: ref(false),
    deferredSessionReloadId: ref<string | null>(null),
    sessionReloadRequestId: ref(0),
    hydratedDescendantSessionIds: new Set<string>(),
    msg: {
      saveSessionState: vi.fn(), reset: vi.fn(), loadHistory: vi.fn(),
      tryLoadFromCache: vi.fn(() => false),
    },
    fwCloseAll: vi.fn(), resetFollow: vi.fn(), reasoningReset: vi.fn(),
    subagentWindowsReset: vi.fn(), clearRetryStatus: vi.fn(),
    codexApi: { activeThreadId: ref(''), selectThread: vi.fn(async (_id: string) => {}) },
    codexHistory: ref<unknown[]>([]), codexReapplyBackfill: vi.fn(),
    fetchRootSessionHistory: vi.fn(async (_id: string) => ({ requestId: 1, loaded: true })),
    waitForPendingRenders: vi.fn(async () => {}),
    reserveRootHistoryRequestId: vi.fn(() => 1),
    scheduleDescendantSessionHistoryHydration: vi.fn(),
    anchorOutputToBottom: vi.fn(async () => {}), restoreShellSessions: vi.fn(async () => {}),
    reloadTodosForAllowedSessions: vi.fn(), fetchPendingPermissions: vi.fn(),
    fetchPendingQuestions: vi.fn(), focusInput: vi.fn(),
  };
  return { options, ...useBackendSessionReload(options) };
}

afterEach(() => vi.unstubAllGlobals());

describe('session reload ownership', () => {
  it('clears loading when authentication invalidates a pending reload without selecting again', async () => {
    const { options, reloadSelectedSessionState, invalidateMessageCacheContext } = setup();
    const root = deferred<{ requestId: number; loaded: boolean }>();
    options.fetchRootSessionHistory.mockReturnValue(root.promise);
    const pending = reloadSelectedSessionState('old-auth');
    await vi.waitFor(() => expect(options.isLoadingHistory.value).toBe(true));
    options.sessionReloadRequestId.value += 1;
    invalidateMessageCacheContext();
    const loadingAfterInvalidation = options.isLoadingHistory.value;
    root.resolve({ requestId: 1, loaded: false });
    await pending;
    expect(loadingAfterInvalidation).toBe(false);
    expect(options.isLoadingHistory.value).toBe(false);
  });

  it('finishes loading an empty history without waiting for unrelated worker renders', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const { options, reloadSelectedSessionState } = setup();
    const renders = deferred<void>();
    options.waitForPendingRenders.mockReturnValue(renders.promise);
    const pending = reloadSelectedSessionState('new-empty');
    await vi.waitFor(() => expect(options.waitForPendingRenders).toHaveBeenCalled());
    const loadingAfterResponse = options.isLoadingHistory.value;
    renders.resolve();
    await pending;
    expect(loadingAfterResponse).toBe(false);
  });

  it.each(['cached-empty', undefined])('clears the old loading state when selecting %s', async (nextId) => {
    // Given a history request that remains pending during a switch.
    const { options, reloadSelectedSessionState } = setup();
    const root = deferred<{ requestId: number; loaded: boolean }>();
    options.fetchRootSessionHistory.mockReturnValue(root.promise);
    const first = reloadSelectedSessionState('slow');
    await vi.waitFor(() => expect(options.fetchRootSessionHistory).toHaveBeenCalled());
    expect(options.isLoadingHistory.value).toBe(true);
    options.msg.tryLoadFromCache.mockReturnValue(true);

    // When the new selection needs no network history, it owns the loading flag.
    await reloadSelectedSessionState(nextId, 'slow');
    const loadingAfterSwitch = options.isLoadingHistory.value;
    root.resolve({ requestId: 1, loaded: false });
    await first;

    // Then stale cleanup cannot leave the current empty/cache view spinning forever.
    expect(loadingAfterSwitch).toBe(false);
    expect(options.isLoadingHistory.value).toBe(false);
  });

  it('does not publish Codex history after its selection request was superseded', async () => {
    const { options, reloadSelectedSessionState } = setup();
    options.activeBackendKind.value = 'codex';
    const selected = deferred<void>();
    options.codexApi.selectThread.mockImplementation((id) => id === 'slow' ? selected.promise : Promise.resolve());
    const first = reloadSelectedSessionState('slow');
    await vi.waitFor(() => expect(options.codexApi.selectThread).toHaveBeenCalledWith('slow'));
    options.codexHistory.value = [{ id: 'current' }];
    await reloadSelectedSessionState('current', 'slow');
    options.msg.loadHistory.mockClear();
    options.msg.reset.mockClear();

    // When the old selection completes after the new thread is visible.
    selected.resolve();
    await first;

    // Then it must not reset or replace the current message view.
    expect(options.msg.reset).not.toHaveBeenCalled();
    expect(options.msg.loadHistory).not.toHaveBeenCalled();
  });

  it('does not enter history loading after being superseded during the reset tick', async () => {
    const { options, reloadSelectedSessionState } = setup();
    const pending = reloadSelectedSessionState('stale');
    await nextTick();
    options.sessionReloadRequestId.value += 1;
    await pending;
    expect(options.fetchRootSessionHistory).not.toHaveBeenCalled();
    expect(options.isLoadingHistory.value).toBe(false);
  });
});
