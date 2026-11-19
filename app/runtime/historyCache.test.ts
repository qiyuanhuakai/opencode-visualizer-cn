import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRuntimeClient } from './client';
import { createRuntimeConnection } from './connection';
import { createSelectionScope } from './selectionScope';
import { createHistorySource } from './historySource';
import { createHistoryCache } from './historyCache';
import { createMemoryBudget } from './entityCache';
import { decodeFrame, encodeFrame } from '../../shared/runtime/protocol.js';
import type { Request } from '../../shared/runtime/protocol.js';
import type { HistoryDescriptor, HistoryItem } from '../../shared/runtime/historyPage.js';
import { parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../shared/runtime/identity.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { parseCapabilities } from '../../shared/runtime/capabilities.js';
import { parseRuntimeParams, RUNTIME_WIRE_METHODS } from '../../shared/runtime/runtimeWire.js';

const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harness = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const profile = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const session = { environmentId: target, harnessInstanceId: harness, nativeSessionId: 'same' };
const fence = { id: '44444444-4444-4444-8444-444444444444', sourceGeneration: 1 };
class Wire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer'; readyState: 0 | 1 | 2 | 3 = 1; bufferedAmount = 0;
  autoOpen = true; autoClose = true;
  chunkResponder: ((request: Request) => void) | undefined;
  readonly sent: Request[] = []; readonly queued: Request[] = [];
  readonly sessions = new Map<string, SessionRef>();
  waiter: ((request: Request) => void) | undefined;
  close() { this.readyState = 3; }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') throw new TypeError('JSON required');
    const request = decodeFrame(data); if (request.kind !== 'request') throw new TypeError('Request required');
    this.sent.push(request);
    if (request.method === 'runtime.history.open') {
      const params = parseRuntimeParams('runtime.history.open', request.params);
      this.sessions.set(params.historyId, params.session);
      if (this.autoOpen) { this.open(request); return; }
    }
    if (request.method === 'runtime.history.close' && this.autoClose) { this.reply(request, { closed: true }); return; }
    if (request.method === 'runtime.history.chunk' && this.chunkResponder) { this.chunkResponder(request); return; }
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(request); } else this.queued.push(request);
  }
  next(): Promise<Request> { const request = this.queued.shift(); return request ? Promise.resolve(request) : new Promise(resolve => { this.waiter = resolve; }); }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(request: Request, result: unknown) { this.frame({ version: 1, kind: 'result', target, epoch: 'epoch', generation: 1, id: request.id, ok: true, phase: 'read', result }); }
  error(request: Request) { this.frame({ version: 1, kind: 'result', target, epoch: 'epoch', generation: 1, id: request.id, ok: false, typedError: { code: 'source_unavailable', message: 'test fault' } }); }
  open(request: Request) {
    if (request.method !== 'runtime.history.open') throw new TypeError('Open required');
    this.reply(request, { historyId: request.params.historyId, session: request.params.session, fence, capabilities: { archive: 'paged', recordStream: true, live: 'invalidate' } });
  }
  page(request: Request, options: { readonly items?: readonly HistoryItem[]; readonly document?: HistoryDescriptor; readonly cursor?: string; readonly completeness?: 'partial' | 'complete' | 'unsupported' } = {}) {
    if (request.method !== 'runtime.history.page') throw new TypeError('Page required');
    const pageId = crypto.randomUUID();
    this.reply(request, { historyId: request.params.historyId, session: this.sessions.get(parseRuntimeParams('runtime.history.page', request.params).historyId), fence, pageId,
      items: options.items ?? [{ kind: 'inline', recordId: 'message', value: { text: 'kept' } }], cursor: options.cursor ?? null,
      completeness: options.completeness ?? 'complete', ...(options.document ? { document: options.document } : {}) });
    return pageId;
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
async function checkpoint() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
async function setup() {
  const wire = new Wire(); const created = Promise.withResolvers<void>();
  const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:43210/runtime' }, resolveAuthentication: async () => ({}), createWebSocket: () => { created.resolve(); return wire; } });
  const client = createRuntimeClient({ connection });
  const scope = createSelectionScope({ client, profileId: profile });
  const budget = createMemoryBudget({ maxBytes: 128 * 1024 * 1024, maxEntries: 10000 });
  const cache = createHistoryCache(createHistorySource(client), budget);
  cleanups.push(() => { scope.dispose(); client.dispose(); connection.dispose(); });
  const connected = connection.connect(); await created.promise;
  wire.frame({ kind: 'hello', version: 1, target, epoch: 'epoch', generation: 1, instanceId: parseInstanceId('66666666-6666-4666-8666-666666666666'), capabilities: parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] }) }); await connected;
  function capture(nativeSessionId = 'same') { const value = scope.select({ ...session, nativeSessionId }); if (!value) throw new TypeError('Capture required'); return value; }
  await cache.select(capture());
  async function page(options?: Parameters<Wire['page']>[1]) { const pending = cache.page(); wire.page(await wire.next(), options); return pending; }
  return { wire, client, connection, scope, budget, cache, capture, page };
}

