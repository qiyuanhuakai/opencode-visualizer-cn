import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, encodeBinary, decodeBinary, ProtocolError, createProtocolState } from '../shared/runtime/protocol.js';
import { parseCapabilities, authorizeExtension } from '../shared/runtime/capabilities.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../shared/runtime/identity.js';
const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const other = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const binding = { target, epoch: 'epoch-1', generation: 1 };
const request = { kind: 'request', version: 1, ...binding, id: 'r1', method: 'session.send', params: { text: 'hello' }, idempotencyKey: 'intent-1' };
const accepted = { kind: 'result', version: 1, ...binding, id: 'r1', ok: true, phase: 'durable-accepted', result: { operationId: 'op-1' } };
const executed = { ...accepted, phase: 'native-executed', result: { text: 'done' } };
const event = { kind: 'event', version: 1, ...binding, seq: 1, entityRevision: 8, scope: 'session', type: 'updated', payload: { text: 'hello 世界' } };
const hello = { kind: 'hello', version: 1, ...binding, instanceId: other, capabilities: { methods: ['session.send'], extensions: [] } };
function rejects(value: unknown, code = 'invalid_request') {
  expect(() => encodeFrame(value)).toThrow(expect.objectContaining({ code }));
}
describe('runtime protocol', () => {
  it('roundtrips request, accepted/executed result, event and hello with shared validators', () => {
    for (const frame of [request, accepted, executed, event, hello]) expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    expect(() => decodeFrame('{')).toThrow(ProtocolError);
  });
  it('roundtrips binary bytes with channel, offset and exact length', () => {
    const chunk = { channelId: 7, offset: 65536, data: new Uint8Array([0, 255, 42]) };
    expect(decodeBinary(encodeBinary(chunk))).toEqual({ ...chunk, length: 3 });
  });
  it('preserves unknown native extension declarations while requiring owner and permission', () => {
    const extension = { owner: other, name: 'future.native', permission: 'session:write', schemaVersion: 42, metadata: { future: ['x'] } };
    const capabilities = parseCapabilities({ methods: ['session.send'], extensions: [extension] });
    expect(capabilities.extensions).toEqual([extension]);
    expect(authorizeExtension(capabilities, { owner: other, name: 'future.native', permissions: ['session:write'] })).toEqual(extension);
    expect(() => authorizeExtension(capabilities, { owner: other, name: 'future.native', permissions: [] })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });
  it('correlates accepted then executed and advances event cursor', () => {
    const state = createProtocolState(binding);
    state.register(request);
    expect(state.receive(accepted)).toEqual(accepted);
    expect(state.receive(executed)).toEqual(executed);
    expect(state.receive(event)).toEqual(event);
    expect(state.snapshot()).toMatchObject({ pending: 0, seq: 1 });
  });
  it('validates snapshot/replay shapes with epoch, revision fences and bounded TTL', () => {
    const snapshot = { kind: 'snapshot', version: 1, ...binding, token: 'snap', revision: 8, watermark: 4, expiresAt: 60000, items: [{ id: 's' }], cursor: null };
    const replay = { kind: 'replay', version: 1, ...binding, after: 4, through: 5, events: [{ ...event, seq: 5 }] };
    expect(decodeFrame(encodeFrame(snapshot))).toEqual(snapshot);
    expect(decodeFrame(encodeFrame(replay))).toEqual(replay);
  });
  it('enforces four credits and four active channels; acknowledgement restores one credit', () => {
    const state = createProtocolState(binding);
    for (let channelId = 1; channelId <= 4; channelId++) state.openChannel(channelId);
    expect(() => state.openChannel(5)).toThrow(expect.objectContaining({ code: 'conflict' }));
    for (let offset = 0; offset < 4; offset++) state.reserveChunk({ channelId: 1, offset, length: 1 });
    const before = state.snapshot();
    expect(() => state.reserveChunk({ channelId: 1, offset: 4, length: 1 })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(state.snapshot()).toEqual(before);
    state.acknowledgeChunk({ channelId: 1, offset: 0, length: 1 });
    state.reserveChunk({ channelId: 1, offset: 4, length: 1 });
    state.close();
    expect(state.snapshot()).toMatchObject({ pending: 0, channels: 0, closed: true });
  });
  it('failure rejects malformed, oversized, unknown method/version and invalid JSON values', () => {
    rejects({ ...request, version: 2 }, 'version_mismatch');
    rejects({ ...request, method: 'execute.arbitrary' }, 'unsupported');
    rejects({ ...request, id: '' });
    rejects({ ...request, target: 'localhost' });
    rejects({ ...request, params: { text: '界'.repeat(400000) } });
    rejects({ ...request, params: { invalid: undefined } });
    rejects({ ...accepted, ok: false });
    rejects({ ...request, unexpected: true });
    expect(() => decodeFrame(' '.repeat(1048577))).toThrow(ProtocolError);
    expect(() => encodeBinary({ channelId: 1, offset: 0, data: new Uint8Array(65537) })).toThrow(ProtocolError);
    expect(() => decodeBinary(new Uint8Array([1]))).toThrow(ProtocolError);
  });
  it('failure rejects cross-target/stale epoch/generation and duplicate response without mutation', () => {
    const state = createProtocolState(binding);
    state.register(request);
    for (const bad of [{ ...accepted, target: other }, { ...accepted, epoch: 'old' }, { ...accepted, generation: 0 }, { ...accepted, id: 'unknown' }]) {
      const before = state.snapshot();
      expect(() => state.receive(bad)).toThrow(ProtocolError);
      expect(state.snapshot()).toEqual(before);
    }
    state.receive(accepted);
    const before = state.snapshot();
    expect(() => state.receive(accepted)).toThrow(ProtocolError);
    expect(state.snapshot()).toEqual(before);
    state.receive(executed);
    expect(() => state.receive(executed)).toThrow(ProtocolError);
    state.receive(event);
    expect(() => state.receive(event)).toThrow(expect.objectContaining({ code: 'replay_required' }));
  });
  it('failure rejects event gaps and snapshot revision regression without mutation', () => {
    const state = createProtocolState(binding);
    const before = state.snapshot();
    expect(() => state.receive({ ...event, seq: 2 })).toThrow(expect.objectContaining({ code: 'replay_required' }));
    expect(state.snapshot()).toEqual(before);
    state.acceptSnapshot({ kind: 'snapshot', version: 1, ...binding, token: 's', revision: 8, watermark: 4, expiresAt: 61000, items: [], cursor: null }, 1000);
    const snapshotState = state.snapshot();
    expect(() => state.receive({ ...event, seq: 5, entityRevision: 8 })).toThrow(ProtocolError);
    expect(state.snapshot()).toEqual(snapshotState);
    state.receive({ ...event, seq: 5, entityRevision: 9 });
    expect(() => state.acceptSnapshot({ kind: 'snapshot', version: 1, ...binding, token: 's', revision: 8, watermark: 4, expiresAt: 61000, items: [], cursor: null }, 62000)).toThrow(ProtocolError);
  });
  it('failure rejects snapshots older than observed tombstones without erasing fences', () => {
    for (const delivery of ['event', 'replay']) {
      const state = createProtocolState(binding);
      try {
        const snapshot = { kind: 'snapshot', version: 1, ...binding, token: 's', revision: 8, watermark: 0, expiresAt: 61000, items: [], cursor: null };
        state.acceptSnapshot(snapshot, 1000);
        const tombstone = { ...event, seq: 1, entityRevision: 9, type: 'deleted' };
        state.receive(delivery === 'event' ? tombstone : { kind: 'replay', version: 1, ...binding, after: 0, through: 1, events: [tombstone] });
        const before = state.snapshot();
        expect(() => state.acceptSnapshot({ ...snapshot, watermark: 1 }, 1000)).toThrow(expect.objectContaining({ code: 'replay_required' }));
        expect(state.snapshot()).toEqual(before);
        expect(() => state.receive({ ...event, seq: 2, entityRevision: 9 })).toThrow(expect.objectContaining({ code: 'replay_required' }));
        expect(state.snapshot()).toEqual(before);
        state.receive({ ...event, seq: 2, entityRevision: 10 });
        expect(state.snapshot()).toMatchObject({ seq: 2, fences: [[event.scope, 10]] });
      } finally { state.close(); }
    }
  });
  it('accepts equal-revision newer-watermark snapshots when no newer fence exists', () => {
    const state = createProtocolState(binding);
    try {
      const snapshot = { kind: 'snapshot', version: 1, ...binding, token: 's', revision: 8, watermark: 0, expiresAt: 61000, items: [], cursor: null };
      state.acceptSnapshot(snapshot, 1000);
      expect(state.acceptSnapshot({ ...snapshot, watermark: 1 }, 1000)).toMatchObject({ revision: 8, watermark: 1 });
      state.receive({ ...event, seq: 2, entityRevision: 9, type: 'deleted' });
      expect(state.acceptSnapshot({ ...snapshot, revision: 9, watermark: 2 }, 1000)).toMatchObject({ revision: 9, watermark: 2 });
      expect(state.snapshot()).toMatchObject({ revision: 9, seq: 2, fences: [] });
    } finally { state.close(); }
  });
  it('failure rejects executable extension registration without a permission grant', () => {
    const state = createProtocolState(binding);
    const extensionRequest = { ...request, method: 'native.extension', params: { owner: other, name: 'future', payload: { command: 'opaque' } } };
    const before = state.snapshot();
    expect(() => state.register(extensionRequest)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(state.snapshot()).toEqual(before);
  });
  it('failure prevents extension owner bypass, malformed binary and stale credit acknowledgements', () => {
    const caps = parseCapabilities({ methods: [], extensions: [{ owner: other, name: 'x', permission: 'write', schemaVersion: 1, metadata: {} }] });
    expect(() => authorizeExtension(caps, { owner: parseHarnessInstanceId(target), name: 'x', permissions: ['write'] })).toThrow(expect.objectContaining({ code: 'unsupported' }));
    const bytes = encodeBinary({ channelId: 1, offset: 0, data: new Uint8Array([1]) });
    expect(() => decodeBinary(bytes.subarray(0, bytes.length - 1))).toThrow(ProtocolError);
    const state = createProtocolState(binding);
    state.openChannel(1);
    state.reserveChunk({ channelId: 1, offset: 0, length: 1 });
    const before = state.snapshot();
    expect(() => state.acknowledgeChunk({ channelId: 1, offset: 0, length: 2 })).toThrow(ProtocolError);
    expect(state.snapshot()).toEqual(before);
    state.acknowledgeChunk({ channelId: 1, offset: 0, length: 1 });
    expect(() => state.acknowledgeChunk({ channelId: 1, offset: 0, length: 1 })).toThrow(ProtocolError);
    state.closeChannel(1);
    expect(() => state.openChannel(1)).toThrow(ProtocolError);
  });
});
