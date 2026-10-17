// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDraftCache } from './draftCache';
import type { DraftCacheStore } from './draftCache';
import type { DraftHeader } from './draftStore';
import { createMemoryBudget } from './entityCache';
const identity = { context: 'qualified-context', clientOrigin: 'local-a', revision: 1 };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const chunks = new Map<string, Uint8Array>(); const headers = new Map<number, DraftHeader>(); let fail = false; let queued: (() => void) | undefined; let writes = 0;
  const chunkKey = (revision: number, name: string, index: number) => JSON.stringify([revision, name, index]);
  const data = Uint8Array.from({ length: 65536 }, (_, i) => i % 251);
  const attachment = new Uint8Array([0, 128, 255]);
  chunks.set(chunkKey(1, 'body', 0), data); chunks.set(chunkKey(1, 'attachment', 0), attachment);
  headers.set(1, { ...identity, parts: [{ name: 'body', kind: 'body', bytes: data.length, chunks: 1, sha256: hash(data) }, { name: 'attachment', kind: 'attachment', bytes: attachment.length, chunks: 1, sha256: hash(attachment) }] });
  const store: DraftCacheStore = {
    get paused() { return !!queued; }, get pendingCount() { return queued ? 1 : 0; },
    async header(id) { return headers.get(id.revision); },
    async page(options) { return { headers: options?.after ? [] : [headers.get(1)].filter((item): item is DraftHeader => !!item), next: options?.after ? null : 'cursor' }; },
    async *readPart(id, part) { for (let i = 0; i < part.chunks; i++) { const bytes = chunks.get(chunkKey(id.revision, part.name, i)); if (!bytes) throw new Error('missing'); yield bytes.slice(); } },
    async writeChunk(id, part) { writes++; const write = () => { chunks.set(chunkKey(id.revision, part.name, part.index), part.bytes.slice()); }; if (fail) { fail = false; queued = write; throw new DOMException('quota', 'QuotaExceededError'); } write(); },
    async commit(header) { headers.set(header.revision, header); },
    async retry() { queued?.(); queued = undefined; },
  };
  return { store, headers, chunks, writes: () => writes, fault: () => { fail = true; } };
}
describe('draft resident cache', () => {
  it('clamps header window and releases all held output reservations', async () => {
    const cache = createDraftCache({ store: fixture().store });
    await expect(cache.pageHeaders({ limit: 33 })).rejects.toMatchObject({ code: 'invalid_chunk' });
    const page = await cache.pageHeaders(); expect(page.headers).toHaveLength(1); expect(page.next).toBeNull();
    expect(cache.usage().entries).toBe(1); page.release(); page.release(); expect(cache.usage()).toEqual({ entries: 0, residentBytes: 0, reservedBytes: 0 });
  });
  it('cannot widen fixed byte ceiling with a permissive injected ledger', async () => {
    const cache = createDraftCache({ store: fixture().store, budget: createMemoryBudget({ maxBytes: 1e9, maxEntries: 1000 }) });
    const handles = [];
    for (let i = 0; i < 4; i++) handles.push(await cache.open(identity));
    await expect(cache.open(identity)).rejects.toMatchObject({ code: 'paused' });
    expect(cache.usage().residentBytes).toBe(8 * 1024 * 1024);
    handles.forEach(handle => handle?.release()); await cache.dispose();
  });
  it('keeps a returned segment charged even after generator cleanup and rejects advancing a held output', async () => {
    const cache = createDraftCache({ store: fixture().store });
    const segment = await cache.readSegment({ identity, part: 'body', index: 0 });
    expect(segment.bytes.length).toBe(65536); expect(cache.usage().residentBytes).toBeGreaterThan(65536);
    segment.release(); expect(cache.usage().residentBytes).toBe(0);
    const stream = cache.exportPart({ identity, part: 'body' }); const first = await stream.next();
    await expect(stream.next()).rejects.toMatchObject({ code: 'paused' });
    if (!first.done) first.value.release(); expect(cache.usage().residentBytes).toBe(0);
  });
  it('streams immutable body replacement and untouched binary attachment with independent digest', async () => {
    const source = fixture(); const cache = createDraftCache({ store: source.store }); const bytes = new Uint8Array([7, 8, 9]);
    const result = await cache.editSegment({ identity, nextRevision: 2, part: 'body', index: 0, bytes });
    expect(result.header.parts.map(part => part.sha256)).toEqual([hash(bytes), hash(new Uint8Array([0, 128, 255]))]);
    expect(source.headers.get(1)?.parts[0]?.bytes).toBe(65536); result.release(); expect(cache.usage().entries).toBe(0);
  });
  it('retains rejected writes, blocks admission and disposal, then retries without duplicate enqueue', async () => {
    const source = fixture(); const cache = createDraftCache({ store: source.store }); source.fault();
    await expect(cache.editSegment({ identity, nextRevision: 2, part: 'body', index: 0, bytes: new Uint8Array([4]) })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    const pending = cache.usage(); expect(pending.entries).toBe(2); expect(pending.reservedBytes).toBeGreaterThan(4e6); expect(source.writes()).toBe(1);
    await expect(cache.dispose()).rejects.toMatchObject({ code: 'paused' });
    await expect(cache.editSegment({ identity, nextRevision: 3, part: 'body', index: 0, bytes: new Uint8Array([8]) })).rejects.toMatchObject({ code: 'paused' });
    expect(cache.usage()).toEqual(pending); await cache.retry(); expect(source.writes()).toBe(2);
    expect(source.headers.get(2)?.parts[0]?.sha256).toBe(hash(new Uint8Array([4]))); expect(cache.usage().reservedBytes).toBe(0); await cache.dispose();
  });
  it('retains backing allocation accounting and rejects an oversized subarray before a store write', async () => {
    const source = fixture(); const cache = createDraftCache({ store: source.store });
    await expect(cache.editSegment({ identity, nextRevision: 2, part: 'body', index: 0, bytes: new Uint8Array(3 * 1024 * 1024).subarray(0, 1) })).rejects.toMatchObject({ code: 'paused' });
    expect(source.writes()).toBe(0); expect(cache.usage().entries).toBe(0);
  });
  it('retains acknowledged but unreconciled input until a successful hash readback retry', async () => {
    const source = fixture(); const read = source.store.header; let unavailable = true;
    source.store.header = async id => id.revision === 2 && unavailable ? undefined : read(id);
    const cache = createDraftCache({ store: source.store });
    await expect(cache.editSegment({ identity, nextRevision: 2, part: 'body', index: 0, bytes: new Uint8Array([2]) })).rejects.toMatchObject({ code: 'corrupt' });
    expect(source.headers.has(2)).toBe(true); expect(cache.usage().reservedBytes).toBeGreaterThan(0);
    await expect(cache.dispose()).rejects.toMatchObject({ code: 'paused' });
    unavailable = false; await cache.retry(); expect(source.writes()).toBe(2); expect(cache.usage().reservedBytes).toBe(0);
  });
  it('rejects a second quota failure during retry without hanging or duplicating retained chunks', async () => {
    const source = fixture(); const cache = createDraftCache({ store: source.store }); source.fault();
    await expect(cache.editSegment({ identity, nextRevision: 2, part: 'body', index: 0, bytes: new Uint8Array([2]) })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    source.fault(); await expect(cache.retry()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(source.store.pendingCount).toBe(1); expect(cache.usage().reservedBytes).toBeGreaterThan(0);
    await cache.retry(); expect(source.writes()).toBe(2); expect(cache.usage().entries).toBe(0);
  });
  it('counts the shared 32-identity header window against further opens', async () => {
    const source = fixture(); const original = source.headers.get(1); if (!original) throw new Error('fixture absent');
    source.store.page = async options => { const index = Number(options?.after ?? 0); return { headers: [{ ...original, context: `draft-${index}` }], next: String(index + 1) }; };
    const cache = createDraftCache({ store: source.store }); const page = await cache.pageHeaders({ limit: 32 });
    expect(page.headers).toHaveLength(32); expect(cache.usage().entries).toBe(32);
    await expect(cache.open(identity)).rejects.toMatchObject({ code: 'paused' });
    page.release(); expect(cache.usage().entries).toBe(0);
  });

});
