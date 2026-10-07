import { integer, fail } from '../../../shared/runtime/native/dsh/protocol.js';
import { historyPage } from '../../../shared/runtime/native/dsh/follow.js';
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
