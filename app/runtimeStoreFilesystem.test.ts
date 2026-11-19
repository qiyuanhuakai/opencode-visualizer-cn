// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyFilesystem, darwinMountType, probeLocalFilesystem } from '../bridge/runtime/storage/localFilesystem.js';

const MOUNT_OUTPUT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted)',
  '/dev/disk4s2 on /Volumes/Backup (hfs, local, journaled)',
  'staff.example.com:/exports on /Network/server (nfs, nodev, nosuid)',
].join('\n');
const ON_SEPARATOR_OUTPUT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
  'server:/exports on /Volumes/Share (smbfs, nodev, nosuid)',
  'staff.example.com:/exports on /Volumes/Work on NAS (smbfs, nodev, nosuid)',
  '//user@server on share on /Volumes/Relay (smbfs, nodev, nosuid)',
  'server:/exports/deep on /Volumes/Share/Deep on X (nfs, nodev, nosuid)',
  'nas.example.com:/time on /Volumes/Time on Machine (autofs, automounted)',
  '/dev/disk4s2 on /Volumes/Backup on Disk (hfs, local, journaled)',
].join('\n');
const hostPlatform = process.platform;
const unsupported = { code: 'unsupported', reason: 'unverified_local_filesystem' };
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'vis-runtime-store-on-')));
const separatorVolume = path.join(temporary, 'Work on NAS');
const separatorState = path.join(separatorVolume, 'runtime');

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
});

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

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
  it('reads the mount record whose source or mount point contains the separator text', () => {
    expect(darwinMountType(ON_SEPARATOR_OUTPUT, '/Volumes/Work on NAS/runtime')).toBe('smbfs');
    expect(darwinMountType(ON_SEPARATOR_OUTPUT, '/Volumes/Time on Machine')).toBe('autofs');
    expect(darwinMountType(ON_SEPARATOR_OUTPUT, '/Volumes/Backup on Disk/data')).toBe('hfs');
    expect(darwinMountType(ON_SEPARATOR_OUTPUT, '/Volumes/Relay/state')).toBe('smbfs');
    expect(darwinMountType(ON_SEPARATOR_OUTPUT, '/Volumes/Share/Deep on X/state')).toBe('nfs');
    const contested = ['server:/a on /Volumes/Dup (apfs, local)', 'server:/b on /Volumes/Dup (nfs, nodev, nosuid)'].join('\n');
    expect(() => darwinMountType(contested, '/Volumes/Dup/state')).toThrow(expect.objectContaining(unsupported));
  });
  it('refuses when an unrelated local record would override the real network mount with a longer pseudo suffix', () => {
    // The real mount point of the local record is the verbatim remainder after the FIRST
    // separator — `/Volumes/Backup on /Volumes/Network/State` — and it does NOT cover the
    // target. The covering candidate `/Volumes/Network/State` only exists because the loop
    // also split at the second separator, so it is a pseudo suffix of that record's own
    // mount point; it must not out-deny the NFS record that genuinely covers the target.
    const mixed = [
      'server:/share on /Volumes/Network (nfs, nodev, nosuid)',
      '/dev/disk2s1 on /Volumes/Backup on /Volumes/Network/State (hfs, local)',
    ].join('\n');
    expect(darwinMountType('server:/share on /Volumes/Network (nfs, nodev, nosuid)', '/Volumes/Network/State/runtime')).toBe('nfs');
    expect(() => darwinMountType(mixed, '/Volumes/Network/State/runtime')).toThrow(expect.objectContaining(unsupported));
    // The same local record WITHOUT the competing network mount still answers from its own
    // covering candidate: nothing below it but the root, so the split is not contested.
    const lone = '/dev/disk2s1 on /Volumes/Backup on /Volumes/Network/State (hfs, local)';
    expect(darwinMountType(lone, '/Volumes/Network/State/runtime')).toBe('hfs');
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
  it('failure refuses a macOS network volume whose mount point name contains the separator text', () => {
    mkdirSync(separatorState, { recursive: true });
    asDarwin(`/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\nstaff.example.com:/exports on ${separatorVolume} (smbfs, nodev, nosuid)`);
    expect(() => probeLocalFilesystem(separatorState)).toThrow(expect.objectContaining(unsupported));
  });
});
