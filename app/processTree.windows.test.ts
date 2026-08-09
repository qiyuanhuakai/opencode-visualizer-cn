import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { stopWindowsProcessTree } from '../bridge/processTree.js';

class FakeKiller extends EventEmitter {
  constructor(exitCode: number) {
    super();
    queueMicrotask(() => this.emit('exit', exitCode, null));
  }
}

describe('Windows process tree cleanup', () => {
  it('sweeps descendants when taskkill cannot find an exited leader', async () => {
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => new FakeKiller(128))
      .mockImplementationOnce(() => new FakeKiller(0));

    await stopWindowsProcessTree(42, false, { spawnProcess });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe('taskkill');
    expect(spawnProcess.mock.calls[1]?.[0]).toBe('powershell.exe');
    expect(spawnProcess.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      expect.stringContaining('Get-CimInstance Win32_Process'),
    ]));
  });

  it('rejects when both taskkill and the descendant sweep fail', async () => {
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => new FakeKiller(128))
      .mockImplementationOnce(() => new FakeKiller(1));

    await expect(stopWindowsProcessTree(42, true, { spawnProcess })).rejects.toThrow(
      'Windows process tree did not stop (pid 42)',
    );
  });
});
