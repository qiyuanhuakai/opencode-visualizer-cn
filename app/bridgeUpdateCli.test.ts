// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseBridgeUpdateArgs, runBridgeUpdate } from '../bridge/updateCli.js';

const RELEASE = {
  version: '0.8.0',
  assets: [{
    name: 'VisBridge-0.8.0-x64-Linux.deb',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 12,
    url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
  }],
};

describe('vis_bridge terminal updater command', () => {
  it.each(['update', 'upgrade'])('parses the %s alias and updater-only flags', (command) => {
    expect(parseBridgeUpdateArgs([command, '--check', '-y'])).toEqual({
      command: 'update', check: true, help: false, yes: true,
    });
    expect(parseBridgeUpdateArgs([command, '--help'])).toEqual({
      command: 'update', check: false, help: true, yes: false,
    });
  });

  it('rejects arbitrary updater options before any release request', () => {
    expect(() => parseBridgeUpdateArgs(['update', '--version', '9.9.9']))
      .toThrow('Unknown option');
  });

  it('checks live metadata without staging, prompting, probing ancestors, or handing off', async () => {
    const dependencies = harness();

    const result = await runBridgeUpdate(
      { command: 'update', check: true, help: false, yes: false },
      dependencies,
    );

    expect(result).toEqual({ kind: 'available', currentVersion: '0.7.13', latestVersion: '0.8.0' });
    expect(dependencies.presentOffer).toHaveBeenCalledWith({
      currentVersion: '0.7.13', latestVersion: '0.8.0', asset: RELEASE.assets[0],
    });
    expect(dependencies.assertInstallAllowed).not.toHaveBeenCalled();
    expect(dependencies.transport.downloadAsset).not.toHaveBeenCalled();
    expect(dependencies.handoff).not.toHaveBeenCalled();
    expect(dependencies.transport.dispose).toHaveBeenCalledOnce();
  });

  it('prevents downgrades and exits without requiring --yes in a non-interactive client', async () => {
    const dependencies = harness({ release: { ...RELEASE, version: '0.7.12' }, interactive: false });

    await expect(runBridgeUpdate(
      { command: 'update', check: false, help: false, yes: false }, dependencies,
    )).resolves.toEqual({ kind: 'current', currentVersion: '0.7.13', latestVersion: '0.7.12' });

    expect(dependencies.confirm).not.toHaveBeenCalled();
    expect(dependencies.transport.downloadAsset).not.toHaveBeenCalled();
  });

  it('requires --yes for an available update in a non-interactive client before download', async () => {
    const dependencies = harness({ interactive: false });

    await expect(runBridgeUpdate(
      { command: 'update', check: false, help: false, yes: false }, dependencies,
    )).rejects.toThrow('--yes');

    expect(dependencies.assertInstallAllowed).not.toHaveBeenCalled();
    expect(dependencies.transport.downloadAsset).not.toHaveBeenCalled();
  });

  it('defaults interactive confirmation to No and warns that all clients and tasks are interrupted', async () => {
    const dependencies = harness();
    dependencies.confirm.mockImplementation(async () => {
      expect(dependencies.presentOffer).toHaveBeenCalledWith({
        currentVersion: '0.7.13', latestVersion: '0.8.0', asset: RELEASE.assets[0],
      });
      return false;
    });

    await expect(runBridgeUpdate(
      { command: 'update', check: false, help: false, yes: false }, dependencies,
    )).resolves.toMatchObject({ kind: 'cancelled' });

    expect(dependencies.confirm).toHaveBeenCalledOnce();
    expect(dependencies.transport.downloadAsset).not.toHaveBeenCalled();
  });

  it('checks managed-install and ancestor safety before staging a confirmed update', async () => {
    const dependencies = harness();
    dependencies.assertInstallAllowed.mockRejectedValue(new Error('unmanaged installation'));

    await expect(runBridgeUpdate(
      { command: 'update', check: false, help: false, yes: true }, dependencies,
    )).rejects.toThrow('unmanaged installation');

    expect(dependencies.transport.downloadAsset).not.toHaveBeenCalled();
  });

  it('verifies the selected artifact and reports handoff rather than claiming installation', async () => {
    const dependencies = harness();
    const resultLogPath = String.raw`C:\Users\me\AppData\Local\vis_bridge\updates\installer.log`;
    dependencies.handoff.mockImplementation(async (request) => request.onAccepted?.(resultLogPath));

    await expect(runBridgeUpdate(
      { command: 'update', check: false, help: false, yes: true }, dependencies,
    )).resolves.toMatchObject({ kind: 'handed-off', latestVersion: '0.8.0' });

    expect(dependencies.transport.verifyAsset).toHaveBeenCalledWith(
      '/private/staging/update.deb', RELEASE.assets[0], 'a'.repeat(64), 'sha256',
    );
    expect(dependencies.handoff).toHaveBeenCalledWith(expect.objectContaining({
      assetPath: '/private/staging/update.deb', linuxFormat: 'deb', nonInteractiveYes: false,
    }));
    expect(dependencies.assertInstallAllowed).toHaveBeenCalledWith({
      allowPrivilegedInspection: true,
      nonInteractiveYes: false,
    });
    expect(dependencies.output).toHaveBeenLastCalledWith(expect.stringContaining(resultLogPath));
  });
});

function harness(options: { release?: typeof RELEASE; interactive?: boolean } = {}) {
  const release = options.release ?? RELEASE;
  const transport = {
    getLatestRelease: vi.fn(async () => release),
    downloadAsset: vi.fn(async () => '/private/staging/update.deb'),
    verifyAsset: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return {
    currentVersion: '0.7.13', platform: 'linux' as const, arch: 'x64' as const,
    interactive: options.interactive ?? true,
    output: vi.fn(), presentOffer: vi.fn(), confirm: vi.fn(async () => true),
    assertInstallAllowed: vi.fn(async () => undefined),
    resolveLinuxFormat: vi.fn(async () => 'deb' as const),
    handoff: vi.fn(async (request: { onAccepted?: (resultLogPath?: string) => void }) => request.onAccepted?.()),
    transport,
  };
}
