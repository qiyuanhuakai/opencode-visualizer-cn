// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { LegacyPiece } from '../../../shared/runtime/migration/legacyExport.js';
import type { DraftHeader, DraftIdentity, DraftPart, DraftStore } from '../draftStore';

// Task 24 fix (PR #182 round e0f83b871 item 4):
// `createBrowserLegacySourcePort` reassembled legacy chunks but emitted
// `checksum: ''` while also rewriting the original namespace/authority/offset.
// `archiveLegacySource` verifies `legacyDigest(chunk.content) === chunk.checksum`,
// so any non-empty source was rejected as `corrupt` and no backup chunk landed.
// These tests pin the corrected behaviour: the adapter is a faithful paged
// projection of the source's own export protocol.

const HEX32 = 'a'.repeat(32);
const environmentId = '11111111-1111-4111-8111-111111111111';

// A legitimate, non-empty legacy history record split across two paged pieces.
// Both pieces share a sourceKey (same source + key), so the record reassembles
// with a byte offset of 0 for the first piece and 15 for the second.
async function* twoPieceHistory(): AsyncGenerator<LegacyPiece> {
  const key = `opencode.state.backendHistory.v1.${HEX32}.${encodeURIComponent('session-0001')}`;
  const base = { key, source: 'browser:scope/opencode.backendHistory/histories', namespace: `backend-history-v1:${HEX32}`, authority: 'indexeddb' } as const;
  yield { ...base, content: 'legacy-first-half-', end: false };
  yield { ...base, content: 'legacy-second-half', end: true };
}

type MemoryStore = {
  chunksWritten: number;
  retry(): Promise<void>;
  checkpoint(key: string, value: unknown): Promise<void>;
  readCheckpoint(key: string): Promise<unknown>;
  writeChunk(identity: DraftIdentity, part: { name: string; kind: DraftPart['kind']; index: number; bytes: Uint8Array }): Promise<void>;
  commit(header: DraftHeader): Promise<void>;
  page(options?: { after?: string; limit?: number }): Promise<{ headers: readonly DraftHeader[]; next: string | null }>;
};

// Controlled persistence double: an in-memory stand-in for `DraftStore` that
// records how many backup chunks the archive actually writes. It never touches
// a browser IndexedDB so the test is deterministic under happy-dom.
function createMemoryStore(onWriteChunk: () => void): MemoryStore {
  const checkpoints = new Map<string, unknown>();
  const headers = new Map<string, DraftHeader>();
  const chunks = new Map<string, Uint8Array>();
  const identityKey = (identity: DraftIdentity) => JSON.stringify([identity.context, identity.clientOrigin, identity.revision]);
  const partKey = (identity: DraftIdentity, name: string, index: number) => JSON.stringify([identityKey(identity), name, index]);
  const store: MemoryStore = {
    chunksWritten: 0,
    async retry() { /* no-op */ },
    async checkpoint(key, value) { checkpoints.set(key, structuredClone(value)); },
    async readCheckpoint(key) { return checkpoints.has(key) ? structuredClone(checkpoints.get(key)) : undefined; },
    async writeChunk(identity, part) {
      onWriteChunk();
      chunks.set(partKey(identity, part.name, part.index), part.bytes.slice());
      store.chunksWritten += 1;
    },
    async commit(header) { headers.set(identityKey(header), structuredClone(header)); },
    async page(options = {}) {
      const limit = options.limit ?? 100;
      const ordered = [...headers.keys()].sort();
      const filtered = options.after === undefined ? ordered : ordered.filter((key) => key > options.after!);
      const slice = filtered.slice(0, limit);
      const pageHeaders = slice.map((key) => structuredClone(headers.get(key) as DraftHeader));
      return { headers: pageHeaders, next: slice.length === limit ? slice[slice.length - 1] : null };
    },
  };
  return store;
}

describe('browser legacy source port', () => {
  it('preserves the source checksum, namespace, authority and offsets verbatim', async () => {
    // Given a real paged export of a two-piece IndexedDB history record.
    const { openLegacyExport, readLegacyExportPage } = await import('../migration/legacyExport');
    const { createBrowserLegacySourcePort } = await import('./browserSourcePort');
    const token = await openLegacyExport(twoPieceHistory);
    const expected = await readLegacyExportPage(twoPieceHistory, { token, limit: 200 });
    // When the adapter projects the same source through its port.
    const port = createBrowserLegacySourcePort(twoPieceHistory);
    await port.open();
    const actual = await port.page({ token, limit: 8 });
    // Then every chunk is the source's own chunk, not a rewritten surrogate.
    expect(actual.revision).toBe(expected.revision);
    expect(actual.chunks).toEqual(expected.chunks);
    expect(actual.chunks.every((chunk) => /^[a-f0-9]{64}$/u.test(chunk.checksum))).toBe(true);
    expect(actual.next).toBeNull();
  });

  it('completes backup for a legitimate non-empty source through coordinator and writerFreeze', async () => {
    vi.resetModules();
    const freeze = await import('./writerFreeze');
    const { createImportCoordinator } = await import('./importCoordinator');
    const { createBrowserLegacySourcePort } = await import('./browserSourcePort');

    // Given a real adapter over the legitimate two-piece legacy source.
    const port = createBrowserLegacySourcePort(twoPieceHistory);
    let phaseDuringFirstWrite: string | null = null;
    const store = createMemoryStore(() => { phaseDuringFirstWrite ??= freeze.legacyWriterPhase(); });
    const target = {
      environmentId,
      service: {
        accept: async (): Promise<never> => { throw new Error('unexpected accept'); },
        verify: async (): Promise<never> => { throw new Error('unexpected verify'); },
      },
    };
    const coordinator = createImportCoordinator({
      source: port, local: store as unknown as DraftStore, target,
      currentEnvironment: () => environmentId, mappings: [], clientOrigin: 'client-test',
    });

    // When the coordinator freezes writers and runs the staged backup.
    let result: Awaited<ReturnType<typeof coordinator.run>> | null = null;
    let failure: unknown = null;
    try { result = await coordinator.run(); } catch (error) { failure = error; }
    const code = failure instanceof Error ? ((failure as { code?: string }).code ?? failure.name) : null;

    // Then the source completes with real backup chunk writes at a frozen phase.
    expect(store.chunksWritten, `coordinator run failure=${code}`).toBeGreaterThan(0);
    expect(failure).toBeNull();
    expect(result?.records).toBe(1);
    expect(result?.chunks).toBe(2);
    expect(phaseDuringFirstWrite).toBe('frozen');
    expect(freeze.legacyEditingPaused()).toBe(true);
  });
});
