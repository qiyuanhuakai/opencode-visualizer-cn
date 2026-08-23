import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPersistentStorage } from '../electron/persistentStorage.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

describe('Electron persistent storage', () => {
  it('keeps failed candidates out of cache and later atomic writes', () => {
    // Given: one value is durably stored and the next temporary write will fail.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    const storage = createPersistentStorage(() => filePath);
    storage.setItem('safe', 'persisted');
    const writeFileSync = vi.spyOn(fs, 'writeFileSync');
    writeFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    // When: a candidate fails and an unrelated write succeeds afterward.
    expect(() => storage.setItem('failed', 'must-not-leak')).toThrow('disk full');
    storage.setItem('unrelated', 'saved');

    // Then: cache and final JSON contain only successfully committed values.
    expect(storage.getItem('failed')).toBeNull();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      safe: 'persisted',
      unrelated: 'saved',
    });
    expect(fs.readdirSync(directory)).toEqual(['renderer-storage.json']);
  });

  it('merges legacy migration entries in one recoverable commit', () => {
    // Given: persisted state already owns one key and the first migration write fails.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    const storage = createPersistentStorage(() => filePath);
    storage.setItem('existing', 'electron');
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    // When: one atomic migration fails and is retried after storage recovers.
    expect(() =>
      storage.migrate({ existing: 'legacy', missingA: 'a', missingB: 'b' }),
    ).toThrow('disk full');
    expect(storage.getItem('missingA')).toBeNull();
    storage.migrate({ existing: 'legacy', missingA: 'a', missingB: 'b' });

    // Then: retry preserves Electron winners and commits every missing legacy key together.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      existing: 'electron',
      missingA: 'a',
      missingB: 'b',
    });
    expect(fs.readdirSync(directory)).toEqual(['renderer-storage.json']);
  });
});
