import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  collectLinuxAncestors,
  readLinuxExecutableWithSudo,
} from './updateLinuxAncestry.js';

export {
  collectLinuxAncestors,
  privilegedLinuxReadlinkCommand,
  readLinuxExecutableWithSudo,
} from './updateLinuxAncestry.js';

const DEB_FAMILIES = new Set(['debian', 'linuxmint', 'pop', 'ubuntu']);
const RPM_FAMILIES = new Set(['almalinux', 'amzn', 'centos', 'fedora', 'opensuse', 'rhel', 'rocky', 'sles', 'suse']);

export function managedBridgePath(platform, env = process.env) {
  if (platform === 'linux') return '/usr/bin/vis_bridge';
  if (platform === 'darwin') return '/usr/local/bin/vis_bridge';
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return path.win32.join(env.LOCALAPPDATA, 'Programs', 'vis_bridge', 'vis_bridge.exe');
  }
  throw new Error(`vis_bridge updates are unsupported on ${platform}`);
}

export function assertManagedInstallation(execPath, platform, env = process.env) {
  const installedPath = managedBridgePath(platform, env);
  if (!sameExecutable(execPath, installedPath, platform)) {
    throw new Error(`Run the update command from the installed vis_bridge executable at ${installedPath}.`);
  }
  return installedPath;
}

export function hasBridgeHostedAncestor(ancestors, installedPath, platform) {
  return ancestors.some(({ executable }) => sameExecutable(executable, installedPath, platform)
    || (platform === 'darwin'
      && path.posix.basename(executable) === path.posix.basename(installedPath)));
}

export async function assertBridgeInstallAllowed(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const installedPath = assertManagedInstallation(options.execPath ?? process.execPath, platform, env);
  const pid = options.pid ?? process.ppid;
  const ancestors = options.collectAncestors
    ? await options.collectAncestors(pid, platform, env)
    : await collectProcessAncestorsWithOptions({
      pid,
      platform,
      env,
      allowPrivilegedInspection: options.allowPrivilegedInspection ?? false,
      nonInteractiveYes: options.nonInteractiveYes ?? false,
    });
  if (hasBridgeHostedAncestor(ancestors, installedPath, platform)) {
    throw new Error('Refusing to update from a bridge-hosted terminal because installation stops its ancestor process tree.');
  }
}

export async function detectLinuxPackageFormat(options = {}) {
  let osRelease = '';
  try {
    osRelease = await readFile('/etc/os-release', 'utf8');
  } catch {
    throw new Error('Cannot determine the Linux distribution package format.');
  }
  return selectLinuxPackageFormat({
    osRelease,
    installedPath: '/usr/bin/vis_bridge',
    requireOwnership: options.requireOwnership ?? false,
    toolExists: existsSync,
    probe: execFileResult,
  });
}

export async function selectLinuxPackageFormat(options) {
  const debTool = options.toolExists('/usr/bin/dpkg-query');
  const rpmTool = options.toolExists('/usr/bin/rpm');
  const [debOwner, rpmOwner] = await Promise.all([
    debTool
      ? options.probe('/usr/bin/dpkg-query', ['--search', options.installedPath])
      : { code: 1, stdout: '' },
    rpmTool
      ? options.probe('/usr/bin/rpm', ['-qf', '--queryformat', '%{NAME}', options.installedPath])
      : { code: 1, stdout: '' },
  ]);
  const ownedFormats = [
    ...(debOwner.code === 0 ? ['deb'] : []),
    ...(rpmOwner.code === 0 ? ['rpm'] : []),
  ];
  if (ownedFormats.length > 1) throw ambiguousLinuxPackageError();

  const distroFormats = linuxDistroFormats(options.osRelease);
  if (ownedFormats.length === 1) {
    const owned = ownedFormats[0];
    if (distroFormats.length !== 1 || distroFormats[0] !== owned) throw ambiguousLinuxPackageError();
    return owned;
  }
  if (options.requireOwnership) throw ambiguousLinuxPackageError();

  const available = distroFormats.filter((format) => format === 'deb' ? debTool : rpmTool);
  if (available.length !== 1) throw ambiguousLinuxPackageError();
  return available[0];
}

