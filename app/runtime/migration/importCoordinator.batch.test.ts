// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createImportService } from '../../../bridge/runtime/migration/importService.js';
import type { ImportBatch } from '../../../bridge/runtime/migration/importService.js';
import { chunkKey, readImportValue } from '../../../bridge/runtime/migration/manifest.js';
import type { DraftHeader, DraftStore } from '../draftStore';
import type { LegacySourcePort } from './sourceArchive';
import { legacyDigest } from './legacyExport';

afterEach(() => { vi.resetModules(); });

it.each([[false, false], [true, false], [false, true], [true, true]])('imports escaped=%s history after checkpoint failure=%s and restores identical bytes after restart', async (escaped, failCheckpoint) => {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-import-batch-'));
  const environmentId = '11111111-1111-4111-8111-111111111111';
  const harnessInstanceId = '22222222-2222-4222-8222-222222222222';
  const profileId = '33333333-3333-4333-8333-333333333333';
  const options = { stateDirectory: root, environmentId, ownerId: profileId, epoch: harnessInstanceId };
  let store = createRuntimeStore(options);
  try {
    await store.ready;
    const content = JSON.stringify({ text: escaped ? '\\'.repeat(300000) : 'a'.repeat(600000) });
    const sourceKey = 'a'.repeat(64), revision = await legacyDigest(content);
    const chunks = await Promise.all(Array.from({ length: Math.ceil(content.length / 65536) }, async (_, index) => {
      const offset = index * 65536, value = content.slice(offset, offset + 65536);
      return { source: 'localStorage', sourceKey, namespace: 'history', ownership: 'unattached-legacy-local' as const, authority: 'browser-history', offset, content: value, end: offset + value.length === content.length, checksum: await legacyDigest(value) };
    }));
    const token = { version: 1 as const, revision, offset: 0, count: chunks.length, records: 1, exportableRecords: 1, localOnlyRecords: 0 };
    const source: LegacySourcePort = {
      open: async () => token,
      page: async ({ token: current }) => {
        const page = chunks.slice(current.offset, current.offset + 8);
        const offset = current.offset + page.length;
        return { revision, chunks: page, next: offset < chunks.length ? { ...token, offset } : null };
      },
      binding: async () => ({ sourceKey, kind: 'history', nativeSessionId: 'native', scopeFingerprint: 'proven-source' }),
    };
    // Local archive storage is controlled; the coordinator and target SQLite
    // receiver, validation, verification and restart are production code.
    const headers = new Map<string, DraftHeader>(), checkpoints = new Map<string, unknown>();
    const parts = new Map<string, Uint8Array[]>();
    let paused = false, retries = 0, shouldFail = failCheckpoint;
    let pendingCheckpoint: { key: string; value: unknown } | undefined;
    const local = {
      get paused() { return paused; },
      async retry() { retries++; paused = false; if (pendingCheckpoint) { checkpoints.set(pendingCheckpoint.key, pendingCheckpoint.value); pendingCheckpoint = undefined; } },
      async writeChunk(identity: { context: string }, part: { index: number; bytes: Uint8Array }) {
        const values = parts.get(identity.context) ?? []; values[part.index] = part.bytes.slice(); parts.set(identity.context, values);
      },
      async commit(header: DraftHeader) { headers.set(header.context, header); },
      async checkpoint(key: string, value: unknown) {
        if (paused) throw new Error('archive paused');
        if (shouldFail && key === 'migration-active') { shouldFail = false; paused = true; pendingCheckpoint = { key, value }; throw new Error('archive checkpoint failed'); }
        checkpoints.set(key, value);
      },
      async readCheckpoint(key: string) { return checkpoints.get(key); },
      async page({ after }: { after?: string }) { return { headers: [...headers.values()].filter(header => !after || header.context > after), next: null }; },
      async *readPart(header: DraftHeader) { yield* parts.get(header.context) ?? []; },
    } as unknown as DraftStore;
    const service = createImportService({ store, environmentId });
    const batches: ImportBatch[] = [];
    const { createImportCoordinator } = await import('./importCoordinator');
    const coordinator = createImportCoordinator({ source, local, clientOrigin: 'test-origin', currentEnvironment: () => environmentId,
      mappings: [{ environmentId, harnessInstanceId, profileId, nativeSessionId: 'native', scopeFingerprint: 'proven-source', evidence: 'user-confirmed' }],
      target: { environmentId, service: { ...service, async accept(batch) { batches.push(batch); return service.accept(batch); } } },
    });
    if (failCheckpoint) await expect(coordinator.run()).rejects.toThrow('archive checkpoint failed');
    const result = await coordinator.run();
    expect(retries).toBe(failCheckpoint ? 1 : 0);
    expect(result).toMatchObject({ phase: 'cutover', records: 1, boundRecords: 1, chunks: chunks.length });
    expect(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 900000)).toBe(true);
    expect(batches.every(batch => batch.chunks.length <= 8)).toBe(true);
    expect(batches.flatMap(batch => batch.chunks).map(chunk => chunk.offset)).toEqual(chunks.map(chunk => chunk.offset));
    await store.close(); store = createRuntimeStore(options); await store.ready;
    await createImportService({ store, environmentId }).verify({ importId: result.importId, sourceRevision: revision, expectedRecords: 1, expectedChunks: chunks.length });
    let restored = '';
    for (const chunk of batches.flatMap(batch => batch.chunks)) {
      const row = await store.get({ collection: 'imports', key: chunkKey(result.importId, chunk) });
      if (!row) throw new Error('Missing persisted chunk');
      const value = await readImportValue(store, row);
      if (!value || typeof value !== 'object' || !('content' in value) || typeof value.content !== 'string') throw new Error('Invalid persisted chunk');
      restored += value.content;
    }
    expect(restored).toBe(content);
    expect(await legacyDigest(restored)).toBe(revision);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
