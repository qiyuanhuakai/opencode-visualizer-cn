// @vitest-environment node
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryService } from '../../bridge/runtime/historyService.js';
import type { InternalNativeHistoryHandle, HistoryStreamStore } from '../../bridge/runtime/historyService.js';
import { parseEnvironmentId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { HistoryPage } from '../../shared/runtime/historyPage.js';
const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const session = parseSessionRef({ environmentId: target, harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'same' });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanups.splice(0).map(close => close())); });
function gate() { return Promise.withResolvers<void>(); }
function fixture(options: { readonly opening?: Promise<void>; readonly acquisition?: Promise<void>; readonly pageGate?: Promise<void>; readonly closeGate?: Promise<void>; readonly liveOnly?: boolean; readonly falseComplete?: boolean; readonly overrides?: Partial<InternalNativeHistoryHandle> } = {}) {
  let generation = 1, authorized = true, store: HistoryStreamStore | undefined, closes = 0, pages = 0, reads = 0, opens = 0;
  const fence = { id: randomUUID(), sourceGeneration: 'native-epoch' };
  const producer: InternalNativeHistoryHandle = {
    capabilities: { archive: options.liveOnly ? 'live-only' : 'paged', recordStream: true, live: 'invalidate' },
    async open(resources) { opens++; store = resources.streamStore; await options.opening; if (resources.signal.aborted) throw new DOMException('closed', 'AbortError'); return { fence }; },
    async page({ releasePageIds = [] }) {
      if (!store) throw new TypeError('not opened');
      for (const id of releasePageIds) await store.release(id);
      await options.pageGate;
      const bytes = new TextEncoder().encode(JSON.stringify([{ id: 'record-' + pages++, body: 'x'.repeat(90000) }]));
      const output = await store.ingest({ source: (async function* () { for (let offset = 0; offset < bytes.length; offset += 32768) yield bytes.slice(offset, offset + 32768); })(), cancel() {}, maxBytes: bytes.length, grammar: { records: [{ path: ['*'], fields: [{ name: 'id', path: ['id'] }], validate: metadata => String(metadata.id) }], fields: [], validate() {} } });
      return { pageId: output.id, items: output.records.map(record => ({ recordId: record.recordId, kind: 'stream', descriptor: { id: record.id, format: record.format, totalBytes: record.totalBytes, sha256: record.sha256 } })), document: { id: output.document.id, format: output.document.format, totalBytes: output.document.totalBytes, sha256: output.document.sha256 }, cursor: options.falseComplete ? null : 'native-' + pages, completeness: options.falseComplete ? 'complete' : 'partial' };
    },
    async chunk(input) { if (!store) throw new TypeError('not opened'); return store.read(input); },
    async read({ after, signal }) { reads++; if (signal.aborted) throw new DOMException('closed', 'AbortError'); return { through: after + 1, changed: true, status: 'current' }; },
    async close() { closes++; await options.closeGate; },
    ...options.overrides,
  };
  const service = createHistoryService({ binding: { target, epoch: 'epoch', generation: 1 }, async authorize() { if (!authorized) throw new TypeError('unauthorized'); return { epoch: 'epoch', processGeneration: generation }; }, async openProducer() { await options.acquisition; return producer; } });
  cleanups.push(() => service.dispose());
  return { service, producer, params: { historyId: randomUUID(), session }, generation: () => generation++, deny: () => { authorized = false; }, counts: () => ({ opens, closes, pages, reads }), usage: () => store?.usage() };
}
async function streamed(f: ReturnType<typeof fixture>) { await f.service.open(f.params); return f.service.page({ historyId: f.params.historyId }); }
function firstDescriptor(page: HistoryPage) { const item = page.items[0]; if (item?.kind !== 'stream') throw new TypeError('Missing stream'); return item.descriptor; }
describe('connection-owned history service with controlled inert producers and real spool', () => {
  it('serves immutable owned records and whole envelope using bounded segments', async () => {
    const f = fixture(), page = await streamed(f), descriptor = firstDescriptor(page);
    const segment = await f.service.chunk({ historyId: f.params.historyId, pageId: page.pageId, descriptorId: descriptor.id, offset: 0 });
    expect(Buffer.from(segment.data, 'base64').length).toBe(65536); expect(segment.nextOffset).toBe(65536);
    const tail = await f.service.chunk({ historyId: f.params.historyId, pageId: page.pageId, descriptorId: descriptor.id, offset: 65536 });
    const exported = Buffer.concat([Buffer.from(segment.data, 'base64'), Buffer.from(tail.data, 'base64')]);
    expect(createHash('sha256').update(exported).digest('hex')).toBe(descriptor.sha256);
    expect(exported.toString()).toBe(JSON.stringify({ id: 'record-0', body: 'x'.repeat(90000) })); expect(tail.nextOffset).toBeNull();
    if (!page.document) throw new TypeError('Missing document');
    const document = await f.service.chunk({ historyId: f.params.historyId, pageId: page.pageId, descriptorId: page.document.id, offset: 0 });
    expect(Buffer.from(document.data, 'base64').subarray(0, 1).toString()).toBe('[');
    expect(f.usage()?.outputs).toBe(0);
    await f.service.close({ historyId: f.params.historyId }); expect(f.usage()).toMatchObject({ diskBytes: 0, pages: 0, fileHandles: 0, pendingWrites: 0, outputs: 0 });
  });
  it('rejects producer open results that try to replace service-owned identity fields', async () => {
    const f = fixture({ overrides: { async open() { return { fence: { id: randomUUID(), sourceGeneration: 1 }, historyId: randomUUID() }; } } });
    await expect(f.service.open(f.params)).rejects.toMatchObject({ code: 'invalid_request', field: 'fields' });
    expect(f.counts().closes).toBe(1);
  });
  it('rejects a foreign target before invoking or opening the native producer', async () => {
    const f = fixture();
    await expect(f.service.open({ ...f.params, session: parseSessionRef({ ...session, environmentId: randomUUID() }) })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.counts()).toEqual({ opens: 0, closes: 0, pages: 0, reads: 0 });
  });
  it('refuses a fourth leased page then releases only specified owned pages', async () => {
    const f = fixture(), first = await streamed(f);
    await f.service.page({ historyId: f.params.historyId }); await f.service.page({ historyId: f.params.historyId });
    await expect(f.service.page({ historyId: f.params.historyId })).rejects.toMatchObject({ code: 'source_unavailable' });
    await expect(f.service.page({ historyId: f.params.historyId, releasePageIds: [randomUUID()] })).rejects.toMatchObject({ code: 'unauthorized' });
    await f.service.page({ historyId: f.params.historyId, releasePageIds: [first.pageId] }); expect(f.usage()?.pages).toBe(3);
    await expect(f.service.chunk({ historyId: f.params.historyId, pageId: first.pageId, descriptorId: firstDescriptor(first).id, offset: 0 })).rejects.toMatchObject({ code: 'replay_required' });
  });
  it('rejects a consumed cursor without exposing or retaining native cursor history', async () => {
    const f = fixture(), first = await streamed(f); if (!first.cursor) throw new TypeError('Missing cursor');
    expect(first.cursor).not.toContain('native'); await f.service.page({ historyId: f.params.historyId, cursor: first.cursor });
    await expect(f.service.page({ historyId: f.params.historyId, cursor: first.cursor })).rejects.toMatchObject({ code: 'replay_required' });
  });
  it('rechecks native generation and tears down old bytes before serving another page', async () => {
    const f = fixture(); await streamed(f); f.generation();
    await expect(f.service.page({ historyId: f.params.historyId })).rejects.toMatchObject({ code: 'replay_required' });
    expect(f.counts().closes).toBe(1); expect(f.usage()?.diskBytes).toBe(0);
    await expect(f.service.open(f.params)).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('rechecks authorization on owned chunk reads', async () => {
    const f = fixture(), page = await streamed(f); f.deny();
    await expect(f.service.chunk({ historyId: f.params.historyId, pageId: page.pageId, descriptorId: firstDescriptor(page).id, offset: 0 })).rejects.toThrow('unauthorized');
    expect(f.usage()?.diskBytes).toBe(0);
  });
  it('fences close before open and makes a known closed id idempotent', async () => {
    const f = fixture(); await f.service.close({ historyId: f.params.historyId });
    await expect(f.service.open(f.params)).rejects.toMatchObject({ code: 'cancelled' });
    expect(await f.service.close({ historyId: f.params.historyId })).toEqual({ closed: true }); expect(f.counts().opens).toBe(0);
  });
  it('waits for late inert acquisition and prevents a held open from publishing', async () => {
    const held = gate(), f = fixture({ acquisition: held.promise });
    const opened = f.service.open(f.params); const rejected = expect(opened).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.counts().opens).toBe(0));
    const closed = f.service.close({ historyId: f.params.historyId }); held.resolve(); await closed; await rejected;
    expect(f.counts().opens).toBe(0); expect(f.counts().closes).toBe(1);
  });
  it('awaits native close on selection replacement and service disposal', async () => {
    const held = gate(), f = fixture({ closeGate: held.promise }); await f.service.open(f.params);
    const newer = f.service.open({ ...f.params, historyId: randomUUID() });
    await vi.waitFor(() => expect(f.counts().closes).toBe(1)); expect(f.counts().opens).toBe(1);
    held.resolve(); await newer; await f.service.dispose(); expect(f.counts().closes).toBe(2);
  });
  it('waits for in-flight native open IO after cancelling publication', async () => {
    const held = gate(), f = fixture({ opening: held.promise });
    const opening = f.service.open(f.params); const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.counts().opens).toBe(1));
    let finished = false; const closing = f.service.close({ historyId: f.params.historyId }).then(() => { finished = true; });
    await vi.waitFor(() => expect(f.counts().closes).toBe(1)); expect(finished).toBe(false);
    held.resolve(); await rejected; await closing; expect(finished).toBe(true);
  });
  it('revalidates authority after a held page read and deletes unpublished spools', async () => {
    const held = gate(), f = fixture({ pageGate: held.promise }); await f.service.open(f.params);
    const pending = f.service.page({ historyId: f.params.historyId }); const rejected = expect(pending).rejects.toMatchObject({ code: 'replay_required' });
    f.generation(); held.resolve(); await rejected; expect(f.usage()?.diskBytes).toBe(0);
  });
  it('allows only one read waiter and aborts a native read at the ten-second bound', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const f = fixture({ overrides: { read(input) { signal = input.signal; return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); } } });
    await f.service.open(f.params);
    const pending = f.service.read({ historyId: f.params.historyId, after: 0 }); const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.service.read({ historyId: f.params.historyId, after: 0 })).rejects.toMatchObject({ code: 'conflict' });
    await vi.advanceTimersByTimeAsync(10000); await rejected; expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps one waiter reserved when a timed-out native read has not settled its IO', async () => {
    vi.useFakeTimers(); const held = Promise.withResolvers<{ through: number; changed: boolean; status: 'current' }>();
    const f = fixture({ overrides: { read: () => held.promise } }); await f.service.open(f.params);
    const pending = f.service.read({ historyId: f.params.historyId, after: 0 }); const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10000); await rejected;
    await expect(f.service.read({ historyId: f.params.historyId, after: 0 })).rejects.toMatchObject({ code: 'conflict' });
    held.resolve({ through: 0, changed: false, status: 'current' }); await held.promise;
  });
  it('coalesces native invalidation versions without exposing transcript payloads', async () => {
    const f = fixture({ overrides: { async read() { return { through: 500, changed: true, status: 'current' }; } } }); await f.service.open(f.params);
    expect(await f.service.read({ historyId: f.params.historyId, after: 0 })).toMatchObject({ through: 500, changed: true, status: 'current' });
    await expect(f.service.read({ historyId: f.params.historyId, after: 501 })).rejects.toThrow('history.after');
  });
  it('retires admission when closed-id tombstones fill instead of forgetting an old fence', async () => {
    const f = fixture();
    for (let i = 0; i < 1024; i++) await f.service.close({ historyId: randomUUID() });
    await expect(f.service.close({ historyId: randomUUID() })).rejects.toMatchObject({ code: 'reconcile_required' });
    await expect(f.service.open(f.params)).rejects.toMatchObject({ code: 'reconcile_required' });
  });
  it('refuses undeclared stream capability and releases the unpublished page', async () => {
    const f = fixture({ overrides: { capabilities: { archive: 'paged', recordStream: false, live: 'unsupported' } } }); await f.service.open(f.params);
    await expect(f.service.page({ historyId: f.params.historyId })).rejects.toMatchObject({ code: 'unsupported', field: 'history.record_stream' });
    expect(f.usage()?.diskBytes).toBe(0);
  });
  it('rejects false archived completeness from a live-only producer', async () => {
    const f = fixture({ liveOnly: true, falseComplete: true }); await f.service.open(f.params);
    await expect(f.service.page({ historyId: f.params.historyId })).rejects.toThrow('history.archive_completeness');
    expect(f.usage()?.diskBytes).toBe(0);
  });
});
