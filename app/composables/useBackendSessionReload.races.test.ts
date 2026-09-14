import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createSessionReloadFixture } from './useBackendSessionReload.test-helpers';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const fixture = createSessionReloadFixture({
    activeBackendKind: ref<'opencode' | 'codex'>('opencode'),
  });
  return { ...fixture, ...fixture.reload };
}

afterEach(() => vi.unstubAllGlobals());

describe('session reload ownership', () => {
  it('clears loading when authentication invalidates a pending reload without selecting again', async () => {
    const { options, mocks, reloadSelectedSessionState, invalidateMessageCacheContext } = setup();
    const root = deferred<{ requestId: number; loaded: boolean }>();
    mocks.fetchRootSessionHistory.mockReturnValue(root.promise);
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
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const { options, mocks, reloadSelectedSessionState } = setup();
    const renders = deferred<void>();
    mocks.waitForPendingRenders.mockReturnValue(renders.promise);
    const pending = reloadSelectedSessionState('new-empty');
    await vi.waitFor(() => expect(mocks.waitForPendingRenders).toHaveBeenCalled());
    const loadingAfterResponse = options.isLoadingHistory.value;
    renders.resolve();
    await pending;
    expect(loadingAfterResponse).toBe(false);
  });

  it.each(['cached-empty', undefined])(
    'clears the old loading state when selecting %s',
    async (nextId) => {
      // Given a history request that remains pending during a switch.
      const { options, mocks, reloadSelectedSessionState } = setup();
      const root = deferred<{ requestId: number; loaded: boolean }>();
      mocks.fetchRootSessionHistory.mockReturnValue(root.promise);
      const first = reloadSelectedSessionState('slow');
      await vi.waitFor(() => expect(mocks.fetchRootSessionHistory).toHaveBeenCalled());
      expect(options.isLoadingHistory.value).toBe(true);
      mocks.msg.tryLoadFromCache.mockReturnValue(true);

      // When the new selection needs no network history, it owns the loading flag.
      await reloadSelectedSessionState(nextId, 'slow');
      const loadingAfterSwitch = options.isLoadingHistory.value;
      root.resolve({ requestId: 1, loaded: false });
      await first;

      // Then stale cleanup cannot leave the current empty/cache view spinning forever.
      expect(loadingAfterSwitch).toBe(false);
      expect(options.isLoadingHistory.value).toBe(false);
    },
  );

  it('does not publish Codex history after its selection request was superseded', async () => {
    const { options, mocks, reloadSelectedSessionState } = setup();
    options.activeBackendKind.value = 'codex';
    const selected = deferred<void>();
    mocks.selectThread.mockImplementation((id) =>
      id === 'slow' ? selected.promise : Promise.resolve(),
    );
    const first = reloadSelectedSessionState('slow');
    await vi.waitFor(() => expect(mocks.selectThread).toHaveBeenCalledWith('slow'));
    options.codexHistory.value = [{ id: 'current' }];
    await reloadSelectedSessionState('current', 'slow');
    mocks.msg.loadHistory.mockClear();
    mocks.msg.reset.mockClear();

    // When the old selection completes after the new thread is visible.
    selected.resolve();
    await first;

    // Then it must not reset or replace the current message view.
    expect(mocks.msg.reset).not.toHaveBeenCalled();
    expect(mocks.msg.loadHistory).not.toHaveBeenCalled();
  });

  it('does not enter history loading after being superseded during the reset tick', async () => {
    const { options, mocks, reloadSelectedSessionState } = setup();
    const pending = reloadSelectedSessionState('stale');
    await nextTick();
    options.sessionReloadRequestId.value += 1;
    await pending;
    expect(mocks.fetchRootSessionHistory).not.toHaveBeenCalled();
    expect(options.isLoadingHistory.value).toBe(false);
  });
});
