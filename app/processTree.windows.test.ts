import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('Windows process tree escalation', () => {
  const platform = process.platform;
  const stop = vi.fn<typeof stopWindowsProcessTree>();
  let stopProcessTree: typeof import('../bridge/processTree.js').stopProcessTree;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.resetModules();
    stop.mockReset();
    vi.doMock('../bridge/windowsProcessTree.js', () => ({ stopWindowsProcessTree: stop }));
    ({ stopProcessTree } = await import('../bridge/processTree.js'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.doUnmock('../bridge/windowsProcessTree.js');
    vi.resetModules();
    vi.useRealTimers();
  });

  function terminal() {
    const state: { pid: number; exitCode: number | null; kill: () => boolean } = {
      pid: 42, exitCode: null, kill: () => true,
    };
    return Object.assign(new EventEmitter(), state);
  }

  it('forces shutdown when graceful tree cleanup rejects', async () => {
    const child = terminal();
    stop
      .mockRejectedValueOnce(new Error('Graceful cleanup failed'))
      .mockImplementationOnce(async () => { child.exitCode = 0; });

    await expect(stopProcessTree(child)).resolves.toBeUndefined();

    expect(stop.mock.calls).toEqual([[42, false], [42, true]]);
  });

  it('rejects with the forced cleanup failure after graceful cleanup rejects', async () => {
    const child = terminal();
    const forcedFailure = new Error('Forced cleanup failed');
    stop
      .mockRejectedValueOnce(new Error('Graceful cleanup failed'))
      .mockRejectedValueOnce(forcedFailure);

    await expect(stopProcessTree(child)).rejects.toBe(forcedFailure);
  });

  it('does not force a terminal that exits during graceful cleanup', async () => {
    const child = terminal();
    stop
      .mockImplementationOnce(async () => { child.exitCode = 0; });

    await expect(stopProcessTree(child)).resolves.toBeUndefined();

    expect(stop.mock.calls).toEqual([[42, false]]);
  });

  it('still rejects if the terminal never exits after forced cleanup', async () => {
    vi.useFakeTimers();
    const child = terminal();
    stop
      .mockRejectedValueOnce(new Error('Graceful cleanup failed'))
      .mockResolvedValue(undefined);

    const stopping = stopProcessTree(child, { graceMs: 1, forceMs: 1 })
      .then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await stopping).toEqual(new Error('Process tree did not stop (pid 42).'));
  });
});
