// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopUpdates } from '../electron/updateService.js';

const RELEASE_VERSION = '1.2.3-alpha.10';

function updateInfo(version = RELEASE_VERSION) {
  return {
    version,
    files: [
      { url: `Vis-${version}-x86_64.AppImage`, sha512: `${'A'.repeat(86)}==`, size: 12 },
      { url: `Vis-${version}-amd64-Linux.deb`, sha512: `${'A'.repeat(86)}==`, size: 12 },
    ],
  };
}

function createFixture() {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: true,
    channel: null,
    checkForUpdates: vi.fn(async () => ({ updateInfo: updateInfo() })),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const runtime = {
    platform: 'linux' as const,
    arch: 'x64' as const,
    automaticAppUpdates: true,
    automaticAppUpdateTarget: 'appimage' as const,
    updater,
    prepareAppUpdate: vi.fn<(_version: string | null) => Promise<string | null>>(async () => RELEASE_VERSION),
    getLatestRelease: vi.fn(),
    getBridgeVersion: vi.fn(),
    resolveBridgeLinuxFormat: vi.fn(async () => 'deb' as const),
    downloadAppUpdate: vi.fn(async () => [`/private/update/Vis-${RELEASE_VERSION}-x86_64.AppImage`]),
    downloadAsset: vi.fn(),
    verifyAsset: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const onChange = vi.fn();
  const service = createDesktopUpdates({
    app: { isPackaged: true, getVersion: () => '1.2.3-alpha.2' },
    shell: { openPath: vi.fn(async () => '') },
    onChange,
    beforeInstall: vi.fn(async () => true),
  }, runtime);
  return { runtime, updater, service, onChange };
}

describe('desktop prerelease automatic checks', () => {
  it('offers a selected newer alpha and verifies its downloaded file before installation', async () => {
    // Given: the official feed selected a newer alpha than the running alpha.
    const { runtime, updater, service } = createFixture();
    await service.check('app');
    await service.download('app');

    // When: the user approves installation.
    await service.install('app');

    // Then: prereleases are enabled without downgrades and the alpha artifact is verified.
    expect(runtime.prepareAppUpdate).toHaveBeenCalledWith('1.2.3-alpha.2');
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(runtime.verifyAsset).toHaveBeenCalledWith(
      `/private/update/Vis-${RELEASE_VERSION}-x86_64.AppImage`,
      expect.objectContaining({ name: `Vis-${RELEASE_VERSION}-x86_64.AppImage`, size: 12 }),
      `${'A'.repeat(86)}==`, 'sha512',
    );
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    await service.dispose();
  });

  it.each(['result', 'event'] as const)('rejects a manifest version different from the selected release in the %s', async (source) => {
    // Given: a valid artifact manifest points at an unselected stable release.
    const { runtime, updater, service } = createFixture();
    await service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });
    updater.checkForUpdates.mockImplementationOnce(async () => {
      if (source === 'event') updater.emit('update-available', updateInfo('1.2.3'));
      return { updateInfo: updateInfo(source === 'result' ? '1.2.3' : RELEASE_VERSION) };
    });

    // When: the automatic check completes.
    await service.check('app');

    // Then: neither the event nor the result can bypass the selected version.
    expect(service.getState().app).toMatchObject({ phase: 'error', error: expect.stringContaining('selected release') });
    expect(runtime.downloadAppUpdate).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('does not request a manifest when the selected release is not newer', async () => {
    // Given: selection found no newer release.
    const { runtime, updater, service } = createFixture();
    runtime.prepareAppUpdate.mockResolvedValueOnce(null);

    // When: checking the app.
    await service.check('app');

    // Then: an older channel manifest is never requested.
    expect(service.getState().app).toMatchObject({ phase: 'up-to-date', availableVersion: null });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('does not check a feed after disposal during release selection', async () => {
    // Given: release selection is pending when disposal begins.
    const { runtime, updater, service, onChange } = createFixture();
    let resolveSelection: (version: string) => void = () => { throw new Error('selection not started'); };
    let markStarted: () => void = () => { throw new Error('selection signal not initialized'); };
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    runtime.prepareAppUpdate.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSelection = resolve;
      markStarted();
    }));
    const checking = service.check('app');
    await started;
    const changesBeforeDispose = onChange.mock.calls.length;
    const disposing = service.dispose();

    // When: selection finishes after disposal.
    resolveSelection(RELEASE_VERSION);
    await Promise.all([checking, disposing]);

    // Then: the runtime is never asked to start a late manifest check or publish state.
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(changesBeforeDispose);
    expect(updater.listenerCount('update-available')).toBe(0);
  });

  it.each([
    { url: `https://evil.example/Vis-${RELEASE_VERSION}-x86_64.AppImage` },
    { url: `../Vis-${RELEASE_VERSION}-x86_64.AppImage` },
    { url: `Vis-${RELEASE_VERSION}-arm64.AppImage` },
    { sha512: 'invalid' },
    { size: 0 },
  ])('rejects unsafe prerelease artifact metadata %j', async (patch) => {
    // Given: a selected alpha manifest contains one invalid file field.
    const { runtime, updater, service } = createFixture();
    const info = updateInfo();
    info.files = info.files.map((file, index) => index === 0 ? { ...file, ...patch } : file);
    updater.checkForUpdates.mockResolvedValueOnce({ updateInfo: info });
    await service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });

    // When: checking the selected alpha.
    await service.check('app');

    // Then: accepting prereleases does not bypass artifact integrity or target checks.
    expect(service.getState().app.phase).toBe('error');
    expect(runtime.downloadAppUpdate).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('rejects updater offers emitted before release selection completes', async () => {
    // Given: an updater event races the awaited official release selection.
    const { runtime, updater, service } = createFixture();
    runtime.prepareAppUpdate.mockImplementationOnce(async () => {
      updater.emit('update-available', updateInfo());
      return RELEASE_VERSION;
    });
    await service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });

    // When: the check finishes with otherwise valid metadata.
    await service.check('app');

    // Then: the premature offer cannot start an automatic download.
    expect(service.getState().app.phase).toBe('error');
    expect(runtime.downloadAppUpdate).not.toHaveBeenCalled();
    await service.dispose();
  });
});
