// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSessionRef } from '../../shared/runtime/identity.js';
import { createRuntimeStore, type RuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeAcceptance } from '../../bridge/runtime/runtimeAcceptance.js';
import { createOperationJournal } from '../../bridge/runtime/operationJournal.js';
import { createInteractionStore } from '../../bridge/runtime/interactionStore.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function gate() { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(wrap: (store: RuntimeStore) => RuntimeStore = store => store) {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-wire-acceptance-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = randomUUID(), epoch = randomUUID(), harnessInstanceId = randomUUID();
  const store = createRuntimeStore({ stateDirectory: root, environmentId: target, epoch, ownerId: randomUUID() }); cleanups.push(() => store.close()); await store.ready;
  const acceptance = createRuntimeAcceptance({ store: wrap(store) }); cleanups.push(() => acceptance.close());
  const scope = { target, epoch, processGeneration: 1, harnessInstanceId, session: parseSessionRef({ environmentId: target, harnessInstanceId, nativeSessionId: 'same-native-id' }) };
  const journal = createOperationJournal({ store: acceptance.store, isProcessCurrent: () => true });
  return { store, acceptance, scope, journal };
}
describe('runtime acceptance observes existing durable native journals', () => {
  it('accepts independent permissions on one parent without mutating the shared process or parent fences', async () => {
    const { store, journal, scope, acceptance } = await setup();
    const interactions = createInteractionStore({ store: acceptance.store });
    await interactions.bindProcess(scope);
    const parent = await journal.accept({ scope, idempotencyKey: 'concurrent-parent', method: 'send', payload: {} });
    await journal.execute(parent.operationId, scope, () => null);
    const before = await store.getControl({ collection: 'operations', key: parent.operationId });
    const keys = await Promise.all(['first', 'second'].map(nativeRequestId => interactions.pending({ scope, nativeRequestId, parentOperationId: parent.operationId, payload: {} })));
    let accepted = 0, native = 0;
    await Promise.all(keys.map(interactionId => acceptance.run({ scope, method: 'interaction.respond', idempotencyKey: randomUUID(), interactionId, onAccepted: () => { accepted++; } }, () => interactions.reply(interactionId, scope, { allow: true }, () => { native++; }))));
    expect([accepted, native]).toEqual([2, 2]);
    expect(await store.getControl({ collection: 'operations', key: parent.operationId })).toEqual(before);
    await journal.terminal(parent.operationId, scope, 'completed');
  });
  for (const phase of ['pending', 'replying'] as const) for (const boundary of ['parent', 'process'] as const) {
    it(`rejects ${phase} atomically if its ${boundary} ends immediately before the claim transaction`, async () => {
      let armed = false, trigger: () => Promise<unknown> = async () => {};
      const { store, journal, scope, acceptance } = await setup(raw => {
        const write = (method: 'mutate' | 'mutateControl') => async (input: Parameters<RuntimeStore['mutate']>[0]) => {
          const claiming = input.changes.some(change => change.collection === 'interactions' && change.value !== null && typeof change.value === 'object' && 'phase' in change.value && change.value.phase === phase);
          if (armed && claiming) { armed = false; await trigger(); }
          return raw[method](input);
        };
        return { ...raw, mutate: write('mutate'), mutateControl: write('mutateControl') };
      });
      const interactions = createInteractionStore({ store: acceptance.store });
      await interactions.bindProcess(scope);
      const parent = await journal.accept({ scope, idempotencyKey: 'raced-parent', method: 'send', payload: {} });
      await journal.execute(parent.operationId, scope, () => null);
      const key = phase === 'replying' ? await interactions.pending({ scope, nativeRequestId: 'raced', parentOperationId: parent.operationId, payload: {} }) : null;
      trigger = boundary === 'parent' ? () => journal.terminal(parent.operationId, scope, 'completed') : () => interactions.processExited(scope);
      armed = true;
      let native = 0;
      const action = key ? interactions.reply(key, scope, { allow: true }, () => { native++; }) : interactions.pending({ scope, nativeRequestId: 'raced', parentOperationId: parent.operationId, payload: {} });
      await expect(action).rejects.toMatchObject({ code: 'conflict', reason: 'entity_precondition' });
      expect(armed).toBe(false);
      expect(native).toBe(0);
      if (key) expect((await store.getControl({ collection: 'interactions', key }))?.value).toMatchObject({ phase: 'pending' });
      else expect((await store.page({ collection: 'interactions' })).items.filter(item => item.value !== null && typeof item.value === 'object' && 'kind' in item.value && item.value.kind === 'interaction')).toHaveLength(0);
    });
  }
  it('invalidates permission ownership when its exact parent turn ends and preserves a later turn', async () => {
    const { store, journal, scope } = await setup();
    const interactions = createInteractionStore({ store });
    await interactions.bindProcess(scope);
    const first = await journal.accept({ scope, idempotencyKey: 'first', method: 'send', payload: {} });
    await journal.execute(first.operationId, scope, async () => ({ running: true }));
    const old = await interactions.pending({ scope, nativeRequestId: 'old-approval', parentOperationId: first.operationId, payload: { permission: 'read' } });
    expect((await interactions.get(old)).phase).toBe('pending');
    await journal.terminal(first.operationId, scope, 'cancelled');
    expect((await interactions.get(old)).phase).toBe('invalidated');
    let submits = 0;
    await expect(interactions.reply(old, scope, {}, () => { submits++; })).rejects.toThrow('interaction_parent_ended');
    expect(submits).toBe(0);
    const next = await journal.accept({ scope, idempotencyKey: 'second', method: 'send', payload: {} });
    await journal.execute(next.operationId, scope, async () => ({ running: true }));
    const current = await interactions.pending({ scope, nativeRequestId: 'next-approval', parentOperationId: next.operationId, payload: { permission: 'read' } });
    expect((await interactions.get(current)).phase).toBe('pending');
    expect((await interactions.get(old)).phase).toBe('invalidated');
  });
  it('waits for the exact accepted-transition child ACK before accepted notification or native submission', async () => {
    const ack = gate(), written = gate(); const order: string[] = [];
    const context = await setup(store => ({ ...store, async mutate(input) { const result = await store.mutate(input); if (input.changes.some(change => (change.value as { phase?: string })?.phase === 'accepted')) { order.push('persisted'); written.resolve(); await ack.promise; order.push('ack'); } return result; } }));
    const { acceptance, journal, scope } = context;
    const result = acceptance.run({ scope, method: 'session.send', idempotencyKey: 'send', onAccepted: () => order.push('accepted') }, async () => { const accepted = await journal.accept({ scope, method: 'send', idempotencyKey: 'send', payload: { text: 'hello' } }); return journal.execute(accepted.operationId, scope, () => { order.push('native'); return { sent: true }; }); });
    await written.promise; expect(order).toEqual(['persisted']); ack.resolve();
    expect(await result).toMatchObject({ value: { sent: true } }); expect(order).toEqual(['persisted', 'ack', 'accepted', 'native']);
  });
  it('preserves qualified created session alongside a native result', async () => {
    const { acceptance, journal, scope } = await setup();
    const result = await acceptance.run({ scope, method: 'session.create', idempotencyKey: 'create', onAccepted() {} }, async () => {
      const accepted = await journal.accept({ scope, method: 'createSession', idempotencyKey: 'create', payload: {} });
      const executed = await journal.execute(accepted.operationId, scope, () => ({ sessionId: scope.session.nativeSessionId }));
      return { ...executed, session: scope.session };
    });
    expect(result.value).toEqual({ session: scope.session, nativeResult: { sessionId: scope.session.nativeSessionId } });
  });
  it('does not mistake intent rows, unchanged accepted guards or wrong-scope operations for acceptance', async () => {
    const { store, acceptance, scope } = await setup(); let accepted = 0;
    const value = { kind: 'operation', scope, method: 'send', phase: 'accepted' };
    await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'operations', key: 'guard', value }] });
    const row = await store.getControl({ collection: 'operations', key: 'guard' }); if (!row) throw new Error('Missing guard');
    await expect(acceptance.run({ scope, method: 'session.send', idempotencyKey: 'false', onAccepted: () => accepted++ }, async () => { await acceptance.store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key: 'guard', expectedRevision: row.revision, value }] }); return { phase: 'native-executed', result: null }; })).rejects.toMatchObject({ code: 'reconcile_required' });
    expect(accepted).toBe(0);
    const other = { ...scope, processGeneration: 2 };
    await expect(acceptance.run({ scope, method: 'session.send', idempotencyKey: 'scope', onAccepted: () => accepted++ }, async () => { await acceptance.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'operations', key: 'intent', value: { ...value, scope: other, phase: 'intent' } }] }); return { phase: 'native-executed', result: null }; })).rejects.toMatchObject({ code: 'reconcile_required' }); expect(accepted).toBe(0);
  });
  it('keeps native execution independent of a disconnected acceptance subscriber', async () => {
    const { acceptance, journal, scope } = await setup(); let calls = 0;
    const result = await acceptance.run({ scope, method: 'session.send', idempotencyKey: 'disconnect', onAccepted: () => { throw new Error('Socket closed'); } }, async () => { const row = await journal.accept({ scope, method: 'send', idempotencyKey: 'disconnect', payload: {} }); return journal.execute(row.operationId, scope, () => { calls++; return null; }); });
    expect(calls).toBe(1); expect(result.value).toBeNull();
  });
  it('claims a pending interaction only once across two concurrent approvals', async () => {
    const { acceptance, scope } = await setup(); const interactions = createInteractionStore({ store: acceptance.store });
    await interactions.bindProcess(scope); const interactionId = await interactions.pending({ scope, nativeRequestId: 'approval', payload: { type: 'permission' } });
    let accepted = 0, native = 0; const submit = gate();
    const run = () => acceptance.run({ scope, method: 'interaction.respond', idempotencyKey: randomUUID(), interactionId, onAccepted: () => accepted++ }, () => interactions.reply(interactionId, scope, { allow: true }, async () => { native++; await submit.promise; }));
    const first = run(); while (native === 0) await new Promise(resolve => setTimeout(resolve, 1));
    await expect(run()).rejects.toMatchObject({ code: 'conflict' }); submit.resolve(); await first;
    expect(accepted).toBe(1); expect(native).toBe(1); expect((await interactions.get(interactionId)).phase).toBe('replied');
  });
  it('detaches a queued receipt observer without cancelling the durable operation', async () => {
    const { acceptance, journal, scope } = await setup(); const controller = new AbortController(), accepted = gate();
    let operationId = '', native = 0;
    const request = acceptance.run({ scope, method: 'session.send', idempotencyKey: 'queued', signal: controller.signal, onAccepted: receipt => { operationId = receipt.operationId; accepted.resolve(); } }, () => journal.accept({ scope, method: 'send', idempotencyKey: 'queued', payload: {} }));
    const rejection = expect(request).rejects.toMatchObject({ code: 'cancelled' });
    await accepted.promise; controller.abort(); await rejection; expect(native).toBe(0);
    await journal.execute(operationId, scope, () => { native++; return null; });
    expect(native).toBe(1); expect((await journal.get(operationId)).phase).toBe('observed');
  });
});
