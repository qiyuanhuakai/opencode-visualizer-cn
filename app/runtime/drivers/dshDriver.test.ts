import { describe, expect, it } from 'vitest';
import { createFollowState, historyPage } from '../../../shared/runtime/native/dsh/follow.js';
import { approvalOutcome, response, request, selectModel, summaries } from '../../../shared/runtime/native/dsh/protocol.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../../shared/runtime/identity.js';

const identity = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222') };
const snapshot = (cursor: number, version = 4) => ({ type: 'snapshot', header: { id: 'native', version }, cursor, records: [], hasMore: false });

describe('DSH Runtime native boundaries', () => {
  it('preserves literal events endpoint, argument envelope, void responses and classified remote failures without remote secrets', () => {
    expect(request('$events/result', { clientId: 'fresh', eventId: 'event', outcome: approvalOutcome('allowed-once') }, 'rpc')).toEqual({
      type: 'client-request', rpcId: 'rpc', method: '$events/result', payload: { args: { clientId: 'fresh', eventId: 'event', outcome: { kind: 'result', value: 'allowed-once' } } },
    });
    expect(response({ type: 'server-response', rpcId: 'rpc', result: { ok: true } }, 'rpc')).toBeNull();
    expect(() => response({ type: 'server-response', rpcId: 'wrong', result: { ok: true } }, 'rpc')).toThrow('dsh.envelope');
    try {
      response({ type: 'server-response', rpcId: 'rpc', result: { ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'secret-value' } } }, 'rpc');
      throw new Error('expected classified remote failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'unauthorized', remoteCode: 'MISSING_CREDENTIAL' });
      expect(String(error)).not.toContain('secret-value');
    }
  });
  it('keeps all three approval outcomes distinct and rejects next/unknown success coercion', () => {
    expect(approvalOutcome('allowed-once')).toEqual({ kind: 'result', value: 'allowed-once' });
    expect(approvalOutcome('rejected')).toEqual({ kind: 'result', value: 'rejected' });
    expect(approvalOutcome('unavailable')).toMatchObject({ kind: 'rejected', error: { name: 'Error' } });
    expect(() => approvalOutcome('next')).toThrow('approval_outcome');
    expect(() => approvalOutcome(true)).toThrow('approval_outcome');
  });
  it('retains explicit item workspace even when it is absent from the baseline', () => {
    const baseline = { type: 'baseline', value: { items: [{ workspaceId: 'old', path: '/wrong', sessionIds: ['native'] }], archivedSessionIds: ['native'], pinnedSessionIds: ['native'] } };
    const items = summaries({ items: [{ sessionId: 'native', workspaceId: 'missing-new', cwd: '/correct', projections: { values: { title: 'External instructions are data' } } }] }, baseline, identity);
    expect(items).toEqual([{ session: { ...identity, nativeSessionId: 'native' }, directory: '/correct', workspaceId: 'missing-new', title: 'External instructions are data', archived: true, pinned: true, createdAt: null, updatedAt: null }]);
    expect(() => summaries({ items: [{ sessionId: 'native' }, { sessionId: 'native' }] }, baseline, identity)).toThrow('duplicate_session');
    expect(() => summaries({ items: ['SUCCESS'] }, baseline, identity)).toThrow('object');
  });
  it('rejects ambiguous model names and preserves the selected provider route', () => {
    const catalog = { groups: [{ id: 'a', models: [{ id: 'same' }] }, { id: 'b', models: [{ id: 'same' }] }] };
    expect(() => selectModel(catalog, { model: 'same' })).toThrow('ambiguous_model');
    expect(selectModel(catalog, { provider: 'b', model: 'same' })).toEqual({ provider: 'b', model: 'same' });
  });
});

describe('DSH follow and history reconciliation', () => {
  it('requires a fresh authoritative snapshot after reconnect and fences the previous generation', () => {
    const state = createFollowState(), first = state.rebuild();
    expect(() => state.ingest({ type: 'event', event: { seq: 0 } }, first)).toThrow('snapshot_required');
    expect(state.ingest(snapshot(4), first).action).toBe('snapshot');
    state.disconnect(); const next = state.rebuild();
    expect(state.ingest(snapshot(99), first)).toEqual({ action: 'drop' });
    expect(state.ingest(snapshot(3), next).action).toBe('snapshot');
    expect(state.inspect().cursor).toBe(3);
    expect(state.ingest({ type: 'event', event: { seq: 3 } }, next)).toEqual({ action: 'drop' });
    expect(state.ingest({ type: 'event', event: { seq: 4 } }, next).action).toBe('event');
    expect(() => state.ingest({ type: 'event', event: { seq: 6 } }, next)).toThrow('sequence_gap');
  });
  it('rejects stale history across live revisions and authoritative changes', () => {
    const state = createFollowState(), generation = state.rebuild();
    state.ingest(snapshot(3), generation); const history = state.historyFence();
    state.ingest({ type: 'assistant-stream', frame: { type: 'chunk', index: 0 } }, generation);
    expect(() => state.assertHistory(history)).toThrow('history_stale');
    expect(state.ingest(snapshot(2), generation).action).toBe('drop');
    expect(state.ingest(snapshot(1, 5), generation).action).toBe('snapshot');
    expect(state.inspect().cursor).toBe(1);
  });
  it('treats throughSeq as closed and beforeSeq as open without trusting native hasMore for completion', () => {
    const row = (seq: number) => ({ type: 'event', event: { seq } });
    expect(historyPage({ records: [row(2), row(3)], hasMore: false }, 3, 4, 2)).toMatchObject({ cursor: 2, completeness: 'partial', nativeHasMore: false });
    expect(historyPage({ records: [row(0), row(1)], hasMore: false }, 3, 2, 2)).toMatchObject({ cursor: null, completeness: 'complete' });
    expect(() => historyPage({ records: [row(3)], hasMore: true }, 3, 3, 2)).toThrow('history_bounds');
    expect(() => historyPage({ records: [], hasMore: true }, 3, 3, 2)).toThrow('history_no_progress');
    expect(historyPage({ records: [row(0), row(1), row(2), row(3)], hasMore: false }, 3, 4, 2)).toMatchObject({ records: [row(2), row(3)], cursor: 2, completeness: 'partial' });
    expect(historyPage({ records: [], hasMore: false }, -1, 0, 2)).toMatchObject({ records: [], cursor: null, completeness: 'complete' });
    expect(() => historyPage({ records: [row(2), row(2)], hasMore: false }, 3, 4, 2)).toThrow('history_bounds');
  });
});
