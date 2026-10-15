import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedRecord } from './sourceArchive';
import type { DraftHeader, DraftPart, DraftStore, InlineDraft } from '../draftStore';

const sourceRevision = 'a'.repeat(64);
const sourceKey = 'b'.repeat(64);
const archiveText = '{"draft-a":{"messageInput":"alpha"},"draft-b":{"messageInput":"beta"}}';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const nativeRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
const nativeGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

// A plain LAN HTTP origin: crypto.randomUUID is SecureContext-only, so it is absent
// while crypto.getRandomValues (which carries no such restriction) is still present.
function insecureOrigin() {
  const getRandomValues = vi.fn(nativeGetRandomValues);
  vi.stubGlobal('crypto', { getRandomValues });
  return getRandomValues;
}

function fixture() {
  const committed: InlineDraft[] = [];
  const checkpoints = new Map<string, unknown>();
  let touched = false;
  const store = {
    async *readPart() { touched = true; yield new TextEncoder().encode(archiveText); },
    async readCheckpoints(keys: readonly string[]) { touched = true; return keys.map(key => checkpoints.get(key)); },
    async commitInlineBatch(entries: readonly InlineDraft[]): Promise<readonly DraftHeader[]> {
      touched = true;
      for (const entry of entries) {
        committed.push(entry);
        if (entry.checkpoint) checkpoints.set(entry.checkpoint.key, entry.checkpoint.value);
      }
      return entries.map(entry => ({ ...entry.identity, parts: [] }));
    },
    async writeChunk(): Promise<void> { touched = true; },
    async header(): Promise<DraftHeader | undefined> { touched = true; return undefined; },
    async commit(): Promise<void> { touched = true; },
    async checkpoint(key: string, value: unknown): Promise<void> { touched = true; checkpoints.set(key, value); },
    async writePart(): Promise<DraftPart> { touched = true; return { name: 'raw', kind: 'raw', bytes: 0, chunks: 0, sha256: '0'.repeat(64) }; },
  };
  return { store: store as unknown as DraftStore, committed, checkpoints, wasTouched: () => touched };
}

function record(): ArchivedRecord {
  return {
    header: {
      context: `legacy-raw:${sourceRevision}:${sourceKey}`, clientOrigin: 'legacy-source', revision: 0,
      parts: [{ name: 'raw', kind: 'raw', bytes: archiveText.length, chunks: 1, sha256: '0'.repeat(64) }],
    },
    metadata: {
      sourceKey, source: 'sqlite', namespace: 'default', authority: 'sqlite-imported',
      binding: { kind: 'unattached', sourceKey }, hint: { sourceKey, kind: 'composer' },
    },
  };
}

function traversalsOf(committed: readonly InlineDraft[]): string[] {
  return committed.map(entry => (entry.checkpoint?.value as { traversal: string } | undefined)?.traversal ?? '');
}

describe('legacy draft import on an insecure origin', () => {
  it('imports composer drafts without crypto.randomUUID instead of leaving the editor frozen', async () => {
    // Given a non-secure origin where crypto.randomUUID is unavailable.
    const getRandomValues = insecureOrigin();
    const f = fixture();
    const { importLegacyDrafts } = await import('./draftImport');
    // When the already-frozen coordinator replays the archived composer records.
    await expect(importLegacyDrafts(f.store, record())).resolves.toBe(2);
    // Then the drafts reached the store, keyed by their legacy digests, with one well-formed nonce.
    expect(f.wasTouched()).toBe(true);
    expect(f.committed.map(entry => entry.identity.context)).toEqual([
      `unattached:${sourceKey}:${await (await import('./legacyExport')).legacyDigest('draft-a')}`,
      `unattached:${sourceKey}:${await (await import('./legacyExport')).legacyDigest('draft-b')}`,
    ]);
    expect(getRandomValues).toHaveBeenCalled();
    const traversals = traversalsOf(f.committed);
    expect(new Set(traversals).size).toBe(1);
    expect(traversals[0]).toMatch(UUID_V4);
  });

  it('derives a distinct traversal nonce per attempt so a retry cannot collide with its own history', async () => {
    // Given the same archived record replayed across separate import attempts.
    insecureOrigin();
    const { importLegacyDrafts } = await import('./draftImport');
    const collected: string[] = [];
    for (let attempt = 0; attempt < 32; attempt++) {
      const f = fixture();
      expect(await importLegacyDrafts(f.store, record())).toBe(2);
      collected.push(...traversalsOf(f.committed));
    }
    // Then every attempt contributes a unique, well-formed nonce shared by its own drafts.
    expect(collected).toHaveLength(64);
    expect(new Set(collected).size).toBe(32);
    for (const traversal of collected) expect(traversal).toMatch(UUID_V4);
  });
});

describe('createTraversalId', () => {
  it('prefers the secure-context crypto.randomUUID when it is available', async () => {
    const randomUUID = vi.fn(nativeRandomUUID);
    const getRandomValues = vi.fn(() => { throw new Error('getRandomValues must not be consulted'); });
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });
    const { createTraversalId } = await import('./draftImport');
    expect(createTraversalId()).toMatch(UUID_V4);
    expect(randomUUID).toHaveBeenCalled();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('falls back to crypto.getRandomValues when randomUUID is unavailable', async () => {
    const getRandomValues = insecureOrigin();
    const { createTraversalId } = await import('./draftImport');
    const ids = Array.from({ length: 4096 }, () => createTraversalId());
    expect(getRandomValues).toHaveBeenCalled();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('still yields distinct ids when no web crypto random source exists at all', async () => {
    vi.stubGlobal('crypto', {});
    const { createTraversalId } = await import('./draftImport');
    const ids = Array.from({ length: 512 }, () => createTraversalId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(8);
  });
});
