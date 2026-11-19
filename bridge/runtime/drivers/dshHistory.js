import { integer, fail } from '../../../shared/runtime/native/dsh/protocol.js';
import { ProtocolError, requireValue, textValue, integerValue } from '../../../shared/runtime/capabilities.js';
import { historyPage } from '../../../shared/runtime/native/dsh/follow.js';

export const DSH_HISTORY_LIMITS = Object.freeze({ page: 200, budgetBytes: 2097152, chunkBytes: 65536 });
/** Legacy selected-history read retained for the `readHistoryPage` core operation. It still applies the
 * native `maxMessages` window and the shared `historyPage` bound checks; the streaming `openHistory`
 * producer below is the substrate-backed path that no longer truncates.
 */
export async function readDshHistoryPage({ transport, session, state, beforeSeq, throughSeq, limit = 200 }) {
  const fence = state.historyFence();
  integer(limit, 1, 200);
  const before = integer(beforeSeq ?? fence.cursor + 1, 0, fence.cursor + 1);
  const through = integer(throughSeq ?? fence.cursor, -1, fence.cursor);
  if (fence.cursor === -1) return { session, records: [], nativeHasMore: false, cursor: null, completeness: 'complete', throughSeq: through, generation: fence.generation, revision: fence.revision };
  const value = await transport.call('session/page', { request: { address: { kind: 'session', sessionId: session.nativeSessionId },
    throughSeq: through, beforeSeq: before, maxMessages: limit } }, { maxBytes: 2097152 });
  state.assertHistory(fence);
  const page = historyPage(value, through, before, limit);
  if (new TextEncoder().encode(JSON.stringify(page)).length > 2097152) fail('source_unavailable', 'history_bytes');
  return { session, ...page, throughSeq: through, generation: fence.generation, revision: fence.revision };
}

/** Raw native selected-history producer for one DSH session. The trusted driver injects the owned-endpoint
 * admission (a raw HTTP `session/page` pull and a dedicated cold-follow `session/follow` snapshot stream),
 * the live follow fence and the captured lease authority. This module never builds an endpoint, holds the
 * cookie, or observes the driver's minimal operation/control monitor, so releasing this owner leaves that
 * monitor alive.
 */
