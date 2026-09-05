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

function createDirectorySyncFailureFileSystem(directory: string) {
  let directoryDescriptor: number | null = null;
  let failedDirectoryDescriptor: number | null = null;
  let directorySyncCount = 0;
  let shouldFail = true;
  const closedDescriptors: number[] = [];
  return {
    closedDescriptors,
    directorySyncCount: () => directorySyncCount,
    failedDirectoryDescriptor: () => failedDirectoryDescriptor,
    fileSystem: {
      ...fs,
      openSync: (target: fs.PathLike, flags: string) => {
        const descriptor = fs.openSync(target, flags);
        directoryDescriptor = target === directory ? descriptor : null;
        return descriptor;
      },
      fsyncSync: (descriptor: number) => {
        if (descriptor === directoryDescriptor) {
          directorySyncCount += 1;
          if (shouldFail) {
            shouldFail = false;
            failedDirectoryDescriptor = descriptor;
            throw new Error('injected directory fsync failure');
          }
        }
        fs.fsyncSync(descriptor);
      },
      closeSync: (descriptor: number) => {
        closedDescriptors.push(descriptor);
        fs.closeSync(descriptor);
      },
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Electron persistent storage', () => {
  it('does not cache a transient read failure as an empty store', () => {
    // Given: a native store contains unrelated data and its first read fails transiently.
    const { filePath } = createStorageFile({ preserved: 'value' });
    let readAttempts = 0;
    const transientFileSystem = {
      ...fs,
      readFileSync: (target: fs.PathOrFileDescriptor, encoding: BufferEncoding) => {
        readAttempts += 1;
        if (readAttempts === 1)
          throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
        return fs.readFileSync(target, encoding);
      },
    };
    const storage = createPersistentStorage(filePath, transientFileSystem);

    // When: the failed read is followed by a successful mutation retry.
    expect(() => storage.getItem('preserved')).toThrow('injected read failure');
    storage.setItem('added', 'next');

    // Then: the retry reloads and preserves the complete durable snapshot.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      preserved: 'value',
      added: 'next',
    });
  });

  it('rejects mutation when the native store contains malformed JSON', () => {
    // Given: the native store exists but its bytes are not a valid object snapshot.
    const { filePath } = createStorageFile({ preserved: 'value' });
    fs.writeFileSync(filePath, '{malformed', 'utf8');
    const before = fs.readFileSync(filePath);
    const storage = createPersistentStorage(filePath);

    // When: a caller attempts to mutate through the unreadable snapshot.
    const mutation = () => storage.setItem('added', 'next');

    // Then: the parse failure is observable and the original bytes remain untouched.
    expect(mutation).toThrow(SyntaxError);
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

  it('rejects mutation when the native store contains malformed UTF-8', () => {
    // Given: the native store is valid JSON bytes except for an invalid UTF-8 byte in one value.
    const { filePath } = createStorageFile({ preserved: 'value' });
    fs.writeFileSync(
      filePath,
      Buffer.concat([Buffer.from('{"preserved":"'), Buffer.from([0x80]), Buffer.from('"}')]),
    );
    const before = fs.readFileSync(filePath);
    const storage = createPersistentStorage(filePath);

    // When: a caller attempts to mutate through the lossy snapshot.
    const mutation = () => storage.setItem('added', 'next');

    // Then: decoding fails closed and the malformed bytes remain unchanged.
    expect(mutation).toThrow(TypeError);
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

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
      openSync: vi.fn((target: fs.PathLike, flags: string) => {
        if (target !== path.dirname(filePath) && flags === 'r') {
          throw new Error('FlushFileBuffers requires GENERIC_WRITE');
        }
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

  it.runIf(process.platform !== 'win32')(
    'flushes the parent directory after atomic replacement',
    () => {
      // Given: the filesystem records the durable commit sequence around one replacement.
      const { directory, filePath } = createStorageFile({ saved: 'old' });
      const operations: string[] = [];
      const tracingFileSystem = {
        ...fs,
        openSync: vi.fn((target: fs.PathLike, flags: string) => {
          operations.push(`open:${target === directory ? 'directory' : 'file'}:${flags}`);
          return target === directory ? 102 : 101;
        }),
        fsyncSync: vi.fn((descriptor: number) => {
          operations.push(`fsync:${descriptor}`);
        }),
        closeSync: vi.fn((descriptor: number) => {
          operations.push(`close:${descriptor}`);
        }),
        renameSync: vi.fn((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          operations.push('rename');
          fs.renameSync(oldPath, newPath);
        }),
      };
      const storage = createPersistentStorage(filePath, tracingFileSystem);

      // When: the writer publishes the staged snapshot.
      storage.setItem('saved', 'new');

      // Then: the renamed directory entry is flushed before the write reports success.
      expect(operations).toEqual([
        'open:file:r+',
        'fsync:101',
        'close:101',
        'rename',
        'open:directory:r',
        'fsync:102',
        'close:102',
      ]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps a renamed set visible and retries its failed directory sync',
    () => {
      // Given: replacement succeeds but the first parent-directory fsync fails.
      const { directory, filePath } = createStorageFile({ saved: 'old' });
      const failure = createDirectorySyncFailureFileSystem(directory);
      const storage = createPersistentStorage(filePath, failure.fileSystem);

      // When: setting a value crosses that post-rename failure boundary.
      expect(() => storage.setItem('saved', 'new')).toThrow('injected directory fsync failure');

      // Then: disk and cache expose the replacement, while the same-value retry flushes it.
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ saved: 'new' });
      expect(storage.getItem('saved')).toBe('new');
      expect(failure.closedDescriptors).toContain(failure.failedDirectoryDescriptor());
      expect(storage.setItem('saved', 'new')).toBe('new');
      expect(failure.directorySyncCount()).toBe(2);
      expect(storage.drainPendingChanges()).toEqual([
        { key: 'saved', oldValue: 'old', newValue: 'new' },
      ]);
      expect(storage.drainPendingChanges()).toEqual([]);
      expect(fs.readdirSync(directory)).toEqual(['renderer-storage.json']);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps a renamed removal visible and retries its failed directory sync',
    () => {
      // Given: deletion replacement succeeds but the first parent-directory fsync fails.
      const { directory, filePath } = createStorageFile({ saved: 'old' });
      const failure = createDirectorySyncFailureFileSystem(directory);
      const storage = createPersistentStorage(filePath, failure.fileSystem);

      // When: removing the value crosses that post-rename failure boundary.
      expect(() => storage.removeItem('saved')).toThrow('injected directory fsync failure');

      // Then: disk and cache expose deletion, while the missing-key retry flushes it.
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({});
      expect(storage.getItem('saved')).toBeNull();
      expect(failure.closedDescriptors).toContain(failure.failedDirectoryDescriptor());
      expect(storage.removeItem('saved')).toBeNull();
      expect(failure.directorySyncCount()).toBe(2);
      expect(storage.drainPendingChanges()).toEqual([
        { key: 'saved', oldValue: 'old', newValue: null },
      ]);
      expect(storage.drainPendingChanges()).toEqual([]);
      expect(fs.readdirSync(directory)).toEqual(['renderer-storage.json']);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps a renamed migration visible and retries its failed directory sync',
    () => {
      // Given: migration replacement succeeds but the first parent-directory fsync fails.
      const { directory, filePath } = createStorageFile({ existing: 'native' });
      const failure = createDirectorySyncFailureFileSystem(directory);
      const storage = createPersistentStorage(filePath, failure.fileSystem);

      // When: fill-missing migration crosses that post-rename failure boundary.
      expect(() => storage.migrate({ missing: 'legacy' })).toThrow(
        'injected directory fsync failure',
      );

      // Then: disk and cache expose the migration, while the no-change retry flushes it.
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
        existing: 'native',
        missing: 'legacy',
      });
      expect(storage.getItem('missing')).toBe('legacy');
      expect(failure.closedDescriptors).toContain(failure.failedDirectoryDescriptor());
      expect(storage.migrate({ missing: 'legacy' })).toEqual([]);
      expect(failure.directorySyncCount()).toBe(2);
      expect(storage.drainPendingChanges()).toEqual([
        { key: 'missing', oldValue: null, newValue: 'legacy' },
      ]);
      expect(storage.drainPendingChanges()).toEqual([]);
      expect(fs.readdirSync(directory)).toEqual(['renderer-storage.json']);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'coalesces a failed replacement and its reversal before publication',
    () => {
      // Given: an unacknowledged replacement is visible after its directory fsync fails.
      const { directory, filePath } = createStorageFile({ saved: 'old' });
      const failure = createDirectorySyncFailureFileSystem(directory);
      const storage = createPersistentStorage(filePath, failure.fileSystem);
      expect(() => storage.setItem('saved', 'new')).toThrow('injected directory fsync failure');

      // When: the caller reverses the value and the durability retry succeeds.
      expect(storage.setItem('saved', 'old')).toBe('new');

      // Then: peers need no event because the final durable state matches their last state.
      expect(storage.drainPendingChanges()).toEqual([]);
      expect(storage.getItem('saved')).toBe('old');
      expect(failure.directorySyncCount()).toBe(2);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'publishes pending changes when an unrelated mutation makes the snapshot durable',
    () => {
      // Given: one renamed value is visible but remains unpublished after directory fsync failure.
      const { directory, filePath } = createStorageFile({ saved: 'old' });
      const failure = createDirectorySyncFailureFileSystem(directory);
      const storage = createPersistentStorage(filePath, failure.fileSystem);
      expect(() => storage.setItem('saved', 'new')).toThrow('injected directory fsync failure');

      // When: a different key commits the complete current snapshot successfully.
      expect(storage.setItem('other', 'value')).toBeNull();

      // Then: both net transitions are published exactly once from peers' last known state.
      expect(storage.drainPendingChanges()).toEqual([
        { key: 'saved', oldValue: 'old', newValue: 'new' },
        { key: 'other', oldValue: null, newValue: 'value' },
      ]);
      expect(storage.drainPendingChanges()).toEqual([]);
      expect(failure.directorySyncCount()).toBe(2);
    },
  );
});
