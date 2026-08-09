import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createDaemonController } from '../bridge/daemonController.js';
import { createDaemonPaths, writeDaemonState } from '../bridge/daemonState.js';

class StuckDaemonChild extends EventEmitter {
  pid = 999_999;
  connected = true;
  kill = vi.fn(() => true);
  send = vi.fn();
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  unref = vi.fn();
}

describe('daemonController', () => {
  it('forces the detached process tree to exit after startup cancellation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-daemon-controller-test-'));
    const child = new StuckDaemonChild();
    const forceStopProcessTree = vi.fn(async () => {
      child.emit('exit', null, 'SIGKILL');
    });
    const output = { write: vi.fn() };
    const controller = createDaemonController({
      paths: createDaemonPaths({ VIS_BRIDGE_STATE_DIR: directory }),
      spawnProcess: () => {
        queueMicrotask(() => child.emit('message', { type: 'awaiting-options' }));
        return child;
      },
      stdout: output,
      stderr: output,
      startTimeoutMs: 10,
      stopTimeoutMs: 10,
      forceStopTimeoutMs: 10,
      forceStopProcessTree,
    });

    try {
      await expect(controller.start([])).rejects.toThrow('startup timed out');
      expect(child.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start-options' }),
      );
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(forceStopProcessTree).toHaveBeenCalledWith(child.pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not accept a ready message after startup cancellation began', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-daemon-controller-test-'));
    const child = new StuckDaemonChild();
    const forceStopProcessTree = vi.fn(async () => {
      child.emit('exit', null, 'SIGKILL');
    });
    const controller = createDaemonController({
      paths: createDaemonPaths({ VIS_BRIDGE_STATE_DIR: directory }),
      spawnProcess: () => {
        queueMicrotask(() => child.emit('message', { type: 'awaiting-options' }));
        setTimeout(
          () => child.emit('message', { type: 'ready', host: '127.0.0.1', port: 1, path: '/', failures: [] }),
          15,
        );
        return child;
      },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      startTimeoutMs: 10,
      stopTimeoutMs: 10,
      forceStopTimeoutMs: 10,
      forceStopProcessTree,
    });

    try {
      await expect(controller.start([])).rejects.toThrow('startup timed out');
      expect(forceStopProcessTree).toHaveBeenCalledWith(child.pid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects after force-stop deadline even when the child never emits exit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-daemon-controller-test-'));
    const child = new StuckDaemonChild();
    const controller = createDaemonController({
      paths: createDaemonPaths({ VIS_BRIDGE_STATE_DIR: directory }),
      spawnProcess: () => {
        queueMicrotask(() => child.emit('message', { type: 'awaiting-options' }));
        return child;
      },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      startTimeoutMs: 10,
      stopTimeoutMs: 10,
      forceStopTimeoutMs: 10,
      forceStopProcessTree: vi.fn(async () => undefined),
    });

    try {
      const outcome = await Promise.race([
        controller.start([]).then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
      ]);
      expect(outcome).toBe('rejected');
      expect(child.disconnect).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects restart arguments that omit required credentials before stopping the daemon', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-daemon-controller-test-'));
    const paths = createDaemonPaths({ VIS_BRIDGE_STATE_DIR: directory });
    await writeDaemonState(paths, {
      instanceId: 'required-credential-test',
      pid: process.pid,
      state: 'running',
      controlPort: 1,
      controlToken: 'control-token',
      failures: [],
      startedAt: new Date().toISOString(),
      launchArgs: [],
      requiredSecrets: ['VIS_BRIDGE_TOKEN'],
      credentialFingerprint: 'fingerprint',
      logPath: paths.logPath,
    });
    const controller = createDaemonController({
      paths,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    try {
      await expect(controller.restart(['--port', '9000'])).rejects.toThrow(
        'requires the original direct token options',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('removes credentials and the control token from the daemon spawn environment', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-daemon-controller-test-'));
    const child = new StuckDaemonChild();
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    const controller = createDaemonController({
      paths: createDaemonPaths({ VIS_BRIDGE_STATE_DIR: directory }),
      env: {
        VIS_BRIDGE_STATE_DIR: directory,
        VIS_BRIDGE_TOKEN: 'bridge-secret',
        VIS_BRIDGE_CODEX_TOKEN: 'codex-secret',
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/secret/token-file',
        VIS_BRIDGE_CODEX_AUTHORIZATION: 'Bearer authorization-secret',
      },
      spawnProcess: (_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawnedEnvironment = options.env;
        queueMicrotask(() => {
          child.emit('message', { type: 'awaiting-options' });
          child.emit('message', {
            type: 'ready', host: '127.0.0.1', port: 23004, path: '/codex', failures: [],
          });
        });
        return child;
      },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    try {
      await controller.start([]);
      expect(spawnedEnvironment).toMatchObject({
        VIS_BRIDGE_STATE_DIR: directory,
        VIS_BRIDGE_DAEMON_INSTANCE_ID: expect.any(String),
      });
      for (const name of [
        'VIS_BRIDGE_DAEMON_CONTROL_TOKEN',
        'VIS_BRIDGE_TOKEN',
        'VIS_BRIDGE_CODEX_TOKEN',
        'VIS_BRIDGE_CODEX_TOKEN_FILE',
        'VIS_BRIDGE_CODEX_AUTHORIZATION',
      ]) {
        expect(spawnedEnvironment).not.toHaveProperty(name);
      }
      expect(child.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start-options', controlToken: expect.any(String) }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe persisted target before stopping the running daemon', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-daemon-controller-test-'));
    const paths = createDaemonPaths({ VIS_BRIDGE_STATE_DIR: directory });
    await writeDaemonState(paths, {
      instanceId: 'unsafe-target-test',
      pid: process.pid,
      state: 'running',
      controlPort: 1,
      controlToken: 'control-token',
      failures: [],
      startedAt: new Date().toISOString(),
      launchArgs: ['--target=wss://example.test/codex?access_token=secret'],
      logPath: paths.logPath,
    });
    const controller = createDaemonController({
      paths,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    try {
      await expect(controller.restart([])).rejects.toThrow(
        'must not include credentials, query parameters, or fragments',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
