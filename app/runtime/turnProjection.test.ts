import { describe, expect, it } from 'vitest';
import { encodeSessionKey, parseSessionRef } from '../../shared/runtime/identity.js';
import type { CanonicalEntity } from '../../shared/runtime/runtimeWire.js';
import { createRuntimeTurnProjection } from './turnProjection';

const first = parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'same-native' });
const second = parseSessionRef({ ...first, harnessInstanceId: '33333333-3333-4333-8333-333333333333' });
function row(key: string, revision: number, phase: string, session = first, method = 'session/prompt'): CanonicalEntity {
  return { key, revision, collection: 'operations', value: { kind: 'operation', method, phase, scope: { session } } };
}

describe('canonical runtime turn ownership', () => {
  it('shows qualified external native activity without inventing a cancel owner', () => {
    const turns = createRuntimeTurnProjection();
    expect(turns.activity(first, { key: encodeSessionKey(first), status: 'running' })).toEqual({ busy: true, cancellable: false });
    expect(turns.activity(first, { key: encodeSessionKey(second), status: 'busy' })).toEqual({ busy: false, cancellable: false });
    expect(turns.activity(first, { key: encodeSessionKey(first), status: 'idle' })).toEqual({ busy: false, cancellable: false });
    turns.apply(row('owned', 1, 'sent'));
    expect(turns.activity(first, { key: encodeSessionKey(first), status: 'idle' })).toEqual({ busy: true, cancellable: true });
    turns.apply(row('owned', 2, 'terminal'));
    expect(turns.activity(first, { key: encodeSessionKey(first), status: 'retry' })).toEqual({ busy: true, cancellable: false });
    expect(turns.get(first)).toBeNull();
  });
  it('keeps an observed native turn busy until its own terminal event, isolated by full SessionRef', () => {
    const turns = createRuntimeTurnProjection();
    turns.apply(row('op-a', 1, 'accepted'));
    turns.apply(row('op-a', 2, 'observed'));
    turns.apply(row('op-b', 3, 'observed', second));
    expect(turns.get(first)?.operationId).toBe('op-a');
    expect(turns.get(second)?.operationId).toBe('op-b');
    turns.apply(row('op-a', 4, 'terminal'));
    turns.apply(row('op-a', 2, 'observed'));
    expect(turns.get(first)).toBeNull();
    expect(turns.get(second)?.operationId).toBe('op-b');
    turns.clear();
    expect(turns.usage()).toEqual({ bytes: 0, active: 0, revisions: 0 });
  });
  it('does not let a queued acceptance or unrelated lifecycle operation replace the running cancel owner', () => {
    const turns = createRuntimeTurnProjection();
    turns.apply(row('running', 1, 'observed'));
    turns.apply(row('queued', 2, 'accepted'));
    turns.apply(row('rename', 3, 'observed', first, 'session/rename'));
    expect(turns.get(first)?.operationId).toBe('running');
    turns.apply(row('queued', 4, 'terminal'));
    expect(turns.get(first)?.operationId).toBe('running');
    turns.apply(row('running', 5, 'terminal'));
    turns.apply(row('next', 6, 'sent'));
    turns.apply(row('running', 7, 'terminal'));
    expect(turns.get(first)?.operationId).toBe('next');
  });
});
