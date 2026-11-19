import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { HISTORY_LIMITS } from '../../shared/runtime/historyPage.js';
import type { HistoryDescriptor, HistoryPage } from '../../shared/runtime/historyPage.js';
import { estimateRetainedBytes } from './entityCache';
import type { CacheUsage, MemoryBudget, MemoryLease } from './entityCache';
import type { HistoryOperation, HistoryOwner, HistorySource } from './historySource';
import type { SelectionCapture } from './selectionScope';

export type HistoryPageLease = Readonly<{ value: HistoryPage; release(): void }>;
export type HistoryChunkLease = Readonly<{ bytes: Uint8Array; nextOffset: number | null; release(): void }>;
export type HistoryStatus = Readonly<{ status: 'idle' | 'loading' | 'partial' | 'complete' | 'unsupported' | 'error'; error?: ErrorCode; reason?: string }>;
type PageEntry = { readonly value: HistoryPage; readonly memory: MemoryLease; references: number; retained: boolean };
type Active = {
  readonly capture: SelectionCapture; readonly owner: HistoryOwner; readonly memory: MemoryLease;
  readonly work: Set<Promise<void>>; readonly removeAbort: () => void;
  live: boolean; ready: boolean; reading: boolean; polling: boolean; after: number; closing?: Promise<void>;
};
// 512KiB wire: <=1MiB UTF16, <=1MiB node/property storage (4096 nodes).
// JSON.parse + protocol clone + history clone + temporary stringify/UTF8 +
// validator traversal arrays and 64KiB decoded backing fit this 10MiB reservation.
const DATA_BYTES = 10 * 1024 * 1024;
// One open/selected identity, one <=1024-unit-field poll, one concurrent close,
// their protocol/validator copies and bounded promise/lease metadata.
const CONTROL_BYTES = 2 * 1024 * 1024;

