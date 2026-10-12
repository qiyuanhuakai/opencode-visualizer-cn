// @vitest-environment node
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
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
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseSessionRef,
} from '../../../shared/runtime/identity.js';
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

import { createHash, randomUUID } from 'node:crypto';
import { createAcpDriver } from '../../../bridge/runtime/drivers/acpDriver.js';
import { createAcpHistory } from '../../../bridge/runtime/drivers/acpSessions.js';
import { createWorkspaceService } from '../../../bridge/runtime/workspaceService.js';
import {
  createHistoryStream,
  createHistoryDiskBudget,
  HISTORY_STREAM_LIMITS,
} from '../../../bridge/runtime/historyStream.js';
import type { InternalNativeHistoryHandle } from '../../../bridge/runtime/historyService.js';

const historyOwner = '22222222-2222-4222-8222-222222222222';
const selected = parseSessionRef({
  environmentId: binding.target,
  harnessInstanceId: binding.harnessInstanceId,
  nativeSessionId: 'sel',
});
const historyLogin = {
  environmentId: parseEnvironmentId(binding.target),
  harnessInstanceId: parseHarnessInstanceId(binding.harnessInstanceId),
};
const historyParams = { epoch: binding.epoch, processGeneration: 1 };

function updateFrame(sessionId: string, text: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
}

function frameAgentScript(emitExpression: string) {
  return [
    "const readline = require('node:readline');",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1' } } }) + '\\n');",
    "  } else if (message.method === 'session/new') {",
    '    process.stdout.write(' + emitExpression + ');',
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sel' } }) + '\\n');",
    '  }',
    '});',
  ].join('\n');
}

async function historyDriver(emitExpression: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-acp-history-'));
  const manager = createAcpProcessManager();
  await manager.reconcile([
    {
      id: 'hist',
      name: 'Hist ACP',
      command: process.execPath,
      args: ['-e', frameAgentScript(emitExpression)],
      enabled: true,
    },
  ]);
  const store = createRuntimeStore({
    stateDirectory: path.join(dir, 'runtime'),
    environmentId: binding.target,
    ownerId: historyOwner,
    epoch: binding.epoch,
  });
  await store.ready;
  const workspace = await createWorkspaceService({
    target: binding.target,
    epoch: binding.epoch,
    roots: [{ root: dir, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }],
  });
  const connection = workspace.connect({
    target: binding.target,
    epoch: binding.epoch,
    generation: 0,
    subscriberId: randomUUID(),
    assertCurrent: () => {},
  });
  const workspaceKey = workspace.workspaces[0]?.key;
  if (!workspaceKey) throw new TypeError('missing workspace key');
  const driver = await createAcpDriver({
    store,
    manager,
    agentId: 'hist',
    target: binding.target,
    harnessInstanceId: binding.harnessInstanceId,
    epoch: binding.epoch,
    workspace: connection,
    workspaceKey,
    cwd: dir,
  });
  return {
    driver,
    manager,
    store,
    dir,
    async close() {
      await driver.close();
      await manager.stopAll();
      await workspace.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function historyStore(scope: string) {
  return createHistoryStream({
    scope,
    createDirectory: () => mkdtemp(path.join(tmpdir(), 'vis-acp-history-spool-')),
    globalDisk: createHistoryDiskBudget(),
  });
}

function openProducer(driver: Awaited<ReturnType<typeof historyDriver>>['driver']) {
  const method = driver.driver.core.openHistory;
  if (typeof method !== 'function') throw new TypeError('missing openHistory producer');
  return method({ ...historyLogin, session: selected, params: historyParams });
}

async function drainDescriptor(handle: InternalNativeHistoryHandle, pageId: string, descriptorId: string) {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await handle.chunk({ pageId, descriptorId, offset, signal: new AbortController().signal });
    expect(chunk.bytes.byteLength).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.chunkBytes);
    expect(chunk.bytes.buffer.byteLength).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.chunkBytes);
    parts.push(Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength));
    const next = chunk.nextOffset;
    chunk.release();
    if (next === null) break;
    offset = next;
  }
  return Buffer.concat(parts);
}

