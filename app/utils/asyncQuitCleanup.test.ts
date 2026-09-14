import { describe, expect, it, vi } from 'vitest';

import {
  cleanupAsyncQuitOwners,
  installAsyncQuitCleanup,
  type QuitEvent,
} from '../../electron/asyncQuitCleanup.js';

describe('Electron async quit cleanup', () => {
  it('executes the main-process quit seam with editor and desktop runtime cleanup together', async () => {
    // Given: the cleanup owners passed to the production composition helper.
    const closeAll = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);

    // When: the actual composition helper used by main is awaited.
    await cleanupAsyncQuitOwners({ closeAll }, { dispose });

    // Then: both asynchronous owners complete through the same bounded quit gate.
    expect(closeAll).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps the editor cleanup unchanged when the optional desktop owner is absent', async () => {
    const closeAll = vi.fn(async () => undefined);

    await cleanupAsyncQuitOwners({ closeAll }, null);

    expect(closeAll).toHaveBeenCalledOnce();
  });

  it('starts both owner cleanups before preserving a rejection', async () => {
    const cleanupError = new Error('editor cleanup failed');
    const closeAll = vi.fn().mockRejectedValue(cleanupError);
    const dispose = vi.fn(async () => undefined);

    await expect(cleanupAsyncQuitOwners({ closeAll }, { dispose })).rejects.toBe(cleanupError);

    expect(closeAll).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('prevents quitting until cleanup finishes and resumes the graceful quit once', async () => {
    let beforeQuit: ((event: QuitEvent) => void) | undefined;
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
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

  it('reports cleanup failure and resumes graceful quit instead of leaving a headless process', async () => {
    let beforeQuit: ((event: QuitEvent) => void) | undefined;
    const cleanupError = new Error('cleanup failed');
    const cleanup = vi.fn().mockRejectedValue(cleanupError);
    const onError = vi.fn();
    const app = {
      on: vi.fn((_event: 'before-quit', listener: (event: QuitEvent) => void) => {
        beforeQuit = listener;
      }),
      quit: vi.fn(),
    };
    installAsyncQuitCleanup(app, cleanup, onError);
    const event = { preventDefault: vi.fn() };

    beforeQuit?.(event);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(cleanupError));
    expect(app.quit).toHaveBeenCalledOnce();
    beforeQuit?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('resumes graceful quit even when the error reporter throws', async () => {
    let beforeQuit: ((event: QuitEvent) => void) | undefined;
    const app = {
      on: vi.fn((_event: 'before-quit', listener: (event: QuitEvent) => void) => {
        beforeQuit = listener;
      }),
      quit: vi.fn(),
    };
    installAsyncQuitCleanup(
      app,
      () => Promise.reject(new Error('cleanup failed')),
      () => {
        throw new Error('report failed');
      },
    );

    beforeQuit?.({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
  });
});
