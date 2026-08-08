import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createDaemonController } from '../bridge/daemonController.js';
import { createDaemonPaths } from '../bridge/daemonState.js';

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
});