export async function collectProcessAncestors(pid, platform, env = process.env) {
  return collectProcessAncestorsWithOptions({ pid, platform, env });
}

async function collectProcessAncestorsWithOptions(options) {
  if (options.platform === 'linux') return collectLinuxAncestors(options.pid, {
    privilegedReadlink: options.allowPrivilegedInspection
      ? (ancestorPid) => readLinuxExecutableWithSudo(ancestorPid, {
        nonInteractiveYes: options.nonInteractiveYes,
      })
      : undefined,
  });
  if (options.platform === 'darwin') return collectDarwinAncestors(options.pid);
  if (options.platform === 'win32') return collectWindowsAncestors(options.pid, options.env);
  return [];
}

export async function collectDarwinAncestors(firstPid, runtime = {
  probe: execFileResult,
  isAlive: processIsAlive,
}) {
  const ancestors = [];
  const visited = new Set();
  let pid = firstPid;
  while (pid > 1 && !visited.has(pid)) {
    visited.add(pid);
    const result = await runtime.probe('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm=']);
    if (result.code !== 0) {
      if (runtime.isAlive(pid)) throw processInspectionError('macOS', pid);
      break;
    }
    const match = /^\s*(\d+)\s+(.+)$/u.exec(result.stdout.trim());
    if (!match) {
      if (runtime.isAlive(pid)) throw processInspectionError('macOS', pid);
      break;
    }
    ancestors.push({ pid, executable: match[2] });
    pid = Number.parseInt(match[1], 10);
  }
  return ancestors;
}

export async function collectWindowsAncestors(firstPid, _env, runtime = {
  probe: execFileResult,
  isAlive: processIsAlive,
}) {
  const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress';
  const result = await runtime.probe(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (result.code !== 0) {
    if (runtime.isAlive(firstPid)) throw processInspectionError('Windows', firstPid);
    return [];
  }
  const parsed = JSON.parse(result.stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const byPid = new Map(rows.map((row) => [Number(row.ProcessId), row]));
  const ancestors = [];
  const visited = new Set();
  let pid = firstPid;
  while (pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    const row = byPid.get(pid);
    if (!row) {
      if (runtime.isAlive(pid)) throw processInspectionError('Windows', pid);
      break;
    }
    if (typeof row.ExecutablePath !== 'string' || row.ExecutablePath.length === 0) {
      if (Number(row.ParentProcessId) === 0) break;
      throw processInspectionError('Windows', pid);
    }
    ancestors.push({ pid, executable: row.ExecutablePath });
    pid = Number(row.ParentProcessId);
  }
  return ancestors;
}

function linuxDistroFormats(osRelease) {
  const values = new Set();
  for (const line of osRelease.split('\n')) {
    const match = /^(?:ID|ID_LIKE)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    for (const value of match[1].replace(/^['"]|['"]$/gu, '').toLowerCase().split(/\s+/u)) values.add(value);
  }
  return [
    ...([...values].some((value) => DEB_FAMILIES.has(value)) ? ['deb'] : []),
    ...([...values].some((value) => RPM_FAMILIES.has(value)) ? ['rpm'] : []),
  ];
}

function sameExecutable(left, right, platform) {
  const normalize = platform === 'win32'
    ? (value) => path.win32.normalize(value).toLowerCase()
    : (value) => path.normalize(value);
  return normalize(left) === normalize(right);
}

function ambiguousLinuxPackageError() {
  return new Error('Cannot unambiguously select a DEB or RPM package from ownership, distribution, and tooling evidence.');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    throw error;
  }
}

function processInspectionError(platform, pid, cause) {
  return new Error(`Unable to inspect live process ancestry on ${platform} at PID ${pid}.`, cause ? { cause } : undefined);
}

function execFileResult(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}
