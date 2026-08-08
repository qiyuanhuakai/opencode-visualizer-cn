import { randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  createDaemonPaths,
  isProcessAlive,
  readDaemonState,
  removeDaemonState,
  withDaemonLock,
} from './daemonState.js';

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 8_000;

export function createDaemonInvocation(options) {
  const { entryPath, execPath, serverArgs } = options;
  if (!entryPath) throw new Error('Unable to resolve the vis_bridge source entry path.');
  if (path.resolve(entryPath) === path.resolve(execPath)) {
    return { command: execPath, args: ['__daemon', ...serverArgs] };
  }
  return { command: execPath, args: [entryPath, '__daemon', ...serverArgs] };
}

export function collectStartupFailures(status) {
  return [...status.services, ...status.acpAgents]
    .filter((entry) => entry.state === 'error')
    .map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      error: entry.error || `${entry.name} failed to start.`,
    }));
}

function requestDaemonControl(state, action) {
  return new Promise((resolve, reject) => {
    if (state.controlPort === undefined || state.controlToken === undefined) {
      reject(new Error('vis_bridge daemon control information is unavailable.'));
      return;
    }
    const controlRequest = request(
      {
        host: '127.0.0.1',
        port: state.controlPort,
        path: action === 'stop' ? '/stop' : '/status',
        method: action === 'stop' ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${state.controlToken}`,
          'X-Vis-Bridge-Instance': state.instanceId,
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          const expectedStatus = action === 'stop' ? 202 : 200;
          if (response.statusCode === expectedStatus) resolve();
          else reject(new Error(`vis_bridge daemon rejected ${action} (${response.statusCode ?? 'unknown'}).`));
        });
      },
    );
    controlRequest.setTimeout(2_000, () => controlRequest.destroy(new Error('vis_bridge daemon control timed out.')));
    controlRequest.once('error', reject);
    controlRequest.end();
  });
}

async function waitForExit(pid) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`vis_bridge daemon did not stop (pid ${pid}).`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('vis_bridge daemon startup timed out.'));
    }, START_TIMEOUT_MS);
    const finish = (error, message) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(message);
    };
    const onMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') finish(undefined, message);
      else if (message.type === 'error') finish(new Error(String(message.error)));
    };
    const onExit = (code, signal) => {
      finish(new Error(`vis_bridge daemon exited during startup (${signal ?? code ?? 'unknown'}).`));
    };
    const onError = (error) => finish(error);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export function createDaemonController(options = {}) {
  const paths = options.paths ?? createDaemonPaths(options.env);
  const spawnProcess = options.spawnProcess ?? spawn;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  async function stopUnlocked(requestedState) {
    const state = requestedState ?? (await readDaemonState(paths));
    if (!state) {
      stdout.write('vis_bridge is not running.\n');
      return;
    }
    if (!isProcessAlive(state.pid)) {
      await removeDaemonState(paths, state.instanceId);
      stdout.write('vis_bridge is not running.\n');
      return;
    }
    if (state.state !== 'running') {
      throw new Error(`vis_bridge daemon is ${state.state}; see ${state.logPath}.`);
    }
    await requestDaemonControl(state, 'stop');
    await waitForExit(state.pid);
    stdout.write('vis_bridge stopped.\n');
  }

  async function startUnlocked(serverArgs) {
    const previous = await readDaemonState(paths);
    if (previous && isProcessAlive(previous.pid)) {
      if (previous.state === 'running') {
        await requestDaemonControl(previous, 'status');
        if (JSON.stringify(previous.launchArgs) === JSON.stringify(serverArgs)) {
          stdout.write(`vis_bridge is already running (pid ${previous.pid}).\n`);
          return previous;
        }
        throw new Error('vis_bridge is already running with different options; use vis_bridge restart.');
      }
      throw new Error(`vis_bridge daemon is ${previous.state}; see ${previous.logPath}.`);
    }
    if (previous) await removeDaemonState(paths, previous.instanceId);

    const instanceId = randomUUID();
    const controlToken = randomBytes(32).toString('hex');
    const invocation = createDaemonInvocation({
      entryPath: process.argv[1],
      execPath: process.execPath,
      serverArgs,
    });
    const logHandle = await open(paths.logPath, 'a', 0o600);
    let child;
    try {
      child = spawnProcess(invocation.command, invocation.args, {
        detached: true,
        env: {
          ...process.env,
          VIS_BRIDGE_STATE_DIR: paths.stateDirectory,
          VIS_BRIDGE_DAEMON_INSTANCE_ID: instanceId,
          VIS_BRIDGE_DAEMON_CONTROL_TOKEN: controlToken,
        },
        stdio: ['ignore', logHandle.fd, logHandle.fd, 'ipc'],
        windowsHide: true,
      });
    } finally {
      await logHandle.close();
    }
    if (!child.pid) throw new Error('vis_bridge daemon did not receive a process id.');
    const message = await waitForStartup(child);
    if (child.connected) child.disconnect();
    child.unref();
    stdout.write(`vis_bridge started (pid ${child.pid}) on ws://${message.host}:${message.port}${message.path}.\n`);
    for (const failure of message.failures) stderr.write(`${failure.name}: ${failure.error}\n`);
    return readDaemonState(paths);
  }

  return {
    start: (serverArgs) => withDaemonLock(paths, () => startUnlocked(serverArgs)),
    stop: () => withDaemonLock(paths, () => stopUnlocked()),
    restart: (serverArgs) => withDaemonLock(paths, async () => {
      const previous = await readDaemonState(paths);
      const launchArgs = serverArgs.length > 0 ? serverArgs : previous?.launchArgs ?? [];
      await stopUnlocked(previous);
      return startUnlocked(launchArgs);
    }),
  };
}
