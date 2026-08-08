import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createNsiPath,
  createLinuxMaintainerScript,
  createMacPreinstallScript,
  createVisBridgeInstallerAssetName,
  createVisBridgeInstallerPaths,
  createWindowsInstallerScript,
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

  it('initializes the NSIS plug-in directory before embedding the PATH helper', () => {
    const paths = createVisBridgeInstallerPaths('/workspace', {
      version: 'v1.2.3',
      platform: 'win32',
      arch: 'x64',
    });
    const script = createWindowsInstallerScript(paths);
    expect(script.indexOf('  InitPluginsDir')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('  InitPluginsDir')).toBeLessThan(
      script.indexOf('  SetOutPath "$PLUGINSDIR"'),
    );
  });

  it('stops an existing daemon before native package upgrade or removal', () => {
    const linuxScript = createLinuxMaintainerScript();
    const macScript = createMacPreinstallScript();
    expect(linuxScript).not.toContain('/usr/bin/vis_bridge stop');
    expect(linuxScript).toContain('/usr/bin/readlink');
    expect(linuxScript).toContain('/proc/[0-9]*/exe');
    expect(linuxScript).toContain('/bin/kill -TERM');
    expect(macScript).not.toContain('/usr/local/bin/vis_bridge stop');
    expect(macScript).toContain('/usr/sbin/lsof');
    expect(macScript).toContain('/bin/kill -TERM');

    const paths = createVisBridgeInstallerPaths('/workspace', {
      version: 'v1.2.3',
      platform: 'win32',
      arch: 'x64',
    });
    const script = createWindowsInstallerScript(paths);
    expect(script).toContain('!include "LogicLib.nsh"');
    const stopCommand = 'nsExec::ExecToStack \'"$INSTDIR\\vis_bridge.exe" stop\'';
    expect(script).not.toContain('0 +6');
    expect(script).toContain('stop_existing_install:');
    expect(script).toContain('continue_install:');
    expect(script).toContain('stop_existing_uninstall:');
    expect(script).toContain('continue_uninstall:');
    expect(script.indexOf(stopCommand)).toBeGreaterThanOrEqual(0);
    expect(script.indexOf(stopCommand)).toBeLessThan(script.indexOf('File /oname=vis_bridge.exe'));
    expect(script.lastIndexOf(stopCommand)).toBeLessThan(script.indexOf('Delete "$INSTDIR\\vis_bridge.exe"'));
    expect(script).toContain("$$_.Path");
    expect(script).toContain('$INSTDIR\\vis_bridge.exe');
  });
});
