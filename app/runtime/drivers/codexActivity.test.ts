// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexDriver } from '../../../bridge/runtime/drivers/codexDriver.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeHost } from '../../../bridge/runtime/runtimeHost.js';
import { createWorkspaceService } from '../../../bridge/runtime/workspaceService.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../../shared/runtime/identity.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';

function subscription(value: unknown): value is AsyncIterableIterator<unknown> {
  return typeof value === 'object' && value !== null &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function' &&
    typeof Reflect.get(value, 'next') === 'function' && typeof Reflect.get(value, 'return') === 'function';
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-codex-activity-'));
  const environmentId = parseEnvironmentId(randomUUID()), harnessInstanceId = parseHarnessInstanceId(randomUUID()), epoch = randomUUID();
  const store = createRuntimeStore({ stateDirectory: path.join(directory, 'state'), environmentId, epoch, ownerId: randomUUID() });
  await store.ready;
  const runtime = createRuntimeHost({ environmentId, role: 'local' }); runtime.start();
  const workspace = await createWorkspaceService({ target: environmentId, epoch, roots: [{ root: directory, permissions: ['read'] }] });
  let receive = (_raw: string) => {}, status: JsonValue = { type: 'active' };
  const methods: string[] = [];
  const calls: { method: string; params: JsonValue }[] = [];
  let createdThread: { id: string; cwd: string; modelProvider: string } | undefined;
  const driver = await createCodexDriver({
    environmentId, harnessInstanceId, epoch, processGeneration: 1, store, runtime, workspace,
    allowedWorkspaces: workspace.workspaces.map(root => root.key), isProcessCurrent: () => true,
    transport: {
      subscribe(callback) { receive = callback; return () => {}; }, close() {},
      send(raw) {
        const message = JSON.parse(raw); if (message.id === undefined) return;
        methods.push(message.method);
        calls.push({ method: message.method, params: message.params });
        if (message.method === 'thread/start') createdThread = { id: 'native-custom', cwd: message.params.cwd, modelProvider: message.params.modelProvider };
        const thread = { id: 'native-outside', name: 'Outside turn', cwd: directory, status, modelProvider: 'openai' };
        const result = message.method === 'initialize' ? { userAgent: 'codex-cli/0.160.0 controlled' }
          : message.method === 'thread/list' ? { data: message.params.archived ? [] : [thread], nextCursor: null }
          : message.method === 'thread/read' ? { thread: message.params.threadId === createdThread?.id ? createdThread : thread }
          : message.method === 'thread/start' ? { thread: createdThread }
          : message.method === 'turn/start' ? { turn: { id: 'fixture-turn' } } : {};
        receive(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  const context = { environmentId, harnessInstanceId };
  const core = driver.registration.driver.core;
  return { core, context, store, methods, calls, workspaceKey: workspace.workspaces[0]!.key, status: (value: JsonValue) => { status = value; },
    notify: (method: string, params: JsonValue) => receive(JSON.stringify({ method, params })),
    async close() { await driver.close(); await workspace.close(); await runtime.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); } };
}

it('preserves actual native status in read-only Codex discovery and selection metadata', async () => {
  const state = await fixture();
  try {
    const list = await state.core.listSessionPage!({ ...state.context, params: { limit: 1 } });
    expect(list).toMatchObject({ items: [{ status: 'busy' }] });
    state.status({ type: 'idle' });
    const selected = await state.core.getSession!({ ...state.context, params: {}, session: { ...state.context, nativeSessionId: 'native-outside' } });
    expect(selected).toMatchObject({ status: 'idle' });
  } finally { await state.close(); }
});

it('publishes external native lifecycle activity without allocating a Vis operation or sending a prompt', async () => {
  const state = await fixture();
  const seen: unknown[] = [];
  const observer = await state.core.subscribe!({ ...state.context, params: {} });
  if (!subscription(observer)) { await state.close(); throw new Error('Expected a native async subscription'); }
  const pump = (async () => { for await (const event of observer) seen.push(event); })();
  try {
    state.notify('turn/started', { threadId: 'native-outside', turn: { id: 'external-turn', status: 'inProgress' } });
    await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ type: 'session.activity', status: 'running', session: { ...state.context, nativeSessionId: 'native-outside' } })));
    state.notify('turn/completed', { threadId: 'native-outside', turn: { id: 'external-turn', status: 'completed' } });
    await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ type: 'session.activity', status: 'idle' })));
    expect((await state.store.page({ collection: 'operations', limit: 10 })).items).toHaveLength(0);
    expect(state.methods).toEqual(['initialize']);
  } finally { await observer.return?.(); await pump; await state.close(); }
});

it('refuses a model from a different provider before dispatching a turn', async () => {
  const state = await fixture();
  try {
    const session = { ...state.context, nativeSessionId: 'native-outside' };
    await expect(state.core.send!({
      ...state.context,
      session,
      params: {
        idempotencyKey: 'provider-mismatch',
        native: { input: [{ type: 'text', text: 'test prompt' }], model: 'org/model', expectedModelProvider: 'custom' },
      },
    })).rejects.toThrow('codex.model_provider_mismatch');
    expect(state.methods).toContain('thread/read');
    expect(state.methods).not.toContain('turn/start');
  } finally { await state.close(); }
});

it('creates a custom-provider thread and dispatches its slash-containing model to that thread', async () => {
  const state = await fixture();
  try {
    await state.core.createSession!({
      ...state.context,
      params: { workspaceKey: state.workspaceKey, idempotencyKey: 'create-custom', native: { model: 'org/model', modelProvider: 'custom' } },
    });
    await state.core.send!({
      ...state.context,
      session: { ...state.context, nativeSessionId: 'native-custom' },
      params: { idempotencyKey: 'send-custom', native: { input: [{ type: 'text', text: 'test prompt' }], model: 'org/model', expectedModelProvider: 'custom' } },
    });
    expect(state.calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ modelProvider: 'custom', model: 'org/model' });
    const sent = state.calls.find(call => call.method === 'turn/start')?.params;
    expect(sent).toMatchObject({ threadId: 'native-custom', model: 'org/model' });
    expect(sent).not.toHaveProperty('expectedModelProvider');
  } finally { await state.close(); }
});