describe('ACP native selected-history producer over a controlled stdio fixture', () => {
  test('registers the producer and advertises no durable archive', async () => {
    const fx = await historyDriver("process.stdout.write('')");
    try {
      const manifest = fx.driver.manifest;
      expect(manifest.core.openHistory).toEqual({ state: 'supported' });
      for (const support of Object.values(manifest.core)) expect(support).toEqual({ state: 'supported' });
      const handle = (await openProducer(fx.driver)) as InternalNativeHistoryHandle;
      expect(handle.capabilities).toEqual({ archive: 'live-only', recordStream: true, live: 'invalidate' });
    } finally {
      await fx.close();
    }
  });

  test('captures only the selected session raw updates and serves them byte-exact', { timeout: 20_000 }, async () => {
    const first = updateFrame('sel', 'selected-one');
    const foreign = updateFrame('other', 'foreign-one');
    const second = updateFrame('sel', 'selected-two');
    const emitted = `${[first, foreign, second].join('\n')}\n`;
    const expected = `[${first},${second}]`;
    const fx = await historyDriver(JSON.stringify(emitted));
    const streamStore = await historyStore(JSON.stringify([binding, session]));
    try {
      const handle = (await openProducer(fx.driver)) as InternalNativeHistoryHandle;
      await handle.open({ signal: new AbortController().signal, streamStore });
      const createSession = fx.driver.driver.core.createSession;
      if (typeof createSession !== 'function') throw new TypeError('missing createSession');
      await createSession({
        ...historyLogin,
        params: { ...historyParams, idempotencyKey: 'hist-1', directory: fx.dir },
      });
      expect(await handle.read({ after: 0, signal: new AbortController().signal })).toMatchObject({
        through: 2,
        changed: true,
        status: 'current',
      });
      const page = await handle.page({ signal: new AbortController().signal });
      if (!page.document) throw new TypeError('missing native document');
      expect(page).toMatchObject({ completeness: 'partial', cursor: null });
      expect(page.items.map((item) => item.recordId.length > 0)).toEqual([true, true]);

      const document = await drainDescriptor(handle, page.pageId, page.document.id);
      expect(document.toString('utf8')).toBe(expected);
      expect(document.toString('utf8')).not.toContain('foreign-one');
      expect(createHash('sha256').update(document).digest('hex')).toBe(page.document.sha256);
      expect(page.document.totalBytes).toBe(Buffer.byteLength(expected));

      const records = page.items;
      for (const [index, frame] of [first, second].entries()) {
        const item = records[index];
        if (item?.kind !== 'stream') throw new TypeError('missing streamed record');
        const bytes = await drainDescriptor(handle, page.pageId, item.descriptor.id);
        expect(bytes.toString('utf8')).toBe(frame);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.descriptor.sha256);
      }
      expect(streamStore.usage().diskBytes).toBe(page.document.totalBytes);
      expect(streamStore.usage().pages).toBe(1);
      await handle.close();
    } finally {
      await streamStore.close();
      await fx.close();
    }
  });

  test('captures a selected update larger than the legacy 256KiB in-memory discard', { timeout: 20_000 }, async () => {
    const frameShape =
      "{ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sel', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y'.repeat(600000) } } } }";
    const frameText = JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sel',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'y'.repeat(600000) },
        },
      },
    });
    const script = [
      "const readline = require('node:readline');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const message = JSON.parse(line);',
      "  if (message.method === 'trigger') process.stdout.write(JSON.stringify(" +
        frameShape +
        ") + '\\n');",
      '});',
    ].join('\n');
    const manager = createAcpProcessManager();
    await manager.reconcile([
      { id: 'mid', name: 'Mid ACP', command: process.execPath, args: ['-e', script], enabled: true },
    ]);
    const socket = Object.assign(new EventEmitter(), { send() {}, close() {} });
    const attachment = manager.attach('mid', socket, { runtime: true });
    let fed = 0;
    const producer = createAcpHistory({
      session: selected,
      authority: { epoch: binding.epoch, processGeneration: 1 },
      current: () => true,
      assertCurrent: async () => {},
      attachRaw: (tap) =>
        attachment.setRawTap(
          tap
            ? (chunk) => {
                fed += chunk.byteLength;
                tap(chunk);
              }
            : undefined,
        ),
    });
    const streamStore = await historyStore(JSON.stringify([binding, session]));
    try {
      await producer.open({ signal: new AbortController().signal, streamStore });
      socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'trigger', params: {} }));
      await vi.waitFor(() => expect(fed).toBeGreaterThanOrEqual(Buffer.byteLength(frameText) + 1));
      const page = await producer.page({ signal: new AbortController().signal });
      if (!page.document) throw new TypeError('missing native document');
      expect(Buffer.byteLength(frameText)).toBeGreaterThan(262144);
      expect(page.document.totalBytes).toBeGreaterThan(262144);
      const document = await drainDescriptor(producer, page.pageId, page.document.id);
      expect(document.toString('utf8')).toBe(`[${frameText}]`);
      expect(createHash('sha256').update(document).digest('hex')).toBe(page.document.sha256);
      expect(page.items).toHaveLength(1);
      expect(page.completeness).toBe('partial');
    } finally {
      await producer.close();
      await streamStore.close();
      await manager.stopAll();
    }
  });

  test('rejects an oversized selected update through the substrate bounds before assembly', { timeout: 20_000 }, async () => {
    const emit =
      "JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sel', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(2200000) } } } }) + '\\n'";
    const script = [
      "const readline = require('node:readline');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const message = JSON.parse(line);',
      "  if (message.method === 'trigger') process.stdout.write(" + emit + ');',
      '});',
    ].join('\n');
    const manager = createAcpProcessManager();
    await manager.reconcile([
      { id: 'big', name: 'Big ACP', command: process.execPath, args: ['-e', script], enabled: true },
    ]);
    const socket = Object.assign(new EventEmitter(), {
      send() {},
      close() {},
    });
    const attachment = manager.attach('big', socket, { runtime: true });
    let fed = 0;
    const producer = createAcpHistory({
      session: selected,
      authority: { epoch: binding.epoch, processGeneration: 1 },
      current: () => true,
      assertCurrent: async () => {},
      attachRaw: (tap) =>
        attachment.setRawTap(
          tap
            ? (chunk) => {
                fed += chunk.byteLength;
                tap(chunk);
              }
            : undefined,
        ),
    });
    const streamStore = await historyStore(JSON.stringify([binding, session]));
    try {
      await producer.open({ signal: new AbortController().signal, streamStore });
      socket.emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'trigger', params: {} }));
      await vi.waitFor(() => expect(fed).toBeGreaterThan(2100000));
      await expect(producer.page({ signal: new AbortController().signal })).rejects.toMatchObject({
        code: 'source_unavailable',
      });
      expect(streamStore.usage()).toMatchObject({ diskBytes: 0, pages: 0, fileHandles: 0 });
      expect(manager.getStatus()[0]?.droppedFrames ?? 0).toBeGreaterThan(0);
    } finally {
      await producer.close();
      await streamStore.close();
      await manager.stopAll();
    }
  });
});