describe('bounded selected history cache through production wire codecs', () => {
  it('evicts the fourth selected page but charges held obsolete page references until release', async () => {
    // Given three cached pages, including a caller-held first output.
    const { cache, page, wire } = await setup();
    const first = await page({ items: [{ kind: 'inline', recordId: 'message', value: { text: 'kept', body: 'y'.repeat(16384) } }] }); const second = await page(); second.release(); const third = await page(); third.release();
    const before = cache.usage().residentBytes;
    // When another page is admitted.
    const fourth = await page(); fourth.release();
    // Then exactly the oldest server page is released while its external view remains charged.
    const request = wire.sent.at(-1); expect(request).toMatchObject({ method: 'runtime.history.page', params: { releasePageIds: [first.value.pageId] } });
    expect(cache.get(first.value.pageId)).toBeNull(); expect(first.value.items[0]).toMatchObject({ value: { text: 'kept' } });
    await cache.dispose(); expect(cache.usage().residentBytes).toBeGreaterThanOrEqual(32768); expect(cache.usage().residentBytes).toBeLessThan(before);
    first.release(); expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });
  it('coalesces repeated selection changes and waits for late page drainage after early close ACK', async () => {
    // Given a selected session with a page packet held by the peer.
    const { cache, wire, capture } = await setup(); const reading = cache.page(); const old = await wire.next();
    const rejected = expect(reading).rejects.toMatchObject({ code: 'cancelled' });
    // When two new selections replace it before the old packet arrives.
    const middle = cache.select(capture('middle')); const newest = cache.select(capture('newest')); await checkpoint();
    // Then close ACK alone releases neither the pending memory nor a new open.
    const heldUsage = cache.usage();
    expect(heldUsage.reservedBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    expect(wire.sent.filter(request => request.method === 'runtime.history.open')).toHaveLength(1);
    wire.page(old); await rejected; await middle; await newest;
    expect(wire.sent.filter(request => request.method === 'runtime.history.open').map(request => request.params)).toMatchObject([{ session: { nativeSessionId: 'same' } }, { session: { nativeSessionId: 'newest' } }]);
    expect(cache.status.status).toBe('partial'); await cache.dispose(); expect(cache.usage().residentBytes).toBe(0);
    if (process.env.HISTORY_FRONTEND_EVIDENCE_DIR) writeFileSync(`${process.env.HISTORY_FRONTEND_EVIDENCE_DIR}/runtime-race-result.json`, JSON.stringify({ status: 'PASS', scenario: 'production client/connection/codecs: old page held after close ACK, newest capture coalesced, late packet drained before reopen', heldUsage, finalUsage: cache.usage(), wire: wire.sent.map(request => ({ method: request.method, params: request.params })), oldResultRejected: true, noNativeCancel: wire.sent.every(request => request.method.startsWith('runtime.history.')) }, null, 2));
  });
  it('keeps timeout visible while retaining reservation until a late packet arrives', async () => {
    // Given an unanswered page request.
    vi.useFakeTimers(); const { cache, wire } = await setup(); const reading = cache.page(); const request = await wire.next();
    const rejected = expect(reading).rejects.toMatchObject({ code: 'timeout' });
    // When the request times out locally.
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    // Then status is actionable but new admission remains blocked until physical drainage.
    expect(cache.status).toEqual({ status: 'error', error: 'timeout' });
    expect(cache.usage().reservedBytes).toBe(10 * 1024 * 1024);
    await expect(cache.page()).rejects.toMatchObject({ code: 'conflict' });
    wire.page(request); await checkpoint(); expect(cache.usage().reservedBytes).toBe(0);
    const retry = cache.retry(); wire.page(await wire.next()); const output = await retry;
    expect(output).toHaveProperty('release');
    if (output && typeof output === 'object' && 'release' in output && typeof output.release === 'function') output.release();
    await cache.dispose(); expect(cache.usage().residentBytes).toBe(0);
  });
  it('closes pending open immediately but does not open its replacement before old drainage', async () => {
    // Given a replacement open whose reply is held.
    const { cache, wire, capture } = await setup(); wire.autoOpen = false;
    const oldSelection = cache.select(capture('held')); const opening = await wire.next();
    // When a newer capture supersedes the pending open.
    const newSelection = cache.select(capture('latest')); await checkpoint();
    // Then old close is already sent while the newest open is still absent.
    expect(wire.sent.filter(request => request.method === 'runtime.history.close')).toHaveLength(2);
    expect(wire.sent.filter(request => request.method === 'runtime.history.open')).toHaveLength(2);
    wire.autoOpen = true; wire.open(opening); await oldSelection; await newSelection;
    expect(wire.sent.at(-1)).toMatchObject({ method: 'runtime.history.open', params: { session: { nativeSessionId: 'latest' } } });
    await cache.dispose();
  });
  it('waits for pending invalidation poll after close ACK during disposal', async () => {
    // Given a bounded selected invalidation poll.
    const { cache, wire } = await setup(); const poll = cache.poll(); const request = await wire.next();
    const rejected = expect(poll).rejects.toMatchObject({ code: 'cancelled' });
    // When the cache is disposed before that poll replies.
    const disposing = cache.dispose(); let done = false; void disposing.then(() => { done = true; }); await checkpoint();
    // Then observer resources remain charged until the pending response terminates.
    expect(done).toBe(false); expect(cache.usage().residentBytes).toBeGreaterThan(0);
    if (request.method !== 'runtime.history.read') throw new TypeError('Poll required');
    wire.reply(request, { historyId: request.params.historyId, fence, through: 0, changed: false, status: 'current' });
    await rejected; await disposing; expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });
  it('retains good pages after a typed failure and retries the failed page without re-opening', async () => {
    // Given a retained partial page and a failing next-page response.
    const { cache, wire, page } = await setup(); const retained = await page({ cursor: crypto.randomUUID(), completeness: 'partial' });
    const loading = cache.page(retained.value.cursor ?? undefined); wire.error(await wire.next()); await expect(loading).rejects.toMatchObject({ code: 'source_unavailable' }); await checkpoint();
    // When retry succeeds on the same owner.
    const retry = cache.retry(); wire.page(await wire.next(), { items: [], completeness: 'unsupported' }); const result = await retry;
    // Then the previous page survives and unsupported remains explicit.
    const previous = cache.get(retained.value.pageId); expect(previous?.value).toBe(retained.value); previous?.release();
    expect(cache.status.status).toBe('unsupported'); expect(wire.sent.filter(request => request.method === 'runtime.history.open')).toHaveLength(1);
    if (result && typeof result === 'object' && 'release' in result && typeof result.release === 'function') result.release();
    retained.release(); await cache.dispose();
  });
  it('rejects admission at the hard16MiB limit even when the injected budget allows128MiB', async () => {
    // Given many externally held pages, each containing independent large inline values.
    const { cache, page, wire } = await setup();
    const held = [];
    const items: HistoryItem[] = Array.from({ length: 15 }, (_, index) => ({ kind: 'inline', recordId: String(index), value: `${index}:${'x'.repeat(30000)}` }));
    for (let i = 0; i < 5; i++) held.push(await page({ items }));
    const before = wire.sent.length;
    // When another page would exceed the fixed ceiling including the pending wire allocation.
    const denied = cache.page();
    const unexpected = wire.queued.shift(); if (unexpected) wire.error(unexpected);
    // Then no new request is sent and all held outputs remain charged.
    await expect(denied).rejects.toMatchObject({ code: 'source_unavailable' }); expect(wire.sent).toHaveLength(before);
    const usage = cache.usage(); expect(usage.residentBytes + usage.reservedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    await cache.dispose(); expect(cache.usage().residentBytes).toBeGreaterThan(3 * 1024 * 1024);
    for (const output of held) output.release(); expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });
  it('streams full envelope bytes through the document descriptor and releases on early generator return', async () => {
    // Given unknown envelope adjuncts represented outside the record array.
    const { cache, wire, page } = await setup();
    const bytes = Buffer.from('{"unknownAdjunct":{"text":"kept"},"records":[]}');
    const descriptor: HistoryDescriptor = { id: crypto.randomUUID(), format: 'native-json-utf8', totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const header = await page({ items: [], document: descriptor }); const document = header.value.document; if (!document) throw new TypeError('Document required');
    const before = cache.usage().residentBytes;
    // When the consumer pulls one chunk then exits the generator early.
    const exported = cache.export(header.value.pageId, document); const next = exported.next(); const request = await wire.next();
    if (request.method !== 'runtime.history.chunk') throw new TypeError('Chunk required');
    wire.reply(request, { ...request.params, fence, totalBytes: bytes.length, sha256: descriptor.sha256, data: bytes.toString('base64'), nextOffset: null });
    const result = await next; if (result.done) throw new TypeError('Output required');
    expect(Buffer.from(result.value.bytes)).toEqual(bytes); expect(cache.usage().residentBytes).toBeGreaterThan(before);
    await exported.return(undefined); await checkpoint();
    // Then no whole-document concatenation or held chunk remains in the cache.
    expect(cache.usage().residentBytes).toBe(before); header.release(); await cache.dispose();
  });
  it('charges held chunk backing after selection retirement until explicit release', async () => {
    // Given a held decoded chunk from a streamed record.
    const { cache, wire, page } = await setup(); const bytes = Buffer.from('"body"');
    const descriptor: HistoryDescriptor = { id: crypto.randomUUID(), format: 'native-json-utf8', totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const header = await page({ items: [{ kind: 'stream', recordId: 'body', descriptor }] });
    const item = header.value.items[0]; if (item?.kind !== 'stream') throw new TypeError('Stream required');
    const reading = cache.readChunk(header.value.pageId, item.descriptor, 0); const request = await wire.next();
    if (request.method !== 'runtime.history.chunk') throw new TypeError('Chunk required');
    wire.reply(request, { ...request.params, fence, totalBytes: bytes.length, sha256: descriptor.sha256, data: bytes.toString('base64'), nextOffset: null }); const output = await reading;
    // When selection is disposed while the consumer still owns the byte view.
    header.release(); await cache.dispose();
    // Then the backing allocation remains charged and intact until its lease is released.
    expect(Buffer.from(output.bytes)).toEqual(bytes); expect(cache.usage().residentBytes).toBeGreaterThanOrEqual(output.bytes.buffer.byteLength);
    output.release(); expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });
  it('restarts only the selected history after an invalidation without native cancel or draft mutations', async () => {
    // Given a selected owner and one invalidation poll.
    const { cache, wire } = await setup(); const poll = cache.poll(); const request = await wire.next();
    if (request.method !== 'runtime.history.read') throw new TypeError('Poll required');
    // When the native source changes.
    wire.reply(request, { historyId: request.params.historyId, fence, through: 1, changed: true, status: 'current' }); await poll; await checkpoint();
    // Then only the owned history closes/reopens and the new selection remains usable.
    expect(wire.sent.map(request => request.method)).toEqual(['runtime.history.open', 'runtime.history.read', 'runtime.history.close', 'runtime.history.open']);
    expect(cache.status.status).toBe('partial'); await cache.dispose();
  });


  it('drains and disconnects malformed history before it can become cached content', async () => {
    // Given a selected source with an in-flight page request.
    const { cache, wire, connection } = await setup(); const reading = cache.page(); const request = await wire.next();
    // When the peer violates the bounded page contract with201records.
    wire.page(request, { items: Array.from({ length: 201 }, (_, index) => ({ kind: 'inline', recordId: String(index), value: 'bad' })) });
    // Then strict production codecs reject it, detach the binding and drain the owner.
    await expect(reading).rejects.toMatchObject({ code: 'invalid_request' }); await cache.dispose();
    expect(connection.status.state).toBe('disconnected'); expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });

  it('retries a source-unavailable invalidation poll without losing the complete page', async () => {
    // Given a complete page and a pending selected-source poll.
    const { cache, wire, page } = await setup(); const header = await page();
    const reading = cache.poll(); const request = await wire.next();
    if (request.method !== 'runtime.history.read') throw new TypeError('Poll required');
    await expect(cache.poll()).rejects.toMatchObject({ code: 'conflict' });
    wire.reply(request, { historyId: request.params.historyId, fence, through: 0, changed: false, status: 'source_unavailable' }); await reading; await checkpoint();
    expect(cache.status).toEqual({ status: 'error', error: 'source_unavailable' });
    // When the invalidation source becomes available on explicit retry.
    const retry = cache.retry(); const retried = await wire.next();
    if (retried.method !== 'runtime.history.read') throw new TypeError('Poll required');
    wire.reply(retried, { historyId: retried.params.historyId, fence, through: 0, changed: false, status: 'current' }); await retry;
    // Then existing content is still complete and no history reopen occurred.
    const retained = cache.get(header.value.pageId); expect(retained?.value).toBe(header.value); retained?.release();
    expect(cache.status.status).toBe('complete'); expect(wire.sent.filter(request => request.method === 'runtime.history.open')).toHaveLength(1);
    header.release(); await cache.dispose();
  });

  it('returns to idle when the newest queued capture is aborted before old drainage', async () => {
    // Given a pending old page and a queued new selection.
    const { cache, wire, scope, capture } = await setup(); const reading = cache.page(); const old = await wire.next();
    const rejected = expect(reading).rejects.toMatchObject({ code: 'cancelled' });
    const selecting = cache.select(capture('queued'));
    // When the queued capture is itself invalidated before the old packet drains.
    scope.select(null); wire.page(old); await rejected; await selecting;
    // Then no stale open or perpetual loading state survives repeated interruption.
    expect(wire.sent.filter(request => request.method === 'runtime.history.open')).toHaveLength(1);
    expect(cache.status.status).toBe('idle'); expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
    await cache.dispose();
  });
  it('retains cleanup ownership after a failed close and retries disposal explicitly', async () => {
    // Given a selected owner whose close operation returns a typed failure.
    const { cache, wire } = await setup(); wire.autoClose = false;
    const disposing = cache.dispose(); wire.error(await wire.next());
    // When disposal cannot confirm resource release.
    await expect(disposing).rejects.toMatchObject({ code: 'source_unavailable' });
    // Then control memory remains owned until a successful explicit retry.
    expect(cache.usage().residentBytes).toBeGreaterThan(0);
    wire.autoClose = true; await cache.dispose();
    expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
    expect(wire.sent.filter(request => request.method === 'runtime.history.close')).toHaveLength(2);
  });
  it('releases a held chunk while a different data request remains pending', async () => {
    // Given one externally held chunk.
    const { cache, wire, page } = await setup(); const descriptor: HistoryDescriptor = { id: crypto.randomUUID(), format: 'native-json-utf8', totalBytes: 2, sha256: 'a'.repeat(64) };
    const header = await page({ items: [{ kind: 'stream', recordId: 'record', descriptor }] });
    const item = header.value.items[0]; if (item?.kind !== 'stream') throw new TypeError('Stream required');
    const read = cache.readChunk(header.value.pageId, item.descriptor, 0); const request = await wire.next();
    wire.reply(request, { ...request.params, fence, totalBytes: 2, sha256: descriptor.sha256, data: 'eHg=', nextOffset: null }); const held = await read;
    const next = cache.page(); const pending = await wire.next(); const before = cache.usage().residentBytes;
    // When the first chunk is released while a second request is still in flight.
    held.release();
    // Then its own allocation is released independently of the pending read slot.
    expect(cache.usage().residentBytes).toBeLessThan(before); expect(cache.usage().reservedBytes).toBeGreaterThan(0);
    await expect(cache.page()).rejects.toMatchObject({ code: 'conflict' });
    wire.page(pending); const output = await next; output.release(); header.release(); await cache.dispose();
    expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });
  it('pulls an actual16MiB body and64MiB attachment losslessly within the cache ledger', async () => {
    // Given a native document with large body, attachment and an unknown envelope adjunct.
    const { cache, wire, page } = await setup();
    const bodyBytes = 16 * 1024 * 1024, attachmentBytes = 64 * 1024 * 1024;
    const prefix = Buffer.from('{"unknownAdjunct":{"version":7},"body":"');
    const middle = Buffer.from('","attachment":"'); const suffix = Buffer.from('","records":[]}');
    const encodedAttachmentBytes = 4 * Math.ceil(attachmentBytes / 3);
    const bodyStart = prefix.length, attachmentStart = bodyStart + bodyBytes + middle.length;
    const totalBytes = attachmentStart + encodedAttachmentBytes + suffix.length;
    // The input oracle is generated in bounded blocks; no transcript-sized string or byte array exists.
    function input(offset: number) {
      const chunk = Buffer.alloc(Math.min(65536, totalBytes - offset));
      for (let index = 0; index < chunk.length; index++) {
        const position = offset + index;
        if (position < bodyStart) chunk[index] = prefix[position];
        else if (position < bodyStart + bodyBytes) chunk[index] = 98;
        else if (position < attachmentStart) chunk[index] = middle[position - bodyStart - bodyBytes];
        else if (position < attachmentStart + encodedAttachmentBytes) chunk[index] = position < attachmentStart + encodedAttachmentBytes - 2 ? 65 : 61;
        else chunk[index] = suffix[position - attachmentStart - encodedAttachmentBytes];
      }
      return chunk;
    }
    const expectedDocument = createHash('sha256');
    for (let offset = 0; offset < totalBytes; offset += 65536) expectedDocument.update(input(offset));
    const expectedBody = createHash('sha256'); for (let offset = 0; offset < bodyBytes; offset += 65536) expectedBody.update(Buffer.alloc(Math.min(65536, bodyBytes - offset), 98));
    const expectedAttachment = createHash('sha256'); for (let offset = 0; offset < attachmentBytes; offset += 65536) expectedAttachment.update(Buffer.alloc(Math.min(65536, attachmentBytes - offset)));
    const descriptor: HistoryDescriptor = { id: crypto.randomUUID(), format: 'native-json-utf8', totalBytes, sha256: expectedDocument.digest('hex') };
    const header = await page({ items: [], document: descriptor }); const document = header.value.document; if (!document) throw new TypeError('Document required');
    let peak = 0, chunks = 0, maximumChunk = 0;
    wire.chunkResponder = request => {
      const params = parseRuntimeParams('runtime.history.chunk', request.params);
      const chunk = input(params.offset); const end = params.offset + chunk.length;
      const usage = cache.usage(); peak = Math.max(peak, usage.residentBytes + usage.reservedBytes);
      wire.reply(request, { ...params, fence, totalBytes, sha256: descriptor.sha256, data: chunk.toString('base64'), nextOffset: end === totalBytes ? null : end });
    };
    const observedDocument = createHash('sha256'), observedBody = createHash('sha256'), observedAttachment = createHash('sha256');
    let offset = 0, observedBodyBytes = 0, observedAttachmentBytes = 0, base64Remainder = '';
    // When a pull consumer incrementally hashes document, body and decoded attachment bytes.
    for await (const chunk of cache.export(header.value.pageId, document)) {
      chunks++; maximumChunk = Math.max(maximumChunk, chunk.bytes.byteLength); observedDocument.update(chunk.bytes);
      const end = offset + chunk.bytes.length;
      const bodyFrom = Math.max(bodyStart, offset), bodyTo = Math.min(bodyStart + bodyBytes, end);
      if (bodyFrom < bodyTo) { observedBody.update(chunk.bytes.subarray(bodyFrom - offset, bodyTo - offset)); observedBodyBytes += bodyTo - bodyFrom; }
      const attachmentFrom = Math.max(attachmentStart, offset), attachmentTo = Math.min(attachmentStart + encodedAttachmentBytes, end);
      if (attachmentFrom < attachmentTo) {
        const encoded = base64Remainder + Buffer.from(chunk.bytes.subarray(attachmentFrom - offset, attachmentTo - offset)).toString('ascii');
        const whole = encoded.length - encoded.length % 4; const decoded = Buffer.from(encoded.slice(0, whole), 'base64');
        observedAttachment.update(decoded); observedAttachmentBytes += decoded.length; base64Remainder = encoded.slice(whole);
      }
      offset = end;
    }
    const observed = { document: observedDocument.digest('hex'), body: observedBody.digest('hex'), attachment: observedAttachment.digest('hex') };
    const expected = { document: descriptor.sha256, body: expectedBody.digest('hex'), attachment: expectedAttachment.digest('hex') };
    header.release(); await cache.dispose();
    // Then all three independent hashes and byte counts match, with bounded retained plus pending memory.
    expect(observed).toEqual(expected); expect(observedBodyBytes).toBe(bodyBytes); expect(observedAttachmentBytes).toBe(attachmentBytes);
    expect(offset).toBe(totalBytes); expect(base64Remainder).toBe(''); expect(maximumChunk).toBeLessThanOrEqual(65536);
    expect(peak).toBeLessThanOrEqual(16 * 1024 * 1024); expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
    if (process.env.HISTORY_FRONTEND_EVIDENCE_DIR) writeFileSync(`${process.env.HISTORY_FRONTEND_EVIDENCE_DIR}/large-result.json`, JSON.stringify({ status: 'PASS', totalBytes, observedBodyBytes, observedAttachmentBytes, chunks, maximumChunk, peak, observed, expected, finalUsage: cache.usage(), boundary: 'controlled production RuntimeClient/connection/codecs; not native service or browser RSS' }, null, 2));
  }, 30000);

});
