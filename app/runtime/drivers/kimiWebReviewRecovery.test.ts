// @vitest-environment node
import { parseNativeCapabilities } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import { createKimiWebDriver } from '../../../bridge/runtime/drivers/kimiWebDriver.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createRawWebSocketPeer, createWebSocketAccept } from '../../../bridge/webSocketFrames.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'review-session' });
const context = { environmentId, harnessInstanceId, session, params: {} };
async function fixture(legacy: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-review-'));
  const epoch = randomUUID();
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch });
  await store.ready;
  const state = { interactions: [] as Record<string, unknown>[], answers: [] as Record<string, unknown>[], legacy, gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined, seq: 1, turn: undefined as Record<string, unknown> | undefined, prompts: 0, historyGate: undefined as Promise<void> | undefined, historyEntered: undefined as (() => void) | undefined };
  const sockets = new Set<import('node:net').Socket>();
  const peers = new Set<ReturnType<typeof createRawWebSocketPeer>>();
  const controls: Record<string, unknown>[] = [];
  const send = (frame: object) => { for (const peer of peers) peer.send(JSON.stringify(frame)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const reply = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data })); };
    if (url.pathname === '/api/v1/meta') return reply({ server_id: 'review-server', backend: 'v2', server_version: '2.5.2', capabilities: { websocket: true } });
    if (url.pathname === '/openapi.json') {
      res.end(JSON.stringify({ paths: {
        '/api/v2/sessions': { get: {} },
        '/api/v1/sessions/{session_id}/transcript': { get: {} },
        '/api/v1/sessions/{session_id}/prompts': { post: {} },
        '/api/v1/sessions/{session_id}/interactions/{interaction_id}': { post: {} },
        '/api/v1/sessions/{session_id}/prompts/{tail}': { post: { operationId: 'promptAction' } },
        ...(state.legacy ? { '/api/v1/sessions/{session_id}/snapshot': { get: {} } } : { '/api/v1/sessions/{session_id}': { get: {} } }),
      } })); return;
    }
    if (url.pathname === '/asyncapi.json') { res.end(JSON.stringify({ components: { messages: { subscribe_v2: { name: 'subscribe_v2' }, ...(state.legacy ? { subscribe: { name: 'subscribe' } } : {}) } } })); return; }
    if (url.pathname === '/api/v1/sessions/review-session' || url.pathname.endsWith('/snapshot')) {
      const snapshot = url.pathname.endsWith('/snapshot');
      state.entered?.();
      if (state.gate) await state.gate;
      const value = { id: session.nativeSessionId, title: 'Captured response', workspace_id: 'review-workspace', busy: false };
      return reply(snapshot ? { session: value, epoch: 'native-review', as_of_seq: state.seq } : value);
    }
    if (url.pathname.endsWith('/transcript')) {
      if (url.searchParams.get('agent_id') === 'child' && state.historyGate) {
        state.historyEntered?.(); await state.historyGate;
        res.writeHead(500); res.end('{}'); return;
      }
      return reply({ items: state.turn ? [state.turn] : [], agents: [], interactions: state.interactions, attachments: [], prompts: [], has_more: false, seq: state.seq });
    }
    if (url.pathname.endsWith('/prompts') && req.method === 'POST') {
      const parts = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      state.prompts++; state.seq++;
      state.turn = { kind: 'turn', turnId: `t${state.prompts}`, triggerPromptId: body.prompt_id, state: 'running', steps: [] };
      send({ type: 'transcript.ops', session_id: session.nativeSessionId, payload: { agent_id: 'main', seq: state.seq, ops: [{ op: 'turn.upsert', turn: state.turn }] } });
      return reply({ prompt_id: body.prompt_id });
    }
    if (url.pathname.includes('/interactions/') && req.method === 'POST') {
      const parts = []; for await (const part of req) parts.push(part);
      state.answers.push(JSON.parse(Buffer.concat(parts).toString()));
      return reply({ outcome: 'answered', ended_at: '2026-11-09T00:00:00Z' });
    }
    reply({});
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createWebSocketAccept(String(req.headers['sec-websocket-key']))}\r\n\r\n`);
    const peer = createRawWebSocketPeer(socket, head); peers.add(peer); socket.once('close', () => peers.delete(peer));
    peer.send(JSON.stringify({ type: 'server_hello', payload: { protocol_version: 2, heartbeat_ms: 10000 } }));
    peer.on('message', (text: string) => {
      const frame = JSON.parse(text); controls.push(frame);
      if (frame.type === 'pong') return;
      // A successful resume at the current seq does not replay an already-read terminal.
      peer.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, payload: { accepted: [session.nativeSessionId], not_found: [], resync_required: [] } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const driver = await createKimiWebDriver({ environmentId, harnessInstanceId, store, endpoint: `http://127.0.0.1:${address.port}`, getAuthorization: () => 'Bearer owned-review', getAuthority: () => ({ epoch, processGeneration: 1 }), ownership: 'borrowed' });
  return { driver, store, state, controls, send,
    async close() { state.gate = undefined; await driver.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
it.each([true, false])('captures the session response schema across concurrent inspect (legacy=%s)', async legacy => {
  const f = await fixture(legacy); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  try {
    f.state.gate = gate.promise; f.state.entered = entered.resolve;
    const read = f.driver.registration.driver.core.getSession!({ ...context });
    const outcome = Promise.resolve(read).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered.promise;
    f.state.legacy = !legacy;
    await f.driver.registration.driver.core.inspect!({ ...context });
    gate.resolve();
    const result = await outcome;
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ session, title: 'Captured response' });
  } finally { gate.resolve(); await f.close(); }
});
it.each(['reconnect', 'resync'] as const)('settles owned modern completion recovered through HTTP during %s without WS replay', async mode => {
  const f = await fixture(false);
  try {
    const send = f.driver.registration.driver.core.send!;
    const sent = await send({ ...context, params: { content: [{ type: 'text', text: 'owned' }], idempotencyKey: 'first' } }) as { operationId: string };
    await f.driver.flush();
    expect((await f.driver.operations!.journal.get(sent.operationId)).phase).not.toBe('terminal');
    f.state.turn = { ...f.state.turn, state: 'completed' }; f.state.seq = 7;
    if (mode === 'reconnect') await f.driver.reconnect();
    else f.send({ type: 'resync_required', session_id: session.nativeSessionId });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await f.driver.flush();
      if ((await f.driver.operations!.journal.get(sent.operationId)).phase === 'terminal') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await f.driver.flush();
    expect(await f.driver.operations!.journal.get(sent.operationId)).toMatchObject({ phase: 'terminal', outcome: 'completed' });
    expect(f.driver.diagnostics()).toMatchObject({ selected: 0, historySessions: 0 });
    await expect(send({ ...context, params: { content: [{ type: 'text', text: 'next' }], idempotencyKey: 'second' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.prompts).toBe(2);
  } finally { await f.close(); }
});

it('settles a proven main terminal after a different agent attachment fails', async () => {
  const f = await fixture(false); const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  try {
    const observed = await f.driver.registration.driver.core.subscribe!({ ...context }) as AsyncIterator<unknown>;
    const send = f.driver.registration.driver.core.send!;
    const sent = await send({ ...context, params: { content: [{ type: 'text', text: 'owned' }], idempotencyKey: 'first' } }) as { operationId: string };
    await f.driver.flush();
    f.state.historyGate = gate.promise; f.state.historyEntered = entered.resolve;
    const attaching = Promise.resolve(f.driver.registration.driver.core.subscribe!({ ...context, params: { agentId: 'child' } })).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered.promise;
    f.state.turn = { ...f.state.turn, state: 'completed' }; f.state.seq = 7;
    f.send({ type: 'transcript.ops', session_id: session.nativeSessionId, payload: { agent_id: 'main', seq: 7, ops: [{ op: 'turn.upsert', turn: f.state.turn }] } });
    const deadline = Date.now() + 3000;
    while (f.driver.diagnostics().eventQueue === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.driver.diagnostics().eventQueue).toBeGreaterThan(0);
    gate.resolve();
    expect((await attaching).error).toMatchObject({ code: 'source_unavailable', field: 'native_http' });
    await expect(f.driver.flush()).resolves.toBeUndefined();
    expect(await f.driver.operations!.journal.get(sent.operationId)).toMatchObject({ phase: 'terminal', outcome: 'completed' });
    await observed.return?.();
    expect(f.driver.diagnostics()).toMatchObject({ selected: 0, historySessions: 0 });
    await expect(send({ ...context, params: { content: [{ type: 'text', text: 'next' }], idempotencyKey: 'second' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.prompts).toBe(2);
  } finally { gate.resolve(); f.state.historyGate = undefined; await f.close(); }
});

it.each([false, true])('persists and answers a modern question only after proving its owned prompt and tool (dismiss=%s)', async dismiss => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    const sent = await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Question' }], idempotencyKey: 'question-send' } }) as { operationId: string };
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: 'AskUserQuestion' }] }] };
    f.state.interactions = [{ interactionId: 'question-1', interactionKind: 'question', toolCallId: 'owned-tool', state: 'pending', request: { session_id: session.nativeSessionId, questions: [{ id: 'q_0', question: 'Choose', options: [{ id: 'opt_0', label: 'First' }] }] } }];
    f.send({ type: 'interaction', session_id: session.nativeSessionId, agent_id: 'main', interaction_id: 'question-1', tool_call_id: 'owned-tool', kind: 'question', status: 'pending' });
    let pending;
    for (let i = 0; i < 100; i++) {
      pending = (await f.store.page({ collection: 'interactions', limit: 100 })).items.find(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction' && row.value.phase === 'pending');
      if (pending) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(pending).toBeDefined();
    await f.driver.flush();
    const answer: Record<string, JsonValue> = dismiss ? { dismiss: true } : { answers: { q_0: { kind: 'single', option_id: 'opt_0' } } };
    const params = { interactionId: pending!.key, answer, idempotencyKey: 'question-reply' };
    await expect(core.respondInteraction!({ ...context, session: { ...session, nativeSessionId: 'foreign-session' }, params })).rejects.toMatchObject({ field: 'interaction_scope' });
    await expect(core.respondInteraction!({ ...context, params })).resolves.toMatchObject({ phase: 'native-executed', parentOperationId: sent.operationId });
    expect(f.state.answers).toEqual([dismiss ? { kind: 'question', dismissed: true } : { kind: 'question', answers: params.answer.answers }]);
    await expect(core.respondInteraction!({ ...context, params })).rejects.toBeDefined();
    expect(f.state.answers).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(['external-prompt', 'wrong-turn', 'missing-tool', 'child-agent'])('does not adopt a modern question from %s', async variant => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    const sent = await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Question' }], idempotencyKey: 'question-unowned' } }) as { operationId: string };
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, ...(variant === 'external-prompt' ? { triggerPromptId: 'foreign-prompt' } : {}), ...(variant === 'wrong-turn' ? { turnId: 'wrong-turn' } : {}), steps: variant === 'missing-tool' ? [] : [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: 'AskUserQuestion' }] }] };
    f.state.interactions = [{ interactionId: 'question-1', interactionKind: 'question', toolCallId: 'owned-tool', state: 'pending', request: { session_id: session.nativeSessionId, questions: [] } }];
    const initialFrames = f.driver.diagnostics().nativeFrames;
    f.send({ type: 'interaction', session_id: session.nativeSessionId, agent_id: variant === 'child-agent' ? 'child' : 'main', interaction_id: 'question-1', tool_call_id: 'owned-tool', kind: 'question', status: 'pending' });
    // A subsequent ordered transcript event proves the prior frame has been dispatched.
    f.state.seq++;
    f.send({ type: 'transcript.ops', session_id: session.nativeSessionId, payload: { agent_id: 'main', seq: f.state.seq, ops: [] } });
    for (let i = 0; i < 100 && f.driver.diagnostics().nativeFrames < initialFrames + 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const outcome = await f.driver.flush().then(() => null, error => error);
    if (variant !== 'child-agent') expect(outcome).toMatchObject({ code: 'reconcile_required' });
    const rows = (await f.store.page({ collection: 'interactions', limit: 100 })).items;
    expect(rows).toHaveLength(0);
    expect(f.state.answers).toHaveLength(0);
    expect(await f.driver.operations!.journal.get(sent.operationId)).not.toMatchObject({ phase: 'terminal' });
  } finally { await f.close(); }
});

it.each(['2.5.2', '2.5.3', 'missing-route'])('enables modern questions only for the verified native profile %s', version => {
  const paths = { '/api/v1/sessions/{session_id}/prompts/{tail}': { post: { operationId: 'promptAction' } }, ...(version !== 'missing-route' ? { '/api/v1/sessions/{session_id}/interactions/{interaction_id}': { post: {} } } : {}) };
  const capability = parseNativeCapabilities({ backend: 'v2', server_version: version === 'missing-route' ? '2.5.2' : version, capabilities: {} }, { paths }, { components: { messages: {} } });
  expect(capability.modernQuestions).toBe(version === '2.5.2');
  expect(capability.questions).toBe(version === '2.5.2');
  expect(capability.approvals).toBe(false);
});
