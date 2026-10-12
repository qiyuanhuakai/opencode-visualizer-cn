import { ProtocolError, requireValue, integerValue } from '../../../shared/runtime/capabilities.js';
import { nativeInteger, nativeText, record, updateDurableCursor, recoverSnapshotFrames } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import { transcriptPage, transcriptSnapshot, applyTranscriptOps, mergeOlderTranscript } from '../../../shared/runtime/native/kimiWeb/transcript.js';

const MAX_BYTES = 16777216;
const MAX_RECOVERY_BYTES = 4194304;
const empty = () => transcriptSnapshot({ items: [], tasks: [], meta: {} });
export function createKimiWebHistory({ transport, onRecovered = () => {} }) {
  const sessions = new Map();
  function selected(sessionId, agentId = 'main') {
    nativeText(sessionId, 'session_id', 512);
    nativeText(agentId, 'agent_id', 128);
    if (!/^[A-Za-z0-9_.-]+$/u.test(agentId)) throw new ProtocolError('invalid_request', 'agent_id');
    let session = sessions.get(sessionId);
    if (!session) {
      if (sessions.size >= 32) throw new ProtocolError('source_unavailable', 'selected_session_limit');
      session = { agents: new Map(), cursor: undefined, recovering: undefined, buffer: [], bytes: 0, version: 0, failure: undefined };
      sessions.set(sessionId, session);
    }
    let agent = session.agents.get(agentId);
    if (!agent) {
      if (session.agents.size >= 16) throw new ProtocolError('source_unavailable', 'selected_agent_limit');
      agent = { snapshot: empty(), seq: undefined, connection: 0, offsets: new Map() };
      session.agents.set(agentId, agent);
    }
    return { session, agent };
  }
  function budget() {
    let bytes = 0;
    for (const session of sessions.values()) for (const agent of session.agents.values()) bytes += Buffer.byteLength(JSON.stringify(agent.snapshot));
    if (bytes > MAX_BYTES) throw new ProtocolError('replay_required', 'history_budget');
  }
  function receive(frame, connection, replay = false) {
    const session = sessions.get(frame.session_id);
    if (!session) return false;
    if (session.recovering && !replay) {
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (session.bytes + bytes > MAX_RECOVERY_BYTES || session.buffer.length >= 2048) {
        session.failure = new ProtocolError('replay_required', 'recovery_buffer');
        throw session.failure;
      }
      session.bytes += bytes; session.buffer.push({ frame, connection });
      return false;
    }
    if (session.cursor && frame.epoch && session.cursor.epoch !== frame.epoch)
      throw new ProtocolError('replay_required', 'native_epoch_changed');
    if (frame.volatile !== true && frame.seq !== undefined && session.cursor?.seq >= frame.seq) return false;
    const payload = frame.payload ?? {};
    const agentId = payload.agent_id ?? payload.agentId ?? 'main';
    const agent = session.agents.get(agentId);
    if (agent && (frame.type === 'transcript.reset' || frame.type === 'transcript.ops')) {
      const seq = nativeInteger(payload.seq, 'transcript_seq');
      if (agent.seq !== undefined && seq < agent.seq) return false;
      if (frame.type === 'transcript.ops' && seq === agent.seq) return false;
      const next = frame.type === 'transcript.reset'
        ? transcriptSnapshot(payload.snapshot)
        : applyTranscriptOps(agent.snapshot, payload.ops);
      const prior = agent.snapshot;
      agent.snapshot = next;
      try { budget(); } catch (error) { agent.snapshot = prior; throw error; }
      agent.seq = seq;
    } else if (agent && frame.volatile === true && frame.offset !== undefined) {
      if (agent.connection !== connection) { agent.connection = connection; agent.offsets.clear(); }
      const key = `${frame.type}:${payload.agent_id ?? payload.agentId ?? 'main'}`;
      if ((agent.offsets.get(key) ?? -1) >= frame.offset) return false;
      agent.offsets.set(key, frame.offset);
    }
    session.cursor = updateDurableCursor(session.cursor, frame);
    session.version++;
    return true;
  }
  async function read(sessionId, { agentId = 'main', cursor, limit = 100, signal } = {}) {
    const { session, agent } = selected(sessionId, agentId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProtocolError('invalid_request', 'transcript_native_page_size');
    if (cursor !== undefined) nativeText(cursor, 'transcript_cursor', 512);
    const epoch = session.cursor?.epoch;
    const query = new URLSearchParams({ agent_id: agentId, page_size: String(limit), ...(cursor ? { before_turn: cursor } : {}) });
    const value = await transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?${query}`, undefined, signal);
    const page = transcriptPage(value, cursor);
    if (epoch !== session.cursor?.epoch && epoch !== undefined) throw new ProtocolError('replay_required', 'history_epoch_changed');
    const previous = agent.snapshot;
    if (cursor) {
      const merged = mergeOlderTranscript(agent.snapshot, page);
      // Only three selected pages are resident. The native cursor still permits the caller to page/export everything.
      agent.snapshot = { ...merged, items: merged.items.slice(-300) };
    } else if (agent.seq === undefined || page.seq >= agent.seq) {
      agent.snapshot = transcriptSnapshot(page); agent.seq = page.seq;
    }
    try { budget(); } catch (error) { agent.snapshot = previous; throw error; }
    return {
      agentId, items: cursor ? page.items : agent.snapshot.items,
      tasks: agent.snapshot.tasks, interactions: agent.snapshot.interactions, agents: page.agents,
      metadata: agent.snapshot.meta, cursor: page.cursor, completeness: page.completeness,
      transcriptSeq: agent.seq, durableCursor: session.cursor ?? null,
    };
  }
  async function recover(sessionId) {
    const { session } = selected(sessionId);
    if (session.recovering) return session.recovering;
    session.buffer = []; session.bytes = 0; session.failure = undefined;
    session.recovering = (async () => {
      const snapshot = record(await transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`), 'native_snapshot');
      const epoch = nativeText(snapshot.epoch, 'native_epoch', 512);
      const seq = nativeInteger(snapshot.as_of_seq, 'native_sequence');
      const pages = [];
      for (const [agentId] of session.agents) {
        const query = new URLSearchParams({ agent_id: agentId, page_size: '100' });
        const page = transcriptPage(await transport.request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?${query}`));
        pages.push([agentId, page]);
      }
      if (session.failure) throw session.failure;
      if (session.buffer.some(({ frame }) => frame.epoch && frame.epoch !== epoch)) throw new ProtocolError('replay_required', 'recovery_epoch_changed');
      const prior = new Map([...session.agents].map(([key, agent]) => [key, { snapshot: agent.snapshot, seq: agent.seq }]));
      for (const [agentId, page] of pages) { const agent = session.agents.get(agentId); agent.snapshot = transcriptSnapshot(page); agent.seq = page.seq; agent.offsets.clear(); }
      try { budget(); } catch (error) { for (const [key, value] of prior) Object.assign(session.agents.get(key), value); throw error; }
      session.cursor = { epoch, seq };
      const buffered = session.buffer;
      const recovered = recoverSnapshotFrames(snapshot, buffered.map(({ frame }) => frame));
      for (const frame of recovered) receive(frame, buffered.at(-1)?.connection ?? 0, true);
      session.version++;
      onRecovered(sessionId, { cursor: session.cursor, buffered: buffered.length });
      return { cursor: session.cursor, recovered: true };
    })();
    try { return await session.recovering; }
    finally { session.recovering = undefined; session.buffer = []; session.bytes = 0; }
  }
  return {
    selected, receive, read, recover,
    cursor: (sessionId) => sessions.get(sessionId)?.cursor,
    transcriptCursors: (sessionId) => Object.fromEntries([...(sessions.get(sessionId)?.agents ?? [])].filter(([, agent]) => agent.seq !== undefined).map(([id, agent]) => [id, agent.seq])),
    inspect: (sessionId, agentId = 'main') => {
      const { session, agent } = selected(sessionId, agentId);
      return { cursor: session.cursor ?? null, transcriptSeq: agent.seq ?? null, snapshot: structuredClone(agent.snapshot), recovering: !!session.recovering };
    },
    clear: () => sessions.clear(),
  };
}

export const KIMI_WEB_HISTORY_LIMITS = Object.freeze({ page: 200, chunkBytes: 65536 });
/** Native events that change the selected session's transcript inventory or its settled content. */
const INVALIDATION = Object.freeze(['transcript.reset', 'transcript.ops', 'replay_required', 'resynchronized']);

/** Raw native transcript producer for one selected session and agent. The trusted driver injects request
 * admission, the current fence, the captured authority, the native subscription bus and the owner release;
 * this module never builds an endpoint, holds credentials or observes any other session.
 */
export function createKimiWebHistoryProducer(options) {
  const { session, authority, current, assertCurrent, pull, subscribe, releaseOwner, sessionEpoch, randomUUID } = options;
  const nativeSessionId = nativeText(session.nativeSessionId, 'kimi.history_session', 512);
  let store, observer, pump, opened = false, closed = false, through = 0, nativeCursor = null, failure;
  const pages = new Set();
  let change = Promise.withResolvers();
  const wake = () => { const previous = change; change = Promise.withResolvers(); previous.resolve(); };
  function awaitChange(signal) {
    const pending = change.promise;
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(new ProtocolError('cancelled', 'kimi.history_read'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ProtocolError('cancelled', 'kimi.history_read'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        () => { signal.removeEventListener('abort', onAbort); resolve(); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }
  function alive(signal) {
    requireValue(!closed, 'kimi.history_closed', 'cancelled');
    requireValue(!signal?.aborted, 'kimi.history_cancelled', 'cancelled');
    requireValue(current(), 'kimi.generation', 'reconcile_required');
  }
  async function fenced(signal) { alive(signal); await assertCurrent(); alive(signal); }
  let envelope;
  const grammar = Object.freeze({
    records: Object.freeze([Object.freeze({
      path: Object.freeze(['items', '*']),
      fields: Object.freeze([
        Object.freeze({ name: 'turnId', path: Object.freeze(['turnId']) }),
        Object.freeze({ name: 'markerId', path: Object.freeze(['markerId']) }),
        Object.freeze({ name: 'refId', path: Object.freeze(['refId']) }),
      ]),
      validate(metadata) {
        if (metadata.turnId !== undefined) return `turn:${nativeText(metadata.turnId, 'kimi.history_turn_id', 512)}`;
        if (metadata.markerId !== undefined) return `marker:${nativeText(metadata.markerId, 'kimi.history_marker_id', 512)}`;
        if (metadata.refId !== undefined) return `ref:${nativeText(metadata.refId, 'kimi.history_ref_id', 512)}`;
        throw new ProtocolError('replay_required', 'kimi.history_record_identity');
      },
    })]),
    fields: Object.freeze([
      Object.freeze({ name: 'hasMore', path: Object.freeze(['has_more']) }),
      Object.freeze({ name: 'seq', path: Object.freeze(['seq']) }),
      Object.freeze({ name: 'epoch', path: Object.freeze(['epoch']) }),
    ]),
    validate(metadata) {
      requireValue(typeof metadata.hasMore === 'boolean', 'kimi.history_has_more');
      integerValue(metadata.seq, 'kimi.history_native_seq');
      const epoch = metadata.epoch === undefined ? undefined : nativeText(metadata.epoch, 'kimi.history_native_epoch', 512);
      const known = sessionEpoch();
      if (epoch !== undefined && known !== undefined && known !== epoch) throw new ProtocolError('replay_required', 'kimi.history_epoch_changed');
      envelope = Object.freeze({ hasMore: metadata.hasMore, seq: metadata.seq, epoch: epoch ?? null });
    },
  });
  async function open({ signal, streamStore }) {
    requireValue(!opened && !closed, 'kimi.history_open', 'conflict');
    await fenced(signal);
    opened = true; store = streamStore;
    observer = subscribe((event) => event?.type !== undefined && INVALIDATION.includes(event.type) && event.session?.nativeSessionId === nativeSessionId);
    pump = (async () => {
      try {
        for (;;) {
          const next = await observer.next();
          if (next.done) { failure ??= new ProtocolError('source_unavailable', 'kimi.history_observer_closed'); break; }
          if (next.value !== undefined) { through++; wake(); }
        }
      } catch (error) { failure ??= error instanceof ProtocolError ? error : new ProtocolError('replay_required', 'kimi.history_observer'); }
      finally { wake(); }
    })();
    return { fence: { id: randomUUID(), sourceGeneration: authority.epoch } };
  }
  async function page({ cursor, releasePageIds = [], signal }) {
    await fenced(signal);
    requireValue(opened && store, 'kimi.history_open', 'replay_required');
    requireValue(Array.isArray(releasePageIds), 'kimi.history_release');
    for (const id of releasePageIds) {
      nativeText(id, 'kimi.history_page', 512);
      requireValue(pages.has(id), 'kimi.history_page_owner', 'unauthorized');
      await store.release(id); pages.delete(id);
    }
    await fenced(signal);
    const before = cursor === undefined || cursor === null ? null : nativeText(cursor, 'kimi.history_cursor', 512);
    requireValue(before === null || before === nativeCursor, 'kimi.history_cursor', 'replay_required');
    envelope = undefined;
    let pulled;
    try {
      pulled = await pull({ before, signal });
      await fenced(signal);
      let released = false;
      const release = () => { if (released) return; released = true; pulled?.release(); };
      const source = (async function* () {
        try { for await (const piece of pulled.body) yield piece; }
        finally { release(); }
      })();
      const output = await store.ingest({ source, cancel: () => release(), grammar, signal });
      await fenced(signal);
      requireValue(envelope !== undefined, 'kimi.history_envelope', 'replay_required');
      const boundary = output.records.find((record) => record.recordId.startsWith('turn:'));
      if (envelope.hasMore) {
        requireValue(boundary !== undefined, 'kimi.history_cursor', 'replay_required');
        requireValue(boundary.recordId.slice(5) !== before, 'kimi.history_repeated_cursor', 'replay_required');
      }
      pages.add(output.id);
      nativeCursor = envelope.hasMore ? boundary.recordId.slice(5) : null;
      return {
        pageId: output.id,
        items: output.records.map((record) => ({ recordId: record.recordId, kind: 'stream', descriptor: { id: record.id, format: record.format, totalBytes: record.totalBytes, sha256: record.sha256 } })),
        document: { id: output.document.id, format: output.document.format, totalBytes: output.document.totalBytes, sha256: output.document.sha256 },
        cursor: nativeCursor,
        completeness: nativeCursor === null ? 'complete' : 'partial',
        reason: 'native-transcript-page',
      };
    } catch (error) { pulled?.release(); throw error; }
  }
  async function chunk({ pageId, descriptorId, offset, signal }) {
    await fenced(signal);
    requireValue(opened && store, 'kimi.history_open', 'replay_required');
    nativeText(pageId, 'kimi.history_page', 512);
    nativeText(descriptorId, 'kimi.history_descriptor', 512);
    integerValue(offset, 'kimi.history_offset');
    requireValue(pages.has(pageId), 'kimi.history_page_owner', 'replay_required');
    const output = await store.read({ pageId, descriptorId, offset });
    await fenced(signal);
    return output;
  }
  async function read({ after, signal }) {
    await fenced(signal);
    requireValue(opened, 'kimi.history_open', 'replay_required');
    integerValue(after, 'kimi.history_after');
    for (;;) {
      if (failure) return { through, changed: false, status: failure.code === 'replay_required' ? 'replay_required' : 'source_unavailable' };
      if (through > after) return { through, changed: true, status: 'current' };
      if (closed || signal?.aborted) throw new ProtocolError('cancelled', 'kimi.history_read');
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
    await releaseOwner?.();
  }
  return Object.freeze({ capabilities: Object.freeze({ archive: 'paged', recordStream: true, live: 'invalidate' }), open, page, chunk, read, close });
}