export function createDshHistory(options) {
  const { session, authority, current, assertCurrent, fence, pullPage, pullSnapshot, subscribe, randomUUID } = options;
  const nativeSessionId = textValue(session.nativeSessionId, 'dsh.history_session');
  let store, observer, pump, opened = false, closed = false, through = 0, nativeCursor = null, failure;
  const pages = new Set();
  let change = Promise.withResolvers();
  const wake = () => { const previous = change; change = Promise.withResolvers(); previous.resolve(); };
  function awaitChange(signal) {
    const pending = change.promise;
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(new ProtocolError('cancelled', 'dsh.history_read'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ProtocolError('cancelled', 'dsh.history_read'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        () => { signal.removeEventListener('abort', onAbort); resolve(); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }
  function alive(signal) {
    requireValue(!closed, 'dsh.history_closed', 'cancelled');
    requireValue(!signal?.aborted, 'dsh.history_cancelled', 'cancelled');
    requireValue(current(), 'dsh.generation', 'reconcile_required');
  }
  async function fenced(signal) { alive(signal); await assertCurrent(); alive(signal); }
  /** Grammar shared by both native shapes: records live at `<prefix>.records[*]` and each row is an `event`
   * whose `event.seq` is the record identity. `prefix` is `['result','value']` for the raw HTTP
   * `session/page` body (the whole `server-response` envelope) and `['value']` for the cold-follow snapshot,
   * whose raw mux frame carries the payload under `value`.
   * The HTTP page additionally fences every row inside the requested `(before, through]` window; the cold
   * snapshot only fences the envelope and defers the row bound to the captured snapshot cursor, which is not
   * known until the document is tokenized.
   */
  function grammar(prefix, before, throughSeq, captured) {
    return Object.freeze({
      records: Object.freeze([Object.freeze({
        path: Object.freeze([...prefix, 'records', '*']),
        fields: Object.freeze([
          Object.freeze({ name: 'rowType', path: Object.freeze(['type']) }),
          Object.freeze({ name: 'seq', path: Object.freeze(['event', 'seq']) }),
        ]),
        validate(metadata) {
          requireValue(metadata.rowType === 'event', 'dsh.history_record', 'invalid_request');
          const seq = integerValue(metadata.seq, 'dsh.history_seq');
          if (before !== undefined) requireValue(seq <= throughSeq && seq < before, 'dsh.history_bounds', 'invalid_request');
          return String(seq);
        },
      })]),
      fields: Object.freeze([
        Object.freeze({ name: 'hasMore', path: Object.freeze([...prefix, 'hasMore']) }),
        Object.freeze({ name: 'nativeCursor', path: Object.freeze([...prefix, 'cursor']) }),
        Object.freeze({ name: 'headerId', path: Object.freeze([...prefix, 'header', 'id']) }),
      ]),
      validate(metadata) {
        requireValue(typeof metadata.hasMore === 'boolean', 'dsh.history_envelope', 'invalid_request');
        if (metadata.nativeCursor !== undefined) integerValue(metadata.nativeCursor, 'dsh.history_cursor');
        if (metadata.headerId !== undefined) {
          textValue(metadata.headerId, 'dsh.history_header');
          requireValue(metadata.headerId === nativeSessionId, 'dsh.history_scope', 'reconcile_required');
        }
        captured.hasMore = metadata.hasMore;
        captured.nativeCursor = metadata.nativeCursor;
        captured.headerId = metadata.headerId;
      },
    });
  }
  async function open({ signal, streamStore }) {
    requireValue(!opened && !closed, 'dsh.history_open', 'conflict');
    await fenced(signal);
    opened = true; store = streamStore;
    observer = subscribe();
    pump = (async () => {
      try {
        for (;;) {
          const next = await observer.next();
          if (next.done) { failure ??= new ProtocolError('source_unavailable', 'dsh.history_observer_closed'); break; }
          if (next.value !== undefined) { through++; wake(); }
        }
      } catch (error) { failure ??= error instanceof ProtocolError ? error : new ProtocolError('replay_required', 'dsh.history_observer'); }
      finally { wake(); }
    })();
    return { fence: { id: randomUUID(), sourceGeneration: authority.generation } };
  }
  async function page({ cursor, releasePageIds = [], signal }) {
    await fenced(signal);
    requireValue(opened && store, 'dsh.history_open', 'replay_required');
    requireValue(Array.isArray(releasePageIds), 'dsh.history_release');
    for (const id of releasePageIds) {
      textValue(id, 'dsh.history_page');
      requireValue(pages.has(id), 'dsh.history_page_owner', 'unauthorized');
      await store.release(id); pages.delete(id);
    }
    await fenced(signal);
    const requested = cursor === undefined || cursor === null ? null : textValue(cursor, 'dsh.history_cursor');
    requireValue(requested === null || requested === nativeCursor, 'dsh.history_cursor', 'replay_required');
    const snapshot = requested === null;
    let before, throughSeq;
    if (!snapshot) {
      const live = fence();
      before = Number(requested);
      throughSeq = live.cursor;
    }
    const captured = { hasMore: undefined, nativeCursor: undefined, headerId: undefined };
    let pulled, reader, drained = false, released = false, settled;
    const release = () => { if (released) return; released = true; pulled?.release(); };
    const settle = () => {
      settled ??= (async () => {
        release();
        try { if (!drained) await reader?.cancel(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
        try { reader?.releaseLock(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      })();
      return settled;
    };
    const source = (async function* () {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) { drained = true; break; }
          const bytes = next.value;
          for (let offset = 0; offset < bytes.byteLength;) {
            const length = Math.min(DSH_HISTORY_LIMITS.chunkBytes, bytes.byteLength - offset);
            const piece = new Uint8Array(length);
            piece.set(bytes.subarray(offset, offset + length));
            offset += length;
            yield piece;
          }
        }
      } finally { await settle(); }
    })();
    try {
      pulled = snapshot ? await pullSnapshot({ signal }) : await pullPage({ before, through: throughSeq, signal });
      await fenced(signal);
      reader = pulled.body.getReader();
      const output = await store.ingest({ source, cancel: () => { void settle(); }, grammar: grammar(snapshot ? ['value'] : ['result', 'value'], before, throughSeq, captured), signal, maxBytes: DSH_HISTORY_LIMITS.budgetBytes });
      await fenced(signal);
      const rows = output.records;
      let lowest = snapshot ? (captured.nativeCursor ?? 0) + 1 : before;
      for (const row of rows) {
        const seq = Number(row.recordId);
        requireValue(Number.isSafeInteger(seq) && (snapshot ? seq <= (captured.nativeCursor ?? -1) : seq < before && seq <= throughSeq), 'dsh.history_bounds', 'invalid_request');
        lowest = Math.min(lowest, seq);
      }
      if (captured.hasMore && lowest === (snapshot ? (captured.nativeCursor ?? 0) + 1 : before)) fail('replay_required', 'dsh.history_no_progress');
      const next = rows.length === 0 || lowest === 0 ? null : String(lowest);
      requireValue(next === null || next !== requested, 'dsh.history_repeated_cursor', 'replay_required');
      pages.add(output.id);
      nativeCursor = next;
      return {
        pageId: output.id,
        items: rows.map((row) => ({ recordId: row.recordId, kind: 'stream', descriptor: { id: row.id, format: row.format, totalBytes: row.totalBytes, sha256: row.sha256 } })),
        document: { id: output.document.id, format: output.document.format, totalBytes: output.document.totalBytes, sha256: output.document.sha256 },
        cursor: next,
        completeness: next === null ? 'complete' : 'partial',
        reason: snapshot ? 'native-follow-snapshot' : 'native-session-page',
      };
    } catch (error) { await settle(); throw error; }
  }
  async function chunk({ pageId, descriptorId, offset, signal }) {
    await fenced(signal);
    requireValue(opened && store, 'dsh.history_open', 'replay_required');
    textValue(pageId, 'dsh.history_page');
    textValue(descriptorId, 'dsh.history_descriptor');
    integerValue(offset, 'dsh.history_offset');
    requireValue(pages.has(pageId), 'dsh.history_page_owner', 'replay_required');
    const output = await store.read({ pageId, descriptorId, offset });
    await fenced(signal);
    return output;
  }
  async function read({ after, signal }) {
    await fenced(signal);
    requireValue(opened, 'dsh.history_open', 'replay_required');
    integerValue(after, 'dsh.history_after');
    for (;;) {
      if (failure) return { through, changed: false, status: failure.code === 'replay_required' ? 'replay_required' : 'source_unavailable' };
      if (through > after) return { through, changed: true, status: 'current' };
      if (closed || signal?.aborted) throw new ProtocolError('cancelled', 'dsh.history_read');
      await awaitChange(signal);
      await fenced(signal);
    }
  }
  async function close() {
    if (closed) return;
    closed = true; wake();
    const iterator = observer, task = pump;
    observer = undefined; pump = undefined;
    try { await iterator?.return?.(); } catch (error) { if (!(error instanceof TypeError)) throw error; }
    if (task) await task.catch(() => {});
    const owned = [...pages]; pages.clear();
    for (const id of owned) { try { await store?.release(id); } catch (error) { if (!(error instanceof TypeError)) throw error; } }
    store = undefined;
  }
  return Object.freeze({ capabilities: Object.freeze({ archive: 'paged', recordStream: true, live: 'invalidate' }), open, page, chunk, read, close });
}
