// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DraftDigest, decodeDataUrl } from './runtime/migration/draftChunks';
import { jsonEntries, jsonLeaves } from './runtime/migration/nestedJson';
import { createRuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';
import { createImportService } from '../bridge/runtime/migration/importService.js';
import { legacyDigest } from './runtime/migration/legacyExport';
import { bindLegacySource } from './runtime/migration/legacyBinding';
import type { Json } from '../bridge/runtime/storage/runtimeStore.js';

const environmentId = '11111111-1111-4111-8111-111111111111';
const harnessInstanceId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
describe('lossless migration import', () => {
  it('retains ambiguous same-native-ID attribution locally', () => {
    // Given a legacy native ID and no proven profile/endpoint mapping.
    const hint = { sourceKey: 'a'.repeat(64), nativeSessionId: 'same' };
    // When candidate native IDs happen to match; Then no upload route is inferred.
    expect(bindLegacySource(hint, [{ profileId, environmentId, harnessInstanceId, nativeSessionId: 'same', evidence: 'endpoint' }])).toEqual({ kind: 'unattached', sourceKey: hint.sourceKey });
  });
  it('deduplicates concurrent batch delivery and rejects a changed target', async () => {
    // Given a real target worker and one immutable source chunk.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'migration-import-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId: profileId, epoch: harnessInstanceId });
    try {
      await store.ready;
      const service = createImportService({ store, environmentId });
      const content = 'untouched raw body';
      const batch = { importId: 'a'.repeat(64), environmentId, sourceRevision: 'b'.repeat(64), offset: 0, nextOffset: 1, total: 1, chunks: [{ sourceKey: 'c'.repeat(64), offset: 0, content, end: true, checksum: await legacyDigest(content), authority: 'sqlite-imported', binding: { environmentId, harnessInstanceId, nativeSessionId: 'same', profileId } }] };
      // When two clients deliver the identical batch.
      const result = await Promise.all([service.accept(batch), service.accept(batch)]);
      // Then the durable intent and stored record are shared, with no foreign-target admission.
      expect(result[0]).toEqual(result[1]);
      const rows = (await store.page({ collection: 'imports', limit: 100 })).items;
      expect(rows.filter(row => row.key.startsWith('chunk:'))).toHaveLength(1);
      expect(rows.filter(row => row.key.startsWith('manifest:'))).toHaveLength(1);
      expect(rows.filter(row => row.key.startsWith('admission:'))).toHaveLength(1);
      expect(rows).toHaveLength(3);
      await expect(service.accept({ ...batch, environmentId: harnessInstanceId })).rejects.toMatchObject({ code: 'target_changed' });
    } finally { await store.close(); await rm(stateDirectory, { recursive: true, force: true }); }
  });
  it.each(['offset', 'binding', 'authority'] as const)('rejects persisted %s corruption before recording verified state', async field => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'migration-verify-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId: profileId, epoch: harnessInstanceId });
    try {
      await store.ready;
      const service = createImportService({ store, environmentId });
      const content = 'original bytes 🦉';
      const binding = { environmentId, harnessInstanceId, nativeSessionId: 'source-session', profileId };
      const chunk = { sourceKey: 'c'.repeat(64), offset: 0, content, end: true, checksum: await legacyDigest(content), authority: 'sqlite-imported', binding };
      const batch = { importId: 'a'.repeat(64), environmentId, sourceRevision: 'b'.repeat(64), offset: 0, nextOffset: 1, total: 1, chunks: [chunk] };
      await service.accept(batch);
      const key = `chunk:${batch.importId}:${chunk.sourceKey}:0000000000000000`;
      const original = await store.get({ collection: 'imports', key });
      const patch: Record<string, Json> = field === 'offset' ? { offset: 999999 } : field === 'authority' ? { authority: 'clear-tombstone' }
        : { binding: { ...binding, harnessInstanceId: '44444444-4444-4444-8444-444444444444' } };
      await store.mutate({ intentId: `fault:${field}`, changes: [{ collection: 'imports', key, expectedRevision: original!.revision, value: { ...chunk, ...patch } }] });
      await expect(service.verify({ importId: batch.importId, sourceRevision: batch.sourceRevision, expectedRecords: 1, expectedChunks: 1 })).rejects.toMatchObject({ code: 'corrupt_import' });
      const manifest = await store.get({ collection: 'imports', key: `manifest:${batch.importId}` });
      expect(manifest?.value).toMatchObject({ phase: 'staged' });
    } finally { await store.close(); await rm(stateDirectory, { recursive: true, force: true }); }
  });
});

