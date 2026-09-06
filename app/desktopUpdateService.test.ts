import { EventEmitter } from 'node:events';
import { AppUpdater, type UpdateInfo } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopUpdates } from '../electron/updateService.js';
import type { DesktopUpdateState } from './types/desktop';

const RELEASE = {
  version: '1.2.3',
  assets: [
    {
      name: 'VisBridge-1.2.3-x64-Linux.deb',
      digest: `sha256:${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      size: 12,
      url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
    },
  ],
};

describe('desktop update service', () => {
  it('preserves an installer while OS handoff is still pending beyond the quit deadline', async () => {
    const fixture = createFixture();
    let finishOpen: ((error: string) => void) | undefined;
    fixture.shell.openPath.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishOpen = resolve;
        }),
    );
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');
    const installing = fixture.service.install('bridge');
    await vi.waitFor(() => expect(fixture.shell.openPath).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    try {
      const disposing = fixture.service.dispose();
      await vi.advanceTimersByTimeAsync(5001);
      await disposing;
      expect(fixture.runtime.removeFile).not.toHaveBeenCalled();
    } finally {
      finishOpen?.('');
      await installing;
      vi.useRealTimers();
    }
  });
  it('reports honest unsupported app state in development while bridge checks remain available', async () => {
    // Given: an unpackaged Linux app and an installed older bridge.
    const fixture = createFixture({ packaged: false });

    // When: both components are checked.
    await fixture.service.check('app');
    await fixture.service.check('bridge');

    // Then: app updating is unsupported, while bridge uses the connected bridge version.
    expect(fixture.service.getState().app.phase).toBe('unsupported');
    expect(fixture.service.getState().bridge).toMatchObject({
      currentVersion: '1.0.0',
      availableVersion: '1.2.3',
      phase: 'available',
    });
  });

  it('downloads, revalidates, confirms, and opens a bridge installer without claiming installation', async () => {
    // Given: an available verified bridge update.
    const fixture = createFixture();
    await fixture.service.check('bridge');

    // When: the installer is downloaded and explicitly installed.
    await fixture.service.download('bridge');
    await fixture.service.install('bridge');

    // Then: integrity is checked both after download and immediately before opening.
    expect(fixture.runtime.verifyAsset).toHaveBeenCalledTimes(2);
    expect(fixture.beforeInstall).toHaveBeenCalledWith('bridge', expect.any(AbortSignal));
    expect(fixture.shell.openPath).toHaveBeenCalledWith('/private/update/bridge.deb');
    expect(fixture.service.getState().bridge).toMatchObject({
      phase: 'installer-opened',
      currentVersion: '1.0.0',
      availableVersion: '1.2.3',
    });
  });

  it('uses electron-updater for packaged Linux app updates and quits only on explicit install', async () => {
    // Given: electron-updater has announced and downloaded an app update.
    const fixture = createFixture();
    fixture.updater.checkForUpdates.mockImplementation(async () => {
      const update = updateInfo('1.2.3');
      fixture.updater.emit('update-available', update);
      return { updateInfo: update };
    });
    fixture.runtime.downloadAppUpdate.mockImplementation(async () => {
      fixture.updater.emit('update-downloaded', { version: '1.2.3' });
      return ['/private/update/Vis-1.2.3-x86_64-Linux.AppImage'];
    });
    await fixture.service.check('app');
    await fixture.service.download('app');

    // When: install is explicitly requested.
    await fixture.service.install('app');

    // Then: the confirmation hook precedes the updater-owned quit/install action.
    expect(fixture.runtime.downloadAppUpdate).toHaveBeenCalledOnce();
    expect(fixture.beforeInstall).toHaveBeenCalledWith('app', expect.any(AbortSignal));
    expect(fixture.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it.each([
    { platform: 'linux' as const, arch: 'x64' as const, channel: null },
    { platform: 'win32' as const, arch: 'arm64' as const, channel: 'latest-arm64' },
  ])(
    'disables downgrade after assigning the real updater channel setter for $platform $arch',
    async ({ platform, arch, channel }) => {
      // Given: electron-updater's real channel setter, which enables downgrades on assignment.
      const updater = new SetterBackedUpdater();

      // When: the desktop service configures the platform channel.
      createDesktopUpdates(
        {
          app: { isPackaged: true, getVersion: () => '1.0.0' },
          shell: { openPath: vi.fn(async () => '') },
          onChange: () => undefined,
          beforeInstall: vi.fn(async () => true),
        },
        createRuntime(updater, platform, arch),
      );

      // Then: the selected channel is retained without permitting older releases.
      expect(updater.channel).toBe(channel);
      expect(updater.allowDowngrade).toBe(false);
      await expect(updater.accepts(updateInfo('0.9.9'))).resolves.toBe(false);
    },
  );

  it('rejects an older automatic app offer without downloading it', async () => {
    // Given: automatic download is enabled and electron-updater returns an older release.
    const fixture = createFixture();
    await fixture.service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });
    fixture.updater.checkForUpdates.mockResolvedValueOnce({ updateInfo: updateInfo('0.9.0') });

    // When: the application explicitly checks for updates.
    await fixture.service.check('app');

    // Then: the older offer is rejected and never reaches the download path.
    expect(fixture.service.getState().app.phase).toBe('up-to-date');
    expect(fixture.runtime.downloadAppUpdate).not.toHaveBeenCalled();
  });

  it('exposes automatic check failures instead of creating an unhandled rejection', async () => {
    // Given: automatic checks are enabled and GitHub is unavailable.
    const fixture = createFixture();
    fixture.runtime.getLatestRelease.mockRejectedValueOnce(new Error('network unavailable'));

    // When: update preferences are configured.
    await fixture.service.configure({ autoCheckUpdates: true, autoDownloadUpdates: false });

    // Then: the failed bridge check is represented in observable state.
    expect(fixture.service.getState().bridge).toMatchObject({
      phase: 'error',
      error: 'network unavailable',
    });
  });

  it('does not repeat automatic checks when configuration is unchanged', async () => {
    // Given: automatic checking has already run for both components.
    const fixture = createFixture();
    await fixture.service.configure({ autoCheckUpdates: true, autoDownloadUpdates: false });

    // When: the same preferences are activated again.
    await fixture.service.configure({ autoCheckUpdates: true, autoDownloadUpdates: false });

    // Then: neither updater backend performs a duplicate check.
    expect(fixture.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getLatestRelease).toHaveBeenCalledTimes(1);
  });

  it('does not offer the latest release when the connected bridge already runs it', async () => {
    const fixture = createFixture({ bridgeVersion: '1.2.3' });

    await fixture.service.check('bridge');

    expect(fixture.service.getState().bridge).toMatchObject({
      currentVersion: '1.2.3',
      availableVersion: null,
      phase: 'up-to-date',
    });
  });

  it('does not query releases or offer an update before bridge health reports a version', async () => {
    const fixture = createFixture({ bridgeVersion: null });

    await fixture.service.check('bridge');

    expect(fixture.runtime.getLatestRelease).not.toHaveBeenCalled();
    expect(fixture.service.getState().bridge).toMatchObject({
      currentVersion: null,
      availableVersion: null,
      phase: 'idle',
    });
  });

  it('offers a newer release using only the reported connected bridge version', async () => {
    const fixture = createFixture({ bridgeVersion: '1.0.0' });

    await fixture.service.check('bridge');

    expect(fixture.runtime.getBridgeVersion).not.toHaveBeenCalled();
    expect(fixture.service.getState().bridge).toMatchObject({
      currentVersion: '1.0.0',
      availableVersion: '1.2.3',
      phase: 'available',
    });
  });

  it('defers one automatic bridge check until health metadata arrives', async () => {
    const fixture = createFixture({ bridgeVersion: null });
    await fixture.service.configure({ autoCheckUpdates: true, autoDownloadUpdates: false });
    expect(fixture.runtime.getLatestRelease).not.toHaveBeenCalled();

    fixture.service.reportBridgeVersion({ connectionId: 'connection-2', version: '1.0.0' });
    await vi.waitFor(() => expect(fixture.runtime.getLatestRelease).toHaveBeenCalledOnce());
    fixture.service.reportBridgeVersion({ connectionId: 'connection-2', version: '1.0.0' });

    await Promise.resolve();
    expect(fixture.runtime.getLatestRelease).toHaveBeenCalledOnce();
    expect(fixture.service.getState().bridge.phase).toBe('available');
  });

  it('resets bridge update eligibility when the active connection becomes unavailable', async () => {
    const fixture = createFixture();
    await fixture.service.check('bridge');

    const state = fixture.service.reportBridgeVersion({
      connectionId: 'connection-2',
      version: null,
    });
    await fixture.service.check('bridge');

    expect(fixture.runtime.getLatestRelease).toHaveBeenCalledOnce();
    expect(state.bridge).toMatchObject({
      currentVersion: null,
      availableVersion: null,
      phase: 'idle',
      assetName: null,
    });
    expect(fixture.service.getState().bridge.phase).toBe('idle');
  });

  it('does not access update networks when automatic checking is enabled in development', async () => {
    // Given: an unpackaged application with automatic checking enabled.
    const fixture = createFixture({ packaged: false });

    // When: preferences are activated by the desktop controller.
    await fixture.service.configure({ autoCheckUpdates: true, autoDownloadUpdates: true });

    // Then: development state stays local until an explicit component check.
    expect(fixture.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(fixture.runtime.getLatestRelease).not.toHaveBeenCalled();
    expect(fixture.service.getState().app.phase).toBe('unsupported');
  });

  it('downloads an existing offer only when automatic download becomes enabled', async () => {
    // Given: a checked bridge offer while automatic download is disabled.
    const fixture = createFixture();
    await fixture.service.check('bridge');

    // When: automatic download is enabled twice with otherwise identical preferences.
    await fixture.service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });
    await fixture.service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });

    // Then: the preference transition starts exactly one download.
    expect(fixture.runtime.downloadAsset).toHaveBeenCalledTimes(1);
    expect(fixture.service.getState().bridge.phase).toBe('downloaded');
  });

  it('applies automatic download after every successful explicit check without duplicate work', async () => {
    // Given: automatic downloading is enabled before an offer exists.
    const fixture = createFixture();
    await fixture.service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });

    // When: two callers share one check, followed by a later successful check.
    await Promise.all([fixture.service.check('bridge'), fixture.service.check('bridge')]);
    await fixture.service.check('bridge');

    // Then: each actual check triggers one download, without self-deadlock or duplicate admission.
    expect(fixture.runtime.getLatestRelease).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.downloadAsset).toHaveBeenCalledTimes(2);
    expect(fixture.service.getState().bridge.phase).toBe('downloaded');
  });
});

function createFixture(
  options: {
    readonly packaged?: boolean;
    readonly automaticAppUpdates?: boolean;
    readonly bridgeVersion?: string | null;
  } = {},
) {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    channel: null as string | null,
    checkForUpdates: vi.fn<() => Promise<{ updateInfo: UpdateInfo } | null>>(async () => null),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  });
  const runtime = {
    platform: 'linux' as const,
    arch: 'x64' as const,
    automaticAppUpdates: options.automaticAppUpdates ?? true,
    automaticAppUpdateTarget: options.automaticAppUpdates === false ? null : ('appimage' as const),
    updater,
    getLatestRelease: vi.fn(async () => RELEASE),
    getBridgeVersion: vi.fn(async () => '1.0.0'),
    downloadAppUpdate: vi.fn(async () => [] as string[]),
    downloadAsset: vi.fn(
      async (_asset, _onProgress: (percent: number) => void) => '/private/update/bridge.deb',
    ),
    verifyAsset: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const shell = { openPath: vi.fn(async () => '') };
  const beforeInstall = vi.fn<
    (_component: 'app' | 'bridge', _signal: AbortSignal) => Promise<void | boolean>
  >(async () => undefined);
  const changes: DesktopUpdateState[][] = [];
  const service = createDesktopUpdates(
    {
      app: {
        isPackaged: options.packaged ?? true,
        getVersion: () => '1.0.0',
      },
      shell,
      onChange: (state) => changes.push([state.app, state.bridge]),
      beforeInstall,
    },
    runtime,
  );
  if (options.bridgeVersion !== null) {
    service.reportBridgeVersion({
      connectionId: 'connection-1',
      version: options.bridgeVersion ?? '1.0.0',
    });
  }
  return { beforeInstall, changes, runtime, service, shell, updater };
}

class SetterBackedUpdater extends AppUpdater {
  accepts(updateInfo: UpdateInfo): Promise<boolean> {
    return (
      this as unknown as { isUpdateAvailable(info: UpdateInfo): Promise<boolean> }
    ).isUpdateAvailable(updateInfo);
  }

  constructor() {
    super(null, {
      version: '1.0.0',
      name: 'Vis',
      isPackaged: true,
      appUpdateConfigPath: '/private/app-update.yml',
      userDataPath: '/private/user-data',
      baseCachePath: '/private/cache',
      whenReady: async () => undefined,
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: () => undefined,
    });
  }

  protected override doDownloadUpdate(): Promise<string[]> {
    return Promise.resolve([]);
  }

  override quitAndInstall(): void {}
}

function updateInfo(version: string): UpdateInfo {
  const name = `Vis-${version}-x86_64-Linux.AppImage`;
  return {
    version,
    files: [
      { url: name, size: 12, sha512: `${'A'.repeat(86)}==` },
      { url: `Vis-${version}-amd64-Linux.deb`, size: 12, sha512: `${'A'.repeat(86)}==` },
    ],
    path: name,
    sha512: `${'A'.repeat(86)}==`,
    releaseDate: '2026-09-06T00:00:00.000Z',
  };
}

function createRuntime(
  updater: SetterBackedUpdater,
  platform: 'linux' | 'win32',
  arch: 'x64' | 'arm64',
) {
  return {
    platform,
    arch,
    automaticAppUpdates: true,
    automaticAppUpdateTarget: platform === 'win32' ? ('nsis' as const) : ('appimage' as const),
    updater,
    getLatestRelease: vi.fn(async () => RELEASE),
    getBridgeVersion: vi.fn(async () => '1.0.0'),
    downloadAppUpdate: vi.fn(async () => [] as string[]),
    downloadAsset: vi.fn(async () => '/private/update/bridge.deb'),
    verifyAsset: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}
