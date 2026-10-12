import { describe, expect, it } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { useRuntimeMessageSend } from './useRuntimeMessageSend';
import { createFakeCapture, createFakeRuntimeActionClient } from './runtimeActions.test-helpers';

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const ENV_A = '11111111-1111-4111-8111-111111111111' as EnvironmentId;
const ENV_B = '22222222-2222-4222-8222-222222222222' as EnvironmentId;
const HARNESS_A = '10000000-0000-4000-8000-000000000001' as HarnessInstanceId;
const HARNESS_B = '10000000-0000-4000-8000-000000000002' as HarnessInstanceId;

// The exact collision this task exists to prevent: the SAME native session id
// under two different environments/harnesses.
const SESSION_A: SessionRef = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_A, nativeSessionId: 'shared-native-id' });
const SESSION_B: SessionRef = parseSessionRef({ environmentId: ENV_B, harnessInstanceId: HARNESS_B, nativeSessionId: 'shared-native-id' });

function context(client: ReturnType<typeof createFakeRuntimeActionClient>, session: SessionRef = SESSION_A) {
  const { capture, uiCurrent } = createFakeCapture(client.client.scope(session.environmentId), PROFILE, session);
  return {
    ctx: { client: client.asClient(), profileId: PROFILE, capture: () => capture },
    capture,
    uiCurrent,
  };
}

describe('useRuntimeMessageSend routes every message operation by the qualified SessionRef', () => {
  it('send builds a session.send NativeCall carrying the full SessionRef', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    const send = useRuntimeMessageSend(ctx);
    send.send(SESSION_A, { text: 'hello' });
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.kind).toBe('mutate');
    expect(call.target).toBe(ENV_A);
    expect(call.method).toBe('session.send');
    expect(call.params.harnessInstanceId).toBe(HARNESS_A);
    expect(call.params.session).toEqual(SESSION_A);
    expect(call.params.args).toMatchObject({ text: 'hello' });
  });

  it('queue adds queue:true to the same NativeCall envelope', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    useRuntimeMessageSend(ctx).queue(SESSION_A, { text: 'later' });
    expect(client.calls[0]!.params.args).toMatchObject({ text: 'later', queue: true });
  });

  it('slash wraps the command name/arguments in the native envelope', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    useRuntimeMessageSend(ctx).slash(SESSION_A, 'rename', { title: 'x' });
    expect(client.calls[0]!.method).toBe('session.send');
    expect(client.calls[0]!.params.args).toEqual({ command: { name: 'rename', arguments: { title: 'x' } } });
  });

  it('attach carries attachments in the send args', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    useRuntimeMessageSend(ctx).attach(SESSION_A, [{ name: 'a.txt' }], { text: 'see file' });
    expect(client.calls[0]!.params.args).toMatchObject({ text: 'see file', attachments: [{ name: 'a.txt' }] });
  });

  it('cancelTurn uses session.cancel for the same qualified session', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    useRuntimeMessageSend(ctx).cancelTurn(SESSION_A);
    expect(client.calls[0]!.method).toBe('session.cancel');
    expect(client.calls[0]!.target).toBe(ENV_A);
    expect(client.calls[0]!.params.session).toEqual(SESSION_A);
  });

  it('compact/revert route as session.send commands', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    const send = useRuntimeMessageSend(ctx);
    send.compact(SESSION_A);
    send.revert(SESSION_A, { messageId: 'm1' });
    expect(client.calls.map(call => call.params.args)).toEqual([
      { command: { name: 'compact' } },
      { command: { name: 'revert', arguments: { messageId: 'm1' } } },
    ]);
  });
});

describe('useRuntimeMessageSend — busy-session switch invariant (GAP-1)', () => {
  it('switching the UI selection while a send is in flight does NOT cancel that send', async () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx, capture, uiCurrent } = context(client);
    const send = useRuntimeMessageSend(ctx);
    const inFlight = send.sendCaptured({ text: 'long turn' });
    expect(client.pending).toHaveLength(1);
    // The user now clicks another source/session. selectionScope.ts aborts the
    // capture signal and flips capture.isCurrent() to false — but the target is
    // still attached, so the turn must survive.
    uiCurrent.value = false;
    expect(capture.isCurrent()).toBe(false);
    expect(client.settle()).toBe(true);
    await expect(inFlight.executed).resolves.toMatchObject({ value: null });
  });

  it('capture sends with its own scope: the NativeCall uses the CAPTURED session, not the ambient one', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const { ctx } = context(client, SESSION_A);
    const send = useRuntimeMessageSend(ctx);
    send.sendCaptured({ text: 'captured' });
    // Bound to the capture's session (A) even though B is a legal target.
    expect(client.calls[0]!.target).toBe(ENV_A);
    expect(client.calls[0]!.params.session).toEqual(SESSION_A);
  });

  it('capture refuses to send when there is no current selection', () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const ctx = { client: client.asClient(), profileId: PROFILE, capture: () => null };
    expect(() => useRuntimeMessageSend(ctx).sendCaptured({ text: 'x' })).toThrowError(/action\.selection|cancelled/);
    expect(client.calls).toHaveLength(0);
  });

  it('a detached target still cancels the send (the fence is real, not a no-op)', async () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    const inFlight = useRuntimeMessageSend(ctx).sendCaptured({ text: 'turn' });
    client.detach(ENV_A);
    expect(client.settle()).toBe(true);
    await expect(inFlight.executed).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('useRuntimeMessageSend — model selection never crosses sources', () => {
  it('keeps model selection keyed by the full qualified session', () => {
    const client = createFakeRuntimeActionClient([ENV_A, ENV_B]);
    const { ctx } = context(client);
    const send = useRuntimeMessageSend(ctx);
    send.setModel(SESSION_A, 'model-a');
    expect(send.modelFor(SESSION_A)).toBe('model-a');
    expect(send.modelFor(SESSION_B)).toBeNull();
    send.setModel(SESSION_B, 'model-b');
    expect(send.modelFor(SESSION_A)).toBe('model-a');
    expect(send.modelFor(SESSION_B)).toBe('model-b');
    send.clearModel(SESSION_A);
    expect(send.modelFor(SESSION_A)).toBeNull();
    expect(send.modelFor(SESSION_B)).toBe('model-b');
  });
});
