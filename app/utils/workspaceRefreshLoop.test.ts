import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceRefreshLoop } from './workspaceRefreshLoop';

describe('createWorkspaceRefreshLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pauses while inactive and coalesces attention events into one refresh', async () => {
    let hidden = true;
    let focused = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const refresh = vi.fn(async () => {});
    const loop = createWorkspaceRefreshLoop(refresh, { intervalMs: 5_000 });
    loop.start();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).not.toHaveBeenCalled();

    hidden = false;
    focused = true;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('waits for a slow refresh before scheduling the next one', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let releaseFirstRefresh: VoidFunction | undefined;
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRefresh = resolve;
        });
      }
    });
    const loop = createWorkspaceRefreshLoop(refresh, { intervalMs: 5_000 });
    loop.start();

    await vi.advanceTimersByTimeAsync(5_000);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    if (!releaseFirstRefresh) throw new Error('expected the disk refresh to be waiting');
    releaseFirstRefresh();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it('continues scheduling after a refresh rejects', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const loop = createWorkspaceRefreshLoop(refresh, { intervalMs: 5_000, onError });
    loop.start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'refresh failed' }));
    loop.stop();
  });
});
