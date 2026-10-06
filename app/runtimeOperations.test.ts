// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';
import type { RuntimeStore, Json } from '../bridge/runtime/storage/runtimeStore.js';
import { createOperationJournal } from '../bridge/runtime/operationJournal.js';
import { createInteractionStore } from '../bridge/runtime/interactionStore.js';
import { createAdmissionQueue } from '../bridge/runtime/admissionQueue.js';
import { parseSessionRef } from '../shared/runtime/identity.js';

const environmentId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const scope = {
  target: environmentId,
  epoch,
  processGeneration: 1,
  session: parseSessionRef({
    environmentId,
    harnessInstanceId: ownerId,
    nativeSessionId: 'native-1',
  }),
};
describe('runtime operation ownership', () => {
  it('submits once when two windows execute the same durable operation concurrently', async () => {
    // Given two window contexts sharing the Runtime-owned durable journal.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-operation-test-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
    try {
      await store.ready;
      const journal = createOperationJournal({
        store,
        isProcessCurrent: (candidate) => candidate.processGeneration === 1,
      });
      const input = { scope, idempotencyKey: 'one', method: 'send', payload: { text: 'hello' } };
      const [first, second] = await Promise.all([journal.accept(input), journal.accept(input)]);
      let sends = 0;
      // When both windows dispatch their accepted operation.
      await Promise.allSettled([
        journal.execute(first.operationId, scope, () => {
          sends++;
          return 'native-turn';
        }),
        journal.execute(second.operationId, scope, () => {
          sends++;
          return 'native-turn';
        }),
      ]);
      // Then one durable operation and one actual native submission exist.
      expect(first.operationId).toBe(second.operationId);
      expect(sends).toBe(1);
      expect((await journal.get(first.operationId)).phase).toBe('observed');
    } finally {
      await store.terminate();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});

async function withStore(action: (store: ReturnType<typeof createRuntimeStore>) => Promise<void>) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-operation-test-'));
  const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
  try {
    await store.ready;
    await action(store);
  } finally {
    await store.terminate();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

describe('runtime operation failure boundaries', () => {
  it('rejects changed payload when a scoped idempotency key already exists', () =>
    withStore(async (store) => {
      // Given a durable intent.
      const journal = createOperationJournal({ store, isProcessCurrent: () => true });
      const input = { scope, idempotencyKey: 'one', method: 'send', payload: { text: 'hello' } };
      await journal.accept(input);
      // When another payload reuses its scoped key.
      const conflict = journal.accept({ ...input, payload: { text: 'different' } });
      // Then reuse cannot silently attach to the first native operation.
      await expect(conflict).rejects.toMatchObject({
        code: 'conflict',
        reason: 'idempotency_mismatch',
      });
    }));
  it('requires reconciliation when native submission outcome is ambiguous', () =>
    withStore(async (store) => {
      // Given an accepted operation and a transport that loses the acknowledgement.
      const journal = createOperationJournal({ store, isProcessCurrent: () => true });
      const operation = await journal.accept({
        scope,
        idempotencyKey: 'one',
        method: 'send',
        payload: null,
      });
      let sends = 0;
      // When submission fails after the native boundary.
      await expect(
        journal.execute(operation.operationId, scope, () => {
          sends++;
          throw new Error('connection lost after write');
        }),
      ).rejects.toThrow('connection lost');
      // Then a repeated execution never repeats the send.
      await expect(
        journal.execute(operation.operationId, scope, () => {
          sends++;
        }),
      ).rejects.toMatchObject({ code: 'reconcile_required' });
      expect(sends).toBe(1);
      expect((await journal.get(operation.operationId)).phase).toBe('reconciling');
    }));
  it('arbitrates once when two windows reply to one native permission', () =>
    withStore(async (store) => {
      // Given one Runtime-owned upstream permission.
      const interactions = createInteractionStore({ store });
      await interactions.bindProcess(scope);
      const key = await interactions.pending({
        scope,
        nativeRequestId: 4,
        payload: { options: ['approve', 'deny'] },
      });
      let submissions = 0;
      // When two windows reply concurrently.
      const results = await Promise.allSettled([
        interactions.reply(key, scope, 'approve', () => {
          submissions++;
        }),
        interactions.reply(key, scope, 'deny', () => {
          submissions++;
        }),
      ]);
      // Then precisely one upstream reply and one successful result exist.
      expect(submissions).toBe(1);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await interactions.get(key)).phase).toBe('replied');
    }));
  it('invalidates a pending RPC when its native process exits', () =>
    withStore(async (store) => {
      // Given a durable pending permission.
      const interactions = createInteractionStore({ store });
      await interactions.bindProcess(scope);
      const key = await interactions.pending({ scope, nativeRequestId: 4, payload: null });
      // When its native process exits and a newer generation replaces it.
      await interactions.processExited(scope);
      await interactions.bindProcess({ ...scope, processGeneration: 2 });
      // Then the old RPC cannot be answered by the new process.
      let replies = 0;
      await expect(
        interactions.reply(key, scope, 'approve', () => {
          replies++;
        }),
      ).rejects.toMatchObject({ code: 'reconcile_required', reason: 'stale_generation' });
      expect(replies).toBe(0);
      expect((await interactions.get(key)).phase).toBe('invalidated');
    }));

  it('blocks an old RPC when process exit races the committed reply claim', () =>
    withStore(async (store) => {
      // Given the real worker and an exit arriving immediately after durable claim.
      const hasPhase = (value: Json, phase: string) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'phase' in value &&
        value.phase === phase;
      const traced: RuntimeStore = {
        ...store,
        async mutateControl(params) {
          const ack = await store.mutateControl(params);
          if (params.changes.some((change) => hasPhase(change.value, 'replying')))
            await interactions.processExited(scope);
          return ack;
        },
      };
      const interactions = createInteractionStore({ store: traced });
      await interactions.bindProcess(scope);
      const key = await interactions.pending({ scope, nativeRequestId: 4, payload: null });
      let replies = 0;
      // When the process exits before the claimed reply reaches its callback.
      await expect(
        interactions.reply(key, scope, 'approve', () => {
          replies++;
        }),
      ).rejects.toMatchObject({ code: 'reconcile_required', reason: 'stale_generation' });
      // Then no old-generation RPC is sent, even though its claim was committed.
      expect(replies).toBe(0);
      expect((await interactions.get(key)).phase).toBe('invalidated');
    }));
  it('keeps independent SessionRef RPC generations when one native session exits', () =>
    withStore(async (store) => {
      // Given two distinct native sessions sharing a configured harness instance.
      const interactions = createInteractionStore({ store });
      const secondScope = {
        ...scope,
        session: parseSessionRef({ ...scope.session, nativeSessionId: 'native-2' }),
      };
      await interactions.bindProcess(scope);
      await interactions.bindProcess(secondScope);
      const key = await interactions.pending({
        scope: secondScope,
        nativeRequestId: 4,
        payload: null,
      });
      // When only the first session process exits.
      await interactions.processExited(scope);
      // Then the second session retains its own live permission RPC.
      let replies = 0;
      await interactions.reply(key, secondScope, 'approve', () => {
        replies++;
      });
      expect(replies).toBe(1);
      expect((await interactions.get(key)).phase).toBe('replied');
    }));
  it('preserves the native terminal when cancellation races completion', () =>
    withStore(async (store) => {
      // Given a native-observed operation.
      const journal = createOperationJournal({ store, isProcessCurrent: () => true });
      const operation = await journal.accept({
        scope,
        idempotencyKey: 'one',
        method: 'send',
        payload: null,
      });
      await journal.execute(operation.operationId, scope, () => undefined);
      // When cancellation and native completion arrive together.
      await Promise.all([
        journal.cancel(operation.operationId, scope),
        journal.terminal(operation.operationId, scope, 'completed'),
      ]);
      // Then cancellation cannot invent a cancelled terminal.
      expect(await journal.get(operation.operationId)).toMatchObject({
        phase: 'terminal',
        outcome: 'completed',
      });
    }));
  it('retains bounded occupancy when admitted work outlives its deadline', async () => {
    // Given work that can only finish when explicitly released.
    const admission = createAdmissionQueue();
    const deferred = Promise.withResolvers<void>();
    // When its response deadline expires.
    await expect(admission.run({ deadlineMs: 1 }, () => deferred.promise)).rejects.toMatchObject({
      code: 'timeout',
    });
    // Then its outstanding work remains accounted until actual settlement.
    expect(admission.pending.total).toBe(1);
    deferred.resolve();
    await deferred.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(admission.pending.total).toBe(0);
  });
});

describe('trusted runtime store scope binding', () => {
  const foreignScope = {
    ...scope,
    target: ownerId,
    session: parseSessionRef({ ...scope.session, environmentId: ownerId }),
  };
  it('rejects a foreign target before recording any intent even with permissive native authority', () =>
    withStore(async (store) => {
      // Given a real store bound to environment A and syntactically valid scope B.
      const journal = createOperationJournal({ store, isProcessCurrent: () => true });
      // When a caller asks environment A to durably accept B's operation.
      await expect(
        journal.accept({
          scope: foreignScope,
          idempotencyKey: 'foreign',
          method: 'send',
          payload: { text: 'private' },
        }),
      ).rejects.toMatchObject({ code: 'conflict', reason: 'store_target' });
      // Then no intent, payload or interaction rows are created, while A remains usable.
      expect((await store.page({ collection: 'operations' })).items).toHaveLength(0);
      expect((await store.page({ collection: 'interactions' })).items).toHaveLength(0);
      expect((await store.inspect()).revision).toBe(0);
      expect(
        await journal.accept({ scope, idempotencyKey: 'local', method: 'send', payload: null }),
      ).toMatchObject({ phase: 'durable-accepted' });
    }));
  it('rejects a foreign native interaction binding before any durable state', () =>
    withStore(async (store) => {
      // Given an interaction service for store A.
      const interactions = createInteractionStore({ store });
      // When a caller registers a valid-looking foreign SessionRef.
      await expect(interactions.bindProcess(foreignScope)).rejects.toMatchObject({
        code: 'conflict',
        reason: 'store_target',
      });
      // Then no process or payload records exist, and legitimate A can still register.
      expect((await store.page({ collection: 'operations' })).items).toHaveLength(0);
      expect((await store.page({ collection: 'interactions' })).items).toHaveLength(0);
      await interactions.bindProcess(scope);
      expect(await interactions.pending({ scope, nativeRequestId: 1, payload: null })).toEqual(
        expect.any(String),
      );
    }));
  it('refuses durable acceptance when the Runtime process generation is inactive', () =>
    withStore(async (store) => {
      // Given a valid local target whose native generation is no longer current.
      const journal = createOperationJournal({ store, isProcessCurrent: () => false });
      // When durable acceptance is requested.
      await expect(
        journal.accept({ scope, idempotencyKey: 'inactive', method: 'send', payload: null }),
      ).rejects.toMatchObject({ code: 'reconcile_required', reason: 'stale_generation' });
      // Then no false accepted intent or body is stranded in the store.
      expect((await store.inspect()).revision).toBe(0);
      expect((await store.page({ collection: 'operations' })).items).toHaveLength(0);
    }));
  it('keeps every mutation scoped to the trusted environment after local acceptance', () =>
    withStore(async (store) => {
      // Given valid local operation and permission records.
      const journal = createOperationJournal({ store, isProcessCurrent: () => true });
      const accepted = await journal.accept({
        scope,
        idempotencyKey: 'local',
        method: 'send',
        payload: null,
      });
      const interactions = createInteractionStore({ store });
      await interactions.bindProcess(scope);
      const key = await interactions.pending({ scope, nativeRequestId: 1, payload: null });
      const revision = (await store.inspect()).revision;
      let nativeCalls = 0;
      // When foreign scope is presented to every other mutation entry point.
      const outcomes = await Promise.allSettled([
        journal.execute(accepted.operationId, foreignScope, () => {
          nativeCalls++;
        }),
        journal.cancel(accepted.operationId, foreignScope),
        journal.terminal(accepted.operationId, foreignScope, 'completed'),
        journal.reconcile(accepted.operationId, foreignScope),
        interactions.pending({ scope: foreignScope, nativeRequestId: 2, payload: 'foreign' }),
        interactions.reply(key, foreignScope, 'approve', () => {
          nativeCalls++;
        }),
        interactions.processExited(foreignScope),
      ]);
      // Then every entry rejects before mutation or any native callback.
      expect(outcomes).toHaveLength(7);
      for (const outcome of outcomes)
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: { code: 'conflict', reason: 'store_target' },
        });
      expect((await store.inspect()).revision).toBe(revision);
      expect(nativeCalls).toBe(0);
    }));
});

