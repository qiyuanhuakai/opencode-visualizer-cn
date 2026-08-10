import { describe, expect, it, vi } from 'vitest';

import { installAsyncQuitCleanup, type QuitEvent } from '../../electron/asyncQuitCleanup.js';

describe('Electron async quit cleanup', () => {
  it('prevents quitting until cleanup finishes and resumes the graceful quit once', async () => {
    let beforeQuit: ((event: QuitEvent) => void) | undefined;
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () => new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
    );
    const app = {
      on: vi.fn((_event: 'before-quit', listener: (event: QuitEvent) => void) => {
        beforeQuit = listener;
      }),
      quit: vi.fn(),
    };
    installAsyncQuitCleanup(app, cleanup);
    const event = { preventDefault: vi.fn() };

    beforeQuit?.(event);
    beforeQuit?.(event);
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    finishCleanup?.();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    beforeQuit?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
});
