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
});
