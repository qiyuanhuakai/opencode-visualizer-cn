import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadElectronMainHarness } from './test/electronMainHarness';

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
});

describe('Electron main wiring', () => {
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
