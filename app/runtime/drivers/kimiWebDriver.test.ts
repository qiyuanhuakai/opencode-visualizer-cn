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

it('requires the native GET session route for modern session reads', () => {
  const meta = { backend: 'v2', server_version: '2.5.2' };
  const ws = { components: { messages: {} } };
  expect(parseNativeCapabilities(meta, { paths: {} }, ws).sessionRead).toBe(false);
  expect(parseNativeCapabilities(meta, { paths: { '/api/v1/sessions/{session_id}': { post: {} } } }, ws).sessionRead).toBe(false);
  const capabilities = parseNativeCapabilities(meta, { paths: { '/api/v1/sessions/{session_id}': { get: {} } } }, ws);
  expect(capabilities.sessionRead).toBe(true);
  expect(capabilities.snapshot).toBe(false);
});

it('recovers modern transcript cursors per agent without reading or fabricating a legacy snapshot epoch', async () => {
  const { createKimiWebHistory } = await import('../../../bridge/runtime/drivers/kimiWebHistory.js');
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const history = createKimiWebHistory({ legacySnapshot: () => false, transport: {
    async request(_method: string, path: string) {
      calls.push(path);
      await gate;
      return { agent_id: 'main', items: [], has_more: false, interactions: [], attachments: [], prompts: [], agents: [], seq: 5 };
    },
  } });
  history.selected('modern-session');
  const recovering = history.recover('modern-session');
  const frame = { type: 'transcript.ops', session_id: 'modern-session', payload: { agent_id: 'main', seq: 6, ops: [{ op: 'turn.upsert', turn: { kind: 'turn', turnId: 't0', state: 'running' } }] } };
  expect(history.receive(frame, 1)).toBe(false);
  release?.();
  expect(await recovering).toEqual({ cursor: null, recovered: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/transcript?');
  expect(history.cursor('modern-session')).toBeUndefined();
  expect(history.transcriptCursors('modern-session')).toEqual({ main: 6 });
  expect(history.inspect('modern-session').snapshot.items).toMatchObject([{ turnId: 't0' }]);
  history.receive(frame, 1);
  expect(history.inspect('modern-session').snapshot.items).toHaveLength(1);
});

it('limits the modern prompt abort alias to the verified dispatcher profile', () => {
  const spec = { paths: { '/api/v1/sessions/{session_id}/prompts/{tail}': { post: { operationId: 'promptAction' } } } };
  const ws = { components: { messages: {} } };
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.2' }, spec, ws).promptAbort).toBe(true);
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.3' }, spec, ws).promptAbort).toBe(false);
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.2' }, { paths: {} }, ws).promptAbort).toBe(false);
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.2' }, { paths: { '/api/v1/sessions/{session_id}/prompts/{tail}': { post: { operationId: 'otherAction' } } } }, ws).promptAbort).toBe(false);
});
