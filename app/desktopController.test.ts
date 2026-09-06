import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersistentStorage } from '../electron/persistentStorage.js';
import { createDesktopController, registerDesktopIpc } from '../electron/desktopController.js';
import type { DesktopControllerOptions } from '../electron/desktopController.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'vis-desktop-'));
  directories.push(directory);
  const storage = createPersistentStorage(path.join(directory, 'settings.json'));
  const update = { currentVersion: null, availableVersion: null, phase: 'idle', progress: null, error: null, installKind: 'manual', assetName: null } as const;
  const updates = {
    getState: () => ({ app: { ...update, component: 'app' }, bridge: { ...update, component: 'bridge' } }) satisfies ReturnType<DesktopControllerOptions['updates']['getState']>,
    configure: vi.fn(), check: vi.fn(async () => {}), download: vi.fn(async () => {}), install: vi.fn(async () => {}),
  };
  const desktopShell = { configure: vi.fn(), getCapabilities: () => ({ trayAvailable: true, nativeNotificationsAvailable: true }), notify: vi.fn() };
  const options = { storage, updates, desktopShell, publish: vi.fn() };
  return { ...options, controller: createDesktopController(options), options };
}

describe('desktop controller', () => {
  it('persists preferences across controller recreation', () => {
    const { controller, options } = setup();
    controller.configure({ closeToTray: true, locale: 'zh-CN' });
    expect(createDesktopController(options).getState().preferences).toMatchObject({ closeToTray: true, locale: 'zh-CN', minimizeToTray: false });
  });

  it('rejects malformed preference patches without changing runtime settings', () => {
    const { controller, desktopShell } = setup();
    expect(() => controller.configure({ closeToTray: 'yes' })).toThrow('Invalid desktop preference');
    expect(() => controller.configure({ feedUrl: 'https://evil.test' })).toThrow('Unknown desktop preference');
    expect(desktopShell.configure).not.toHaveBeenCalled();
  });

  it('rejects arbitrary update targets before calling the update service', async () => {
    const { controller, updates } = setup();
    await expect(controller.install('../../payload')).rejects.toThrow();
    expect(updates.install).not.toHaveBeenCalled();
  });

  it('does not publish or activate settings when persistence fails', () => {
    const { options } = setup();
    const controller = createDesktopController({ ...options, storage: { getItem: () => null, setItem: () => { throw new Error('disk full'); } } });
    expect(() => controller.configure({ closeToTray: true })).toThrow('disk full');
    expect(options.publish).not.toHaveBeenCalled();
    expect(controller.getState().preferences.closeToTray).toBe(false);
  });

  it('authenticates every privileged operation before reading its payload', () => {
    const { controller, updates } = setup();
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    registerDesktopIpc({ ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } }, controller, assertTrustedRenderer: () => { throw new Error('Untrusted renderer'); } });
    expect([...handlers.keys()]).toEqual(['desktop-get-state', 'desktop-configure', 'desktop-check', 'desktop-download', 'desktop-install', 'desktop-notify']);
    for (const handler of handlers.values()) expect(() => handler({}, 'app')).toThrow('Untrusted renderer');
    expect(updates.install).not.toHaveBeenCalled();
  });
});
