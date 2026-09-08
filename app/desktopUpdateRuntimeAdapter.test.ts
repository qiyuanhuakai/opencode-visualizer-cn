// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  getLatestRelease: vi.fn(async () => ({ version: '1.2.3', assets: [] })),
  downloadAsset: vi.fn(async () => '/private/update.deb'),
  verifyAsset: vi.fn(async () => undefined),
  removeFile: vi.fn(async () => undefined),
  dispose: vi.fn(),
  onBeforeRequest: vi.fn(),
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
    },
    CancellationToken: class {},
  },
}));

import { createUpdateRuntime } from '../electron/updateRuntime.js';

describe('desktop update runtime adapter', () => {
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
