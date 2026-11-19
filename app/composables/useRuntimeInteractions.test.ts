import { describe, expect, it } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { useRuntimeInteractions } from './useRuntimeInteractions';
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

describe('useRuntimeInteractions routes permission and question responses by SessionRef', () => {
  it('permission responds with the native answer field carrying the qualified session', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    useRuntimeInteractions(context(client)).permission(SESSION_A, 'req-1', { allow: true });
    expect(client.calls[0]!.method).toBe('interaction.respond');
    expect(client.calls[0]!.target).toBe(ENV_A);
    expect(client.calls[0]!.params.session).toEqual(SESSION_A);
    expect(client.calls[0]!.params.args).toEqual({ interactionId: 'req-1', answer: { decision: 'accept' } });
  });

  it('question encodes the answers under the native answer field', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    useRuntimeInteractions(context(client)).question(SESSION_A, 'ask-1', { answer: 'yes' });
    expect(client.calls[0]!.params.args).toEqual({ interactionId: 'ask-1', answer: { answers: { answer: 'yes' } } });
  });

  it('a raw respond passes a caller-supplied native answer through unchanged', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    useRuntimeInteractions(context(client)).respond(SESSION_A, 'req-2', { action: 'decline' });
    expect(client.calls[0]!.params.args).toEqual({ interactionId: 'req-2', answer: { action: 'decline' } });
  });

  it('respond rejects an empty interaction id before touching the wire', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const interactions = useRuntimeInteractions(context(client));
    expect(() => interactions.respond(SESSION_A, '', { allow: true })).toThrow();
    expect(client.calls).toHaveLength(0);
  });
});

describe('useRuntimeInteractions keeps pending interactions scoped to their source', () => {
  it('a tracked interaction on A is invisible to B even with a colliding native id', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const interactions = useRuntimeInteractions(context(client));
    interactions.track(SESSION_A, 'req-1');
    interactions.track(SESSION_A, 'req-2');
    expect(interactions.pendingFor(SESSION_A)).toEqual(['req-1', 'req-2']);
    expect(interactions.pendingFor(SESSION_B)).toEqual([]);
    interactions.track(SESSION_B, 'req-b');
    expect(interactions.pendingFor(SESSION_A)).toEqual(['req-1', 'req-2']);
    expect(interactions.pendingFor(SESSION_B)).toEqual(['req-b']);
    interactions.resolveInteraction(SESSION_A, 'req-1');
    expect(interactions.pendingFor(SESSION_A)).toEqual(['req-2']);
    expect(interactions.pendingFor(SESSION_B)).toEqual(['req-b']);
  });

  it('responding to A never routes to B', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const interactions = useRuntimeInteractions(context(client));
    interactions.track(SESSION_B, 'req-b');
    interactions.permission(SESSION_A, 'req-a', { allow: false });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.target).toBe(ENV_A);
    expect(client.calls[0]!.params.session).toEqual(SESSION_A);
    expect(interactions.pendingFor(SESSION_B)).toEqual(['req-b']);
  });
});
