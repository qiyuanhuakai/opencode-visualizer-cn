import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const STATE_VERSION = 1;
const ACTIVE_LOCK_MAX_AGE_MS = 30_000;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

export function createDaemonPaths(env = process.env) {
  const configured = env.VIS_BRIDGE_STATE_DIR?.trim();
  const stateDirectory = configured || (() => {
    if (process.platform === 'win32') {
      return path.join(env.LOCALAPPDATA?.trim() || path.join(homedir(), 'AppData', 'Local'), 'vis', 'bridge');
    }
    if (process.platform === 'darwin') {
      return path.join(homedir(), 'Library', 'Application Support', 'vis', 'bridge');
    }
    return path.join(env.XDG_STATE_HOME?.trim() || path.join(homedir(), '.local', 'state'), 'vis', 'bridge');
  })();
  return {
    stateDirectory,
    statePath: path.join(stateDirectory, 'daemon.json'),
    lockPath: path.join(stateDirectory, 'control.lock'),
    logPath: path.join(stateDirectory, 'daemon.log'),
  };
}

function parseFailure(value) {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.error !== 'string') {
    throw new Error('Invalid vis_bridge daemon startup failure.');
  }
  return {
    name: value.name,
    error: value.error,
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
  };
}

function parseDaemonState(value) {
  if (
    !isRecord(value) ||
    value.version !== STATE_VERSION ||
    typeof value.instanceId !== 'string' ||
    typeof value.pid !== 'number' ||
    typeof value.state !== 'string' ||
    !['starting', 'running', 'error'].includes(value.state) ||
    typeof value.logPath !== 'string' ||
    !Array.isArray(value.launchArgs) ||
    !value.launchArgs.every((argument) => typeof argument === 'string') ||
    (value.requiredSecrets !== undefined &&
      (!Array.isArray(value.requiredSecrets) ||
        !value.requiredSecrets.every((secret) => typeof secret === 'string')))
  ) {
    throw new Error('Invalid vis_bridge daemon state file.');
  }
  if (value.state === 'running') {
    if (
      typeof value.controlPort !== 'number' ||
      typeof value.controlToken !== 'string' ||
      !Array.isArray(value.failures)
    ) {
      throw new Error('Invalid running vis_bridge daemon state.');
    }
  }
  return {
    version: STATE_VERSION,
    instanceId: value.instanceId,
    pid: value.pid,
    state: value.state,
    logPath: value.logPath,
    launchArgs: [...value.launchArgs],
    ...(Array.isArray(value.requiredSecrets)
      ? { requiredSecrets: [...value.requiredSecrets] }
      : {}),
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.host === 'string' ? { host: value.host } : {}),
    ...(typeof value.port === 'number' ? { port: value.port } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.controlPort === 'number' ? { controlPort: value.controlPort } : {}),
    ...(typeof value.controlToken === 'string' ? { controlToken: value.controlToken } : {}),
    ...(Array.isArray(value.failures) ? { failures: value.failures.map(parseFailure) } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export async function readDaemonState(paths) {
  try {
    return parseDaemonState(JSON.parse(await readFile(paths.statePath, 'utf8')));
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function writeDaemonState(paths, state) {
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${paths.statePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, paths.statePath);
}

export async function removeDaemonState(paths, instanceId) {
  const state = await readDaemonState(paths);
  if (!state || state.instanceId !== instanceId) return;
  await rm(paths.statePath, { force: true });
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reclaimStaleLock(paths) {
  let lockOwner;
  try {
    lockOwner = JSON.parse(await readFile(paths.lockPath, 'utf8'));
  } catch (error) {
    if (!isMissingFileError(error)) {
      const metadata = await stat(paths.lockPath);
      if (Date.now() - metadata.mtimeMs < ACTIVE_LOCK_MAX_AGE_MS) {
        throw new Error('Another vis_bridge lifecycle command is still starting.');
      }
    }
  }
  if (isRecord(lockOwner) && typeof lockOwner.pid === 'number' && isProcessAlive(lockOwner.pid)) {
    throw new Error(`Another vis_bridge lifecycle command is running (pid ${lockOwner.pid}).`);
  }
  const stalePath = `${paths.lockPath}.stale-${randomUUID()}`;
  try {
    await rename(paths.lockPath, stalePath);
    await rm(stalePath, { force: true });
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export async function withDaemonLock(paths, operation) {
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(paths.lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, 'utf8');
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST' || attempt > 0) throw error;
      await reclaimStaleLock(paths);
    }
  }
  if (!handle) throw new Error('Unable to acquire the vis_bridge lifecycle lock.');
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(paths.lockPath, { force: true });
  }
}
