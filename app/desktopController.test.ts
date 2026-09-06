import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersistentStorage } from '../electron/persistentStorage.js';
import { createDesktopController, registerDesktopIpc } from '../electron/desktopController.js';
import type { DesktopControllerOptions } from '../electron/desktopController.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'vis-desktop-'));
  directories.push(directory);
  const storage = createPersistentStorage(path.join(directory, 'settings.json'));
  const update = {
    currentVersion: null,
    availableVersion: null,
    phase: 'idle',
    progress: null,
    error: null,
    installKind: 'manual',
    assetName: null,
  } as const;
  const updates = {
    getState: () =>
      ({
        app: { ...update, component: 'app' },
        bridge: { ...update, component: 'bridge' },
      }) satisfies ReturnType<DesktopControllerOptions['updates']['getState']>,
    configure: vi.fn(),
    reportBridgeVersion: vi.fn(),
    check: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  };
  const desktopShell = {
    configure: vi.fn(),
    getCapabilities: () => ({ trayAvailable: true, nativeNotificationsAvailable: true }),
    notify: vi.fn(),
  };
  const options = { storage, updates, desktopShell, publish: vi.fn() };
  return { ...options, controller: createDesktopController(options), options };
}

describe('desktop controller', () => {
  it('persists preferences across controller recreation', () => {
    const { controller, options } = setup();
    controller.configure({ closeToTray: true, locale: 'zh-CN' });
    expect(createDesktopController(options).getState().preferences).toMatchObject({
      closeToTray: true,
      locale: 'zh-CN',
      minimizeToTray: false,
    });
  });

  it('rejects malformed preference patches without changing runtime settings', () => {
    const { controller, desktopShell } = setup();
    expect(() => controller.configure({ closeToTray: 'yes' })).toThrow(
      'Invalid desktop preference',
    );
    expect(() => controller.configure({ feedUrl: 'https://evil.test' })).toThrow(
      'Unknown desktop preference',
    );
    expect(desktopShell.configure).not.toHaveBeenCalled();
  });

  it('rejects arbitrary update targets before calling the update service', async () => {
    const { controller, updates } = setup();
    await expect(controller.install('../../payload')).rejects.toThrow();
    expect(updates.install).not.toHaveBeenCalled();
  });

  it('does not publish or activate settings when persistence fails', () => {
    const { options } = setup();
    const controller = createDesktopController({
      ...options,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('disk full');
        },
      },
    });
    expect(() => controller.configure({ closeToTray: true })).toThrow('disk full');
    expect(options.publish).not.toHaveBeenCalled();
    expect(controller.getState().preferences.closeToTray).toBe(false);
  });

  it('authenticates every privileged operation before reading its payload', () => {
    const { controller, updates } = setup();
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    registerDesktopIpc({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      controller,
      assertTrustedRenderer: () => {
        throw new Error('Untrusted renderer');
      },
    });
    expect([...handlers.keys()]).toEqual([
      'desktop-get-state',
      'desktop-configure',
      'desktop-report-bridge-version',
      'desktop-check',
      'desktop-download',
      'desktop-install',
      'desktop-notify',
    ]);
    for (const handler of handlers.values())
      expect(() => handler({}, 'app')).toThrow('Untrusted renderer');
    expect(updates.install).not.toHaveBeenCalled();
  });

  it('authenticates bridge reports before rejecting malformed payloads', async () => {
    const { controller, updates } = setup();
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
    const assertTrustedRenderer = vi.fn();
    registerDesktopIpc({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      controller,
      assertTrustedRenderer,
    });

    await expect(
      handlers.get('desktop-report-bridge-version')?.(
        {},
        {
          connectionId: 'connection-1',
          version: '1.2.3-rc.1',
        },
      ),
    ).rejects.toThrow('Invalid bridge version');

    expect(assertTrustedRenderer).toHaveBeenCalledOnce();
    expect(updates.reportBridgeVersion).not.toHaveBeenCalled();
  });

  it('normalizes connected bridge versions and accepts explicit unavailable reports', async () => {
    const { controller, updates } = setup();

    await controller.reportBridgeVersion({ connectionId: 'connection-1', version: 'v01.002.0003' });
    await controller.reportBridgeVersion({ connectionId: 'connection-2', version: null });

    expect(updates.reportBridgeVersion.mock.calls).toEqual([
      [{ connectionId: 'connection-1', version: '1.2.3' }],
      [{ connectionId: 'connection-2', version: null }],
    ]);
  });

  it.each([
    { connectionId: '', version: '1.2.3' },
    { connectionId: 'x'.repeat(129), version: '1.2.3' },
    { connectionId: 'connection-1', version: '1.2' },
    { connectionId: 'connection-1', version: `1.2.${'3'.repeat(65)}` },
  ])('rejects malformed bridge report %#', async (payload) => {
    const { controller, updates } = setup();

    await expect(controller.reportBridgeVersion(payload)).rejects.toThrow('Invalid bridge');

    expect(updates.reportBridgeVersion).not.toHaveBeenCalled();
  });
});
