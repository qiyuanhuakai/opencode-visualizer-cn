import { describe, expect, it } from 'vitest';
import { parseRuntimeParams, parseRuntimeResult, RUNTIME_WIRE_METHODS } from '../../shared/runtime/runtimeWire.js';
import { encodeSessionKey, parseSessionRef } from '../../shared/runtime/identity.js';
const harnessInstanceId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const session = { environmentId, harnessInstanceId, nativeSessionId: 'same-native-id' };
describe('closed runtime wire DTO validation', () => {
  it('accepts declared native envelopes and refuses authority injection', () => {
    expect(parseRuntimeParams('native.query', { harnessInstanceId, operation: 'getGlobalConfig', args: {} })).toMatchObject({ operation: 'getGlobalConfig' });
    expect(parseRuntimeParams('native.extension', { harnessInstanceId, session, operation: 'updateSession', args: { native: { name: 'renamed' } } })).toMatchObject({ session });
    expect(() => parseRuntimeParams('native.extension', { harnessInstanceId, session, operation: 'updateSession', args: { idempotencyKey: 'forged' } })).toThrow('unauthorized');
    expect(parseRuntimeResult('native.extension', { operationId: 'op', value: null })).toEqual({ operationId: 'op', value: null });
  });
  it('rejects client authority overrides and improperly scoped native requests', () => {
    for (const name of ['target', 'environmentId', 'harnessInstanceId', 'session', 'epoch', 'processGeneration', 'permissions', 'idempotencyKey']) expect(() => parseRuntimeParams('session.send', { harnessInstanceId, session, args: { [name]: 'forged' } })).toThrow('unauthorized');
    expect(() => parseRuntimeParams('session.send', { harnessInstanceId, args: {} })).toThrow();
    expect(() => parseRuntimeParams('session.create', { harnessInstanceId, session, args: {} })).toThrow();
    expect(parseRuntimeParams('session.send', { harnessInstanceId, session, args: { content: [{ type: 'text', text: 'hello' }] } })).toMatchObject({ session });
  });
  it('keeps the allowed index surface and channel budgets bounded', () => {
    // Includes the session-qualified interaction payload read used by approval cards.
    expect(Object.keys(RUNTIME_WIRE_METHODS)).toHaveLength(42);
    expect(RUNTIME_WIRE_METHODS['runtime.interaction.read']).toBe('read');
    expect(parseRuntimeParams('runtime.interaction.read', { session, interactionId: 'approval-1' })).toEqual({ session, interactionId: 'approval-1' });
    expect(() => parseRuntimeParams('runtime.interaction.read', { session, interactionId: '' })).toThrow();
    expect(() => parseRuntimeParams('runtime.interaction.read', { session: { ...session, endpoint: 'forged' }, interactionId: 'approval-1' })).toThrow();
    expect(() => parseRuntimeParams('runtime.snapshot', { collection: 'imports' })).toThrow();
    expect(() => parseRuntimeParams('runtime.snapshot', { collection: 'workspaces', limit: 201 })).toThrow();
    expect(() => parseRuntimeParams('runtime.channel.ack', { channelId: 0, offset: 0, length: 1 })).toThrow();
    expect(() => parseRuntimeParams('runtime.pty.write', { ptyId: 'pty', data: 'x'.repeat(65537) })).toThrow();
    expect(() => parseRuntimeResult('runtime.channel.open', { channelId: 1, direction: 'upload', service: 'pty', credits: 4, chunkBytes: 65536, offset: 0 })).toThrow();
  });
  it('binds an inline summary to the delivered patch key and revision', () => {
    const key = encodeSessionKey(parseSessionRef(session));
    const frame = {
      kind: 'event', version: 1, target: environmentId, epoch: 'epoch', generation: 1, seq: 1,
      entityRevision: 9, scope: key, type: 'entity.patch',
      payload: { collection: 'session_summaries', key, deleted: false },
    };
    const canonical = { collection: 'session_summaries', key, revision: 9, value: { session, title: 'updated' } };
    expect(parseRuntimeResult('runtime.observer.read', { kind: 'event', frame, canonical })).toMatchObject({ canonical });
    for (const invalid of [{ ...canonical, key: 'another' }, { ...canonical, revision: 8 }, { ...canonical, chunked: true }]) {
      expect(() => parseRuntimeResult('runtime.observer.read', { kind: 'event', frame, canonical: invalid })).toThrow('observer_entity');
    }
  });
  it('checks nested frames and exact result shapes before client consumption', () => {
    expect(() => parseRuntimeResult('runtime.observer.read', { kind: 'control', frame: { kind: 'event', version: 1 } })).toThrow();
    expect(() => parseRuntimeResult('runtime.target.detach', { detached: true, nativeEndpoint: 'secret' })).toThrow();
    expect(() => parseRuntimeResult('session.send', { operationId: 'op', value: undefined })).toThrow();
    expect(parseRuntimeResult('runtime.observer.read', null)).toBeNull();
  });
});
