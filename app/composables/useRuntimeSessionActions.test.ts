import { describe, expect, it } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { useRuntimeSessionActions } from './useRuntimeSessionActions';
import { createFakeCapture, createFakeRuntimeActionClient } from './runtimeActions.test-helpers';

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const ENV_A = '11111111-1111-4111-8111-111111111111' as EnvironmentId;
const ENV_B = '22222222-2222-4222-8222-222222222222' as EnvironmentId;
const HARNESS_A = '10000000-0000-4000-8000-000000000001' as HarnessInstanceId;
const HARNESS_B = '10000000-0000-4000-8000-000000000002' as HarnessInstanceId;
const SESSION_A: SessionRef = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, nativeSessionId: 'same-native' });
const SESSION_B: SessionRef = parseSessionRef({ environmentId: ENV_B, harnessInstanceId: HARNESS_B, nativeSessionId: 'same-native' });

function context(client: ReturnType<typeof createFakeRuntimeActionClient>) {
  const { capture } = createFakeCapture(client.client.scope(ENV_A), PROFILE, SESSION_A);
  return { client: client.asClient(), profileId: PROFILE, capture: () => capture };
}

describe('useRuntimeSessionActions routes session lifecycle operations by SessionRef', () => {
  it('fork/archive/unarchive/delete/compact/revert emit session.send commands', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const actions = useRuntimeSessionActions(context(client));
    actions.fork(SESSION_A, { messageId: 'm1' });
    actions.archive(SESSION_A);
    actions.unarchive(SESSION_A);
    actions.delete(SESSION_A);
    actions.compact(SESSION_A);
    actions.revert(SESSION_A, { messageId: 'm2' });
    expect(client.calls.map(call => call.method)).toEqual(Array(6).fill('session.send'));
    expect(client.calls.map(call => call.params.args)).toEqual([
      { command: { name: 'fork', arguments: { messageId: 'm1' } } },
      { command: { name: 'archive' } },
      { command: { name: 'unarchive' } },
      { command: { name: 'delete' } },
      { command: { name: 'compact' } },
      { command: { name: 'revert', arguments: { messageId: 'm2' } } },
    ]);
    for (const call of client.calls) {
      expect(call.target).toBe(ENV_A);
      expect(call.params.session).toEqual(SESSION_A);
      expect(call.params.harnessInstanceId).toBe(HARNESS_A);
    }
  });

  it('rename trims and rejects an empty title before touching the wire', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const actions = useRuntimeSessionActions(context(client));
    expect(() => actions.rename(SESSION_A, '   ')).toThrow();
    expect(client.calls).toHaveLength(0);
    actions.rename(SESSION_A, '  My session  ');
    expect(client.calls[0]!.params.args).toEqual({ command: { name: 'rename', arguments: { title: 'My session' } } });
  });

  it('todos and tokenMonitor read via session.get with the qualified session', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const actions = useRuntimeSessionActions(context(client));
    actions.todos(SESSION_A);
    actions.tokenMonitor(SESSION_A);
    expect(client.calls.map(call => call.method)).toEqual(['session.get', 'session.get']);
    expect(client.calls[0]!.params.args).toEqual({ include: ['todos'] });
    expect(client.calls[1]!.params.args).toEqual({ include: ['usage'] });
    expect(client.calls[0]!.params.session).toEqual(SESSION_A);
  });
});

describe('useRuntimeSessionActions never crosses sources for colliding native ids', () => {
  it('an action for source A targets only A even when B shares the native id', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const actions = useRuntimeSessionActions(context(client));
    actions.archive(SESSION_A);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.target).toBe(ENV_A);
    expect(client.calls[0]!.params.session).toEqual(SESSION_A);
  });

  it('switching the action target to B does not reuse or mutate A routing', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const actions = useRuntimeSessionActions(context(client));
    actions.rename(SESSION_A, 'a');
    actions.rename(SESSION_B, 'b');
    expect(client.calls.map(call => call.target)).toEqual([ENV_A, ENV_B]);
    expect(client.calls.map(call => call.params.session?.environmentId)).toEqual([ENV_A, ENV_B]);
    expect(client.calls.map(call => call.params.session?.nativeSessionId)).toEqual(['same-native', 'same-native']);
  });

  it('history reload reads session.history for the qualified session only', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const actions = useRuntimeSessionActions(context(client));
    actions.history(SESSION_B, { after: 3 });
    expect(client.calls[0]!.target).toBe(ENV_B);
    expect(client.calls[0]!.method).toBe('session.history');
    expect(client.calls[0]!.params.args).toEqual({ after: 3 });
  });
});
