import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadElectronMainHarness } from './test/electronMainHarness';

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
});

describe('Electron main wiring', () => {
  it('drains writes accepted while desktop shutdown is still pending', async () => {
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);
    let releaseOwner: () => void = () => {};
    let releaseWrite: () => void = () => {};
    let enteredWrite: () => void = () => {};
    const ownerHeld = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { enteredWrite = resolve; });
    const runtime = harness.createDesktopRuntime.mock.results[0]?.value;
    runtime?.dispose.mockImplementation(() => ownerHeld);
    const liveFileSystem = (await import('node:fs')).default;
    const originalRename = liveFileSystem.promises.rename;
    const rename = vi.spyOn(liveFileSystem.promises, 'rename').mockImplementation(async (from, to) => {
      enteredWrite();
      await writeHeld;
      await originalRename(from, to);
    });
    harness.appListeners.get('before-quit')?.[0]?.({ preventDefault: vi.fn() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const key = 'opencode.state.codexAuxiliaryHistory.v1.late-quit';
    const write = harness.invoke('persistent-storage-set-async', { key, value: 'late' });
    try {
      await writeStarted;
      releaseOwner();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.app.quit).not.toHaveBeenCalled();
    } finally {
      releaseOwner();
      releaseWrite();
      await write.result;
      await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
      rename.mockRestore();
    }
  });

  it('waits for history persistence when desktop cleanup fails during quit', async () => {
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const liveFileSystem = (await import('node:fs')).default;
    const originalRename = liveFileSystem.promises.rename;
    const rename = vi.spyOn(liveFileSystem.promises, 'rename').mockImplementation(async (from, to) => {
      entered();
      await held;
      await originalRename(from, to);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runtime = harness.createDesktopRuntime.mock.results[0]?.value;
    runtime?.dispose.mockRejectedValue(new Error('desktop cleanup failed'));
    const key = 'opencode.state.codexAuxiliaryHistory.v1.held-quit';
    const write = harness.invoke('persistent-storage-set-async', { key, value: 'durable' });
    try {
      await started;
      harness.appListeners.get('before-quit')?.[0]?.({ preventDefault: vi.fn() });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.app.quit).not.toHaveBeenCalled();
    } finally {
      release();
      await write.result;
      await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
      rename.mockRestore();
      log.mockRestore();
    }
    expect(harness.invoke('persistent-storage-get', key).event.returnValue).toEqual({ ok: true, value: 'durable' });
  });

  it('waits for a queued auxiliary history write before quitting', async () => {
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);
    const key = 'opencode.state.codexAuxiliaryHistory.v1.quit-test';
    const write = harness.invoke('persistent-storage-set-async', { key, value: 'durable' });
    const beforeQuit = harness.appListeners.get('before-quit')?.[0];
    const event = { preventDefault: vi.fn() };
    beforeQuit?.(event);
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
    await expect(write.result).resolves.toBe(true);
    expect(harness.invoke('persistent-storage-get', key).event.returnValue).toEqual({ ok: true, value: 'durable' });
  });

  it('rejects asynchronous history writes from an untrusted renderer or to a settings key', async () => {
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);
    const untrusted = harness.invoke('persistent-storage-set-async', {
      key: 'opencode.state.codexAuxiliaryHistory.v1.thread', value: 'text',
    }, 2);
    const setting = harness.invoke('persistent-storage-set-async', { key: 'opencode.setting', value: 'text' });
    await expect(untrusted.result).rejects.toThrow('Untrusted renderer');
    await expect(setting.result).rejects.toThrow('restricted to auxiliary history');
  });

  it('binds the production persistent storage registration to the actual main module', async () => {
    // Given: the actual main module has started with isolated Electron and filesystem infrastructure.
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);
    new harness.BrowserWindow({});

    // When: the renderer uses the production storage channels registered by main.
    const set = harness.invoke('persistent-storage-set', {
      key: 'opencode.main-wiring',
      value: 'bound',
    });
    const get = harness.invoke('persistent-storage-get', 'opencode.main-wiring');
    const migrate = harness.invoke('persistent-storage-migrate', {
      'opencode.main-migrated': 'legacy',
    });
    const remove = harness.invoke('persistent-storage-remove', 'opencode.main-wiring');

    // Then: actual main handlers preserve acknowledgements and durable storage behavior.
    expect(set.event.returnValue).toBe(true);
    expect(get.event.returnValue).toEqual({ ok: true, value: 'bound' });
    expect(migrate.event.returnValue).toBe(true);
    expect(remove.event.returnValue).toBe(true);
    expect(harness.sentMessages).toEqual([
      [
        2,
        'persistent-storage-changed',
        { key: 'opencode.main-wiring', oldValue: null, newValue: 'bound' },
      ],
      [
        1,
        'persistent-storage-changed',
        { key: 'opencode.main-migrated', oldValue: null, newValue: 'legacy' },
      ],
      [
        2,
        'persistent-storage-changed',
        { key: 'opencode.main-migrated', oldValue: null, newValue: 'legacy' },
      ],
      [
        2,
        'persistent-storage-changed',
        { key: 'opencode.main-wiring', oldValue: 'bound', newValue: null },
      ],
    ]);
  });

  it('injects main sender trust into the production storage registration', async () => {
    // Given: actual main has registered storage with its current main-window ownership check.
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);

    // When: a different webContents invokes the actual registered get handler.
    const action = () => harness.invoke('persistent-storage-get', 'opencode.main-wiring', 2);

    // Then: main rejects the sender before returning native storage data.
    expect(action).toThrow('Untrusted renderer');
  });

  it('waits for the actual local-file and desktop-runtime owners before quitting', async () => {
    // Given: actual main owns an open local-file session and its created desktop runtime.
    const harness = await loadElectronMainHarness();
    cleanupCallbacks.push(harness.cleanup);
    const select = harness.invoke('local-file-select-application');
    await select.result;
    const opened = harness.invoke('local-file-open', {
      sessionId: 'quit-owner',
      fileName: 'note.txt',
      content: 'cleanup proof',
    });
    await opened.result;
    const localFileDirectory = harness.localFileDirectories[0];
    expect(localFileDirectory).toBeDefined();
    expect(localFileDirectory ? fs.existsSync(localFileDirectory) : false).toBe(true);
    const runtime = harness.createDesktopRuntime.mock.results[0]?.value;
    const beforeQuit = harness.appListeners.get('before-quit')?.[0];
    expect(beforeQuit).toBeDefined();

    // When: Electron emits the real before-quit callback installed by main.
    const event = { preventDefault: vi.fn() };
    beforeQuit?.(event);

    // Then: both cleanup owners finish before main resumes the quit.
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());
    expect(runtime?.dispose).toHaveBeenCalledOnce();
    expect(localFileDirectory ? fs.existsSync(localFileDirectory) : true).toBe(false);
  });
});
