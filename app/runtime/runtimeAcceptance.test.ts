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
  it('waits for the exact accepted-transition child ACK before accepted notification or native submission', async () => {
    const ack = gate(), written = gate(); const order: string[] = [];
    const context = await setup(store => ({ ...store, async mutate(input) { const result = await store.mutate(input); if (input.changes.some(change => (change.value as { phase?: string })?.phase === 'accepted')) { order.push('persisted'); written.resolve(); await ack.promise; order.push('ack'); } return result; } }));
    const { acceptance, journal, scope } = context;
    const result = acceptance.run({ scope, method: 'session.send', idempotencyKey: 'send', onAccepted: () => order.push('accepted') }, async () => { const accepted = await journal.accept({ scope, method: 'send', idempotencyKey: 'send', payload: { text: 'hello' } }); return journal.execute(accepted.operationId, scope, () => { order.push('native'); return { sent: true }; }); });
    await written.promise; expect(order).toEqual(['persisted']); ack.resolve();
    expect(await result).toMatchObject({ value: { sent: true } }); expect(order).toEqual(['persisted', 'ack', 'accepted', 'native']);
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
