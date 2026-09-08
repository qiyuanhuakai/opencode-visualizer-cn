import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createNsiPath,
  createLinuxMaintainerScript,
  createLinuxRpmSpec,
  createMacPreinstallScript,
  createWindowsStopScript,
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
      createVisBridgeInstallerAssetName({
        version: '0.7.0',
        platform: 'linux',
        arch: 'x64',
        format: 'deb',
      }),
    ).toBe('VisBridge-0.7.0-x64-Linux.deb');
    expect(
      createVisBridgeInstallerAssetName({
        version: '0.7.0',
        platform: 'linux',
        arch: 'x64',
        format: 'rpm',
      }),
    ).toBe('VisBridge-0.7.0-x64-Linux.rpm');
    expect(
      createVisBridgeInstallerAssetName({ version: 'v0.7.0', platform: 'darwin', arch: 'arm64' }),
    ).toBe('VisBridge-0.7.0-arm64-MacOS.pkg');
    expect(
      createVisBridgeInstallerAssetName({ version: '0.7.0', platform: 'win32', arch: 'x64' }),
    ).toBe('VisBridge-0.7.0-x64-Windows.exe');
  });

  it('keeps DEB as the Linux default and isolates explicit RPM workspace output', () => {
    const root = path.resolve('/workspace/vis');
    expect(
      createVisBridgeInstallerPaths(root, {
        version: '0.7.0',
        platform: 'linux',
        arch: 'arm64',
        format: 'rpm',
      }),
    ).toEqual({
      binaryPath: path.join(root, 'dist-bridge', 'vis_bridge'),
      installerDirectory: path.join(root, 'dist-bridge', 'installers'),
      installerPath: path.join(
        root,
        'dist-bridge',
        'installers',
        'VisBridge-0.7.0-arm64-Linux.rpm',
      ),
      workspacePath: path.join(root, 'dist-bridge', 'installer-work', 'linux-arm64-rpm'),
    });
  });

  it('creates RPM metadata without mutating prebuilt native payloads', () => {
    const spec = createLinuxRpmSpec({
      version: '1.2.3',
      architecture: 'x86_64',
      payloadPath: '/workspace/payload',
    });
    expect(spec).toContain('Name: vis-bridge');
    expect(spec).toContain('Version: 1.2.3');
    expect(spec).toContain('BuildArch: x86_64');
    expect(spec).toContain('%global _enable_debug_packages 0');
    expect(spec).toContain('%global _build_id_links none');
    expect(spec).toContain('%global _no_recompute_build_ids 1');
    expect(spec).toContain('%global __os_install_post %{nil}');
    expect(spec).toContain('%global __brp_strip %{nil}');
    expect(spec).toContain('%{?python_disable_dependency_generator}');
    expect(spec).toContain(
      'Requires(pre): /bin/sh, /usr/bin/pgrep, /usr/bin/readlink, /usr/bin/kill, /usr/bin/sleep',
    );
    expect(spec).toContain(
      'Requires(preun): /bin/sh, /usr/bin/pgrep, /usr/bin/readlink, /usr/bin/kill, /usr/bin/sleep',
    );
    expect(spec).toContain('%attr(0755,root,root) /usr/bin/vis_bridge');
  });

  it('stops the installed RPM daemon tree before install and only before true uninstall', () => {
    const spec = createLinuxRpmSpec({
      version: '1.2.3',
      architecture: 'aarch64',
      payloadPath: '/workspace/payload',
    });
    const preinstall = spec.slice(spec.indexOf('%pre\n'), spec.indexOf('%preun\n'));
    const preuninstall = spec.slice(spec.indexOf('%preun\n'), spec.indexOf('%files\n'));
    expect(preinstall).toContain('/usr/bin/vis_bridge');
    expect(preinstall).toContain('collect_process_tree');
    expect(preuninstall).toContain('if [ "$1" -eq 0 ]; then');
    expect(preuninstall).toContain('/usr/bin/vis_bridge');
    expect(preuninstall).not.toContain('%postun');
    expect(spec).not.toContain('%postun');
    expect(spec).toContain('printf "%%s\\n"');
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
    expect(linuxScript).toContain('/usr/bin/kill -TERM');
    expect(linuxScript).toContain('/usr/bin/sleep 0.1');
    expect(linuxScript).toContain('collect_process_tree');
    expect(linuxScript).toContain('/usr/bin/pgrep -P');
    expect(linuxScript).toContain('tree_pids');
    expect(macScript).not.toContain('/usr/local/bin/vis_bridge stop');
    expect(macScript).toContain('/usr/sbin/lsof');
    expect(macScript).toContain('/bin/kill -TERM');
    expect(macScript).toContain('collect_process_tree');

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
    expect(script).toContain('stop-daemon.ps1');
    expect(script).toContain('StrCmp $0 "0" continue_install');
    expect(script).toContain('StrCmp $0 "0" continue_uninstall');
    expect(script).not.toContain('${If} $0 != 0');
    expect(script).toContain('$INSTDIR\\vis_bridge.exe');
    expect(script).toContain('SetOutPath "$INSTDIR\\node_modules\\node-pty"');
    expect(script).toContain('File /r');
    expect(script).toContain('RMDir /r "$INSTDIR\\node_modules"');
  });

  it('fails Windows package changes unless the installed executable tree is gone', () => {
    const stopScript = createWindowsStopScript();
    expect(stopScript).toContain('Get-CimInstance Win32_Process');
    expect(stopScript).toContain('ExecutablePath');
    expect(stopScript).toContain('taskkill.exe');
    expect(stopScript).toContain('throw');

    const paths = createVisBridgeInstallerPaths('/workspace', {
      version: 'v1.2.3',
      platform: 'win32',
      arch: 'x64',
    });
    const installer = createWindowsInstallerScript(paths);
    expect(installer).toContain('stop-daemon.ps1');
    expect(installer).toContain('Abort');
  });
});
