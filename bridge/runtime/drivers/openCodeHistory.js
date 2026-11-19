import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { ProtocolError, requireValue, textValue, integerValue } from '../../../shared/runtime/capabilities.js';

export const OPEN_CODE_HISTORY_LIMITS = Object.freeze({ page: 200, chunkBytes: 65536 });
/** Native events that change the selected session's message inventory or its settled content. */
const INVALIDATION = Object.freeze(['message.updated', 'message.removed', 'message.part.removed', 'session.idle', 'session.error', 'session.deleted']);

/** Raw native HTTP history producer for one selected session. The trusted driver injects request admission,
 * the current fence, the native subscription bus and the captured authority; this module never builds an
 * endpoint, holds credentials or observes any other session.
 */
export function createOpenCodeHistory(options) {
  const { session, authority, current, assertCurrent, subscribe, pull, randomUUID } = options;
  const key = encodeSessionKey(session);
  const nativeSessionId = textValue(session.nativeSessionId, 'opencode.history_session');
  let store, observer, pump, opened = false, closed = false, through = 0, nativeCursor = null, failure;
  const pages = new Set();
  let change = Promise.withResolvers();
  const wake = () => { const previous = change; change = Promise.withResolvers(); previous.resolve(); };
  function awaitChange(signal) {
    const pending = change.promise;
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(new ProtocolError('cancelled', 'opencode.history_read'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ProtocolError('cancelled', 'opencode.history_read'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        () => { signal.removeEventListener('abort', onAbort); resolve(); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }
  function alive(signal) {
    requireValue(!closed, 'opencode.history_closed', 'cancelled');
    requireValue(!signal?.aborted, 'opencode.history_cancelled', 'cancelled');
    requireValue(current(), 'opencode.generation', 'reconcile_required');
  }
  async function fenced(signal) { alive(signal); await assertCurrent(); alive(signal); }
  const grammar = Object.freeze({
    records: Object.freeze([Object.freeze({
      path: Object.freeze(['*']),
      fields: Object.freeze([Object.freeze({ name: 'id', path: Object.freeze(['info', 'id']) }), Object.freeze({ name: 'sessionID', path: Object.freeze(['info', 'sessionID']) })]),
      validate(metadata) {
        requireValue(metadata.sessionID === nativeSessionId, 'opencode.history_scope', 'reconcile_required');
        return textValue(metadata.id, 'opencode.history_message_id');
      },
    })]),
    fields: Object.freeze([]),
    validate() {},
  });
  async function open({ signal, streamStore }) {
    requireValue(!opened && !closed, 'opencode.history_open', 'conflict');
    await fenced(signal);
    opened = true; store = streamStore;
    observer = subscribe((event) => event?.type !== undefined && INVALIDATION.includes(event.type) && event.session !== undefined && encodeSessionKey(event.session) === key);
    pump = (async () => {
      try {
        for (;;) {
          const next = await observer.next();
          if (next.done) { failure ??= new ProtocolError('source_unavailable', 'opencode.history_observer_closed'); break; }
          if (next.value !== undefined) { through++; wake(); }
        }
      } catch (error) { failure ??= error instanceof ProtocolError ? error : new ProtocolError('replay_required', 'opencode.history_observer'); }
      finally { wake(); }
    })();
    return { fence: { id: randomUUID(), sourceGeneration: authority.processGeneration } };
  }
  async function page({ cursor, releasePageIds = [], signal }) {
    await fenced(signal);
    requireValue(opened && store, 'opencode.history_open', 'replay_required');
    requireValue(Array.isArray(releasePageIds), 'opencode.history_release');
    for (const id of releasePageIds) {
      textValue(id, 'opencode.history_page');
      requireValue(pages.has(id), 'opencode.history_page_owner', 'unauthorized');
      await store.release(id); pages.delete(id);
    }
    await fenced(signal);
    const before = cursor === undefined || cursor === null ? null : textValue(cursor, 'opencode.history_cursor');
    requireValue(before === null || before === nativeCursor, 'opencode.history_cursor', 'replay_required');
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
            const length = Math.min(OPEN_CODE_HISTORY_LIMITS.chunkBytes, bytes.byteLength - offset);
            const piece = new Uint8Array(length);
            piece.set(bytes.subarray(offset, offset + length));
            offset += length;
            yield piece;
          }
        }
      } finally { await settle(); }
    })();
    try {
      pulled = await pull({ before, signal });
      await fenced(signal);
      reader = pulled.body.getReader();
      const next = pulled.cursor;
      if (next !== null && next !== undefined) {
        textValue(next, 'opencode.history_native_cursor');
        requireValue(next !== before, 'opencode.history_repeated_cursor', 'replay_required');
      }
      const output = await store.ingest({ source, cancel: () => { void settle(); }, grammar, signal });
      await fenced(signal);
      requireValue(next === null || output.records.length > 0, 'opencode.history_empty_progress', 'reconcile_required');
      pages.add(output.id);
      nativeCursor = next ?? null;
      return {
        pageId: output.id,
        items: output.records.map((record) => ({ recordId: record.recordId, kind: 'stream', descriptor: { id: record.id, format: record.format, totalBytes: record.totalBytes, sha256: record.sha256 } })),
        document: { id: output.document.id, format: output.document.format, totalBytes: output.document.totalBytes, sha256: output.document.sha256 },
        cursor: nativeCursor,
        completeness: nativeCursor === null ? 'complete' : 'partial',
        reason: 'native-http-message-page',
      };
    } catch (error) { await settle(); throw error; }
  }
  async function chunk({ pageId, descriptorId, offset, signal }) {
    await fenced(signal);
    requireValue(opened && store, 'opencode.history_open', 'replay_required');
    textValue(pageId, 'opencode.history_page');
    textValue(descriptorId, 'opencode.history_descriptor');
    integerValue(offset, 'opencode.history_offset');
    requireValue(pages.has(pageId), 'opencode.history_page_owner', 'replay_required');
    const output = await store.read({ pageId, descriptorId, offset });
    await fenced(signal);
    return output;
  }
  async function read({ after, signal }) {
    await fenced(signal);
    requireValue(opened, 'opencode.history_open', 'replay_required');
    integerValue(after, 'opencode.history_after');
    for (;;) {
      if (failure) return { through, changed: false, status: failure.code === 'replay_required' ? 'replay_required' : 'source_unavailable' };
      if (through > after) return { through, changed: true, status: 'current' };
      if (closed || signal?.aborted) throw new ProtocolError('cancelled', 'opencode.history_read');
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
