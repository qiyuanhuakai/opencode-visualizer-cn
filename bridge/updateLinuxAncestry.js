import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

export async function collectLinuxAncestors(firstPid, options = {}) {
  const readStat = options.readFile ?? readFile;
  const readExecutable = options.readlink ?? readlink;
  const ancestors = [];
  const visited = new Set();
  let pid = firstPid;
  while (pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    const stat = await readProcessStat(readStat, pid);
    if (!stat) break;
    const identity = parseProcessIdentity(stat, pid);
    const executable = await resolveExecutable({
      pid,
      identity,
      readExecutable,
      readStat,
      privilegedReadlink: options.privilegedReadlink,
    });
    if (executable === null) break;
    ancestors.push({ pid, executable });
    pid = identity.parentPid;
  }
  return ancestors;
}

export function privilegedLinuxReadlinkCommand(pid, nonInteractiveYes) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Linux ancestor PID.');
  return {
    command: '/usr/bin/sudo',
    args: [
      ...(nonInteractiveYes ? ['-n'] : []),
      '/usr/bin/readlink',
      '--',
      `/proc/${pid}/exe`,
    ],
  };
}

export async function readLinuxExecutableWithSudo(pid, options = {}) {
  const invocation = privilegedLinuxReadlinkCommand(pid, options.nonInteractiveYes ?? false);
  const result = await (options.probe ?? execFileResult)(invocation.command, invocation.args);
  const executable = result.stdout.trim();
  if (result.code !== 0 || !path.isAbsolute(executable)) {
    throw new Error(`Unable to inspect Linux ancestor PID ${pid} with sudo.`);
  }
  return executable;
}

async function resolveExecutable(options) {
  try {
    return await options.readExecutable(`/proc/${options.pid}/exe`);
  } catch (error) {
    if (isGoneProcessError(error)) return null;
    if (!isPermissionError(error) || !options.privilegedReadlink) {
      throw processInspectionError(options.pid, error);
    }
    return resolvePrivilegedExecutable(options);
  }
}

async function resolvePrivilegedExecutable(options) {
  let executable;
  let privilegedError;
  try {
    executable = await options.privilegedReadlink(options.pid);
  } catch (error) {
    privilegedError = error;
  }
  const currentStat = await readProcessStat(options.readStat, options.pid);
  if (!currentStat) return null;
  const currentIdentity = parseProcessIdentity(currentStat, options.pid);
  if (currentIdentity.startTime !== options.identity.startTime
    || currentIdentity.parentPid !== options.identity.parentPid) {
    throw new Error(`Linux ancestor PID ${options.pid} changed during privileged inspection.`);
  }
  if (privilegedError) throw processInspectionError(options.pid, privilegedError);
  return executable;
}

async function readProcessStat(readStat, pid) {
  try {
    return await readStat(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (isGoneProcessError(error)) return null;
    throw processInspectionError(pid, error);
  }
}

function parseProcessIdentity(stat, expectedPid) {
  const nameEnd = stat.lastIndexOf(')');
  const statPid = Number.parseInt(stat.slice(0, stat.indexOf('(')).trim(), 10);
  const fields = stat.slice(nameEnd + 2).trim().split(/\s+/u);
  const parentPid = Number.parseInt(fields[1] ?? '', 10);
  const startTime = fields[19];
  if (nameEnd < 0 || statPid !== expectedPid || !Number.isSafeInteger(parentPid) || !startTime) {
    throw processInspectionError(expectedPid);
  }
  return { parentPid, startTime };
}

function isGoneProcessError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isPermissionError(error) {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'EACCES' || error.code === 'EPERM');
}

function processInspectionError(pid, cause) {
  return new Error(
    `Unable to inspect live process ancestry on Linux at PID ${pid}.`,
    cause ? { cause } : undefined,
  );
}

function execFileResult(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}
