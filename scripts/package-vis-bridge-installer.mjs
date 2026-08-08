import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  createLinuxMaintainerScript,
  createMacPreinstallScript,
  createWindowsStopScript,
  windowsStopDaemonLines,
} from './vis-bridge-installer-lifecycle.mjs';

export { createLinuxMaintainerScript, createMacPreinstallScript, createWindowsStopScript };

const execFileAsync = promisify(execFile);

export class VisBridgeInstallerTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisBridgeInstallerTargetError';
  }
}

function normalizedVersion(version) {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(version);
  if (!match) {
    throw new VisBridgeInstallerTargetError(`Invalid vis_bridge installer version: ${version}`);
  }
  return match[1];
}

function checkedArchitecture(arch) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new VisBridgeInstallerTargetError(
      `Unsupported vis_bridge installer architecture: ${arch}`,
    );
  }
  return arch;
}

export function createVisBridgeInstallerAssetName(target) {
  const version = normalizedVersion(target.version);
  const arch = checkedArchitecture(target.arch);
  switch (target.platform) {
    case 'linux':
      return `VisBridge-${version}-${arch}-Linux.deb`;
    case 'darwin':
      return `VisBridge-${version}-${arch}-MacOS.pkg`;
    case 'win32':
      return `VisBridge-${version}-${arch}-Windows.exe`;
    default:
      throw new VisBridgeInstallerTargetError(
        `Unsupported vis_bridge installer platform: ${target.platform}`,
      );
  }
}

export function createVisBridgeInstallerPaths(rootDirectory, target) {
  const installerDirectory = path.join(rootDirectory, 'dist-bridge', 'installers');
  return {
    binaryPath: path.join(
      rootDirectory,
      'dist-bridge',
      target.platform === 'win32' ? 'vis_bridge.exe' : 'vis_bridge',
    ),
    installerDirectory,
    installerPath: path.join(installerDirectory, createVisBridgeInstallerAssetName(target)),
    workspacePath: path.join(
      rootDirectory,
      'dist-bridge',
      'installer-work',
      `${target.platform}-${checkedArchitecture(target.arch)}`,
    ),
  };
}

