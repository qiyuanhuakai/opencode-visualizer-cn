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
    expect(() => storage.migrate({ existing: 'legacy', missingA: 'a', missingB: 'b' })).toThrow(
      'disk full',
    );
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

  it('keeps deleted native credentials authoritative over stale renderer residue', () => {
    // Given: native storage was already initialized and credentials were intentionally removed.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    fs.writeFileSync(filePath, '{}', { mode: 0o600 });
    const storage = createPersistentStorage(() => filePath);

    // When: a later upgrade submits stale canonical, legacy, and bridge credentials.
    storage.migrate({
      'opencode.auth.credentials.v1': 'stale-canonical',
      'opencode.credentials.v1': 'stale-legacy',
      'opencode.auth.codexBridgeToken.v1': 'stale-codex-token',
      'opencode.auth.acpBridgeToken.v1': 'stale-acp-token',
      'opencode.global.dat:model': 'model-state',
    });

    // Then: sensitive absences remain authoritative while non-sensitive state still migrates.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      'opencode.global.dat:model': 'model-state',
    });
  });

  it('imports credentials only when native storage has never been initialized', () => {
    // Given: this is the first migration and no native storage file exists yet.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    const storage = createPersistentStorage(() => filePath);

    // When: the released renderer-only application submits its credentials.
    storage.migrate({
      'opencode.auth.credentials.v1': 'first-migration',
      'opencode.auth.codexBridgeToken.v1': 'first-token',
    });

    // Then: the one-time migration preserves credentials in the native source of truth.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      'opencode.auth.credentials.v1': 'first-migration',
      'opencode.auth.codexBridgeToken.v1': 'first-token',
    });
  });

  it('persists an empty first migration as the native authority tombstone', () => {
    // Given: first launch has no renderer entries to migrate.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    const storage = createPersistentStorage(() => filePath);

    // When: the empty migration is acknowledged and stale credentials appear later.
    expect(storage.migrate({})).toEqual([]);
    storage.migrate({ 'opencode.auth.credentials.v1': 'must-not-resurrect' });

    // Then: the durable empty file prevents later renderer residue from becoming canonical.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({});
  });

  it('treats a malformed native file as authoritative for sensitive absences', () => {
    // Given: the native file exists but its JSON is damaged.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    fs.writeFileSync(filePath, '{broken', { mode: 0o600 });
    const storage = createPersistentStorage(() => filePath);

    // When: migration submits stale credentials plus recoverable non-sensitive state.
    storage.migrate({
      'opencode.auth.credentials.v1': 'stale-secret',
      'opencode.settings.enterToSend.v1': 'true',
    });

    // Then: corruption cannot resurrect credentials while the file is repaired atomically.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      'opencode.settings.enterToSend.v1': 'true',
    });
  });

  it('commits credential bundle updates atomically', () => {
    // Given: native storage contains one internally consistent credential bundle.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-persistent-storage-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'renderer-storage.json');
    const storage = createPersistentStorage(() => filePath);
    storage.setItem('endpoint', 'https://old.example');
    storage.setItem('credential', 'old-secret');
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    // When: one bundle replacement fails, then succeeds after storage recovers.
    expect(() =>
      storage.update({ endpoint: 'https://new.example', credential: 'new-secret' }),
    ).toThrow('disk full');
    const afterFailure = {
      endpoint: storage.getItem('endpoint'),
      credential: storage.getItem('credential'),
    };
    storage.update({ endpoint: 'https://new.example', credential: 'new-secret' });

    // Then: failure exposes the complete old bundle and success exposes the complete new bundle.
    expect(afterFailure).toEqual({
      endpoint: 'https://old.example',
      credential: 'old-secret',
    });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      endpoint: 'https://new.example',
      credential: 'new-secret',
    });
  });
});
