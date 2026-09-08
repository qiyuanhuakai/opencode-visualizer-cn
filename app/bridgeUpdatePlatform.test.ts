// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  assertBridgeInstallAllowed,
  assertManagedInstallation,
  collectDarwinAncestors,
  collectLinuxAncestors,
  collectWindowsAncestors,
  hasBridgeHostedAncestor,
  readLinuxExecutableWithSudo,
  selectLinuxPackageFormat,
} from '../bridge/updatePlatform.js';

describe('bridge updater platform admission', () => {
  it('requires the updater to run from the platform-managed executable', () => {
    expect(() => assertManagedInstallation('/tmp/vis_bridge', 'linux', {})).toThrow('installed');
    expect(() => assertManagedInstallation('/usr/bin/vis_bridge', 'linux', {})).not.toThrow();
    expect(() => assertManagedInstallation('/usr/local/bin/vis_bridge', 'darwin', {})).not.toThrow();
    expect(() => assertManagedInstallation(
      String.raw`C:\Users\me\AppData\Local\Programs\vis_bridge\VIS_BRIDGE.EXE`,
      'win32', { LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local` },
    )).not.toThrow();
  });

  it('identifies an installed bridge executable anywhere in the ancestor chain', () => {
    expect(hasBridgeHostedAncestor([
      { pid: 20, executable: '/bin/bash' },
      { pid: 10, executable: '/usr/bin/vis_bridge' },
    ], '/usr/bin/vis_bridge', 'linux')).toBe(true);
    expect(hasBridgeHostedAncestor([
      { pid: 20, executable: '/bin/bash' },
      { pid: 10, executable: '/usr/bin/node' },
    ], '/usr/bin/vis_bridge', 'linux')).toBe(false);
    expect(hasBridgeHostedAncestor([
      { pid: 10, executable: 'vis_bridge' },
    ], '/usr/local/bin/vis_bridge', 'darwin')).toBe(true);
  });

  it('refuses installation from a bridge-hosted terminal ancestor', async () => {
    await expect(assertBridgeInstallAllowed({
      platform: 'linux', execPath: '/usr/bin/vis_bridge', pid: 20,
      collectAncestors: async () => [{ pid: 10, executable: '/usr/bin/vis_bridge' }],
    })).rejects.toThrow('bridge-hosted terminal');
  });

  it('selects DEB or RPM only when ownership, distro family, and installed tooling agree', async () => {
    const probe = vi.fn(async (command: string) => ({
      '/usr/bin/dpkg-query': { code: 1, stdout: '' },
      '/usr/bin/rpm': { code: 0, stdout: 'vis-bridge-0.7.13' },
    }[command] ?? { code: 1, stdout: '' }));

    await expect(selectLinuxPackageFormat({
      osRelease: 'ID=fedora\nID_LIKE="rhel centos"\n',
      installedPath: '/usr/bin/vis_bridge',
      requireOwnership: true,
      toolExists: (tool) => tool === '/usr/bin/rpm',
      probe,
    })).resolves.toBe('rpm');
  });

  it('fails closed when Linux package ownership evidence is ambiguous', async () => {
    await expect(selectLinuxPackageFormat({
      osRelease: 'ID=ubuntu\nID_LIKE=debian\n',
      installedPath: '/usr/bin/vis_bridge',
      requireOwnership: true,
      toolExists: () => true,
      probe: async () => ({ code: 0, stdout: 'owned' }),
    })).rejects.toThrow('unambiguously');
  });

  it('fails closed when a live Linux ancestor executable cannot be inspected', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(collectLinuxAncestors(42, {
      readFile: async () => '42 (node) S 1 0 0 0',
      readlink: async () => { throw permissionError; },
    })).rejects.toThrow('Unable to inspect live process ancestry');
  });

  it('tolerates a Linux ancestor that genuinely exits during inspection', async () => {
    const goneError = Object.assign(new Error('gone'), { code: 'ENOENT' });
    await expect(collectLinuxAncestors(42, {
      readFile: async () => { throw goneError; },
      readlink: async () => '/usr/bin/node',
    })).resolves.toEqual([]);
  });

  it.each(['EACCES', 'EPERM'])('uses a privileged executable lookup only for %s and preserves process identity', async (code) => {
    const permissionError = Object.assign(new Error('permission denied'), { code });
    const privilegedReadlink = vi.fn(async () => '/init');
    let statReads = 0;
    await expect(collectLinuxAncestors(42, {
      readFile: async () => {
        statReads += 1;
        return linuxProcessStat(42, 0, 100);
      },
      readlink: async () => { throw permissionError; },
      privilegedReadlink,
    })).resolves.toEqual([{ pid: 42, executable: '/init' }]);

    expect(privilegedReadlink).toHaveBeenCalledWith(42);
    expect(statReads).toBe(2);
  });

  it('does not escalate a non-permission Linux executable lookup failure', async () => {
    const privilegedReadlink = vi.fn(async () => '/init');
    await expect(collectLinuxAncestors(42, {
      readFile: async () => linuxProcessStat(42, 0, 100),
      readlink: async () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); },
      privilegedReadlink,
    })).rejects.toThrow('Unable to inspect live process ancestry');
    expect(privilegedReadlink).not.toHaveBeenCalled();
  });

  it('rejects a reused PID after privileged Linux executable inspection', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    let statReads = 0;
    await expect(collectLinuxAncestors(42, {
      readFile: async () => linuxProcessStat(42, 0, statReads++ < 1 ? 100 : 101),
      readlink: async () => { throw permissionError; },
      privilegedReadlink: async () => '/init',
    })).rejects.toThrow('changed during privileged inspection');
  });

  it.each([
    [false, ['/usr/bin/readlink', '--', '/proc/42/exe']],
    [true, ['-n', '/usr/bin/readlink', '--', '/proc/42/exe']],
  ])('uses fixed sudo argv for privileged Linux identity lookup (noninteractive=%s)', async (nonInteractiveYes, expectedArgs) => {
    const probe = vi.fn(async () => ({ code: 0, stdout: '/init\n' }));

    await expect(readLinuxExecutableWithSudo(42, { nonInteractiveYes, probe })).resolves.toBe('/init');
    expect(probe).toHaveBeenCalledWith('/usr/bin/sudo', expectedArgs);
  });

  it('fails closed when ps cannot inspect a live macOS ancestor', async () => {
    await expect(collectDarwinAncestors(42, {
      probe: async () => ({ code: 1, stdout: '' }),
      isAlive: () => true,
    })).rejects.toThrow('Unable to inspect live process ancestry');
  });

  it('tolerates a macOS ancestor that exits before ps observes it', async () => {
    await expect(collectDarwinAncestors(42, {
      probe: async () => ({ code: 1, stdout: '' }),
      isAlive: () => false,
    })).resolves.toEqual([]);
  });

  it('fails closed when PowerShell cannot inspect a live Windows ancestor', async () => {
    await expect(collectWindowsAncestors(42, { SystemRoot: String.raw`C:\Windows` }, {
      probe: async () => ({ code: 1, stdout: '' }),
      isAlive: () => true,
    })).rejects.toThrow('Unable to inspect live process ancestry');
  });

  it('uses the protected system PowerShell path instead of a caller-controlled environment path', async () => {
    const probe = vi.fn(async () => ({ code: 1, stdout: '' }));
    await collectWindowsAncestors(42, { SystemRoot: String.raw`C:\attacker` }, {
      probe,
      isAlive: () => false,
    });

    expect(probe).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      expect.any(Array),
    );
  });
});

function linuxProcessStat(pid: number, parentPid: number, startTime: number): string {
  return `${pid} (process) ${['S', String(parentPid), ...Array(17).fill('0'), String(startTime)].join(' ')}`;
}
