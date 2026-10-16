// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import type { Item, Json, RuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { encodeSessionKey, parseSessionRef } from '../../../shared/runtime/identity.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import { inspectCapabilities, record } from '../../../shared/runtime/native/acp/capabilities.js';
import { jsonValue } from '../../../shared/runtime/capabilities.js';
import { createAcpMutations } from '../../../bridge/runtime/drivers/acpMutations.js';
import type { AcpMutations } from '../../../bridge/runtime/drivers/acpMutations.js';
import { createAcpInteractions } from '../../../bridge/runtime/drivers/acpInteractions.js';
import { createAcpSessions } from '../../../bridge/runtime/drivers/acpSessions.js';
import { createAcpExtensions } from '../../../bridge/runtime/drivers/acpExtensions.js';
import type { AcpNativeInput } from '../../../bridge/runtime/drivers/acpExtensions.js';
import type { AcpObject, AcpRpc } from '../../../bridge/runtime/drivers/acpRpc.js';

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
const answer = { outcome: { outcome: 'selected', optionId: 'allow' } };
const capabilities = inspectCapabilities({ protocolVersion: 1, agentCapabilities: {} });

async function withStore(action: (store: RuntimeStore) => Promise<void>) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'acp-pr177-unit-'));
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

function reasonOf(error: unknown) {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const { reason } = error;
    if (typeof reason === 'string') return reason;
  }
  return `unexpected:${String(error)}`;
}

function phaseOf(item: Item | null) {
  if (!item || item.value === undefined || item.value === null) return null;
  return record(item.value).phase;
}

function interactionIds(events: readonly AcpObject[]) {
  return events
    .filter((event) => event.type === 'interaction.pending')
    .map((event) => (typeof event.interactionId === 'string' ? event.interactionId : ''));
}

interface InteractionHarness {
  readonly mutations: AcpMutations;
  readonly interactions: ReturnType<typeof createAcpInteractions>;
  readonly active: Map<string, string>;
  readonly replies: (string | number)[];
  readonly requests: string[];
  readonly events: AcpObject[];
  readonly reusePromises: Promise<unknown>[];
  startParent(key: string, scope: SessionRef): Promise<{
    readonly parent: string;
    readonly prompt: Promise<unknown>;
    release(): void;
  }>;
}

async function openInteractions(
  store: RuntimeStore,
  options: { readonly reuseOnReply?: boolean } = {},
): Promise<InteractionHarness> {
  const mutations = await createAcpMutations({ store, ...binding, assertCurrent() {} });
  const replies: (string | number)[] = [];
  const requests: string[] = [];
  const events: AcpObject[] = [];
  const reusePromises: Promise<unknown>[] = [];
  const rpc: AcpRpc = {
    async request(method: string, params: Json) {
      requests.push(`${method}:${String(record(params).value ?? '')}`);
      return { configOptions: [] };
    },
    reply(id: string | number) {
      replies.push(id);
      if (options.reuseOnReply)
        // The native ID is free the instant the reply is written, so the peer's next
        // request for it races this run's database finalization.
        reusePromises.push(interactions.receive(permissionRequest(Number(id))));
    },
    notify() {},
    assertCurrent() {},
    active: true,
    processGeneration: binding.processGeneration,
    pid: 1,
    async close() {},
  };
  const active = new Map<string, string>();
  const interactions = createAcpInteractions({
    store,
    mutations,
    rpc,
    active,
    emit: (event) => {
      events.push(event);
    },
    sessionFor: (id) =>
      mutations.scopeFor(
        parseSessionRef({
          environmentId: binding.target,
          harnessInstanceId: binding.harnessInstanceId,
          nativeSessionId: id,
        }),
      ).session as SessionRef,
  });
  return {
    mutations,
    interactions,
    active,
    replies,
    requests,
    events,
    reusePromises,
    async startParent(key, scope) {
      const started = Promise.withResolvers<string>();
      const gate = Promise.withResolvers<void>();
      const prompt = mutations.run(
        { session: scope, idempotencyKey: key, method: 'session/prompt', payload: {} },
        async ({ operationId }) => {
          started.resolve(operationId);
          await gate.promise;
          return { stopReason: 'end_turn' };
        },
      );
      const parent = await started.promise;
      active.set(scope.nativeSessionId, parent);
      return { parent, prompt, release: () => gate.resolve() };
    },
  };
}