export function createHistoryCache(source: HistorySource, budget: MemoryBudget) {
  let residentBytes = 0, reservedBytes = 0, entries = 0;
  let desired: SelectionCapture | null = null;
  let active: Active | undefined;
  let transition: Promise<void> | undefined;
  let disposed = false;
  let status: HistoryStatus = { status: 'idle' };
  let retryAction: (() => Promise<unknown>) | undefined;
  const pages = new Map<string, PageEntry>();
  function reserve(bytes: number, count = 0): MemoryLease {
    requireValue(bytes <= HISTORY_LIMITS.clientResidentAndPendingBytes - residentBytes - reservedBytes, 'history.memory', 'source_unavailable');
    const underlying = budget.reserve({ bytes, entries: count });
    requireValue(underlying !== null, 'history.shared_memory', 'source_unavailable');
    let size = bytes, committed = false, released = false;
    reservedBytes += size; entries += count;
    return {
      resize(next) {
        if (released || next > size || !underlying.resize(next)) return false;
        if (committed) residentBytes += next - size; else reservedBytes += next - size;
        size = next; return true;
      },
      commit() { if (released || committed) return; committed = true; reservedBytes -= size; residentBytes += size; underlying.commit(); },
      release() { if (released) return; released = true; if (committed) residentBytes -= size; else reservedBytes -= size; entries -= count; underlying.release(); },
    };
  }
  function retire(entry: PageEntry) {
    pages.delete(entry.value.pageId); entry.retained = false;
    if (!entry.references) entry.memory.release();
  }
  function fail(error: unknown) {
    if (!(error instanceof ProtocolError)) throw error;
    status = { status: 'error', error: error.code };
  }
  function current(value: Active) { return !disposed && value === active && value.live && value.capture.isCurrent(); }
  function stop(value: Active) {
    if (value.closing) return value.closing;
    value.live = false; value.removeAbort();
    value.closing = (async () => {
      try { await value.owner.close(); }
      catch (error) { await Promise.all(value.work); value.closing = undefined; throw error; }
      await Promise.all(value.work); value.memory.release();
    })();
    // The transition consumes the original rejection after any pending open drains.
    void value.closing.then(undefined, () => undefined);
    return value.closing;
  }
  function clear() {
    retryAction = undefined;
    for (const entry of pages.values()) retire(entry);
    if (active) void stop(active);
  }
  function track<T>(value: Active, operation: HistoryOperation<T>, memory: MemoryLease, consume: (result: T) => T | Promise<T>): Promise<T> {
    const result = operation.result.then(consume);
    const finished = result.then(() => undefined, () => undefined).then(() => operation.drained).then(() => { memory.release(); });
    value.work.add(finished);
    void finished.then(() => { value.work.delete(finished); });
    return result;
  }
  async function pump() {
    while (true) {
      if (active) {
        const previous = active;
        try { await stop(previous); } catch (error) { fail(error); retryAction = schedule; return; }
        if (active === previous) active = undefined;
      }
      const capture = desired;
      if (disposed || !capture || !capture.isCurrent()) { desired = null; status = { status: 'idle' }; return; }
      let memory: MemoryLease | undefined;
      let data: MemoryLease | undefined;
      try {
        memory = reserve(CONTROL_BYTES); data = reserve(DATA_BYTES);
        const owner = source.open(capture);
        const onAbort = () => { if (active?.capture === capture) invalidate(); };
        capture.signal.addEventListener('abort', onAbort, { once: true });
        const value: Active = { capture, owner, memory, work: new Set(), live: true, ready: false, reading: false, polling: false, after: 0,
          removeAbort: () => capture.signal.removeEventListener('abort', onAbort) };
        active = value; memory.commit();
        const opened = track(value, owner.ready, data, result => {
          if (current(value)) {
            value.ready = true;
            status = { status: result.capabilities.archive === 'unsupported' ? 'unsupported' : 'partial', ...(result.reason ? { reason: result.reason } : {}) };
          }
          return result;
        });
        try { await opened; } catch (error) { if (current(value)) { fail(error); retryAction = () => select(capture); } }
        await Promise.all(value.work);
        if (desired === capture && current(value)) return;
      } catch (error) {
        memory?.release(); data?.release(); fail(error); retryAction = () => select(capture); return;
      }
    }
  }
  function schedule() {
    if (!transition) {
      transition = Promise.resolve().then(pump).finally(() => { transition = undefined; });
    }
    return transition;
  }
  function invalidate() { desired = null; clear(); status = { status: 'idle' }; return schedule(); }
  function select(capture: SelectionCapture) {
    requireValue(!disposed && capture.isCurrent(), 'history.selection', 'cancelled');
    desired = capture; clear(); status = { status: 'loading' }; return schedule();
  }
  function selected() {
    requireValue(active !== undefined && current(active) && active.ready, 'history.selection', 'cancelled');
    return active;
  }
  function output(entry: PageEntry): HistoryPageLease {
    const memory = reserve(512); memory.commit(); entry.references++;
    let released = false;
    return { value: entry.value, release() {
      if (released) return; released = true; memory.release(); entry.references--;
      if (!entry.retained && !entry.references) entry.memory.release();
    } };
  }
  async function page(cursor?: string): Promise<HistoryPageLease> {
    const value = selected();
    requireValue(!value.reading, 'history.pending', 'conflict');
    const memory = reserve(DATA_BYTES, 1);
    const releasePageIds: string[] = [];
    if (pages.size >= HISTORY_LIMITS.selectedPages) {
      const oldest = pages.values().next().value;
      if (oldest) { releasePageIds.push(oldest.value.pageId); retire(oldest); }
    }
    value.reading = true;
    let retained = false, cleared = false;
    const clearReading = () => { if (!cleared) { cleared = true; value.reading = false; } };
    let operation: HistoryOperation<HistoryPage>;
    try { operation = value.owner.page({ ...(cursor === undefined ? {} : { cursor }), releasePageIds }); }
    catch (error) { memory.release(); value.reading = false; throw error; }
    const result = operation.result.then(async result => {
      await operation.drained;
      requireValue(current(value), 'history.selection', 'cancelled');
      const bytes = estimateRetainedBytes(result) + 2048;
      requireValue(memory.resize(bytes), 'history.page_memory', 'source_unavailable'); memory.commit(); retained = true;
      const entry: PageEntry = { value: result, memory, references: 0, retained: true };
      const previous = pages.get(result.pageId); if (previous) retire(previous);
      pages.set(result.pageId, entry);
      status = { status: result.completeness, ...(result.reason ? { reason: result.reason } : {}) }; retryAction = undefined;
      clearReading();
      return output(entry);
    }).catch(error => { if (current(value)) { fail(error); retryAction = () => page(cursor); } throw error; });
    const finished = result.then(() => undefined, () => undefined).then(() => operation.drained).then(() => {
      if (!retained) memory.release(); clearReading();
    });
    value.work.add(finished); void finished.then(() => { value.work.delete(finished); });
    return result;
  }
  async function readChunk(pageId: string, descriptor: HistoryDescriptor, offset: number): Promise<HistoryChunkLease> {
    const value = selected(); const entry = pages.get(pageId);
    requireValue(entry !== undefined && (entry.value.document === descriptor || entry.value.items.some(item => item.kind === 'stream' && item.descriptor === descriptor)), 'history.descriptor', 'invalid_request');
    requireValue(!value.reading, 'history.pending', 'conflict');
    const memory = reserve(DATA_BYTES); value.reading = true;
    let held = false, cleared = false;
    const clearReading = () => { if (!cleared) { cleared = true; value.reading = false; } };
    let operation;
    try { operation = value.owner.chunk({ pageId, descriptorId: descriptor.id, offset }); }
    catch (error) { memory.release(); value.reading = false; throw error; }
    const result = operation.result.then(async chunk => {
      await operation.drained;
      requireValue(current(value), 'history.selection', 'cancelled');
      requireValue(chunk.totalBytes === descriptor.totalBytes && chunk.sha256 === descriptor.sha256, 'history.descriptor_fence', 'replay_required');
      const decoded = atob(chunk.data);
      const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      // Preserve the wire/parse reservation until physical drainage, then hold the backing allocation.
      held = true; let released = false;
      clearReading(); memory.resize(HISTORY_LIMITS.decodedChunkBytes + 1024); memory.commit();
      return { bytes, nextOffset: chunk.nextOffset, release() { if (released) return; released = true; held = false; memory.release(); } };
    }).catch(error => { if (current(value)) { fail(error); retryAction = () => readChunk(pageId, descriptor, offset); } throw error; });
    const finished = result.then(() => undefined, () => undefined).then(() => operation.drained).then(() => {
      clearReading();
      if (held) { memory.resize(HISTORY_LIMITS.decodedChunkBytes + 1024); memory.commit(); } else memory.release();
    });
    value.work.add(finished); void finished.then(() => { value.work.delete(finished); });
    return result;
  }
  async function poll() {
    const value = selected(); requireValue(!value.polling, 'history.poll_pending', 'conflict'); value.polling = true;
    let operation;
    try { operation = value.owner.poll(value.after); }
    catch (error) { value.polling = false; throw error; }
    const result = operation.result.then(change => {
      requireValue(current(value), 'history.selection', 'cancelled'); value.after = change.through;
      if (change.changed || change.status === 'replay_required') void select(value.capture);
      else if (change.status === 'source_unavailable') { status = { status: 'error', error: 'source_unavailable' }; retryAction = poll; }
      else {
        let completeness: 'partial' | 'complete' | 'unsupported' = 'partial';
        for (const entry of pages.values()) completeness = entry.value.completeness;
        status = { status: completeness }; retryAction = undefined;
      }
      return change;
    }).catch(error => { if (current(value)) { fail(error); retryAction = poll; } throw error; });
    const finished = result.then(() => undefined, () => undefined).then(() => operation.drained).then(() => { value.polling = false; });
    value.work.add(finished); void finished.then(() => { value.work.delete(finished); });
    return result;
  }
  return {
    select, invalidate, page, readChunk, poll,
    get status(): HistoryStatus { return status; },
    get(pageId: string) { const entry = pages.get(pageId); return entry ? output(entry) : null; },
    retry() { requireValue(retryAction !== undefined, 'history.retry', 'invalid_request'); return retryAction(); },
    usage(): CacheUsage { return { residentBytes, reservedBytes, entries }; },
    async *export(pageId: string, descriptor: HistoryDescriptor): AsyncGenerator<HistoryChunkLease> {
      let offset: number | null = 0;
      while (offset !== null) {
        const chunk = await readChunk(pageId, descriptor, offset);
        try { yield chunk; offset = chunk.nextOffset; } finally { chunk.release(); }
      }
    },
    async dispose() { disposed = true; await invalidate(); if (active) throw new ProtocolError('source_unavailable', 'history.close_pending'); },
  };
}
