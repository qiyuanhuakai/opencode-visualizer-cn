import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpTerminalManager } from '../bridge/acpTerminalManager.js';

class TestChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === 'SIGKILL') queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  });
}

describe('acpTerminalManager', () => {
  afterEach(() => vi.useRealTimers());

  it('escalates a terminal that ignores SIGTERM and completes shutdown', async () => {
    vi.useFakeTimers();
    const child = new TestChild();
    const manager = createAcpTerminalManager({ spawnProcess: () => child });
    const creation = manager.create({ command: 'resistant-terminal' });
    child.emit('spawn');
    await creation;

    const stopping = manager.stopAll();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(stopping).resolves.toBeUndefined();
  });

  it('terminates descendants of a SIGTERM-resistant terminal', { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-terminal-tree-test-'));
    const pidPath = path.join(directory, 'descendant.pid');
    const manager = createAcpTerminalManager();
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    let descendantPid: number | undefined;

    try {
      await manager.create({ command: process.execPath, args: ['-e', script, pidPath] });
      const deadline = Date.now() + 2_000;
      while (!descendantPid && Date.now() < deadline) {
        try {
          descendantPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (!descendantPid) throw new Error('Descendant PID was not published.');
      const activeDescendantPid = descendantPid;

      await manager.stopAll();

      expect(() => process.kill(activeDescendantPid, 0)).toThrow();
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {}
      }
      await manager.stopAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('escalates descendants after the terminal leader exits on SIGTERM', { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-terminal-leader-exit-'));
    const pidPath = path.join(directory, 'descendant.pid');
    const manager = createAcpTerminalManager();
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `;
    let descendantPid: number | undefined;

    try {
      await manager.create({ command: process.execPath, args: ['-e', script, pidPath] });
      await vi.waitFor(async () => {
        descendantPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
        expect(descendantPid).toBeGreaterThan(0);
      });
      await manager.stopAll();

      expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {}
      }
      await manager.stopAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases descendants after the terminal leader already exited', { timeout: 10_000 }, async () => {
    const manager = createAcpTerminalManager();
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.unref();
      process.stdout.write(String(child.pid));
    `;
    const { terminalId } = await manager.create({
      command: process.execPath,
      args: ['-e', script],
    });
    await manager.waitForExit(terminalId);
    const descendantPid = Number.parseInt(manager.output(terminalId).output, 10);

    try {
      await manager.release(terminalId);
      await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow());
    } finally {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {}
      await manager.stopAll();
    }
  });

  it('keeps outputByteLimit tails valid UTF-8 when a chunk ends mid-character', async () => {
    const child = new TestChild();
    const manager = createAcpTerminalManager({ spawnProcess: () => child });
    const creation = manager.create({ command: 'utf8-terminal', outputByteLimit: 3 });
    child.emit('spawn');
    const { terminalId } = await creation;

    child.stdout.emit('data', Buffer.from('😊b'));

    expect(manager.output(terminalId)).toMatchObject({ output: 'b', truncated: true });
  });

  it('waits for close before completing after exit so late output remains readable', async () => {
    const child = new TestChild();
    const manager = createAcpTerminalManager({ spawnProcess: () => child });
    const creation = manager.create({ command: 'draining-terminal' });
    child.emit('spawn');
    const { terminalId } = await creation;

    child.stdout.emit('data', Buffer.from('before'));
    let settled = false;
    const waiting = manager.waitForExit(terminalId).then(() => { settled = true; });
    child.emit('exit', 0, null);
    child.stdout.emit('data', Buffer.from('-after'));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(manager.output(terminalId)).toMatchObject({ output: 'before-after' });

    child.emit('close', 0, null);
    await waiting;
    expect(manager.output(terminalId)).toMatchObject({
      output: 'before-after',
      exitStatus: { exitCode: 0, signal: null },
    });
  });
});