function permissionRequest(id: number, nativeSessionId = session.nativeSessionId) {
  return {
    id,
    method: 'session/request_permission',
    params: {
      sessionId: nativeSessionId,
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
      toolCall: { toolCallId: 'tool-1', title: 'controlled' },
    },
  };
}

test('cross-session concurrent completion retries only the finishing CAS and releases both leases', () =>
  withStore(async (store) => {
    const parked = Promise.withResolvers<void>();
    const peerFinished = Promise.withResolvers<void>();
    let terminalSeen = false;
    const firstKey = `acp-operation:${fingerprint([
      binding.target,
      binding.harnessInstanceId,
      encodeSessionKey(session),
      'prompt-a',
    ])}`;
    // Holding the first terminal CAS is what forces the cross-session interleaving.
    const wrapped: RuntimeStore = {
      ...store,
      async mutateControl(input) {
        const terminal = input.changes.some(
          (change) => change.key === firstKey && record(change.value).phase === 'terminal',
        );
        if (terminal && !terminalSeen) {
          terminalSeen = true;
          parked.resolve();
          await peerFinished.promise;
        }
        return store.mutateControl(input);
      },
    };
    const mutations = await createAcpMutations({ store: wrapped, ...binding, assertCurrent() {} });
    const other = parseSessionRef({ ...session, nativeSessionId: 'sess-b' });
    const first = mutations.run(
      { session, idempotencyKey: 'prompt-a', method: 'session/prompt', payload: {} },
      async () => ({ stopReason: 'end_turn' }),
    );
    await parked.promise;
    const second = mutations.run(
      { session: other, idempotencyKey: 'prompt-b', method: 'session/prompt', payload: {} },
      async () => ({ stopReason: 'end_turn' }),
    );
    void second.then(
      () => peerFinished.resolve(),
      () => peerFinished.resolve(),
    );
    const settled = await Promise.allSettled([first, second]);
    const outcomes = settled.map((item) =>
      item.status === 'fulfilled' ? item.value.phase : reasonOf(item.reason),
    );
    const leaseOf = async (scope: SessionRef) =>
      (
        await store.getControl({
          collection: 'operations',
          key: mutations.leaseKey(mutations.scopeFor(scope)),
        })
      )?.value ?? null;
    let followUp = 'ok';
    try {
      await mutations.run(
        { session, idempotencyKey: 'prompt-a-2', method: 'session/prompt', payload: {} },
        async () => ({ stopReason: 'end_turn' }),
      );
    } catch (error) {
      followUp = reasonOf(error);
    }
    expect([outcomes, await leaseOf(session), await leaseOf(other), followUp]).toEqual([
      ['native-executed', 'native-executed'],
      null,
      null,
      'ok',
    ]);
  }));

test('five and eight in-flight sessions completing together all finalize and release every lease', async () => {
  for (const count of [5, 8]) {
    await withStore(async (store) => {
      const mutations = await createAcpMutations({ store, ...binding, assertCurrent() {} });
      const gate = Promise.withResolvers<void>();
      const nativeCalls: number[] = [];
      const runs: { scope: SessionRef; run: Promise<{ phase: string }> }[] = [];
      // Every session enters native execution before the next one starts, so each claim is
      // durable and holds its own lease, and only the completions are concurrent.
      for (let index = 0; index < count; index++) {
        const scope = parseSessionRef({ ...session, nativeSessionId: `sess-${index}` });
        const entered = Promise.withResolvers<void>();
        nativeCalls.push(0);
        runs.push({
          scope,
          run: mutations.run(
            { session: scope, idempotencyKey: `prompt-${index}`, method: 'session/prompt', payload: {} },
            async () => {
              nativeCalls[index] += 1;
              entered.resolve();
              await gate.promise;
              return { stopReason: 'end_turn' };
            },
          ),
        });
        await entered.promise;
      }
      gate.resolve();
      const settled = await Promise.allSettled(runs.map((item) => item.run));
      const outcomes = settled.map((item) =>
        item.status === 'fulfilled' ? item.value.phase : reasonOf(item.reason),
      );
      const leases = await Promise.all(
        runs.map((item) =>
          store.getControl({
            collection: 'operations',
            key: mutations.leaseKey(mutations.scopeFor(item.scope)),
          }),
        ),
      );
      const followUps: string[] = [];
      for (const item of runs) {
        try {
          await mutations.run(
            {
              session: item.scope,
              idempotencyKey: `follow-${item.scope.nativeSessionId}`,
              method: 'session/prompt',
              payload: {},
            },
            async () => ({ stopReason: 'end_turn' }),
          );
          followUps.push('ok');
        } catch (error) {
          followUps.push(reasonOf(error));
        }
      }
      expect([
        count,
        outcomes,
        leases.map((item) => item?.value ?? null),
        followUps,
        nativeCalls,
      ]).toEqual([
        count,
        Array.from({ length: count }, () => 'native-executed'),
        Array.from({ length: count }, () => null),
        Array.from({ length: count }, () => 'ok'),
        Array.from({ length: count }, () => 1),
      ]);
    });
  }
});

