import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceCommandRunner } from '../bridge/workspaceCommand.js';

describe('workspace command lifecycle', () => {
  it('rejects new commands synchronously after closing admission', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('spawn should not be called');
    });
    const runner = createWorkspaceCommandRunner({ spawnProcess });

    await runner.close();

    await expect(runner.run({ command: process.execPath })).rejects.toThrow(
      'Command runner is shutting down',
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('retains a command whose process tree failed to stop so close can retry', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    });
    const stopProcessTree = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('command tree survived'))
      .mockResolvedValueOnce();
    const runner = createWorkspaceCommandRunner({
      spawnProcess: () => child,
      stopProcessTree,
    });
    void runner.run({ command: process.execPath });

    await expect(runner.close()).rejects.toThrow('command tree survived');
    await expect(runner.close()).resolves.toBeUndefined();

    expect(stopProcessTree).toHaveBeenCalledTimes(2);
  });
});