describe('generation changes across durable awaits', () => {
  it.each(['transition-read', 'accepted-ack'] as const)(
    'does not report accepted after exit at %s',
    (boundary) =>
      withStore(async (store) => {
        let current = true;
        let armed = false;
        let operationId = '';
        const proxy = new Proxy(store, {
          get(target, property) {
            if (property === 'get')
              return async (input: Parameters<RuntimeStore['get']>[0]) => {
                const result = await target.get(input);
                if (boundary === 'transition-read' && armed && input.key.startsWith('op:'))
                  current = false;
                return result;
              };
            if (property === 'mutate')
              return async (input: Parameters<RuntimeStore['mutate']>[0]) => {
                const result = await target.mutate(input);
                if (input.intentId.startsWith('body:')) armed = true;
                const operation = input.changes.find((change) => change.key.startsWith('op:'));
                if (operation) {
                  operationId = operation.key;
                  if (
                    boundary === 'accepted-ack' &&
                    (operation.value as { phase: string }).phase === 'accepted'
                  )
                    current = false;
                }
                return result;
              };
            return Reflect.get(target, property);
          },
        });
        const journal = createOperationJournal({ store: proxy, isProcessCurrent: () => current });
        await expect(
          journal.accept({ scope, idempotencyKey: boundary, method: 'send', payload: 'body' }),
        ).rejects.toMatchObject({ code: 'reconcile_required', reason: 'stale_generation' });
        expect(current).toBe(false);
        expect((await journal.get(operationId)).phase).toBe(
          boundary === 'transition-read' ? 'intent' : 'reconciling',
        );
        let sends = 0;
        await expect(
          journal.execute(operationId, scope, () => {
            sends++;
          }),
        ).rejects.toMatchObject({ code: 'reconcile_required' });
        expect(sends).toBe(0);
      }),
  );
});