test('permission-reply idempotency summary folds in the interaction identity', () =>
  withStore(async (store) => {
    const harness = await openInteractions(store);
    const parent = await harness.startParent('prompt', session);
    await harness.interactions.receive(permissionRequest(7));
    await harness.interactions.receive(permissionRequest(8));
    const ids = interactionIds(harness.events);
    expect(ids).toHaveLength(2);
    const first = await harness.interactions.respond({
      interactionId: ids[0],
      session,
      answer,
      idempotencyKey: 'shared-key',
    });
    let second = 'ok';
    try {
      await harness.interactions.respond({
        interactionId: ids[1],
        session,
        answer,
        idempotencyKey: 'shared-key',
      });
    } catch (error) {
      second = reasonOf(error);
    }
    const durable = await Promise.all(
      ids.map((id) => store.getControl({ collection: 'interactions', key: id })),
    );
    const visible = await harness.interactions.list();
    parent.release();
    await parent.prompt;
    expect([
      first.phase,
      second,
      harness.replies,
      durable.map((item) => phaseOf(item)),
      visible.length,
    ]).toEqual(['native-executed', 'idempotency_mismatch', [7], ['replied', 'pending'], 1]);
  }));

test('sequential reuse of a native request ID inside one prompt is not judged a duplicate', () =>
  withStore(async (store) => {
    const harness = await openInteractions(store);
    const parent = await harness.startParent('prompt', session);
    await harness.interactions.receive(permissionRequest(7));
    const [firstId] = interactionIds(harness.events);
    await harness.interactions.respond({
      interactionId: firstId,
      session,
      answer,
      idempotencyKey: 'reply-one',
    });
    let reuse = 'ok';
    try {
      await harness.interactions.receive(permissionRequest(7));
    } catch (error) {
      reuse = reasonOf(error);
    }
    const pending = await harness.interactions.list();
    expect(pending).toHaveLength(1);
    await harness.interactions.respond({
      interactionId: pending[0].interactionId,
      session,
      answer,
      idempotencyKey: 'reply-two',
    });
    parent.release();
    await parent.prompt;
    expect([
      reuse,
      harness.replies,
      pending[0].nativeRequestId,
      pending[0].interactionId !== firstId,
    ]).toEqual(['ok', [7, 7], 7, true]);
  }));

test('a native ID is reusable the moment its reply is on the wire', () =>
  withStore(async (store) => {
    const harness = await openInteractions(store, { reuseOnReply: true });
    const parent = await harness.startParent('prompt', session);
    await harness.interactions.receive(permissionRequest(7));
    const [firstId] = interactionIds(harness.events);
    await harness.interactions.respond({
      interactionId: firstId,
      session,
      answer,
      idempotencyKey: 'reply-one',
    });
    const reuseResults = await Promise.allSettled(harness.reusePromises);
    const reuse = reuseResults.map((item) =>
      item.status === 'fulfilled' ? 'ok' : reasonOf(item.reason),
    );
    const visible = await harness.interactions.list();
    let second = 'no-pending';
    if (visible.length)
      try {
        await harness.interactions.respond({
          interactionId: visible[0].interactionId,
          session,
          answer,
          idempotencyKey: 'reply-two',
        });
        second = 'ok';
      } catch (error) {
        second = reasonOf(error);
      }
    parent.release();
    await parent.prompt;
    expect([
      reuse,
      visible.map((item) => item.nativeRequestId),
      visible.length ? visible[0].interactionId !== firstId : false,
      second,
      harness.replies,
    ]).toEqual([['ok'], [7], true, 'ok', [7, 7]]);
  }));

