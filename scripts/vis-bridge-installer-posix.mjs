import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createLinuxMaintainerScript,
  createMacPreinstallScript,
} from './vis-bridge-installer-lifecycle.mjs';
import { stageNodePtyRuntime } from './vis-bridge-node-pty.mjs';

const execFileAsync = promisify(execFile);

export async function packageLinuxInstaller(paths, target, rootDirectory, normalizedVersion) {
  const binaryDirectory = path.join(paths.workspacePath, 'usr', 'bin');
  const metadataDirectory = path.join(paths.workspacePath, 'DEBIAN');
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(metadataDirectory, { recursive: true });
  const installedBinary = path.join(binaryDirectory, 'vis_bridge');
  await copyFile(paths.binaryPath, installedBinary);
  await chmod(installedBinary, 0o755);
  await stageNodePtyRuntime(
    rootDirectory,
    path.join(paths.workspacePath, 'usr', 'lib', 'vis_bridge', 'node_modules', 'node-pty'),
    target.platform,
    target.arch,
  );
  const architecture = target.arch === 'x64' ? 'amd64' : 'arm64';
  await writeFile(
    path.join(metadataDirectory, 'control'),
    [
      'Package: vis-bridge',
      `Version: ${normalizedVersion(target.version)}`,
      'Section: devel',
      'Priority: optional',
      `Architecture: ${architecture}`,
      'Maintainer: qiyuanhuakai',
      'Description: Local process supervisor and protocol bridge for Vis',
      '',
    ].join('\n'),
    'utf8',
  );
  const maintainerScript = createLinuxMaintainerScript();
  await writeFile(path.join(metadataDirectory, 'preinst'), maintainerScript, { encoding: 'utf8', mode: 0o755 });
  await writeFile(path.join(metadataDirectory, 'prerm'), maintainerScript, { encoding: 'utf8', mode: 0o755 });
  await execFileAsync('dpkg-deb', [
    '--build',
    '--root-owner-group',
    paths.workspacePath,
    paths.installerPath,
  ]);
}

export async function packageMacInstaller(paths, target, rootDirectory, normalizedVersion) {
  const binaryDirectory = path.join(paths.workspacePath, 'usr', 'local', 'bin');
  await mkdir(binaryDirectory, { recursive: true });
  const installedBinary = path.join(binaryDirectory, 'vis_bridge');
  await copyFile(paths.binaryPath, installedBinary);
  await chmod(installedBinary, 0o755);
  await stageNodePtyRuntime(
    rootDirectory,
    path.join(paths.workspacePath, 'usr', 'local', 'lib', 'vis_bridge', 'node_modules', 'node-pty'),
    target.platform,
    target.arch,
  );
  const scriptsDirectory = `${paths.workspacePath}-scripts`;
  await rm(scriptsDirectory, { recursive: true, force: true });
  await mkdir(scriptsDirectory, { recursive: true });
  await writeFile(path.join(scriptsDirectory, 'preinstall'), createMacPreinstallScript(), {
    encoding: 'utf8',
    mode: 0o755,
  });
  await execFileAsync('pkgbuild', [
    '--root',
    paths.workspacePath,
    '--identifier',
    'cn.qiyuanhuakai.vis-bridge',
    '--version',
    normalizedVersion(target.version),
    '--install-location',
    '/',
    '--scripts',
    scriptsDirectory,
    paths.installerPath,
  ]);
}
