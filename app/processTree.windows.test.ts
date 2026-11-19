import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stopWindowsProcessTree, taskkillProcessTree } from '../bridge/processTree.js';

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

describe('Windows taskkill probe', () => {
  // Windows semantics modelled here (this suite is platform-independent): a
  // windowless console leader — every process the bridge spawns — cannot be
  // stopped by `taskkill /T` without `/F`, which exits 128. The probe therefore
  // reports the raw taskkill outcome and never spawns the PowerShell sweep.
  it('reports a successful graceful taskkill without spawning the sweep', async () => {
    const spawnProcess = vi.fn().mockImplementationOnce(() => new FakeKiller(0));

    await expect(taskkillProcessTree(42, false, { spawnProcess })).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe('taskkill');
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['/PID', '42', '/T']);
  });

  it('reports a rejected graceful taskkill for a resistant windowless leader', async () => {
    const spawnProcess = vi.fn().mockImplementationOnce(() => new FakeKiller(128));

    await expect(taskkillProcessTree(42, false, { spawnProcess })).resolves.toBe(false);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('adds the force flag for a forced taskkill', async () => {
    const spawnProcess = vi.fn().mockImplementationOnce(() => new FakeKiller(1));

    await expect(taskkillProcessTree(42, true, { spawnProcess })).resolves.toBe(false);

    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(['/PID', '42', '/T', '/F']);
  });
});

describe('Windows process tree escalation', () => {
  const platform = process.platform;
  const stop = vi.fn<typeof stopWindowsProcessTree>();
  const taskkill = vi.fn<typeof taskkillProcessTree>();
  let stopProcessTree: typeof import('../bridge/processTree.js').stopProcessTree;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.resetModules();
    stop.mockReset();
    taskkill.mockReset();
    vi.doMock('../bridge/windowsProcessTree.js', () => ({
      stopWindowsProcessTree: stop,
      taskkillProcessTree: taskkill,
    }));
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

  // Root cause of the CI timeout (run 624, `terminates descendants of a
  // SIGTERM-resistant terminal`, 10008ms): the graceful phase ran the
  // PowerShell CIM descendant sweep and then still waited out the full grace
  // period for a leader that the graceful phase provably cannot stop, before
  // escalating. The forced `taskkill /T /F` reaps the live tree anyway, so the
  // sweep and the grace wait are dead time on the critical path.
  it('escalates to forced teardown without the sweep or the grace period when the graceful taskkill fails', async () => {
    vi.useFakeTimers();
    const child = terminal();
    taskkill.mockResolvedValue(false);
    stop.mockImplementation(async (_pid: number, force: boolean) => {
      if (force) child.exitCode = 0;
    });

    const stopping = stopProcessTree(child, { graceMs: 5_000, forceMs: 5_000 })
      .then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);

    expect(taskkill).toHaveBeenCalledWith(42, false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(42, true);
    expect(await stopping).toBeUndefined();
  });

  it('forces shutdown when the graceful Windows taskkill rejects', async () => {
    const child = terminal();
    taskkill.mockRejectedValueOnce(new Error('taskkill could not start'));
    stop.mockImplementationOnce(async () => { child.exitCode = 0; });

    await expect(stopProcessTree(child)).resolves.toBeUndefined();

    expect(taskkill).toHaveBeenCalledWith(42, false);
    expect(stop).toHaveBeenCalledWith(42, true);
  });

  it('rejects with the forced cleanup failure after the graceful taskkill fails', async () => {
    const child = terminal();
    taskkill.mockResolvedValue(false);
    const forcedFailure = new Error('Forced cleanup failed');
    stop.mockRejectedValueOnce(forcedFailure);

    await expect(stopProcessTree(child)).rejects.toBe(forcedFailure);
  });

  it('does not force a terminal that exits during the Windows grace period', async () => {
    vi.useFakeTimers();
    const child = terminal();
    taskkill.mockResolvedValue(true);

    const stopping = stopProcessTree(child, { graceMs: 5_000, forceMs: 5_000 })
      .then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(stop).not.toHaveBeenCalled();

    child.emit('exit', 0, null);
    expect(await stopping).toBeUndefined();
    expect(taskkill).toHaveBeenCalledWith(42, false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('forces teardown after the grace period when the graceful taskkill succeeds but the terminal survives', async () => {
    vi.useFakeTimers();
    const child = terminal();
    taskkill.mockResolvedValue(true);
    stop.mockImplementation(async (_pid: number, force: boolean) => {
      if (force) child.exitCode = 0;
    });

    const stopping = stopProcessTree(child, { graceMs: 5_000, forceMs: 5_000 })
      .then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(await stopping).toBeUndefined();
    expect(stop).toHaveBeenCalledWith(42, true);
  });

  it('still rejects if the terminal never exits after forced cleanup', async () => {
    vi.useFakeTimers();
    const child = terminal();
    taskkill.mockResolvedValue(false);
    stop.mockResolvedValue(undefined);

    const stopping = stopProcessTree(child, { graceMs: 1, forceMs: 1 })
      .then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await stopping).toEqual(new Error('Process tree did not stop (pid 42).'));
  });
});