test('genuinely concurrent occupancy of one native request ID is still rejected', () =>
  withStore(async (store) => {
    const harness = await openInteractions(store);
    const parent = await harness.startParent('prompt', session);
    const settled = await Promise.allSettled([
      harness.interactions.receive(permissionRequest(7)),
      harness.interactions.receive(permissionRequest(7)),
    ]);
    parent.release();
    await parent.prompt;
    expect([
      settled.map((item) => (item.status === 'fulfilled' ? 'ok' : reasonOf(item.reason))).sort(),
      interactionIds(harness.events).length,
      (await harness.interactions.list()).length,
    ]).toEqual([['duplicate_native_request', 'ok'], 1, 1]);
  }));

test('retrying an older config operation does not roll back the current cache', () =>
  withStore(async (store) => {
    const mutations = await createAcpMutations({ store, ...binding, assertCurrent() {} });
    const requests: string[] = [];
    const rpc: AcpRpc = {
      async request(method: string, params: Json) {
        const value = String(record(params).value ?? '');
        requests.push(`${method}:${value}`);
        return {
          configOptions: [
            {
              id: 'model',
              category: 'model',
              type: 'select',
              currentValue: value,
              options: [
                { value: 'a', name: 'A' },
                { value: 'b', name: 'B' },
              ],
            },
          ],
        };
      },
      reply() {},
      notify() {},
      assertCurrent() {},
      active: true,
      processGeneration: binding.processGeneration,
      pid: 1,
      async close() {},
    };
    const sessions = createAcpSessions({
      rpc,
      mutations,
      capabilities,
      queue: async (action) => action(),
      cwd: '/workspace',
      emit() {},
    });
    const configSession = parseSessionRef({ ...session, nativeSessionId: 'cfg' });
    sessions.register({
      sessionId: configSession.nativeSessionId,
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'a',
          options: [
            { value: 'a', name: 'A' },
            { value: 'b', name: 'B' },
          ],
        },
      ],
    });
    const interactions = createAcpInteractions({
      store,
      mutations,
      rpc,
      active: new Map<string, string>(),
      emit() {},
      sessionFor: (id) =>
        parseSessionRef({
          environmentId: binding.target,
          harnessInstanceId: binding.harnessInstanceId,
          nativeSessionId: id,
        }),
    });
    const extensions = createAcpExtensions({
      capabilities,
      rpc,
      mutations,
      sessions,
      interactions,
      queue: async (action) => action(),
      send: async () => ({}),
      cwd: '/workspace',
      agentId: 'qa',
      active: new Map<string, string>(),
    });
    const call = async (name: string, input: AcpNativeInput) => {
      const method = extensions.methods[name];
      if (!method) throw new Error(`missing declaration ${name}`);
      return method(input);
    };
    const first = await call('acp.setModel', {
      session: configSession,
      idempotencyKey: 'A',
      modelId: 'b',
    });
    const second = await call('acp.setModel', {
      session: configSession,
      idempotencyKey: 'B',
      modelId: 'a',
    });
    const retry = await call('acp.setModel', {
      session: configSession,
      idempotencyKey: 'A',
      modelId: 'b',
    });
    const reported = jsonValue(await call('getSessionConfigOptions', { session: configSession }));
    if (!Array.isArray(reported)) throw new Error('expected a config option list');
    expect([
      record(first).phase,
      record(second).phase,
      record(retry).phase,
      requests,
      record(reported[0]).currentValue,
    ]).toEqual([
      'native-executed',
      'native-executed',
      'already-completed',
      ['session/set_config_option:b', 'session/set_config_option:a'],
      'a',
    ]);
  }));
