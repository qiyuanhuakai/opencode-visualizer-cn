// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  getLatestRelease: vi.fn(async () => ({ version: '1.2.3', assets: [] })),
  downloadAsset: vi.fn(async () => '/private/update.deb'),
  verifyAsset: vi.fn(async () => undefined),
  removeFile: vi.fn(async () => undefined),
  dispose: vi.fn(),
  onBeforeRequest: vi.fn(),
  setFeedURL: vi.fn(),
  detectLinuxPackageFormat: vi.fn(async () => 'rpm' as const),
}));

vi.mock('../bridge/updatePlatform.js', () => ({
  detectLinuxPackageFormat: harness.detectLinuxPackageFormat,
}));

vi.mock('../electron/updateTransport.js', () => ({
  createUpdateTransport: () => ({
    getLatestRelease: harness.getLatestRelease,
    downloadAsset: harness.downloadAsset,
    verifyAsset: harness.verifyAsset,
    removeFile: harness.removeFile,
    dispose: harness.dispose,
  }),
  isAllowedUpdateUrl: () => true,
}));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      netSession: { webRequest: { onBeforeRequest: harness.onBeforeRequest } },
      setFeedURL: harness.setFeedURL,
    },
    CancellationToken: class {},
  },
}));

import { createUpdateRuntime } from '../electron/updateRuntime.js';

describe('desktop update runtime adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins the production updater to the selected prerelease feed', async () => {
    // Given: the official transport returns an alpha newer than the installed version.
    const runtime = createUpdateRuntime();
    harness.getLatestRelease.mockResolvedValueOnce({ version: '1.2.3-alpha.10', assets: [] });

    // When: preparing the production updater check.
    await expect(runtime.prepareAppUpdate?.('1.2.3-alpha.2')).resolves.toBe('1.2.3-alpha.10');

    // Then: the feed is release-specific and uses published latest metadata.
    expect(harness.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/qiyuanhuakai/opencode-visualizer-cn/releases/download/v1.2.3-alpha.10/',
      channel: 'latest',
      useMultipleRangeRequest: false,
    });
    expect(runtime.updater.allowPrerelease).toBe(true);
    expect(runtime.updater.allowDowngrade).toBe(false);
    runtime.dispose();
  });

  it.each(['1.2.3-alpha.10', '1.2.3'])('does not configure an older or equal alpha feed for installed %s', async (installed) => {
    // Given: the newest release is no newer than the current app.
    const runtime = createUpdateRuntime();
    harness.getLatestRelease.mockResolvedValueOnce({ version: '1.2.3-alpha.10', assets: [] });

    // When: preparing the updater.
    await expect(runtime.prepareAppUpdate?.(installed)).resolves.toBeNull();

    // Then: no manifest feed can cause a downgrade.
    expect(harness.setFeedURL).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('rejects pending release selection after disposal before changing the updater feed', async () => {
    // Given: disposal happens while the transport is resolving a release.
    const runtime = createUpdateRuntime();
    harness.getLatestRelease.mockImplementationOnce(async () => {
      runtime.dispose();
      return { version: '1.2.3', assets: [] };
    });

    // When: the pending selection resumes.
    await expect(runtime.prepareAppUpdate?.('1.0.0')).rejects.toThrow('disposed');

    // Then: a disposed runtime cannot prepare a late manifest request.
    expect(harness.setFeedURL).not.toHaveBeenCalled();
    expect(harness.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });

  it('delegates Node-only release transport while retaining Electron session lifecycle', async () => {
    const runtime = createUpdateRuntime();
    const asset = {
      name: 'update.deb',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 12,
      url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
    };

    await expect(runtime.getLatestRelease()).resolves.toEqual({ version: '1.2.3', assets: [] });
    await expect(runtime.downloadAsset(asset, vi.fn())).resolves.toBe('/private/update.deb');
    await runtime.verifyAsset('/private/update.deb', asset, 'a'.repeat(64));
    await runtime.removeFile('/private/update.deb');
    runtime.dispose();

    expect(harness.getLatestRelease).toHaveBeenCalledOnce();
    expect(harness.downloadAsset).toHaveBeenCalledWith(asset, expect.any(Function));
    expect(harness.verifyAsset).toHaveBeenCalledWith('/private/update.deb', asset, 'a'.repeat(64));
    expect(harness.removeFile).toHaveBeenCalledWith('/private/update.deb');
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });

  it('requires package ownership when resolving the desktop bridge Linux format', async () => {
    // Given: the production runtime is active on the desktop host.
    const runtime = createUpdateRuntime();

    // When: a Linux bridge check resolves its native package family.
    await expect(runtime.resolveBridgeLinuxFormat()).resolves.toBe('rpm');

    // Then: detection requires ownership of the installed bridge package.
    expect(harness.detectLinuxPackageFormat).toHaveBeenCalledWith({ requireOwnership: true });
    runtime.dispose();
  });
});
