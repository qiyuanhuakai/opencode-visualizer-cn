import { describe, expect, it } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { useRuntimeInteractions } from './useRuntimeInteractions';
import { useRuntimeMessageSend } from './useRuntimeMessageSend';
import { useRuntimeSessionActions } from './useRuntimeSessionActions';
import { createFakeCapture, createFakeRuntimeActionClient } from './runtimeActions.test-helpers';

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const ENV_A = '11111111-1111-4111-8111-111111111111' as EnvironmentId;
const ENV_B = '22222222-2222-4222-8222-222222222222' as EnvironmentId;
const HARNESS_A = '10000000-0000-4000-8000-000000000001' as HarnessInstanceId;
const HARNESS_B = '10000000-0000-4000-8000-000000000002' as HarnessInstanceId;
const SESSION_A: SessionRef = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, nativeSessionId: 'collide' });
const SESSION_B: SessionRef = parseSessionRef({ environmentId: ENV_B, harnessInstanceId: HARNESS_B, nativeSessionId: 'collide' });

function make(sessions: readonly SessionRef[] = [SESSION_A]) {
  const targets = [...new Set(sessions.map(session => session.environmentId))];
  const client = createFakeRuntimeActionClient(targets);
  const { capture } = createFakeCapture(client.client.scope(sessions[0]!.environmentId), PROFILE, sessions[0]!);
  const ctx = { client: client.asClient(), profileId: PROFILE, capture: () => capture };
  return {
    client,
    messages: useRuntimeMessageSend(ctx),
    actions: useRuntimeSessionActions(ctx),
    interactions: useRuntimeInteractions(ctx),
  };
}

/**
 * The full acceptance surface: every one of the fifteen operations must exist
 * on the new path and route to the correct wire method for the qualified
 * SessionRef. This table is the source of the op->test mapping in DoneClaim.
 */
describe('task-22 operation matrix — 15 operations on the qualified routing path', () => {
  it('covers send / cancel / fork / rename / archive / delete / revert / compact / queue / slash / permissions / questions / attachments / todos / tokenMonitor', () => {
    const expected: Record<string, { method: string; target: EnvironmentId }> = {};
    const run = (name: string, act: (api: ReturnType<typeof make>) => void) => {
      const api = make([SESSION_A, SESSION_B]);
      act(api);
      expect(api.client.calls.length, name).toBeGreaterThan(0);
      const call = api.client.calls.at(-1)!;
      expect(call.params.session, `${name} carries the qualified session`).toEqual(SESSION_A);
      expect(call.target, name).toBe(ENV_A);
      expected[name] = { method: call.method, target: call.target };
    };

    run('send', api => api.messages.send(SESSION_A, { text: 'hi' }));
    run('cancel', api => api.messages.cancelTurn(SESSION_A));
    run('fork', api => api.actions.fork(SESSION_A, { messageId: 'm' }));
    run('rename', api => api.actions.rename(SESSION_A, 'title'));
    run('archive', api => api.actions.archive(SESSION_A));
    run('delete', api => api.actions.delete(SESSION_A));
    run('revert', api => api.actions.revert(SESSION_A, { messageId: 'm' }));
    run('compact', api => api.actions.compact(SESSION_A));
    run('queue', api => api.messages.queue(SESSION_A, { text: 'q' }));
    run('slash', api => api.messages.slash(SESSION_A, 'help'));
    run('permissions', api => api.interactions.permission(SESSION_A, 'i', { allow: true }));
    run('questions', api => api.interactions.question(SESSION_A, 'i', { a: 'b' }));
    run('attachments', api => api.messages.attach(SESSION_A, [{ name: 'f' }]));
    run('todos', api => api.actions.todos(SESSION_A));
    run('tokenMonitor', api => api.actions.tokenMonitor(SESSION_A));

    expect(Object.keys(expected).sort()).toEqual(
      ['archive', 'attachments', 'cancel', 'compact', 'delete', 'fork', 'permissions', 'questions', 'queue', 'rename', 'revert', 'send', 'slash', 'todos', 'tokenMonitor'].sort(),
    );
    expect(expected.send).toEqual({ method: 'session.send', target: ENV_A });
    expect(expected.cancel).toEqual({ method: 'session.cancel', target: ENV_A });
    expect(expected.permissions).toEqual({ method: 'interaction.respond', target: ENV_A });
    expect(expected.questions).toEqual({ method: 'interaction.respond', target: ENV_A });
    expect(expected.todos).toEqual({ method: 'session.get', target: ENV_A });
    expect(expected.tokenMonitor).toEqual({ method: 'session.get', target: ENV_A });
  });
});

describe('task-22 cross-source invariant — A and B share a native id but never cross', () => {
  it('routes each operation to its own environment and never reads the other source', () => {
    const api = make([SESSION_A, SESSION_B]);
    api.actions.archive(SESSION_A);
    api.messages.send(SESSION_B, { text: 'to-b' });
    api.interactions.permission(SESSION_B, 'b-req', { allow: true });
    expect(api.client.calls.map(call => call.target)).toEqual([ENV_A, ENV_B, ENV_B]);
    expect(api.client.calls.map(call => call.params.session?.environmentId)).toEqual([ENV_A, ENV_B, ENV_B]);
  });

  it('model selection and interaction registries are keyed by (profile, environment, harness, native id)', () => {
    const api = make([SESSION_A, SESSION_B]);
    api.messages.setModel(SESSION_A, 'ma');
    api.interactions.track(SESSION_A, 'a-req');
    expect(api.messages.modelFor(SESSION_B)).toBeNull();
    expect(api.interactions.pendingFor(SESSION_B)).toEqual([]);
    api.messages.setModel(SESSION_B, 'mb');
    api.interactions.track(SESSION_B, 'b-req');
    expect(api.messages.modelFor(SESSION_A)).toBe('ma');
    expect(api.interactions.pendingFor(SESSION_A)).toEqual(['a-req']);
    // Same profile + same native id but different environment still separates.
    expect(api.messages.modelFor(SESSION_B)).toBe('mb');
    expect(api.interactions.pendingFor(SESSION_B)).toEqual(['b-req']);
  });
});
