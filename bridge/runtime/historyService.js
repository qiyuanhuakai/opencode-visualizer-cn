import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireValue, ProtocolError, jsonValue, textValue, objectFields } from '../../shared/runtime/capabilities.js';
import { parseRuntimeParams } from '../../shared/runtime/runtimeWire.js';
import { HISTORY_LIMITS, parseHistoryOpen, parseHistoryPage, parseHistoryChunk, parseHistoryChange } from '../../shared/runtime/historyPage.js';
import { createHistoryStream, createHistoryDiskBudget } from './historyStream.js';

const globalDisk = createHistoryDiskBudget();
const sameAuthority = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function createHistoryService({ binding, authorize, openProducer }) {
  const entries = new Map(), closed = new Map();
  let selected, disposed = false, disposal;
  function alive(entry) {
    requireValue(!disposed && !entry.closed && selected === entry && !entry.controller.signal.aborted, 'history.closed', 'cancelled');
  }
  async function check(entry) {
    alive(entry);
    const authority = jsonValue(await authorize(entry.params)); alive(entry);
    requireValue(sameAuthority(authority, entry.authority), 'history.source_generation', 'replay_required');
  }
  function remember(id, entry) {
    if (closed.has(id)) return;
    if (closed.size >= HISTORY_LIMITS.tombstones) {
      disposed = true;
      for (const value of entries.values()) void retire(value);
      throw new ProtocolError('reconcile_required', 'history.tombstones_exhausted');
    }
    closed.set(id, entry?.params ?? null);
  }
  function retire(entry) {
    if (entry.closing) return entry.closing;
    entry.closed = true; entry.controller.abort();
    entry.closing = (async () => {
      const failures = [];
      try { await entry.acquisition; } catch (error) { if (!(error instanceof Error)) failures.push(error); }
      if (entry.producer) try { await entry.producer.close(); } catch (error) { failures.push(error); }
      await Promise.allSettled(entry.pending);
      try { await entry.store.close(); } catch (error) { failures.push(error); }
      entry.pages.clear(); entries.delete(entry.params.historyId);
      if (selected === entry) selected = undefined;
      if (failures.length) throw new AggregateError(failures, 'History cleanup failed');
    })();
    return entry.closing;
  }
  function track(entry, action) {
    const promise = action(); entry.pending.add(promise);
    void promise.then(() => entry.pending.delete(promise), () => entry.pending.delete(promise));
    return promise;
  }
  async function obtain(params) {
    const entry = entries.get(params.historyId);
    requireValue(entry && entry.ready, 'history.handle', 'replay_required');
    try { await check(entry); } catch (error) { await retire(entry); throw error; }
    return entry;
  }
  async function open(input) {
    const params = parseRuntimeParams('runtime.history.open', input);
    requireValue(!disposed, 'history.disposed', 'reconcile_required');
    requireValue(!closed.has(params.historyId) && !entries.has(params.historyId), 'history.closed_id', 'cancelled');
    requireValue(params.session.environmentId === binding.target, 'history.target', 'unauthorized');
    const old = selected;
    const entry = { params, controller: new AbortController(), store: createHistoryStream({ scope: JSON.stringify([binding, params.historyId, params.session]), globalDisk, createDirectory: () => mkdtemp(join(tmpdir(), 'vis-runtime-history-')) }), pending: new Set(), pages: new Map(), producer: null, closed: false, ready: false, paging: false, reading: false, chunking: false, cursor: null, through: 0 };
    remember(params.historyId, entry);
    entries.set(params.historyId, entry); selected = entry;
    const work = track(entry, async () => {
      if (old) { remember(old.params.historyId, old); await retire(old); }
      alive(entry); entry.authority = jsonValue(await authorize(params)); alive(entry);
      entry.acquisition = Promise.resolve(openProducer(params, entry.authority));
      entry.producer = await entry.acquisition;
      for (const method of ['open', 'page', 'chunk', 'read', 'close']) requireValue(typeof entry.producer?.[method] === 'function', 'history.producer', 'unsupported');
      alive(entry);
      const result = await entry.producer.open({ signal: entry.controller.signal, streamStore: entry.store });
      objectFields(result, ['fence'], ['reason']);
      await check(entry);
      const opened = parseHistoryOpen({ historyId: params.historyId, session: params.session, capabilities: entry.producer.capabilities, ...result });
      entry.fence = opened.fence; entry.capabilities = opened.capabilities; entry.ready = true;
      return opened;
    });
    try { return await work; }
    catch (error) { remember(params.historyId, entry); await retire(entry); throw error; }
  }
  async function page(input) {
    const params = parseRuntimeParams('runtime.history.page', input), entry = await obtain(params);
    requireValue(!entry.paging && !entry.chunking, 'history.page_busy', 'conflict');
    const release = params.releasePageIds ?? [];
    requireValue(release.every(id => entry.pages.has(id)), 'history.page_owner', 'unauthorized');
    requireValue(entry.pages.size - release.length < HISTORY_LIMITS.selectedPages, 'history.pages_held', 'source_unavailable');
    requireValue(params.cursor === undefined || entry.cursor?.id === params.cursor, 'history.cursor', 'replay_required');
    entry.paging = true;
    try {
      return await track(entry, async () => {
        for (const id of release) { await entry.store.release(id); entry.pages.delete(id); }
        await check(entry);
        const nativeCursor = params.cursor === undefined ? undefined : entry.cursor.native;
        entry.cursor = null;
        const result = await entry.producer.page({ ...(nativeCursor === undefined ? {} : { cursor: nativeCursor }), releasePageIds: release, signal: entry.controller.signal });
        await check(entry);
        let cursor = null;
        if (result.cursor !== null) { textValue(result.cursor, 'history.native_cursor'); requireValue(result.cursor !== nativeCursor, 'history.cursor_progress', 'replay_required'); cursor = { id: randomUUID(), native: result.cursor }; }
        const output = parseHistoryPage({ ...result, cursor: cursor?.id ?? null, historyId: params.historyId, session: entry.params.session, fence: entry.fence });
        requireValue(entry.capabilities.archive === 'paged' || output.completeness !== 'complete', 'history.archive_completeness');
        requireValue(entry.capabilities.archive !== 'unsupported' || output.completeness === 'unsupported', 'history.archive_unsupported');
        requireValue(entry.capabilities.recordStream || output.document === undefined && output.items.every(item => item.kind === 'inline'), 'history.record_stream', 'unsupported');
        requireValue(!entry.pages.has(output.pageId), 'history.page_reused', 'conflict');
        entry.pages.set(output.pageId, output); entry.cursor = cursor;
        return output;
      });
    } catch (error) { await retire(entry); throw error; }
    finally { entry.paging = false; }
  }
  async function chunk(input) {
    const params = parseRuntimeParams('runtime.history.chunk', input), entry = await obtain(params);
    requireValue(!entry.chunking && !entry.paging, 'history.chunk_busy', 'conflict');
    const page = entry.pages.get(params.pageId), descriptor = page?.document?.id === params.descriptorId ? page.document : page?.items.find(item => item.kind === 'stream' && item.descriptor.id === params.descriptorId)?.descriptor;
    requireValue(descriptor, 'history.descriptor_owner', 'replay_required');
    requireValue(params.offset < descriptor.totalBytes, 'history.offset'); entry.chunking = true;
    try {
      return await track(entry, async () => {
        const output = await entry.producer.chunk({ pageId: params.pageId, descriptorId: params.descriptorId, offset: params.offset, signal: entry.controller.signal });
        try {
          await check(entry);
          requireValue(output.bytes instanceof Uint8Array && output.bytes.byteLength <= HISTORY_LIMITS.decodedChunkBytes && output.bytes.buffer.byteLength <= HISTORY_LIMITS.decodedChunkBytes && output.offset === params.offset, 'history.chunk_bytes');
          return parseHistoryChunk({ historyId: params.historyId, fence: entry.fence, pageId: params.pageId, descriptorId: params.descriptorId, offset: output.offset, totalBytes: descriptor.totalBytes, sha256: descriptor.sha256, data: Buffer.from(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength).toString('base64'), nextOffset: output.nextOffset });
        } finally { output.release(); }
      });
    } finally { entry.chunking = false; }
  }
  async function read(input) {
    const params = parseRuntimeParams('runtime.history.read', input), entry = await obtain(params);
    requireValue(!entry.reading, 'history.read_busy', 'conflict');
    requireValue(entry.capabilities.live === 'invalidate', 'history.live', 'unsupported');
    requireValue(params.after <= entry.through, 'history.after'); entry.reading = true;
    const controller = new AbortController();
    let nativeRead;
    const timer = setTimeout(() => controller.abort(), HISTORY_LIMITS.readTimeoutMs); timer.unref?.();
    try {
      return await track(entry, async () => {
        const work = entry.producer.read({ after: params.after, signal: AbortSignal.any([entry.controller.signal, controller.signal]) }); nativeRead = work;
        // The producer settles its read on cancellation; retaining it in pending keeps close truthful.
        entry.pending.add(work); void work.then(() => entry.pending.delete(work), () => entry.pending.delete(work));
        const interrupted = new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new ProtocolError('timeout', 'history.read')), { once: true }));
        const result = await Promise.race([work, interrupted]); await check(entry);
        const output = parseHistoryChange({ ...result, historyId: params.historyId, fence: entry.fence });
        requireValue(output.through >= entry.through && output.through >= params.after && output.changed === (output.through > params.after), 'history.change_progress');
        entry.through = output.through; return output;
      });
    } finally {
      clearTimeout(timer); controller.abort();
      if (nativeRead) void nativeRead.then(() => { entry.reading = false; }, () => { entry.reading = false; });
      else entry.reading = false;
    }
  }
  async function close(input) {
    const params = parseRuntimeParams('runtime.history.close', input), entry = entries.get(params.historyId);
    remember(params.historyId, entry);
    const cleanup = entry ? retire(entry) : Promise.resolve();
    try { const scope = entry?.params ?? closed.get(params.historyId); if (scope) await authorize(scope); }
    finally { await cleanup; }
    return { closed: true };
  }
  function dispose() {
    disposed = true;
    disposal ??= (async () => { const results = await Promise.allSettled([...entries.values()].map(retire)); closed.clear(); const failures = results.filter(result => result.status === 'rejected'); if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'History disposal failed'); })();
    return disposal;
  }
  return Object.freeze({ open, page, chunk, read, close, dispose });
}
