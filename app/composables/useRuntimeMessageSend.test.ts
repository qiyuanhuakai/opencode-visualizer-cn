import { describe, expect, it } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { useRuntimeMessageSend } from './useRuntimeMessageSend';
import type { RuntimeTurnLifecycle } from './useRuntimeMessageSend';
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

function context(client: ReturnType<typeof createFakeRuntimeActionClient>, session: SessionRef = SESSION_A, turnLifecycle?: RuntimeTurnLifecycle) {
  const { capture, uiCurrent } = createFakeCapture(client.client.scope(session.environmentId), PROFILE, session);
  return {
    ctx: { client: client.asClient(), profileId: PROFILE, capture: () => capture, ...(turnLifecycle ? { turnLifecycle } : {}) },
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

describe('useRuntimeMessageSend — active turn owner vs queued receipt (review round 6138580284 item 6)', () => {
  /** Flush every pending microtask, so an accepted receipt has reached the owner map. */
  function settleMicrotasks() {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /** The turn-lifecycle seam. A turn's terminal notification is the ONLY thing that retires an
   * owner: a send RPC's acknowledgment is not a completion (review P2-2). */
  function createTurnLifecycle() {
    const listeners = new Set<(terminal: Readonly<{ operationId: string }>) => void>();
    return {
      lifecycle: {
        onTerminal(listener: (terminal: Readonly<{ operationId: string }>) => void) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      } satisfies RuntimeTurnLifecycle,
      terminate(operationId: string) {
        for (const listener of Array.from(listeners)) listener({ operationId });
      },
    };
  }

  function lastCancel(client: ReturnType<typeof createFakeRuntimeActionClient>) {
    const call = client.calls.at(-1);
    if (!call || call.kind !== 'mutate' || call.method !== 'session.cancel') {
      throw new TypeError('the last recorded call is not a session.cancel');
    }
    return call;
  }

  it('cancelTurn stops the executing turn, not a message queued behind it', async () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { ctx } = context(client);
    const send = useRuntimeMessageSend(ctx);

    // Given a send that is executing.
    send.send(SESSION_A, { text: 'running turn' });
    await settleMicrotasks();

    // When a second message is queued behind it and the user then stops.
    send.queue(SESSION_A, { text: 'queued behind it' });
    await settleMicrotasks();
    send.cancelTurn(SESSION_A);

    // Then the cancel targets the EXECUTING turn's operationId, not the queued receipt's.
    const cancel = lastCancel(client);
    expect(cancel.params.args).toMatchObject({ operationId: 'op-1' });
  });

  it('retires the active owner once that turn finishes', async () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { lifecycle, terminate } = createTurnLifecycle();
    const { ctx } = context(client, SESSION_A, lifecycle);
    const send = useRuntimeMessageSend(ctx);

    send.send(SESSION_A, { text: 'running turn' });
    await settleMicrotasks();
    // The send RPC's acknowledgment is NOT the turn's end: the real session keeps the operation
    // active until its terminal notification, so the owner survives it.
    expect(client.settle()).toBe(true);
    await settleMicrotasks();
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toMatchObject({ operationId: 'op-1' });

    // The turn's terminal notification is what retires the owner.
    terminate('op-1');
    send.cancelTurn(SESSION_A);
    // The finished turn owns nothing, so no stale operationId is carried into the cancel.
    expect(lastCancel(client).params.args).toEqual({});
  });

  it('keeps a queued receipt from stealing the owner of a still-running turn', async () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { lifecycle, terminate } = createTurnLifecycle();
    const { ctx } = context(client, SESSION_A, lifecycle);
    const send = useRuntimeMessageSend(ctx);

    send.send(SESSION_A, { text: 'running turn' });
    await settleMicrotasks();
    send.queue(SESSION_A, { text: 'first queued' });
    await settleMicrotasks();
    send.queue(SESSION_A, { text: 'second queued' });
    await settleMicrotasks();

    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toMatchObject({ operationId: 'op-1' });

    // And the running turn is still the owner after its send RPC is acknowledged: an
    // acknowledgment is not a completion, so the queued receipts behind it never take over.
    expect(client.settle()).toBe(true);
    await settleMicrotasks();
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toMatchObject({ operationId: 'op-1' });

    // Only the turn's terminal notification retires it.
    terminate('op-1');
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toEqual({});
  });

  it('moves the owner to a queued send once the queue promotes it to the active turn', async () => {
    const client = createFakeRuntimeActionClient([ENV_A]);
    const { lifecycle, terminate } = createTurnLifecycle();
    const { ctx } = context(client, SESSION_A, lifecycle);
    const send = useRuntimeMessageSend(ctx);

    // Given a running turn and a message queued behind it.
    send.send(SESSION_A, { text: 'running turn' });
    await settleMicrotasks();
    const queued = send.queue(SESSION_A, { text: 'promoted next' });
    await settleMicrotasks();
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toMatchObject({ operationId: 'op-1' });

    // When the queue promotes it, its own send RPC is issued and it becomes the active turn.
    expect(client.settle()).toBe(true);
    await settleMicrotasks();
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toMatchObject({ operationId: 'op-1' });

    expect(client.settle()).toBe(true);
    await settleMicrotasks();
    await queued.executed;
    await settleMicrotasks();
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toMatchObject({ operationId: 'op-2' });

    // And that promoted turn's own terminal notification retires it.
    terminate('op-2');
    send.cancelTurn(SESSION_A);
    expect(lastCancel(client).params.args).toEqual({});
  });
});
