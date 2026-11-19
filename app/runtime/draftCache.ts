import type { DraftStore } from './draftStore';
import type { DraftHeader, DraftIdentity, DraftPart } from './draftStore';
import { createMemoryBudget } from './entityCache';
import type { MemoryBudget, MemoryLease } from './entityCache';
import { DRAFT_CHUNK_BYTES, DraftDigest, DraftStorageError } from './migration/draftChunks';

export type DraftHandle = Readonly<{ header: DraftHeader; release(): void }>;
export type DraftSegment = Readonly<{ bytes: Uint8Array; release(): void }>;
type PartRequest = Readonly<{ identity: DraftIdentity; part: string }>;
type Edit = PartRequest & Readonly<{ nextRevision: number; index: number; bytes: Uint8Array }>;
const HEADER_BYTES = 2 * 1024 * 1024;
const STREAM_BYTES = DRAFT_CHUNK_BYTES * 8 + 8192;

export type DraftCacheStore = Pick<DraftStore, 'header' | 'page' | 'readPart' | 'writeChunk' | 'commit' | 'retry' | 'paused' | 'pendingCount'>;
export function createDraftCache(options: Readonly<{ store: DraftCacheStore; budget?: MemoryBudget }>) {
  const { store } = options;
  const budget = createMemoryBudget({ maxBytes: 8 * 1024 * 1024, maxEntries: 32 });
  let closed = false;
  let editing = false;
  let resume: (() => void) | undefined;
  let operation: Promise<void> | undefined;
  let retrying: Promise<void> | undefined;
  let failed: ((error: unknown) => void) | undefined;
  function reserve(bytes: number, entries = 1): MemoryLease {
    if (closed) throw new DraftStorageError('unavailable');
    const local = budget.reserve({ bytes, entries });
    if (!local) throw new DraftStorageError('paused');
    const external = options.budget?.reserve({ bytes, entries });
    if (options.budget && !external) { local.release(); throw new DraftStorageError('paused'); }
    return { resize: next => {
      if (!external) return local.resize(next);
      // Reservations are fixed worst-case envelopes; callers only shrink after readback.
      if (next > bytes) return false;
      return local.resize(next) && external.resize(next);
    }, commit: () => { local.commit(); external?.commit(); }, release: () => { local.release(); external?.release(); } };
  }
  function admit(): void { if (closed) throw new DraftStorageError('unavailable'); if (store.paused || resume) throw new DraftStorageError('paused'); }
  async function open(identity: DraftIdentity): Promise<DraftHandle | undefined> {
    const lease = reserve(HEADER_BYTES);
    try {
      const header = await store.header(identity);
      if (!header) { lease.release(); return undefined; }
      lease.commit(); return { header, release: lease.release };
    } catch (error) { lease.release(); throw error; }
  }
  async function pageHeaders(input: Readonly<{ after?: string; limit?: number }> = {}) {
    const limit = input.limit ?? 32;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new DraftStorageError('invalid_chunk');
    const leases: MemoryLease[] = []; const headers: DraftHeader[] = []; let after = input.after; let next: string | null = null;
    try {
      for (let i = 0; i < limit; i++) {
        const lease = reserve(HEADER_BYTES); leases.push(lease);
        const page = await store.page({ ...(after ? { after } : {}), limit: 1 });
        const header = page.headers[0];
        if (!header) { lease.release(); next = null; break; }
        // Covers original IDB row, parsed header, key strings, descriptors and output references.
        const bytes = 4096 + JSON.stringify(header).length * 8 + header.parts.length * 1024;
        if (bytes > HEADER_BYTES || !lease.resize(bytes)) throw new DraftStorageError('paused');
        lease.commit(); headers.push(header); next = page.next; if (!next) break; after = next;
      }
      return { headers, next, release: () => { for (const lease of leases) lease.release(); } };
    } catch (error) { for (const lease of leases) lease.release(); throw error; }
  }
  async function* exportPart(input: PartRequest): AsyncGenerator<DraftSegment> {
    const handle = await open(input.identity);
    if (!handle) throw new DraftStorageError('unavailable');
    let active: MemoryLease | undefined; let finished = false;
    try {
      const part = handle.header.parts.find(item => item.name === input.part);
      if (!part) throw new DraftStorageError('invalid_chunk');
      const iterator = store.readPart(input.identity, part); const digest = new DraftDigest(); let size = 0;
      try {
        for (;;) {
          if (active) throw new DraftStorageError('paused');
          const lease = reserve(STREAM_BYTES, 0);
          let next: IteratorResult<Uint8Array>;
          try { next = await iterator.next(); } catch (error) { lease.release(); throw error; }
          if (next.done) { lease.release(); break; }
          active = lease; lease.commit(); digest.update(next.value); size += next.value.length;
          yield { bytes: next.value, release: () => { lease.release(); if (active === lease) active = undefined; if (finished) handle.release(); } };
        }
        if (size !== part.bytes || digest.finish() !== part.sha256) throw new DraftStorageError('corrupt');
      } finally { await iterator.return(undefined); }
    } finally { finished = true; if (!active) handle.release(); }
  }
  async function readSegment(input: PartRequest & Readonly<{ index: number }>): Promise<DraftSegment> {
    if (!Number.isSafeInteger(input.index) || input.index < 0) throw new DraftStorageError('invalid_chunk');
    const stream = exportPart(input); let index = 0;
    try { for await (const segment of stream) { if (index++ === input.index) return segment; segment.release(); } }
    finally { await stream.return(undefined); }
    throw new DraftStorageError('invalid_chunk');
  }
  async function editSegment(input: Edit): Promise<DraftHandle> {
    admit(); if (editing) throw new DraftStorageError('paused');
    if (!Number.isSafeInteger(input.nextRevision) || input.nextRevision <= input.identity.revision || !Number.isSafeInteger(input.index) || input.index < 0 || input.bytes.length > DRAFT_CHUNK_BYTES) throw new DraftStorageError('invalid_chunk');
    const lease = reserve(HEADER_BYTES * 3 + STREAM_BYTES * 2 + input.bytes.buffer.byteLength * 4, 2);
    editing = true;
    const replacement = input.bytes.slice();
    let rejectAttempt: (error: unknown) => void = () => undefined;
    const failure = new Promise<never>((_resolve, reject) => { rejectAttempt = reject; failed = reject; });
    const run = async (): Promise<DraftHandle> => {
      let durable = false;
      try {
        const header = await store.header(input.identity);
        if (!header) throw new DraftStorageError('unavailable');
        const target = header.parts.find(part => part.name === input.part);
        if (!target || input.index >= target.chunks) throw new DraftStorageError('invalid_chunk');
        const identity = { ...input.identity, revision: input.nextRevision };
        const parts: DraftPart[] = [];
        const persist = async (write: () => Promise<void>) => {
          try { await write(); }
          catch (error) {
            if (!store.paused || !store.pendingCount) throw error;
            const wake = new Promise<void>(resolve => { resume = resolve; });
            failed?.(error); await wake;
          }
        };
        for (const part of header.parts) {
          const oldDigest = new DraftDigest(); const digest = new DraftDigest(); let size = 0; let originalSize = 0; let index = 0;
          for await (const original of store.readPart(input.identity, part)) {
            oldDigest.update(original); originalSize += original.length;
            const bytes = part.name === input.part && index === input.index ? replacement : original;
            digest.update(bytes); size += bytes.length;
            await persist(() => store.writeChunk(identity, { name: part.name, kind: part.kind, index, bytes })); index++;
          }
          if (originalSize !== part.bytes || oldDigest.finish() !== part.sha256) throw new DraftStorageError('corrupt');
          parts.push({ ...part, bytes: size, chunks: index, sha256: digest.finish() });
        }
        const result = { ...header, ...identity, parts };
        await persist(() => store.commit(result));
        // A failed write's rejected promise is not its ACK. Retry drains its retained queue;
        // full header and per-part hashes are reconciled before its reservation can become evictable.
        let committed: DraftHeader | undefined;
        for (;;) {
          try {
            committed = await store.header(identity);
            if (!committed || JSON.stringify(committed) !== JSON.stringify(result)) throw new DraftStorageError('corrupt');
            for (const part of committed.parts) {
              const digest = new DraftDigest(); let size = 0;
              for await (const bytes of store.readPart(identity, part)) { digest.update(bytes); size += bytes.length; }
              if (size !== part.bytes || digest.finish() !== part.sha256) throw new DraftStorageError('corrupt');
            }
            break;
          } catch (error) {
            const wake = new Promise<void>(resolve => { resume = resolve; });
            failed?.(error); await wake;
          }
        }
        durable = true; lease.commit(); return { header: committed, release: lease.release };
      } finally { editing = false; if (!durable) lease.release(); }
    };
    const running = run();
    // After a failed outward attempt, retry owns and releases the eventual durable handle.
    let rejected = false;
    operation = running.then(handle => { if (rejected) handle.release(); });
    void operation.catch((error: unknown) => { rejectAttempt(error); });
    try { return await Promise.race([running, failure]); }
    catch (error) { rejected = true; throw error; }
  }
  function retry(): Promise<void> {
    if (retrying) return retrying;
    retrying = (async () => {
      const failure = new Promise<never>((_resolve, reject) => { failed = reject; });
      await store.retry(); const wake = resume; resume = undefined; wake?.(); await Promise.race([operation, failure]);
    })().finally(() => { retrying = undefined; });
    return retrying;
  }
  async function dispose(): Promise<void> {
    if (editing || resume || store.pendingCount) throw new DraftStorageError('paused');
    closed = true;
  }
  return { pageHeaders, open, readSegment, editSegment, readAttachment: exportPart, exportPart, retry, usage: budget.usage, dispose };
}
