import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopUpdates } from '../electron/updateService.js';
import type { DesktopUpdateState } from './types/desktop';

const RELEASE = {
  version: '1.2.3',
  assets: [{
    name: 'VisBridge-1.2.3-x64-Linux.deb',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 12,
    url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
  }],
};

describe('desktop update lifecycle', () => {
  it('keeps downloaded state stable while install confirmation is pending', async () => {
    // Given: a downloaded installer whose native confirmation has not resolved.
    const fixture = createFixture();
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');
    let approve = (_value: boolean) => {};
    fixture.beforeInstall.mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; }));

    // When: a concurrent check arrives while install owns the component.
    const install = fixture.service.install('bridge');
    await vi.waitFor(() => expect(fixture.beforeInstall).toHaveBeenCalled());
    const check = fixture.service.check('bridge');

    // Then: the offer remains downloaded until confirmation completes.
    expect(fixture.service.getState().bridge.phase).toBe('downloaded');
    approve(true);
    await Promise.all([install, check]);
    expect(fixture.service.getState().bridge.phase).toBe('installer-opened');
  });

  it('does not open a manual installer when native confirmation is declined', async () => {
    // Given: a verified bridge installer and a rejected confirmation hook.
    const fixture = createFixture();
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');
    fixture.beforeInstall.mockResolvedValueOnce(false);

    // When: installation is requested.
    await fixture.service.install('bridge');

    // Then: cancellation leaves a retryable download and the installer remains unopened.
    expect(fixture.shell.openPath).not.toHaveBeenCalled();
    expect(fixture.service.getState().bridge).toMatchObject({ phase: 'downloaded', error: null });
  });

  it('reports byte progress for manual downloads', async () => {
    // Given: the download adapter reports half of the expected bytes received.
    const fixture = createFixture();
    fixture.runtime.downloadAsset.mockImplementationOnce(async (_asset, onProgress) => {
      onProgress(50);
      return '/private/update/bridge.deb';
    });
    await fixture.service.check('bridge');

    // When: the manual download runs.
    await fixture.service.download('bridge');

    // Then: observable state includes real adapter progress.
    expect(fixture.changes.some(([, bridge]) => bridge.progress === 50)).toBe(true);
  });

  it('removes listeners and private downloaded files on disposal', async () => {
    // Given: a downloaded manual installer and active updater listeners.
    const fixture = createFixture();
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');

    // When: the service is disposed.
    await fixture.service.dispose();

    // Then: the private file is removed and updater subscriptions are detached.
    expect(fixture.runtime.removeFile).toHaveBeenCalledWith('/private/update/bridge.deb');
    expect(fixture.updater.listenerCount('update-available')).toBe(0);
  });

  it('cleans every superseded installer that was never handed to the operating system', async () => {
    // Given: two successive downloads for the same component without opening either.
    const fixture = createFixture();
    fixture.runtime.downloadAsset
      .mockResolvedValueOnce('/private/update/bridge-first.deb')
      .mockResolvedValueOnce('/private/update/bridge-second.deb');
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');

    // When: the service disposes its private staging area.
    await fixture.service.dispose();

    // Then: both unhanded files are removed rather than only the latest path.
    expect(fixture.runtime.removeFile).toHaveBeenCalledWith('/private/update/bridge-first.deb');
    expect(fixture.runtime.removeFile).toHaveBeenCalledWith('/private/update/bridge-second.deb');
  });

  it('leaves a handed-off installer intact during disposal', async () => {
    // Given: a manual installer has been opened by the operating system.
    const fixture = createFixture();
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');
    await fixture.service.install('bridge');

    // When: application shutdown disposes the service.
    await fixture.service.dispose();

    // Then: the external installer retains its staging file.
    expect(fixture.runtime.removeFile).not.toHaveBeenCalled();
  });

  it('cancels pending install confirmation during disposal and never opens the installer', async () => {
    // Given: a downloaded installer with a native confirmation still open.
    const fixture = createFixture();
    await fixture.service.check('bridge');
    await fixture.service.download('bridge');
    fixture.beforeInstall.mockImplementationOnce(
      (_component, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    );
    const install = fixture.service.install('bridge');
    await vi.waitFor(() => expect(fixture.beforeInstall).toHaveBeenCalledOnce());

    // When: application shutdown disposes the service.
    await fixture.service.dispose();
    await install;

    // Then: confirmation is cancelled, runtime work is stopped, and no handoff begins.
    expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
    expect(fixture.shell.openPath).not.toHaveBeenCalled();
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('bounds shutdown waiting after cancelling an active update operation', async () => {
    vi.useFakeTimers();
    try {
      // Given: an update check whose external provider never settles.
      const fixture = createFixture();
      fixture.runtime.getLatestRelease.mockImplementationOnce(() => new Promise(() => undefined));
      void fixture.service.check('bridge');
      await vi.advanceTimersByTimeAsync(0);

      // When: shutdown disposes the updater and reaches its five-second cancellation bound.
      const disposal = fixture.service.dispose();
      expect(fixture.runtime.dispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);

      // Then: quit cleanup completes rather than inheriting the transport's ten-minute timeout.
      await expect(disposal).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports packaged Linux without a supported package identity as unsupported', async () => {
    // Given: a packaged Linux process that is neither AppImage nor a detected native package.
    const fixture = createFixture({ automaticAppUpdates: false });

    // When: application updates are checked.
    await fixture.service.check('app');

    // Then: the state is truthful and electron-updater is not invoked.
    expect(fixture.service.getState().app.phase).toBe('unsupported');
    expect(fixture.updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

function createFixture(options: { readonly automaticAppUpdates?: boolean } = {}) {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
    channel: null as string | null,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  });
  const runtime = {
    platform: 'linux' as const, arch: 'x64' as const,
    automaticAppUpdates: options.automaticAppUpdates ?? true,
    automaticAppUpdateTarget: options.automaticAppUpdates === false ? null : 'appimage' as const,
    updater,
    getLatestRelease: vi.fn(async () => RELEASE),
    getBridgeVersion: vi.fn(async () => '1.0.0'),
    downloadAppUpdate: vi.fn(async () => [] as string[]),
    downloadAsset: vi.fn(async (_asset, _onProgress: (percent: number) => void) => '/private/update/bridge.deb'),
    verifyAsset: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const shell = { openPath: vi.fn(async () => '') };
  const beforeInstall = vi.fn<(_component: 'app' | 'bridge', _signal: AbortSignal) => Promise<void | boolean>>();
  const changes: DesktopUpdateState[][] = [];
  const service = createDesktopUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' }, shell,
    onChange: (state) => changes.push([state.app, state.bridge]), beforeInstall,
  }, runtime);
  return { beforeInstall, changes, runtime, service, shell, updater };
}
