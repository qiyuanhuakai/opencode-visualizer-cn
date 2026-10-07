import { ProtocolError } from '../../../shared/runtime/capabilities.js';
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
