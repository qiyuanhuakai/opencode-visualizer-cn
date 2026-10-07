import { fail, record, integer } from './protocol.js';
export function createFollowState() {
  let generation = 0, revision = 0, cursor = -1, version, phase = 'rebuilding';
  return {
    inspect: () => ({ generation, revision, cursor, version, phase }),
    disconnect() { generation++; revision++; phase = 'degraded'; },
    rebuild() { generation++; revision++; phase = 'rebuilding'; return generation; },
    ingest(value, capturedGeneration) {
      if (capturedGeneration !== generation) return { action: 'drop' };
      const frame = record(value);
      if (frame.type === 'snapshot') {
        integer(frame.cursor, -1); record(frame.header);
        if (!Array.isArray(frame.records) || typeof frame.hasMore !== 'boolean') fail('invalid_request', 'snapshot');
        if (phase === 'live' && version === frame.header.version && frame.cursor < cursor) return { action: 'drop' };
        cursor = frame.cursor; version = frame.header.version; phase = 'live'; revision++;
        return { action: 'snapshot', value: frame };
      }
      if (phase !== 'live') fail('replay_required', 'snapshot_required');
      if (frame.type === 'event') {
        const seq = integer(record(frame.event).seq);
        if (seq <= cursor) return { action: 'drop' };
        if (seq !== cursor + 1) { phase = 'degraded'; revision++; fail('replay_required', 'sequence_gap'); }
        cursor = seq;
      } else if (frame.type !== 'assistant-stream') fail('invalid_request', 'follow_frame');
      revision++;
      return { action: 'event', value: frame };
    },
    historyFence() {
      if (phase !== 'live') fail('replay_required', 'snapshot_required');
      return { generation, revision, cursor };
    },
    assertHistory(fence) {
      if (fence.generation !== generation || fence.revision !== revision || phase !== 'live') fail('replay_required', 'history_stale');
    },
  };
}
export function historyPage(value, throughSeq, beforeSeq, limit) {
  record(value);
  if (!Array.isArray(value.records) || typeof value.hasMore !== 'boolean') fail('invalid_request', 'history');
  integer(limit, 1, 200);
  const records = value.records.slice(-limit);
  let lowest = beforeSeq; const seen = new Set();
  for (const row of value.records) {
    if (record(row).type !== 'event') fail('invalid_request', 'history_record');
    const seq = integer(record(row.event).seq);
    if (seq > throughSeq || seq >= beforeSeq || seen.has(seq)) fail('invalid_request', 'history_bounds');
    seen.add(seq);
  }
  for (const row of records) lowest = Math.min(lowest, row.event.seq);
  if (value.hasMore && lowest === beforeSeq) fail('replay_required', 'history_no_progress');
  return { records, nativeHasMore: value.hasMore, cursor: lowest === 0 || value.records.length === 0 ? null : lowest,
    completeness: lowest === 0 || value.records.length === 0 ? 'complete' : 'partial' };
}