async function packageLinuxInstaller(paths, target) {
  const binaryDirectory = path.join(paths.workspacePath, 'usr', 'bin');
  const metadataDirectory = path.join(paths.workspacePath, 'DEBIAN');
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(metadataDirectory, { recursive: true });
  const installedBinary = path.join(binaryDirectory, 'vis_bridge');
  await copyFile(paths.binaryPath, installedBinary);
  await chmod(installedBinary, 0o755);
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

async function packageMacInstaller(paths, target) {
  const binaryDirectory = path.join(paths.workspacePath, 'usr', 'local', 'bin');
  await mkdir(binaryDirectory, { recursive: true });
  const installedBinary = path.join(binaryDirectory, 'vis_bridge');
  await copyFile(paths.binaryPath, installedBinary);
  await chmod(installedBinary, 0o755);
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

function windowsPathScript(operation) {
  const operationLines = {
    add: [
      'if ($entries -notcontains $InstallDirectory) {',
      '  $entries = @($InstallDirectory) + $entries',
      '}',
    ],
    remove: ['$entries = @($entries | Where-Object { $_ -ne $InstallDirectory })'],
  }[operation];
  if (!operationLines) {
    throw new VisBridgeInstallerTargetError(`Unsupported Windows PATH operation: ${operation}`);
  }
  return [
    'param([Parameter(Mandatory = $true)][string]$InstallDirectory)',
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$entries = @($current -split ';' | Where-Object { $_ })",
    ...operationLines,
    "$updated = $entries -join ';'",
    "[Environment]::SetEnvironmentVariable('Path', $updated, 'User')",
    '',
  ].join('\r\n');
}

export function createNsiPath(filePath) {
  return filePath.replaceAll('$', '$$').replaceAll('"', '$\\"');
}

export function createWindowsInstallerScript(paths) {
  const addPathScript = path.join(paths.workspacePath, 'add-path.ps1');
  const removePathScript = path.join(paths.workspacePath, 'remove-path.ps1');
  const stopDaemonScript = path.join(paths.workspacePath, 'stop-daemon.ps1');
  return [
    '!include "MUI2.nsh"',
    '!include "LogicLib.nsh"',
    '!include "WinMessages.nsh"',
    'Unicode True',
    'Name "Vis Bridge"',
    `OutFile "${createNsiPath(paths.installerPath)}"`,
    'InstallDir "$LOCALAPPDATA\\Programs\\vis_bridge"',
    'RequestExecutionLevel user',
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_UNPAGE_CONFIRM',
    '!insertmacro MUI_UNPAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "English"',
    'Section "Install"',
    ...windowsStopDaemonLines('install', createNsiPath(stopDaemonScript)),
    '  SetOutPath "$INSTDIR"',
    `  File /oname=vis_bridge.exe "${createNsiPath(paths.binaryPath)}"`,
    `  File /oname=remove-path.ps1 "${createNsiPath(removePathScript)}"`,
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    '  InitPluginsDir',
    '  SetOutPath "$PLUGINSDIR"',
    `  File /oname=add-path.ps1 "${createNsiPath(addPathScript)}"`,
    '  nsExec::ExecToLog \'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\\add-path.ps1" "$INSTDIR"\'',
    '  Pop $0',
    '  StrCmp $0 "0" +2',
    '  Abort',
    '  System::Call \'USER32::SendMessageTimeout(p 0xffff, i ${WM_SETTINGCHANGE}, p 0, t "Environment", i 0x2, i 5000, *p .r0)\'',
    'SectionEnd',
    'Section "Uninstall"',
    ...windowsStopDaemonLines('uninstall', createNsiPath(stopDaemonScript)),
    '  nsExec::ExecToLog \'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\\remove-path.ps1" "$INSTDIR"\'',
    '  Delete "$INSTDIR\\vis_bridge.exe"',
    '  Delete "$INSTDIR\\remove-path.ps1"',
    '  Delete "$INSTDIR\\Uninstall.exe"',
    '  RMDir "$INSTDIR"',
    '  System::Call \'USER32::SendMessageTimeout(p 0xffff, i ${WM_SETTINGCHANGE}, p 0, t "Environment", i 0x2, i 5000, *p .r0)\'',
    'SectionEnd',
    '',
  ].join('\r\n');
}

async function packageWindowsInstaller(paths) {
  const addPathScript = path.join(paths.workspacePath, 'add-path.ps1');
  const removePathScript = path.join(paths.workspacePath, 'remove-path.ps1');
  const nsiScript = path.join(paths.workspacePath, 'vis-bridge-installer.nsi');
  await mkdir(paths.workspacePath, { recursive: true });
  await writeFile(addPathScript, windowsPathScript('add'), 'utf8');
  await writeFile(removePathScript, windowsPathScript('remove'), 'utf8');
  await writeFile(path.join(paths.workspacePath, 'stop-daemon.ps1'), createWindowsStopScript(), 'utf8');
  await writeFile(nsiScript, createWindowsInstallerScript(paths), 'utf8');
  await execFileAsync('makensis', [nsiScript]);
}

export async function packageVisBridgeInstaller(rootDirectory, target) {
  const paths = createVisBridgeInstallerPaths(rootDirectory, target);
  await rm(paths.workspacePath, { recursive: true, force: true });
  await mkdir(paths.installerDirectory, { recursive: true });
  switch (target.platform) {
    case 'linux':
      await packageLinuxInstaller(paths, target);
      break;
    case 'darwin':
      await packageMacInstaller(paths, target);
      break;
    case 'win32':
      await packageWindowsInstaller(paths);
      break;
    default:
      throw new VisBridgeInstallerTargetError(
        `Unsupported vis_bridge installer platform: ${target.platform}`,
      );
  }
  return paths.installerPath;
}

const directRun =
  import.meta.url.startsWith('file:') &&
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (directRun) {
  const rootDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const packageJson = JSON.parse(await readFile(path.join(rootDirectory, 'package.json'), 'utf8'));
  const packageVersion =
    process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : packageJson.version;
  if (typeof packageVersion !== 'string') {
    throw new VisBridgeInstallerTargetError('Unable to resolve the vis_bridge installer version');
  }
  const installerPath = await packageVisBridgeInstaller(rootDirectory, {
    version: packageVersion,
    platform: process.platform,
    arch: process.arch,
  });
  process.stdout.write(`${installerPath}\n`);
}
