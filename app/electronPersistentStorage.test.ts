import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPersistentStorage } from '../electron/persistentStorage.js';

const temporaryDirectories: string[] = [];

function createStorageFile(initial: Record<string, string>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'renderer-storage.json');
  fs.writeFileSync(filePath, JSON.stringify(initial, null, 2), { mode: 0o600 });
  return { directory, filePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Electron persistent storage', () => {
  it('preserves final bytes and cache when atomic replacement fails', () => {
    // Given: one durable value exists and replacement of the staged file will fail.
    const { directory, filePath } = createStorageFile({ saved: 'old' });
    const failingFileSystem = {
      ...fs,
      renameSync: () => {
        throw new Error('injected rename failure');
      },
    };
    const storage = createPersistentStorage(filePath, failingFileSystem);

    // When: a new value reaches the filesystem commit boundary.
    expect(() => storage.setItem('saved', 'new')).toThrow('injected rename failure');

    // Then: the prior file and in-memory snapshot remain authoritative with no staged residue.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ saved: 'old' });
    expect(storage.getItem('saved')).toBe('old');
    expect(fs.readdirSync(directory)).toEqual(['renderer-storage.json']);
  });

  it('rolls back the complete migration batch when persistence fails', () => {
    // Given: native storage already owns one key and the migration rename will fail.
    const { filePath } = createStorageFile({ existing: 'native' });
    const failingFileSystem = {
      ...fs,
      renameSync: () => {
        throw new Error('injected migration failure');
      },
    };
    const storage = createPersistentStorage(filePath, failingFileSystem);

    // When: a fill-missing migration attempts one atomic commit.
    expect(() => storage.migrate({ existing: 'legacy', missing: 'legacy' })).toThrow(
      'injected migration failure',
    );

    // Then: neither durable bytes nor cache expose a partially migrated key.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ existing: 'native' });
    expect(storage.getItem('existing')).toBe('native');
    expect(storage.getItem('missing')).toBeNull();
  });

  it('commits fill-missing migration as one durable snapshot', () => {
    // Given: native storage already owns one key and a legacy batch has one missing key.
    const { filePath } = createStorageFile({ existing: 'native' });
    const storage = createPersistentStorage(filePath);

    // When: the migration transaction succeeds.
    const changes = storage.migrate({ existing: 'legacy', missing: 'legacy' });

    // Then: the native winner is preserved and the missing value is durable and observable.
    expect(changes).toEqual([{ key: 'missing', oldValue: null, newValue: 'legacy' }]);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      existing: 'native',
      missing: 'legacy',
    });
    expect(storage.getItem('missing')).toBe('legacy');
  });

  it('opens the staged file for writing before fsync', () => {
    // Given: a Windows-like filesystem rejects flushing a read-only file handle.
    const { filePath } = createStorageFile({});
    const windowsLikeFs = {
      ...fs,
      openSync: vi.fn((_filePath: string, flags: string) => {
        if (flags === 'r') throw new Error('FlushFileBuffers requires GENERIC_WRITE');
        return 1;
      }),
      fsyncSync: vi.fn(),
      closeSync: vi.fn(),
    };
    const storage = createPersistentStorage(filePath, windowsLikeFs);

    // When: a value is committed through the atomic storage writer.
    const result = storage.setItem('key', 'value');

    // Then: fsync uses a writable handle and the final file is replaced successfully.
    expect(result).toBeNull();
    expect(windowsLikeFs.openSync).toHaveBeenCalledWith(expect.any(String), 'r+');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ key: 'value' });
  });
});