describe('bounded draft codecs', () => {
  it('matches independent SHA256 across binary and padding boundaries', () => {
    // Given independently generated binary chunks; When incrementally hashed; Then Node crypto agrees.
    for (const size of [0, 1, 55, 56, 63, 64, 65, 65536, 1024 * 1024]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
      const digest = new DraftDigest();
      for (let offset = 0; offset < size; offset += 37) digest.update(bytes.subarray(offset, offset + 37));
      expect(digest.finish()).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
  it('decodes attachment bytes incrementally across every base64 boundary', async () => {
    // Given a binary attachment with all byte values and padding; When URL chunks split; Then bytes agree.
    const bytes = Buffer.from(Array.from({ length: 200005 }, (_, index) => index % 256));
    const text = 'data:application/octet-stream;base64,' + bytes.toString('base64');
    async function* source() { for (let offset = 0; offset < text.length; offset += 7919) yield text.slice(offset, offset + 7919); }
    const decoded: Uint8Array[] = [];
    for await (const value of decodeDataUrl(source())) { expect(value.length).toBeLessThanOrEqual(65536); decoded.push(value); }
    expect(Buffer.concat(decoded)).toEqual(bytes);
  });
  it('preserves unknown nested fields and escaped Unicode without a complete map parse', async () => {
    // Given nested legacy drafts, an empty object, and an exact chunk boundary; When streamed; Then raw members roundtrip.
    const entries = { a: { messageInput: '🦉\n'.repeat(12000), attachments: [], unknown: { flag: false } }, b: {}, c: 'x'.repeat(16382) };
    const text = JSON.stringify(entries);
    async function* source() { for (let offset = 0; offset < text.length; offset += 17) yield text.slice(offset, offset + 17); }
    const restored: Record<string, string> = {};
    for await (const entry of jsonEntries(source())) { expect(entry.content.length).toBeLessThanOrEqual(16385); restored[entry.key] = (restored[entry.key] ?? '') + entry.content; }
    expect(Object.fromEntries(Object.entries(restored).map(([key, value]) => [key, JSON.parse(value)]))).toEqual(entries);
    const body: string[] = [];
    for await (const leaf of jsonLeaves(source())) if (JSON.stringify(leaf.path) === '["a","messageInput"]') body.push(leaf.content);
    expect(body.join('')).toBe(entries.a.messageInput);
  });
  it.each(['{"a":}', '{"a":1,}', '{"a":"unterminated}', '{"a": [1,]}'])('rejects malformed nested JSON %s', async text => {
    // Given malformed input; When decoded; Then no complete value is accepted.
    async function* source() { yield text; }
    await expect((async () => { for await (const leaf of jsonLeaves(source())) void leaf; })()).rejects.toMatchObject({ code: 'corrupt' });
  });
});
describe('legacy writer cutover', () => {
  it('drains debounce edits before freezing and retains failed post-freeze writes', async () => {
    // Given an admitted pending composer edit and a sink that runs out of quota.
    vi.resetModules();
    const gate = await import('./runtime/migration/writerFreeze');
    const { createComposerDraftScheduler } = await import('./utils/composerDraftScheduler');
    let legacy = ''; let quota = true; const retained: string[] = [];
    const scheduler = createComposerDraftScheduler(() => { legacy = 'pending text'; }, 10000); scheduler.schedule();
    await gate.freezeLegacyWriters({ clientOrigin: 'client-a', persist: async write => { if (quota) throw new DOMException('full', 'QuotaExceededError'); retained.push(write.value ?? ''); } });
    expect(legacy).toBe('pending text'); expect(scheduler.pending).toBe(false);
    // When the acknowledged source is frozen and a later update fails durability.
    gate.retainFrozenLegacyWrite({ channel: 'storage', key: 'draft', value: 'new text' });
    await expect(gate.flushFrozenLegacyWrites()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(gate.writerPendingState().count).toBe(1); expect(gate.legacyEditingPaused()).toBe(true);
    quota = false; await gate.retryFrozenLegacyWrites();
    // Then the same pending value is retried once and original legacy bytes stay intact.
    expect(retained).toEqual(['new text']); expect(legacy).toBe('pending text'); scheduler.dispose();
  });
  it('refuses cutover when an ignored false legacy write occurs during timer drain', async () => {
    // Given the old caller ignores its writer boolean; When the drain fails; Then pending work remains retryable.
    vi.resetModules();
    const gate = await import('./runtime/migration/writerFreeze');
    const { createComposerDraftScheduler } = await import('./utils/composerDraftScheduler');
    let writable = false; let writes = 0;
    const scheduler = createComposerDraftScheduler(() => { gate.confirmLegacyWrite(writable); writes++; }, 10000); scheduler.schedule();
    await expect(gate.freezeLegacyWriters({ clientOrigin: 'a', persist: async () => {} })).rejects.toMatchObject({ code: 'legacy_write_failed' });
    expect(scheduler.pending).toBe(true); expect(gate.legacyWriterPhase()).toBe('paused');
    writable = true; await gate.retryFrozenLegacyWrites();
    expect(writes).toBe(1); expect(scheduler.pending).toBe(false); scheduler.dispose();
  });
});
