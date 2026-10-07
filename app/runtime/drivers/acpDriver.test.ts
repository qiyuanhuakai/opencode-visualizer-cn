// @vitest-environment node
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createAcpProcessManager } from '../../../bridge/acpProcessManager.js';
class Socket extends EventEmitter {
  send(value: string) {
    this.emit('received', JSON.parse(value));
  }
  close() {
    this.emit('close');
  }
}
test('runtime upstream owns reverse calls without invoking the legacy UI handler', async () => {
  let legacy = 0;
  const manager = createAcpProcessManager({
    handleClientRequest: async () => {
      legacy++;
      return {};
    },
  });
  try {
    await manager.reconcile([
      {
        id: 'qa',
        name: 'qa',
        enabled: true,
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL('../../../scripts/qa/runtime-v090-cases/task-15-fixture.mjs', import.meta.url),
          ),
          '--server',
        ],
      },
    ]);
    const socket = new Socket();
    manager.attach('qa', socket, { runtime: true });
    const received = once(socket, 'received');
    socket.emit('message', JSON.stringify({ id: 1, method: '_test/reverse', params: {} }));
    const [message] = await received;
    expect(message.method).toBe('fs/read_text_file');
    expect(legacy).toBe(0);
  } finally {
    await manager.stopAll();
  }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import type { RuntimeStore, Mutation } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createAcpMutations } from '../../../bridge/runtime/drivers/acpMutations.js';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import { record, AcpError } from '../../../shared/runtime/native/acp/capabilities.js';
import { createAcpSubscriptions } from '../../../shared/runtime/native/acp/subscriptions.js';

const binding = {
  target: '11111111-1111-4111-8111-111111111111',
  harnessInstanceId: '44444444-4444-4444-8444-444444444444',
  epoch: '33333333-3333-4333-8333-333333333333',
  processGeneration: 1,
};
const session = parseSessionRef({
  environmentId: binding.target,
  harnessInstanceId: binding.harnessInstanceId,
  nativeSessionId: 'same-native-id',
});
async function withStore(action: (store: RuntimeStore) => Promise<void>) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'acp-driver-unit-'));
  const store = createRuntimeStore({
    stateDirectory: temporary,
    environmentId: binding.target,
    ownerId: '22222222-2222-4222-8222-222222222222',
    epoch: binding.epoch,
  });
  try {
    await store.ready;
    await action(store);
  } finally {
    await store.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
function isPhase(mutation: Mutation, method: string, phase: string) {
  return mutation.changes.some((change) => {
    const value = change.value;
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      record(value).method === method &&
      record(value).phase === phase
    );
  });
}

test('genuine store environment rejects even a permissive process predicate', () =>
  withStore(async (store) => {
    await expect(
      createAcpMutations({
        store,
        ...binding,
        target: '55555555-5555-4555-8555-555555555555',
        assertCurrent() {},
      }),
    ).rejects.toMatchObject({ reason: 'store_target' });
    expect((await store.page({ collection: 'operations' })).items).toEqual([]);
  }));

test('instance intent is durable without a fabricated session and duplicate create returns persisted result', () =>
  withStore(async (store) => {
    const mutations = await createAcpMutations({ store, ...binding, assertCurrent() {} });
    let sends = 0;
    const input = {
      idempotencyKey: 'create-once',
      method: 'session/new',
      payload: { cwd: '/real-workspace', mcpServers: [] },
    };
    const first = await mutations.run(input, async ({ operationId }) => {
      const saved = await mutations.get(operationId);
      expect(saved?.value.phase).toBe('sent');
      expect(record(saved?.value.scope)).not.toHaveProperty('session');
      sends++;
      return { sessionId: 'actual-native-result' };
    });
    const duplicate = await mutations.run(input, () => {
      sends++;
      return { sessionId: 'wrong' };
    });
    expect([first.phase, duplicate.phase, duplicate.result, sends]).toEqual([
      'native-executed',
      'already-completed',
      { sessionId: 'actual-native-result' },
      1,
    ]);
  }));

test('accepted cancellation cannot borrow a replacement lease', () =>
  withStore(async (store) => {
    let leaseKey = '';
    const wrapped: RuntimeStore = {
      ...store,
      async mutateControl(input) {
        const result = await store.mutateControl(input);
        if (isPhase(input, 'session/cancel', 'accepted')) {
          const lease = await store.getControl({ collection: 'operations', key: leaseKey });
          await store.mutateControl({
            intentId: 'foreign-takeover',
            changes: [
              {
                collection: 'operations',
                key: leaseKey,
                expectedRevision: lease?.revision,
                value: { operationId: 'foreign', runtimeOwner: 'foreign' },
              },
            ],
          });
        }
        return result;
      },
    };
    const mutations = await createAcpMutations({ store: wrapped, ...binding, assertCurrent() {} });
    leaseKey = mutations.leaseKey(mutations.scopeFor(session));
    const started = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<void>();
    const parent = mutations.run(
      { session, idempotencyKey: 'prompt', method: 'session/prompt', payload: {} },
      async ({ operationId }) => {
        started.resolve(operationId);
        await finish.promise;
        return {};
      },
    );
    const parentResult = expect(parent).rejects.toMatchObject({ reason: 'original_lease' });
    let cancellations = 0;
    const operationId = await started.promise;
    await expect(
      mutations.run(
        {
          session,
          parent: operationId,
          idempotencyKey: 'cancel',
          method: 'session/cancel',
          payload: {},
        },
        () => {
          cancellations++;
        },
      ),
    ).rejects.toMatchObject({ reason: 'original_lease' });
    expect(cancellations).toBe(0);
    finish.resolve();
    await parentResult;
  }));

