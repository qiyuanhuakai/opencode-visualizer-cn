import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { findLocalWslBridge, openWslBridgeTerminal, parseWslDistros } from '../electron/updateWsl.js';

describe('local WSL bridge updates', () => {
  it('decodes UTF-16 WSL distro names and selects the sole matching installation', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === '--list') return { stdout: Buffer.from('\ufeffUbuntu\r\ndocker-desktop\r\n', 'utf16le') };
      return { stdout: args[1] === 'Ubuntu' ? 'vis_bridge 0.8.5\n' : 'vis_bridge 0.7.0\n' };
    });

    expect(parseWslDistros(Buffer.from('\ufeffUbuntu\r\ndocker-desktop\r\n', 'utf16le')))
      .toEqual(['Ubuntu', 'docker-desktop']);
    await expect(findLocalWslBridge('0.8.5', run)).resolves.toBe('Ubuntu');
    expect(run).toHaveBeenCalledWith('wsl.exe',
      ['--distribution', 'Ubuntu', '--exec', 'vis_bridge', '--version'],
      expect.objectContaining({ encoding: 'utf8' }));
  });

  it('does not guess when two WSL distributions carry the connected version', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => ({
      stdout: args[0] === '--list' ? Buffer.from('Ubuntu\nDebian\n') : 'vis_bridge 0.8.5',
    }));

    await expect(findLocalWslBridge('0.8.5', run)).resolves.toBeNull();
  });

  it('launches the selected distro in Windows Terminal with an interactive update command', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    const unref = vi.fn(() => undefined);
    child.unref = unref;
    const launch = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await openWslBridgeTerminal('Ubuntu', launch);

    expect(launch).toHaveBeenCalledWith('wt.exe', [
      'new-tab', '--title', 'vis_bridge (Ubuntu)', 'wsl.exe', '--distribution', 'Ubuntu',
      '--exec', 'sh', '-lc', 'vis_bridge update; exec "${SHELL:-/bin/sh}" -l',
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    expect(unref).toHaveBeenCalledOnce();
  });
});
