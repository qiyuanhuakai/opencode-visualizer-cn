import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createNsiPath,
  createVisBridgeInstallerAssetName,
  createVisBridgeInstallerPaths,
} from '../scripts/package-vis-bridge-installer.mjs';

describe('vis_bridge installer packaging', () => {
  it('uses native installer extensions and never names a raw executable asset', () => {
    expect(
      createVisBridgeInstallerAssetName({ version: '0.7.0', platform: 'linux', arch: 'x64' }),
    ).toBe('VisBridge-0.7.0-x64-Linux.deb');
    expect(
      createVisBridgeInstallerAssetName({ version: 'v0.7.0', platform: 'darwin', arch: 'arm64' }),
    ).toBe('VisBridge-0.7.0-arm64-MacOS.pkg');
    expect(
      createVisBridgeInstallerAssetName({ version: '0.7.0', platform: 'win32', arch: 'x64' }),
    ).toBe('VisBridge-0.7.0-x64-Windows.exe');
  });

  it('keeps the raw bridge binary outside the publishable installer directory', () => {
    const root = path.resolve('/workspace/vis');
    expect(
      createVisBridgeInstallerPaths(root, { version: '0.7.0', platform: 'linux', arch: 'x64' }),
    ).toEqual({
      binaryPath: path.join(root, 'dist-bridge', 'vis_bridge'),
      installerDirectory: path.join(root, 'dist-bridge', 'installers'),
      installerPath: path.join(root, 'dist-bridge', 'installers', 'VisBridge-0.7.0-x64-Linux.deb'),
      workspacePath: path.join(root, 'dist-bridge', 'installer-work', 'linux-x64'),
    });
  });

  it('rejects targets without a native installer contract', () => {
    expect(() => {
      createVisBridgeInstallerAssetName({
        version: '0.7.0',
        platform: 'freebsd',
        arch: 'x64',
      });
    }).toThrow('Unsupported vis_bridge installer platform: freebsd');
    expect(() => {
      createVisBridgeInstallerAssetName({
        version: '0.7.0',
        platform: 'linux',
        arch: 'ia32',
      });
    }).toThrow('Unsupported vis_bridge installer architecture: ia32');
  });

  it('preserves native Windows separators in NSIS compile-time paths', () => {
    const binaryPath = String.raw`D:\a\vis\dist-bridge\vis_bridge.exe`;
    expect(createNsiPath(binaryPath)).toBe(binaryPath);
  });
});
