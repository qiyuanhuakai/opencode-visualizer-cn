// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import { classifyFilesystem, darwinMountType, probeLocalFilesystem } from '../bridge/runtime/storage/localFilesystem.js';

const MOUNT_OUTPUT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted)',
  '/dev/disk4s2 on /Volumes/Backup (hfs, local, journaled)',
  'staff.example.com:/exports on /Network/server (nfs, nodev, nosuid)',
].join('\n');
const hostPlatform = process.platform;
const unsupported = { code: 'unsupported', reason: 'unverified_local_filesystem' };

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
});

function asDarwin(output = MOUNT_OUTPUT) {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.mocked(execFileSync).mockReturnValue(output);
}

describe('runtime store local filesystem probe', () => {
  it('classifies apfs and hfs as local while rejecting network mounts', () => {
    expect(classifyFilesystem('darwin', 'apfs')).toEqual({ platform: 'darwin', type: 'apfs', local: true });
    expect(classifyFilesystem('darwin', 'hfs')).toMatchObject({ local: true });
    for (const type of ['autofs', 'nfs', 'smbfs', 'webdav', '/', 'apfs ', '']) {
      expect(() => classifyFilesystem('darwin', type)).toThrow(expect.objectContaining(unsupported));
    }
  });
  it('reads the filesystem type name from the longest covering mount entry', () => {
    expect(darwinMountType(MOUNT_OUTPUT, '/')).toBe('apfs');
    expect(darwinMountType(MOUNT_OUTPUT, '/Users/dev/project')).toBe('apfs');
    expect(darwinMountType(MOUNT_OUTPUT, '/System/Volumes/Data/Users/dev')).toBe('apfs');
    expect(darwinMountType(MOUNT_OUTPUT, '/Volumes/Backup/project')).toBe('hfs');
    expect(darwinMountType(MOUNT_OUTPUT, '/Volumes/Backupish')).toBe('apfs');
    expect(darwinMountType(MOUNT_OUTPUT, '/Network/server/share')).toBe('nfs');
    expect(darwinMountType(MOUNT_OUTPUT, '/anywhere/else')).toBe('apfs');
    expect(() => darwinMountType('', '/anywhere/else')).toThrow(expect.objectContaining(unsupported));
    expect(() => darwinMountType('not a mount table\n', '/anywhere/else')).toThrow(expect.objectContaining(unsupported));
  });
  it('probes a macOS directory through the mount table instead of the file type', () => {
    asDarwin();
    const probe = probeLocalFilesystem('/tmp');
    expect(probe).toMatchObject({ platform: 'darwin', type: 'apfs', local: true, canonicalPath: '/tmp' });
    expect(vi.mocked(execFileSync).mock.calls[0][0]).toBe('/sbin/mount');
  });
  it('failure rejects a macOS directory whose covering mount is not local', () => {
    asDarwin('map auto_home on /tmp (autofs, automounted)');
    expect(() => probeLocalFilesystem('/tmp')).toThrow(expect.objectContaining(unsupported));
  });
});
