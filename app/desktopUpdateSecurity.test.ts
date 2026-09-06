import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopUpdates } from '../electron/updateService.js';
import { errorMessage } from '../electron/updateState.js';

describe('automatic desktop update security', () => {
  it('rejects a mismatched event offer before automatic download', async () => {
    // Given: automatic download is enabled and electron-updater emits a bridge artifact as an app offer.
    const fixture = createFixture();
    await fixture.service.configure({ autoCheckUpdates: false, autoDownloadUpdates: true });
    const info = updateInfo('VisBridge-1.2.3-x64-Linux.deb');
    fixture.updater.checkForUpdates.mockImplementationOnce(async () => {
      fixture.updater.emit('update-available', info);
      return { updateInfo: updateInfo('Vis-1.2.3-x86_64-Linux.AppImage') };
    });

    // When: the automatic app check completes.
    await fixture.service.check('app');

    // Then: the untrusted offer becomes an error and cannot enter the download path.
    expect(fixture.service.getState().app.phase).toBe('error');
    expect(fixture.runtime.downloadAppUpdate).not.toHaveBeenCalled();
  });

  it('verifies the selected manifest size and SHA-512 immediately before updater installation', async () => {
    // Given: an exact Linux x64 AppImage offer and its real updater-returned path.
    const fixture = createFixture();
    const info = updateInfo('Vis-1.2.3-x86_64-Linux.AppImage');
    fixture.updater.checkForUpdates.mockImplementationOnce(async () => {
      fixture.updater.emit('update-available', info);
      return { updateInfo: info };
    });
    fixture.runtime.downloadAppUpdate.mockResolvedValueOnce(['/private/update/Vis-1.2.3-x86_64-Linux.AppImage']);
    await fixture.service.check('app');
    await fixture.service.download('app');

    // When: native confirmation approves installation.
    await fixture.service.install('app');

    // Then: the returned path is checked against retained manifest evidence before quitAndInstall.
    expect(fixture.runtime.verifyAsset).toHaveBeenCalledWith(
      '/private/update/Vis-1.2.3-x86_64-Linux.AppImage',
      { name: 'Vis-1.2.3-x86_64-Linux.AppImage', size: 12, sha512: `${'A'.repeat(86)}==`, url: 'Vis-1.2.3-x86_64-Linux.AppImage' },
      `${'A'.repeat(86)}==`,
      'sha512',
    );
    expect(fixture.runtime.verifyAsset.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.updater.quitAndInstall.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('does not install when the updater returns no path for the selected artifact', async () => {
    // Given: an accepted offer whose download result points at a different architecture.
    const fixture = createFixture();
    const info = updateInfo('Vis-1.2.3-x86_64-Linux.AppImage');
    fixture.updater.checkForUpdates.mockResolvedValueOnce({ updateInfo: info });
    fixture.runtime.downloadAppUpdate.mockResolvedValueOnce(['/private/update/Vis-1.2.3-arm64-Linux.AppImage']);
    await fixture.service.check('app');

    // When: the update download is recorded.
    await fixture.service.download('app');

    // Then: the mismatch is rejected and installation never becomes available.
    expect(fixture.service.getState().app.phase).toBe('error');
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not quit or install when final integrity verification fails', async () => {
    // Given: a recorded automatic download whose bytes no longer match its manifest.
    const fixture = createFixture();
    const info = updateInfo('Vis-1.2.3-x86_64-Linux.AppImage');
    fixture.updater.checkForUpdates.mockResolvedValueOnce({ updateInfo: info });
    fixture.runtime.downloadAppUpdate.mockResolvedValueOnce(['/private/update/Vis-1.2.3-x86_64-Linux.AppImage']);
    fixture.runtime.verifyAsset.mockRejectedValueOnce(new Error('SHA512 mismatch'));
    await fixture.service.check('app');
    await fixture.service.download('app');

    // When: installation reaches the final integrity boundary.
    await fixture.service.install('app');

    // Then: the mismatch becomes renderer-safe error state without handing off to the updater.
    expect(fixture.service.getState().app).toMatchObject({ phase: 'error', error: 'SHA512 mismatch' });
    expect(fixture.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('removes URL credentials, query, and fragment from bounded renderer errors', () => {
    // Given: a provider error containing secrets in a URL and an oversized suffix.
    const secret = new Error(`failed https://user:password@github.com/release/file?token=secret#fragment ${'x'.repeat(700)}`);

    // When: the error is prepared for renderer state.
    const message = errorMessage(secret);

    // Then: only the non-sensitive URL path remains and output is bounded.
    expect(message).toContain('https://github.com/release/file');
    expect(message).not.toMatch(/user|password|token|secret|fragment/u);
    expect(message.length).toBeLessThanOrEqual(500);
  });
});

function createFixture() {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    channel: null as string | null,
    checkForUpdates: vi.fn<() => Promise<{ updateInfo: ReturnType<typeof updateInfo> } | null>>(),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  });
  const runtime = {
    platform: 'linux' as const,
    arch: 'x64' as const,
    automaticAppUpdates: true,
    automaticAppUpdateTarget: 'appimage' as const,
    updater,
    getLatestRelease: vi.fn(),
    getBridgeVersion: vi.fn(),
    downloadAppUpdate: vi.fn(async () => [] as string[]),
    downloadAsset: vi.fn(),
    verifyAsset: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const service = createDesktopUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    shell: { openPath: vi.fn(async () => '') },
    onChange: () => undefined,
    beforeInstall: vi.fn(async () => true),
  }, runtime);
  return { runtime, service, updater };
}

function updateInfo(name: string) {
  return {
    version: '1.2.3',
    files: [
      { url: name, sha512: `${'A'.repeat(86)}==`, size: 12 },
      { url: 'Vis-1.2.3-amd64-Linux.deb', sha512: `${'A'.repeat(86)}==`, size: 12 },
    ],
  };
}