test('durable cancellation stays idempotent after the original parent terminal', () =>
  withStore(async (store) => {
    const mutations = await createAcpMutations({ store, ...binding, assertCurrent() {} });
    const started = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<void>();
    const parent = mutations.run(
      { session, idempotencyKey: 'prompt', method: 'session/prompt', payload: {} },
      async ({ operationId }) => {
        started.resolve(operationId);
        await finish.promise;
        return { stopReason: 'cancelled' };
      },
    );
    const input = {
      session,
      parent: await started.promise,
      idempotencyKey: 'cancel',
      method: 'session/cancel',
      payload: {},
    };
    let sends = 0;
    await mutations.run(input, () => {
      sends++;
    });
    finish.resolve();
    await parent;
    const repeated = await mutations.run(input, () => {
      sends++;
    });
    expect([repeated.phase, sends]).toEqual(['already-completed', 1]);
  }));

test('observer replay reports dropped history and never crosses a session boundary', () =>
  withStore(async (store) => {
    const mutations = await createAcpMutations({ store, ...binding, assertCurrent() {} });
    const subscriptions = createAcpSubscriptions(mutations.binding);
    const observer = subscriptions.subscribe({ subscriberId: 'window', session, after: 0 });
    const foreign = parseSessionRef({ ...session, nativeSessionId: 'another-session' });
    for (let index = 0; index < 130; index++)
      subscriptions.emit({ type: 'session.update', session: foreign, index });
    subscriptions.emit({ type: 'session.update', session, marker: 'right-session' });
    const replay = observer.read();
    expect([replay.status, replay.events.length, replay.events[0]?.marker]).toEqual([
      'partial',
      1,
      'right-session',
    ]);
    observer.detach();
    expect(subscriptions.count).toBe(0);
    expect(() => observer.read()).toThrow();
    subscriptions.close();
  }));

test.each(['intent', 'accepted', 'sent'])(
  'process loss after durable %s never auto-replays native work',
  (phase) =>
    withStore(async (store) => {
      let current = true;
      const wrapped: RuntimeStore = {
        ...store,
        async mutateControl(input) {
          const result = await store.mutateControl(input);
          if (isPhase(input, 'session/new', phase)) current = false;
          return result;
        },
        async mutate(input) {
          const result = await store.mutate(input);
          if (isPhase(input, 'session/new', phase)) current = false;
          return result;
        },
      };
      const mutations = await createAcpMutations({
        store: wrapped,
        ...binding,
        assertCurrent() {
          if (!current) throw new AcpError('reconcile_required', 'stale_generation');
        },
      });
      let sends = 0;
      const input = {
        idempotencyKey: 'process-loss',
        method: 'session/new',
        payload: { cwd: '/workspace' },
      };
      await expect(
        mutations.run(input, () => {
          sends++;
          return {};
        }),
      ).rejects.toMatchObject({ reason: 'stale_generation' });
      await expect(
        mutations.run(input, () => {
          sends++;
          return {};
        }),
      ).rejects.toBeDefined();
      const operations = (await store.page({ collection: 'operations' })).items.filter(
        (item) =>
          item.value !== null &&
          typeof item.value === 'object' &&
          !Array.isArray(item.value) &&
          record(item.value).method === 'session/new',
      );
      expect(sends).toBe(0);
      expect(record(operations[0]?.value).phase).toBe(
        phase === 'sent' ? 'reconciling' : 'accepted',
      );
    }),
);

test('loss after native enqueue stays reconciling and cannot resend', () =>
  withStore(async (store) => {
    let current = true;
    const mutations = await createAcpMutations({
      store,
      ...binding,
      assertCurrent() {
        if (!current) throw new AcpError('reconcile_required', 'stale_generation');
      },
    });
    let sends = 0;
    const input = { session, idempotencyKey: 'sent-loss', method: 'session/prompt', payload: {} };
    await expect(
      mutations.run(input, () => {
        sends++;
        current = false;
        return {};
      }),
    ).rejects.toMatchObject({ reason: 'stale_generation' });
    current = true;
    await expect(
      mutations.run(input, () => {
        sends++;
        return {};
      }),
    ).rejects.toMatchObject({ reason: 'operation_phase' });
    expect(sends).toBe(1);
  }));
