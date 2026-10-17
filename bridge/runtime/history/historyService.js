import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { assertAuxiliaryEntry, mergeAuxiliaryCanonical } from './auxiliaryMerge.js';

/**
 * Task 36 — bounded auxiliary-history paging service (bridge side).
 *
 * This is the RUNTIME read path. It reads ONE page at a time on demand and never eager-drains the
 * whole transcript: at most `pages` (three) pages and `residentBytes` (16 MiB) are resident, least
 * -recently-used inactive pages are evicted and re-read on demand (identical content), and an entry
 * larger than `entryInlineBytes` (2 MiB) is stored as a chunked reference and served in `chunkBytes`
 * (64 KiB) slices instead of being held whole.
 *
 * A durable write is staged into a BOUNDED dirty set; when its ack fails the dirty records are
 * retained for recovery and the whole history is never buffered. The only path that materialises the
 * entire transcript is `legacyExport()` — the explicit, read-only legacy export that is deliberately
 * kept out of the runtime hot path.
 *
 * Every read model is frozen; every rejection is a ProtocolError with an explicit code + field.
 * Browser-safe: no node builtins, so the app-side cache bundles this module directly.
 */

export const AUXILIARY_HISTORY_LIMITS = Object.freeze({
  pages: 3,
  residentBytes: 16777216, // 16 MiB resident ceiling
  entryInlineBytes: 2097152, // 2 MiB per-entry inline ceiling → larger entries are chunked
  chunkBytes: 65536, // 64 KiB chunk slice
  recordsPerPage: 200,
  dirtyMaxCount: 32,
  dirtyMaxBytes: 8388608, // 8 MiB dirty-recovery ceiling
});

const encoder = new TextEncoder();
const newId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);
const encodedSize = (value) => encoder.encode(JSON.stringify(value)).length;
const cursorKey = (cursor) => (cursor === null ? '\u0000first' : cursor);

