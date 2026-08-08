import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProcessSupervisor, createNativeServiceDefinitions } from '../bridge/processSupervisor.js';

const spawnedChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (!child.killed) child.kill('SIGKILL');
  }
});

describe('processSupervisor', () => {
  it('uses verified OpenCode and Codex native launch commands', () => {
    expect(createNativeServiceDefinitions()).toEqual([
      expect.objectContaining({
        id: 'opencode',
        command: 'opencode',
        args: ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
      }),
      expect.objectContaining({
        id: 'codex',
        command: 'codex',
        args: ['app-server', '--listen', 'ws://127.0.0.1:4500'],
      }),
    ]);
  });

  it('adopts healthy native services without spawning or owning them', async () => {
    const spawnProcess = vi.fn();
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[0]],
      spawnProcess,
      probeService: vi.fn().mockResolvedValue(true),
    });

    await supervisor.start();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'opencode', state: 'adopted', owned: false }),
    ]);
    await supervisor.stop();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('spawns unavailable services and terminates only owned children', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    spawnedChildren.push(child);
    const kill = vi.spyOn(child, 'kill');
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[1]],
      spawnProcess: vi.fn(() => child),
      probeService: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      readinessIntervalMs: 0,
    });

    await supervisor.start();
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'codex', state: 'running', owned: true, pid: child.pid }),
    ]);

    await supervisor.stop();

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'codex', state: 'stopped', owned: false }),
    ]);
  });

  it('reports spawn errors without taking down other bridge surfaces', async () => {
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[0]],
      spawnProcess: vi.fn(() => {
        const child = spawn('vis-definitely-missing-opencode', [], { stdio: ['ignore', 'ignore', 'pipe'] });
        spawnedChildren.push(child);
        return child;
      }),
      probeService: vi.fn().mockResolvedValue(false),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
    });

    await supervisor.start();

    expect(supervisor.getStatus()).toEqual([
      expect.objectContaining({ id: 'opencode', state: 'error', owned: false, error: expect.stringContaining('ENOENT') }),
    ]);
  });

  it('reclaims each failed readiness generation before allowing a retry', async () => {
    const spawnProcess = vi.fn(() => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      spawnedChildren.push(child);
      return child;
    });
    const supervisor = createProcessSupervisor({
      services: [createNativeServiceDefinitions()[0]],
      spawnProcess,
      probeService: vi.fn().mockResolvedValue(false),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
    });

    await supervisor.start();
    const firstPid = spawnedChildren[0]?.pid;
    expect(() => process.kill(firstPid ?? 0, 0)).toThrow();
    await supervisor.start();
    const secondPid = spawnedChildren[1]?.pid;

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(() => process.kill(firstPid ?? 0, 0)).toThrow();
    expect(() => process.kill(secondPid ?? 0, 0)).toThrow();
    await supervisor.stop();
  });
});
