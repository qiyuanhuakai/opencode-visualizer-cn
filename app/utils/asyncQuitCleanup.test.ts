import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { installAsyncQuitCleanup, type QuitEvent } from '../../electron/asyncQuitCleanup.js';

describe('Electron async quit cleanup', () => {
  it('executes the main-process quit seam with editor and desktop runtime cleanup together', async () => {
    // Given: the cleanup callback extracted from the production main-process wiring.
    const mainSource = readFileSync(path.resolve(__dirname, '../../electron/main.js'), 'utf8');
    const callbackSource = mainSource.match(
      /installAsyncQuitCleanup\(\s*app,\s*(\(\) => Promise\.all\(\[[\s\S]*?\]\))/u,
    )?.[1];
    expect(callbackSource).toBeDefined();
    const closeAll = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const cleanup = vm.runInNewContext(`(${callbackSource})`, {
      localFileEditor: { closeAll },
      desktopRuntime: { dispose },
      Promise,
    }) as () => Promise<unknown>;

    // When: the actual callback used by main is awaited.
    await cleanup();

    // Then: both asynchronous owners complete through the same bounded quit gate.
    expect(closeAll).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

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