export function createAuxiliaryHistoryService(options) {
  const reader = options.reader;
  const persister = options.persister;
  const limits = { ...AUXILIARY_HISTORY_LIMITS, ...options.limits };
  requireValue(typeof reader === 'function', 'history.reader');

  const pages = new Map(); // pageId -> { value, bytes, lastAccess, descriptors: string[] }
  const byCursor = new Map(); // cursorKey -> pageId
  const spool = new Map(); // descriptorId -> { body, totalBytes, pageId }  (chunked oversized bodies)
  const dirty = new Map(); // entryId -> frozen entry
  let residentBytes = 0;
  let clock = 0;
  let evicted = 0;
  let rereads = 0;
  let dirtyBytes = 0;
  let generation = 0;
  let bufferedHistory = false;
  let committing = null;
  let disposed = false;

  function assertOpen() {
    requireValue(!disposed, 'history.disposed', 'cancelled');
  }
  function assertCursor(cursor) {
    requireValue(cursor === null || (typeof cursor === 'string' && cursor.length > 0), 'history.cursor');
  }

  function freePage(pageId) {
    const entry = pages.get(pageId);
    if (entry === undefined) return 0;
    pages.delete(pageId);
    residentBytes -= entry.bytes;
    for (const descriptorId of entry.descriptors) spool.delete(descriptorId);
    for (const [key, id] of byCursor) if (id === pageId) byCursor.delete(key);
    return entry.bytes;
  }

  function evictLru() {
    let oldestId; let oldestAccess = Infinity;
    for (const [id, entry] of pages) if (entry.lastAccess < oldestAccess) { oldestAccess = entry.lastAccess; oldestId = id; }
    if (oldestId === undefined) return;
    freePage(oldestId);
    evicted += 1;
  }

  function admit(built) {
    // Replace any prior resident page for the same cursor (re-read refreshes in place).
    const prior = byCursor.get(cursorKey(built.cursor));
    if (prior !== undefined && pages.has(prior)) freePage(prior);
    requireValue(built.bytes <= limits.residentBytes, 'history.memory', 'source_unavailable');
    while (pages.size >= limits.pages || residentBytes + built.bytes > limits.residentBytes) {
      if (pages.size === 0) break;
      evictLru();
    }
    const pageId = newId();
    pages.set(pageId, { value: { ...built, pageId }, bytes: built.bytes, lastAccess: ++clock, descriptors: built.descriptors });
    byCursor.set(cursorKey(built.cursor), pageId);
    residentBytes += built.bytes;
    return pages.get(pageId).value;
  }

  async function readPage(cursor) {
    assertOpen();
    assertCursor(cursor);
    let raw;
    try {
      raw = await reader(cursor);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError('source_unavailable', 'history.source');
    }
    requireValue(raw !== null && typeof raw === 'object' && Array.isArray(raw.entries), 'history.page', 'source_unavailable');
    const entries = [];
    const oversized = [];
    const descriptors = [];
    // An oversized body IS resident, so it is charged in full and staged only once the ceiling holds.
    const staged = [];
    let bytes = 0;
    for (const value of raw.entries) {
      assertAuxiliaryEntry(value);
      const size = encodedSize(value);
      if (size > limits.entryInlineBytes) {
        const descriptorId = newId();
        staged.push({ descriptorId, bytes: encoder.encode(JSON.stringify(value)), totalBytes: size });
        oversized.push(Object.freeze({ entryId: value.info.id, descriptorId, totalBytes: size }));
        descriptors.push(descriptorId);
        bytes += size;
      } else {
        entries.push(Object.freeze({ info: Object.freeze({ ...value.info }), parts: Object.freeze(value.parts.map(part => Object.freeze({ ...part }))) }));
        bytes += size;
      }
    }
    const nextCursor = raw.nextCursor ?? null;
    if (nextCursor !== null && nextCursor === cursor) throw new ProtocolError('source_unavailable', 'history.cursor');
    requireValue(bytes <= limits.residentBytes, 'history.memory', 'source_unavailable');
    for (const item of staged) spool.set(item.descriptorId, { bytes: item.bytes, totalBytes: item.totalBytes, pageId: '' });
    return { cursor, nextCursor, entries, bytes, oversized, descriptors };
  }

  function page(cursor) {
    const cached = byCursor.get(cursorKey(cursor));
    if (cached !== undefined && pages.has(cached)) {
      pages.get(cached).lastAccess = ++clock;
      return Promise.resolve(pages.get(cached).value);
    }
    return readPage(cursor).then(built => admit(built));
  }

  function reread(cursor) {
    rereads += 1;
    return readPage(cursor).then(built => admit(built));
  }

  function get(pageId) {
    const entry = pages.get(pageId);
    return entry ? entry.value : null;
  }

  function evict(pageId) {
    const freedBytes = freePage(pageId);
    if (freedBytes > 0) evicted += 1;
    return { pageId, freedBytes, evicted: freedBytes > 0 };
  }

  function chunk(pageId, descriptorId, offset) {
    const entry = pages.get(pageId);
    requireValue(entry !== undefined && entry.descriptors.includes(descriptorId), 'history.descriptor', 'invalid_request');
    requireValue(Number.isInteger(offset) && offset >= 0, 'history.offset');
    const spooled = spool.get(descriptorId);
    requireValue(spooled !== undefined, 'history.descriptor', 'invalid_request');
    // The body is addressed by UTF-8 BYTE offset, not by UTF-16 code unit: a `String.slice` over a
    // non-ASCII body both over-reads (one chunk holds more than chunkBytes bytes) and stalls (the
    // remainder is shorter than a slice unit, so bytes comes back 0 forever).
    const body = spooled.bytes;
    requireValue(offset < body.length, 'history.offset');
    const slice = body.subarray(offset, offset + limits.chunkBytes);
    const end = offset + slice.length;
    return Promise.resolve({ bytes: slice, nextOffset: end >= body.length ? null : end });
  }

  async function legacyExport() {
    // The one allowed full read: an explicit, read-only legacy export. Deliberately NOT the runtime path.
    bufferedHistory = true;
    let canonical = [];
    let cursor = null;
    const guard = new Set();
    do {
      const raw = await reader(cursor);
      requireValue(raw !== null && typeof raw === 'object' && Array.isArray(raw.entries), 'history.page', 'source_unavailable');
      const entries = raw.entries.map(value => { assertAuxiliaryEntry(value); return value; });
      canonical = mergeAuxiliaryCanonical(canonical, entries);
      cursor = raw.nextCursor ?? null;
      if (cursor !== null) { requireValue(!guard.has(cursor), 'history.cursor', 'source_unavailable'); guard.add(cursor); }
    } while (cursor !== null);
    return canonical;
  }

  function mergeWithCanonical(canonical, historyPage) {
    return mergeAuxiliaryCanonical(canonical, historyPage?.entries ?? []);
  }

  function stage(entries, writeGeneration) {
    assertOpen();
    if (writeGeneration !== undefined) {
      requireValue(Number.isInteger(writeGeneration) && writeGeneration >= generation, 'history.generation', 'conflict');
      generation = writeGeneration;
    }
    const incoming = [...entries];
    for (const entry of incoming) assertAuxiliaryEntry(entry);
    // An already-dirty record is UPDATED, not dropped: the byte budget is re-charged for the delta.
    for (const entry of incoming) {
      const existing = dirty.get(entry.info.id);
      if (existing === undefined) {
        requireValue(dirty.size + 1 <= limits.dirtyMaxCount, 'history.dirty_budget');
        const size = encodedSize(entry);
        requireValue(dirtyBytes + size <= limits.dirtyMaxBytes, 'history.dirty_budget');
        dirty.set(entry.info.id, Object.freeze({ info: Object.freeze({ ...entry.info }), parts: Object.freeze(entry.parts.map(part => Object.freeze({ ...part }))) }));
        dirtyBytes += size;
        continue;
      }
      const next = Object.freeze({ info: Object.freeze({ ...entry.info }), parts: Object.freeze(entry.parts.map(part => Object.freeze({ ...part }))) });
      const before = encodedSize(existing);
      const after = encodedSize(next);
      requireValue(dirtyBytes - before + after <= limits.dirtyMaxBytes, 'history.dirty_budget');
      dirty.set(entry.info.id, next);
      dirtyBytes += after - before;
    }
  }

  function removeCommitted(batch) {
    // Only this batch's records that have not been re-staged since are removed.
    for (const entry of batch) {
      const current = dirty.get(entry.info.id);
      if (current === entry) dirty.delete(entry.info.id);
    }
    dirtyBytes = [...dirty.values()].reduce((sum, entry) => sum + encodedSize(entry), 0);
  }

  async function commit() {
    assertOpen();
    if (dirty.size === 0) return { committed: 0, bytes: 0 };
    // Commits are serialized: a second caller waits for the in-flight ack.
    while (committing !== null) await committing;
    const batch = [...dirty.values()];
    const bytes = dirtyBytes;
    committing = (async () => {
      try {
        if (persister) await persister(batch);
      } catch {
        throw new ProtocolError('source_unavailable', 'history.durable_ack');
      }
      removeCommitted(batch);
    })();
    try {
      await committing;
    } finally {
      committing = null;
    }
    return { committed: batch.length, bytes };
  }

  function usage() {
    return {
      residentBytes, pageCount: pages.size, evicted, rereads,
      dirtyCount: dirty.size, dirtyBytes, retainedBytes: residentBytes + dirtyBytes,
      bufferedHistory,
    };
  }

  function dispose() {
    disposed = true;
    pages.clear();
    byCursor.clear();
    spool.clear();
    dirty.clear();
    residentBytes = 0;
    dirtyBytes = 0;
  }

  return {
    page, get, evict, reread, chunk, legacyExport, mergeWithCanonical,
    stage, commit, usage, dispose,
  };
}
