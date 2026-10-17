import { describe, expect, it } from 'vitest';
import { applyTranscriptOps, transcriptSnapshot } from '../../../shared/runtime/native/kimiWeb/transcript.js';
import {
  parseCatalogPage,
  recoverSnapshotFrames,
  updateDurableCursor,
  parseNativeCapabilities,
} from '../../../shared/runtime/native/kimiWeb/protocol.js';

describe('Kimi Runtime protocol boundaries', () => {
  it('rejects a nonadvancing opaque native catalog cursor', () => {
    expect(() => parseCatalogPage({ items: [], has_more: true, next_page_token: 'same' }, 'same', 100))
      .toThrow('catalog_cursor');
  });
  it('does not advance durable cursors for live transcript or assistant deltas', () => {
    expect(updateDurableCursor({ epoch: 'e', seq: 4 }, { type: 'assistant.delta', session_id: 's', epoch: 'e', seq: 9, volatile: true }))
      .toEqual({ epoch: 'e', seq: 4 });
  });
  it('preserves the uncovered same-sequence volatile suffix at an authoritative snapshot boundary', () => {
    expect(recoverSnapshotFrames({ epoch: 'e', as_of_seq: 4, in_flight_turn: { assistant_text: 'hello ', thinking_text: '' } }, [
      { type: 'assistant.delta', epoch: 'e', seq: 4, volatile: true, offset: 0, payload: { delta: 'hello world' } },
      { type: 'turn.ended', epoch: 'e', seq: 5, payload: { reason: 'completed' } },
    ])).toEqual([
      { type: 'assistant.delta', epoch: 'e', seq: 4, volatile: true, payload: { delta: 'world' } },
      { type: 'turn.ended', epoch: 'e', seq: 5, payload: { reason: 'completed' } },
    ]);
  });
  it('retains steps produced earlier in the same native operation batch', () => {
    const state = applyTranscriptOps(transcriptSnapshot({ items: [], tasks: [] }), [
      { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't0', state: 'running' } },
      { op: 'step.upsert', turnId: 't0', step: { kind: 'step', stepId: 't0.1', state: 'running' } },
      { op: 'frame.upsert', turnId: 't0', stepId: 't0.1', frame: { kind: 'text', frameId: 'text', text: 'retained' } },
      { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't0', state: 'completed' } },
    ]);
    expect(state.items).toMatchObject([{ turnId: 't0', state: 'completed', steps: [{ frames: [{ text: 'retained' }] }] }]);
  });
  it('merges native agent metadata patches and clears explicitly removed modes', () => {
    const state = applyTranscriptOps(transcriptSnapshot({ items: [], tasks: [], meta: { goal: 'prior', agent: { model: 'local/model', phase: { kind: 'running' } }, modes: { plan: { active: true }, swarm: { active: true } } } }), [
      { op: 'meta.merge', meta: { agent: { phase: { kind: 'ended' } }, goal: null, modes: { plan: null } } },
    ]);
    expect(state.meta).toEqual({ agent: { model: 'local/model', phase: { kind: 'ended' } }, modes: { swarm: { active: true } } });
  });
  it('limits the undocumented abort alias to the native profile actually verified', () => {
    const spec = { paths: { '/api/v1/sessions/{session_id}:archive': { post: { operationId: 'runSessionArchiveAction' } } } };
    const ws = { components: { messages: {} } };
    expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.1.1' }, spec, ws).cancel).toBe(true);
    expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.1.2' }, spec, ws).cancel).toBe(false);
  });
  it('never enables native operations from an unknown capability or version alone', () => {
    expect(parseNativeCapabilities({ backend: 'v2', capabilities: { websocket: true } }, { paths: {} }, { components: { messages: {} } }).subscribeV2)
      .toBe(false);
  });
});
