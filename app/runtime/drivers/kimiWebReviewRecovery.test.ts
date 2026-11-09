// @vitest-environment node
import { parseNativeCapabilities } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { JsonValue, ProtocolError } from '../../../shared/runtime/capabilities.js';
import { createKimiWebDriver } from '../../../bridge/runtime/drivers/kimiWebDriver.js';
import { createOperationJournal, fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createRawWebSocketPeer, createWebSocketAccept } from '../../../bridge/webSocketFrames.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';

// Load the actual internal Node error without requiring a public declaration for storeProtocol.
const { StoreError } = createRequire(import.meta.url)('../../../bridge/runtime/storage/storeProtocol.js') as { StoreError: new (code: ProtocolError['code'], reason: string) => ProtocolError };

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'review-session' });
const context = { environmentId, harnessInstanceId, session, params: {} };
async function fixture(legacy: boolean, prepare?: (store: ReturnType<typeof createRuntimeStore>, epoch: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-review-'));
  const epoch = randomUUID();
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch });
  await store.ready;
  const state = { historyReads: 0, aborts: 0, replyGate: undefined as Promise<void> | undefined, replyEntered: undefined as (() => void) | undefined, interactions: [] as Record<string, unknown>[], answers: [] as Record<string, unknown>[], legacy, gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined, seq: 1, turn: undefined as Record<string, unknown> | undefined, prompts: 0, historyGate: undefined as Promise<void> | undefined, historyEntered: undefined as (() => void) | undefined };
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
      state.historyReads++;
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
    if (url.pathname.endsWith(':abort') && req.method === 'POST') { state.aborts++; return reply({ aborted: true }); }
    if (url.pathname.includes('/interactions/') && req.method === 'POST') {
      const parts = []; for await (const part of req) parts.push(part);
      const answer = JSON.parse(Buffer.concat(parts).toString()); state.answers.push(answer);
      state.replyEntered?.(); if (state.replyGate) await state.replyGate;
      return reply({ outcome: answer.kind === 'approval' ? answer.decision : answer.dismissed ? 'dismissed' : 'answered', ended_at: '2026-11-09T00:00:00Z' });
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
      peer.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, payload: { accepted: [frame.payload?.session_id ?? session.nativeSessionId], not_found: [], resync_required: [] } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  await prepare?.(store, epoch);
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
    const canonical = await f.driver.operations!.interactions.get(pending!.key);
    await expect(f.driver.operations!.interactions.invalidatePending({ ...canonical.scope, epoch: randomUUID() }, 'question-1')).resolves.toBeUndefined();
    await expect(f.driver.operations!.interactions.invalidatePending({ ...canonical.scope, processGeneration: canonical.scope.processGeneration + 1 }, 'question-1')).resolves.toBeUndefined();
    expect(await f.driver.operations!.interactions.get(pending!.key)).toMatchObject({ phase: 'pending' });
    const answer: Record<string, JsonValue> = dismiss ? { dismiss: true } : { answers: { q_0: { kind: 'single', option_id: 'opt_0' } } };
    const params = { interactionId: pending!.key, answer, idempotencyKey: 'question-reply' };
    await expect(core.respondInteraction!({ ...context, session: { ...session, nativeSessionId: 'foreign-session' }, params })).rejects.toMatchObject({ field: 'interaction_scope' });
    await expect(core.respondInteraction!({ ...context, params })).resolves.toMatchObject({ phase: 'native-executed', parentOperationId: sent.operationId });
    expect(f.state.answers).toEqual([dismiss ? { kind: 'question', dismissed: true } : { kind: 'question', answers: params.answer.answers }]);
    await expect(core.respondInteraction!({ ...context, params })).rejects.toBeDefined();
    expect(f.state.answers).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(['external-prompt', 'wrong-turn', 'missing-tool', 'child-agent'].flatMap(variant => [['question', variant], ['approval', variant]]))('does not adopt a modern %s from %s', async (kind, variant) => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    const sent = await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Question' }], idempotencyKey: 'question-unowned' } }) as { operationId: string };
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, ...(variant === 'external-prompt' ? { triggerPromptId: 'foreign-prompt' } : {}), ...(variant === 'wrong-turn' ? { turnId: 'wrong-turn' } : {}), steps: variant === 'missing-tool' ? [] : [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: kind === 'question' ? 'AskUserQuestion' : 'Bash' }] }] };
    f.state.interactions = [{ interactionId: 'question-1', interactionKind: kind, toolCallId: 'owned-tool', state: 'pending', request: kind === 'question' ? { session_id: session.nativeSessionId, questions: [] } : { sessionId: session.nativeSessionId, toolName: 'Bash' } }];
    const initialFrames = f.driver.diagnostics().nativeFrames;
    f.send({ type: 'interaction', session_id: session.nativeSessionId, agent_id: variant === 'child-agent' ? 'child' : 'main', interaction_id: 'question-1', tool_call_id: 'owned-tool', kind, status: 'pending' });
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
  expect(capability.approvals).toBe(version === '2.5.2');
  expect(capability.modernApprovals).toBe(version === '2.5.2');
});

it.each(['reconnect', 'resync'].flatMap(mode => [['question', mode], ['approval', mode]]))('recovers a modern pending %s from HTTP without replay (%s)', async (kind, mode) => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Recover question' }], idempotencyKey: 'recover-question-send' } });
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: kind === 'question' ? 'AskUserQuestion' : 'Bash' }] }] };
    f.state.interactions = [{ interactionId: 'question-recovered', interactionKind: kind, toolCallId: 'owned-tool', state: 'pending', request: kind === 'question' ? { session_id: session.nativeSessionId, questions: [{ id: 'q_0', question: 'Choose', options: [{ id: 'opt_0', label: 'First' }] }] } : { sessionId: session.nativeSessionId, toolName: 'Bash' } }];
    if (mode === 'reconnect') await f.driver.reconnect();
    else f.send({ type: 'resync_required', session_id: session.nativeSessionId });
    let row;
    for (let i = 0; i < 100; i++) {
      await f.driver.flush();
      row = (await f.store.page({ collection: 'interactions', limit: 100 })).items.find(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction');
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(row).toBeDefined();
    const answer: Record<string, JsonValue> = kind === 'approval' ? { decision: 'rejected' } : { answers: { q_0: { kind: 'single', option_id: 'opt_0' } } };
    await expect(core.respondInteraction!({ ...context, params: { interactionId: row!.key, answer, idempotencyKey: 'recover-question-reply' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.answers).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(['live', 'reconnect', 'unproven-ended', 'own-reply', 'stale-generation'].flatMap(mode => [['question', mode], ['approval', mode]]))('synchronizes a native %s resolution without stealing a reply (%s)', async (kind, mode) => {
  const f = await fixture(false);
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  try {
    const core = f.driver.registration.driver.core;
    await core.send!({ ...context, params: { content: [{ type: 'text', text: 'External answer' }], idempotencyKey: 'external-answer-send' } });
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: kind === 'question' ? 'AskUserQuestion' : 'Bash' }] }] };
    f.state.interactions = [{ interactionId: 'question-external', interactionKind: kind, toolCallId: 'owned-tool', state: 'pending', request: kind === 'question' ? { session_id: session.nativeSessionId, questions: [] } : { sessionId: session.nativeSessionId, toolName: 'Bash' } }];
    const event = { type: 'interaction', session_id: session.nativeSessionId, agent_id: 'main', interaction_id: 'question-external', tool_call_id: 'owned-tool', kind };
    const replyAnswer: Record<string, JsonValue> = kind === 'approval' ? { decision: 'rejected' } : { dismiss: true };
    f.send({ ...event, status: 'pending' });
    let row;
    for (let i = 0; i < 100; i++) {
      row = (await f.store.page({ collection: 'interactions', limit: 100 })).items.find(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction');
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(row).toBeDefined(); await f.driver.flush();
    let replying: Promise<unknown> | undefined;
    if (mode === 'own-reply') {
      f.state.replyGate = gate.promise; f.state.replyEntered = entered.resolve;
      replying = Promise.resolve(core.respondInteraction!({ ...context, params: { interactionId: row!.key, answer: replyAnswer, idempotencyKey: 'owned-inflight-reply' } }));
      // Observe rejection immediately while the held HTTP reply is still in flight.
      void replying.catch(() => {});
      await entered.promise;
    }
    if (mode !== 'unproven-ended') f.state.interactions[0] = { ...f.state.interactions[0], state: kind === 'approval' ? 'rejected' : 'answered' };
    if (mode === 'stale-generation') {
      const canonical = await f.driver.operations!.interactions.get(row!.key);
      await f.driver.operations!.interactions.bindProcess({ ...canonical.scope, processGeneration: canonical.scope.processGeneration + 1 });
    }
    const before = f.driver.diagnostics().nativeFrames;
    if (mode === 'reconnect') await f.driver.reconnect();
    else f.send({ ...event, status: 'ended', outcome: kind === 'approval' ? 'rejected' : 'answered' });
    for (let i = 0; i < 100 && f.driver.diagnostics().nativeFrames === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
    if (mode === 'stale-generation') {
      await expect(f.driver.flush()).rejects.toMatchObject({ code: 'reconcile_required' });
      expect(await f.store.get({ collection: 'interactions', key: row!.key })).toMatchObject({ value: { phase: 'pending' } });
      expect(f.state.answers).toHaveLength(0);
      return;
    }
    await f.driver.flush();
    if (mode === 'own-reply') {
      try { expect(await f.driver.operations!.interactions.get(row!.key)).toMatchObject({ phase: 'replying' }); }
      finally { gate.resolve(); }
      await expect(replying).resolves.toMatchObject({ phase: 'native-executed' });
      expect(await f.driver.operations!.interactions.get(row!.key)).toMatchObject({ phase: 'replied' });
      expect(f.state.answers).toHaveLength(1);
    } else if (mode === 'unproven-ended') {
      expect(await f.driver.operations!.interactions.get(row!.key)).toMatchObject({ phase: 'pending' });
      await expect(core.respondInteraction!({ ...context, params: { interactionId: row!.key, answer: replyAnswer, idempotencyKey: 'real-question-reply' } })).resolves.toMatchObject({ phase: 'native-executed' });
      expect(f.state.answers).toHaveLength(1);
    } else {
      expect(await f.driver.operations!.interactions.get(row!.key)).toMatchObject({ phase: 'invalidated' });
      await expect(core.respondInteraction!({ ...context, params: { interactionId: row!.key, answer: replyAnswer, idempotencyKey: 'late-question-reply' } })).rejects.toBeDefined();
      expect(f.state.answers).toHaveLength(0);
    }
  } finally { gate.resolve(); await f.close(); }
});

it.each(['approved', 'rejected'])('persists a verified modern approval and replies %s once', async decision => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    const sent = await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Approval' }], idempotencyKey: 'approval-send' } }) as { operationId: string };
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: 'Bash' }] }] };
    f.state.interactions = [{ interactionId: 'approval-1', interactionKind: 'approval', toolCallId: 'owned-tool', state: 'pending', request: { sessionId: session.nativeSessionId, agentId: 'main', toolName: 'Bash', action: 'Run private command', display: { kind: 'command', command: 'pwd' } } }];
    f.send({ type: 'interaction', session_id: session.nativeSessionId, agent_id: 'main', interaction_id: 'approval-1', tool_call_id: 'owned-tool', kind: 'approval', status: 'pending' });
    let row;
    for (let i = 0; i < 100; i++) {
      row = (await f.store.page({ collection: 'interactions', limit: 100 })).items.find(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction');
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(row).toBeDefined(); await f.driver.flush();
    expect((await f.driver.operations!.interactions.get(row!.key)).payload).toMatchObject({ kind: 'approval', details: { tool_name: 'Bash', action: 'Run private command', tool_input_display: { kind: 'command', command: 'pwd' } } });
    const params = { interactionId: row!.key, answer: { decision }, idempotencyKey: 'approval-reply' };
    await expect(core.respondInteraction!({ ...context, session: { ...session, nativeSessionId: 'foreign-session' }, params })).rejects.toMatchObject({ field: 'interaction_scope' });
    await expect(core.respondInteraction!({ ...context, params })).resolves.toMatchObject({ phase: 'native-executed', parentOperationId: sent.operationId });
    expect(f.state.answers).toEqual([{ kind: 'approval', decision }]);
    await expect(core.respondInteraction!({ ...context, params })).rejects.toBeDefined();
    expect(f.state.answers).toHaveLength(1);
  } finally { await f.close(); }
});

it.each([1, 256, 1000].flatMap(count => [false, true].flatMap(owned => ['question', 'approval', 'mixed'].map(family => ({ count, owned, family })))) )('ignores $count historical $family interactions (owned=$owned) and keeps the task cancellable', async ({ count, owned, family }) => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    const sent = await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Keep task controllable' }], idempotencyKey: 'history-isolation-send' } }) as { operationId: string };
    await f.driver.flush();
    f.state.interactions = Array.from({ length: count }, (_, i) => {
      const kind = family === 'mixed' ? i % 2 ? 'approval' : 'question' : family;
      return { interactionId: `historical-${i}`, interactionKind: kind, toolCallId: `old-tool-${i}`, state: kind === 'approval' ? i % 2 ? 'rejected' : 'approved' : 'answered', request: { session_id: 'read-only-session', sessionId: 'read-only-session', toolName: 'Bash', questions: [] } };
    });
    const readSession = owned ? session : { ...session, nativeSessionId: 'read-only-session' };
    const operation = await f.driver.operations!.journal.get(sent.operationId);
    await expect(f.driver.operations!.interactions.invalidatePending({ ...operation.scope, session: readSession }, 'not-a-local-interaction')).resolves.toBeUndefined();
    const before = f.state.historyReads;
    if (owned) await f.driver.reconnect();
    await expect(core.readHistoryPage!({ ...context, session: readSession, params: { limit: 100 } })).resolves.toMatchObject({ completeness: 'complete' });
    await expect(f.driver.flush()).resolves.toBeUndefined();
    expect(f.driver.diagnostics().lastEventError).toBeNull();
    // Modern subscriptions read before/after attach and once for the requested page; no per-interaction reread.
    expect(f.state.historyReads - before).toBeLessThanOrEqual(3);
    await f.driver.reconnect();
    await expect(core.cancel!({ ...context, params: { operationId: sent.operationId, idempotencyKey: 'history-isolation-cancel' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.aborts).toBe(1);
    expect((await f.store.page({ collection: 'operations', limit: 100 })).items.filter(row => row.key.startsWith('process:'))).toHaveLength(1);
    expect((await f.store.page({ collection: 'interactions', limit: 100 })).items).toHaveLength(0);
  } finally { await f.close(); }
});

it('recovers the owned pending tool among 1000 historical interactions without rereading every item', async () => {
  const f = await fixture(false);
  try {
    const core = f.driver.registration.driver.core;
    await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Recover only current tool' }], idempotencyKey: 'large-owned-send' } });
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'current-tool', name: 'AskUserQuestion' }] }] };
    f.state.interactions = Array.from({ length: 1000 }, (_, i) => ({ interactionId: `old-${i}`, interactionKind: 'question', toolCallId: `past-tool-${i}`, state: 'answered', request: { session_id: session.nativeSessionId, questions: [] } }));
    f.state.interactions.push({ interactionId: 'current-question', interactionKind: 'question', toolCallId: 'current-tool', state: 'pending', request: { session_id: session.nativeSessionId, questions: [] } });
    const before = f.state.historyReads;
    await f.driver.reconnect(); await f.driver.flush();
    const rows = (await f.store.page({ collection: 'interactions', limit: 100 })).items.filter(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction');
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toMatchObject({ nativeRequestId: 'current-question', phase: 'pending' });
    expect(f.state.historyReads - before).toBeLessThanOrEqual(2);
    await expect(core.respondInteraction!({ ...context, params: { interactionId: rows[0].key, answer: { dismiss: true }, idempotencyKey: 'large-owned-reply' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.answers).toHaveLength(1);
  } finally { await f.close(); }
});

it('does not lose an HTTP recovery arriving while the prior batch is running', async () => {
  const f = await fixture(false);
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const operations = f.driver.operations!;
  const recover = operations.recoverModernInteractions;
  let calls = 0, reconnecting: Promise<void> | undefined;
  try {
    const core = f.driver.registration.driver.core;
    await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Recover newest snapshot' }], idempotencyKey: 'coalesced-send' } });
    await f.driver.flush();
    operations.recoverModernInteractions = async (...args: Parameters<typeof recover>) => {
      if (++calls === 1) { entered.resolve(); await gate.promise; }
      return recover(...args);
    };
    f.send({ type: 'resync_required', session_id: session.nativeSessionId });
    await entered.promise;
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'new-tool', name: 'AskUserQuestion' }] }] };
    f.state.interactions = [{ interactionId: 'new-question', interactionKind: 'question', toolCallId: 'new-tool', state: 'pending', request: { session_id: session.nativeSessionId, questions: [] } }];
    reconnecting = f.driver.reconnect(); void reconnecting.catch(() => {});
    for (let i = 0; i < 100; i++) {
      if (f.driver.history(session.nativeSessionId).snapshot.interactions.some(item => item.interactionId === 'new-question')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(f.driver.history(session.nativeSessionId).snapshot.interactions).toHaveLength(1);
    gate.resolve(); await reconnecting; await f.driver.flush();
    expect(calls).toBeGreaterThanOrEqual(2);
    const rows = (await f.store.page({ collection: 'interactions', limit: 100 })).items.filter(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction');
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toMatchObject({ nativeRequestId: 'new-question', phase: 'pending' });
  } finally { gate.resolve(); await reconnecting?.catch(() => {}); operations.recoverModernInteractions = recover; await f.close(); }
});

it.each(['question', 'approval'].flatMap(kind => ['queue-full', 'stale-pending', 'wrong-turn'].map(fault => ({ kind, fault }))))('isolates $kind recovery $fault from the owned main terminal', async ({ kind, fault }) => {
  const f = await fixture(false);
  const read = f.store.get.bind(f.store);
  let stream: AsyncIterator<unknown> | undefined, watching: Promise<void> | undefined;
  let globalStream: AsyncIterator<unknown> | undefined, globalWatching: Promise<void> | undefined;
  const globalEvents: unknown[] = [];
  const events: unknown[] = [];
  try {
    const core = f.driver.registration.driver.core;
    stream = await core.subscribe!({ ...context }) as AsyncIterator<unknown>;
    const observed = stream;
    watching = (async () => { for (;;) { const next = await observed.next(); if (next.done) break; events.push(next.value); } })();
    globalStream = await core.subscribe!({ ...context, session: undefined }) as AsyncIterator<unknown>;
    const diagnostic = globalStream;
    globalWatching = (async () => { for (;;) { const next = await diagnostic.next(); if (next.done) break; globalEvents.push(next.value); } })();
    const sent = await core.send!({ ...context, params: { content: [{ type: 'text', text: 'Finish independently' }], idempotencyKey: 'independent-terminal-send' } }) as { operationId: string };
    await f.driver.flush();
    f.state.turn = { ...f.state.turn, steps: [{ frames: [{ kind: 'tool', toolCallId: 'owned-tool', name: kind === 'question' ? 'AskUserQuestion' : 'Bash' }] }] };
    f.state.interactions = [{ interactionId: 'finish-interaction', interactionKind: kind, toolCallId: 'owned-tool', state: 'pending', request: kind === 'question' ? { session_id: session.nativeSessionId, questions: [] } : { sessionId: session.nativeSessionId, toolName: 'Bash' } }];
    f.send({ type: 'interaction', session_id: session.nativeSessionId, agent_id: 'main', interaction_id: 'finish-interaction', tool_call_id: 'owned-tool', kind, status: 'pending' });
    let row;
    for (let i = 0; i < 100; i++) {
      row = (await f.store.page({ collection: 'interactions', limit: 100 })).items.find(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'kind' in row.value && row.value.kind === 'interaction');
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(row).toBeDefined(); await f.driver.flush();
    let injected = 0;
    f.store.get = async params => {
      if (fault !== 'stale-pending' && !injected && params.collection === 'interactions' && params.key === row!.key) { injected++; throw new StoreError('source_unavailable', 'queue_full'); }
      return read(params);
    };
    f.state.turn = { ...f.state.turn, state: 'completed', ...(fault === 'wrong-turn' ? { turnId: 'wrong-completed-turn' } : {}) }; f.state.seq++;
    f.state.interactions[0] = { ...f.state.interactions[0], state: fault === 'stale-pending' ? 'pending' : kind === 'question' ? 'answered' : 'approved' };
    f.send({ type: 'resync_required', session_id: session.nativeSessionId });
    for (let i = 0; i < 100; i++) {
      if (f.driver.diagnostics().lastEventError && f.driver.diagnostics().eventQueue === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(injected).toBe(fault === 'stale-pending' ? 0 : 1);
    const field = fault === 'stale-pending' ? 'interaction_turn_unknown' : fault === 'wrong-turn' ? 'native_turn_identity' : 'runtime.store.queue_full';
    await expect(f.driver.flush()).rejects.toMatchObject({ field });
    if (fault === 'wrong-turn') {
      expect(await f.driver.operations!.journal.get(sent.operationId)).toMatchObject({ phase: 'observed' });
      expect(globalEvents.some(event => event && typeof event === 'object' && 'reason' in event && event.reason === 'runtime.store.queue_full')).toBe(true);
      expect(globalEvents.some(event => event && typeof event === 'object' && 'reason' in event && event.reason === 'native_turn_identity')).toBe(true);
      expect(events.some(event => event && typeof event === 'object' && 'type' in event && event.type === 'turn.ended')).toBe(false);
      expect(f.state.prompts).toBe(1);
      return;
    }
    expect(await f.driver.operations!.journal.get(sent.operationId)).toMatchObject({ phase: 'terminal', outcome: 'completed' });
    expect(events.some(event => event && typeof event === 'object' && 'type' in event && event.type === 'turn.ended')).toBe(true);
    await stream.return?.(); await watching; await globalStream.return?.(); await globalWatching;
    expect(f.driver.diagnostics()).toMatchObject({ observers: 0, selected: 0, historySessions: 0 });
    await expect(core.send!({ ...context, params: { content: [{ type: 'text', text: 'Next after fault' }], idempotencyKey: 'independent-terminal-next' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.prompts).toBe(2);
  } finally { f.store.get = read; await stream?.return?.(); await watching; await globalStream?.return?.(); await globalWatching; await f.close(); }
});

it('restores only owned active tasks across paged startup state without any observer', async () => {
  const oldEpoch = randomUUID();
  const f = await fixture(false, async store => {
    const scope = { target: environmentId, session, epoch: oldEpoch, processGeneration: 1 };
    const journal = createOperationJournal({ store, isProcessCurrent: () => true });
    const op = await journal.accept({ scope, method: 'send', payload: { prompt_id: 'startup-owned' }, idempotencyKey: 'startup-original' });
    await journal.execute(op.operationId, scope, async () => ({ prompt_id: 'startup-owned' }));
    await store.mutateControl({ intentId: randomUUID(), changes: [
      { collection: 'operations', key: `kimi-native:${op.operationId}`, value: { scope, operationId: op.operationId, promptId: 'startup-owned', turnId: 'startup-turn' } },
      { collection: 'operations', key: `process:${fingerprint(encodeSessionKey(session))}`, value: { epoch: oldEpoch, generation: 1, alive: false } },
    ] });
    await store.mutate({ intentId: randomUUID(), changes: [
      ...Array.from({ length: 150 }, (_, index) => ({ collection: 'operations' as const, key: `000-history-${index}`, value: { kind: 'operation', method: 'send', phase: 'terminal' } })),
      { collection: 'operations', key: 'bad-task', value: { kind: 'operation', method: 'send', phase: 'observed', scope: { ...scope, session: { ...session, nativeSessionId: '' } } } },
      { collection: 'operations', key: 'foreign-task', value: { kind: 'operation', method: 'send', phase: 'observed', scope: { ...scope, session: { ...session, harnessInstanceId: '44444444-4444-4444-8444-444444444444' } } } },
    ] });
  });
  try {
    f.state.turn = { kind: 'turn', turnId: 'startup-turn', triggerPromptId: 'startup-owned', state: 'running', steps: [{ frames: [{ kind: 'tool', toolCallId: 'startup-tool', name: 'AskUserQuestion' }] }] };
    f.state.interactions = [{ interactionId: 'startup-question', interactionKind: 'question', toolCallId: 'startup-tool', state: 'pending', request: { session_id: session.nativeSessionId, questions: [] } }];
    await expect.poll(() => f.driver.diagnostics().startupRecovery.state, { timeout: 10000 }).toBe('partial');
    expect(f.driver.diagnostics()).toMatchObject({ observers: 0, selected: 1, startupRecovery: { restored: 1, failures: 1 } });
    expect(f.driver.diagnostics().startupRecovery.scanned).toBeGreaterThan(150);
    const rows = (await f.store.page({ collection: 'interactions', limit: 100 })).items;
    expect(rows.some(row => row.value && typeof row.value === 'object' && !Array.isArray(row.value) && 'nativeRequestId' in row.value && row.value.nativeRequestId === 'startup-question')).toBe(true);
    expect(f.state.prompts).toBe(0);
    expect(f.controls.filter(frame => frame.type === 'subscribe_v2').map(frame => (frame.payload as Record<string, unknown>).session_id)).toEqual([session.nativeSessionId]);
  } finally { await f.close(); }
});
it('joins an in-flight startup page when closing and creates no observer or subscription', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(false, async store => {
    const page = store.page.bind(store);
    store.page = async input => { entered.resolve(); await release.promise; return page(input); };
  });
  try {
    await entered.promise;
    const closing = f.driver.close();
    release.resolve();
    await closing;
    expect(f.driver.diagnostics()).toMatchObject({ observers: 0, selected: 0, startupRecovery: { state: 'stopped' } });
    expect(f.controls.filter(frame => frame.type === 'subscribe_v2')).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
});
it('restarts a failed startup scan on explicit reconnect without carrying old failure counts', async () => {
  const f = await fixture(false, async store => {
    const page = store.page.bind(store); let failed = false;
    store.page = async input => { if (!failed) { failed = true; throw new StoreError('source_unavailable', 'runtime.store.queue_full'); } return page(input); };
  });
  try {
    await expect.poll(() => f.driver.diagnostics().startupRecovery.state).toBe('partial');
    await f.driver.reconnect();
    await expect.poll(() => f.driver.diagnostics().startupRecovery.state).toBe('complete');
    expect(f.driver.diagnostics()).toMatchObject({ observers: 0, selected: 0, startupRecovery: { restored: 0, failures: 0 } });
  } finally { await f.close(); }
});

async function seedRestartTask(store: ReturnType<typeof createRuntimeStore>, oldEpoch: string) {
  const scope = { target: environmentId, session, epoch: oldEpoch, processGeneration: 1 };
  const journal = createOperationJournal({ store, isProcessCurrent: () => true });
  const op = await journal.accept({ scope, method: 'send', payload: { prompt_id: 'restart-proof' }, idempotencyKey: 'restart-proof' });
  await journal.execute(op.operationId, scope, async () => ({ prompt_id: 'restart-proof' }));
  await store.mutateControl({ intentId: randomUUID(), changes: [
    { collection: 'operations', key: `kimi-native:${op.operationId}`, value: { scope, operationId: op.operationId, promptId: 'restart-proof', turnId: 'restart-turn' } },
    { collection: 'operations', key: `process:${fingerprint(encodeSessionKey(session))}`, value: { epoch: oldEpoch, generation: 1, alive: false } },
  ] });
  return op.operationId;
}
it.each([{ kind: 'question', sendFirst: true }, { kind: 'approval', sendFirst: true }, { kind: 'question', sendFirst: false }, { kind: 'approval', sendFirst: false }])('keeps an adopted $kind monitored after its last observer closes (sendFirst=$sendFirst)', async ({ kind, sendFirst }) => {
  const oldEpoch = randomUUID(); let operationId = '', epoch = '';
  const startupEntered = Promise.withResolvers<void>(), releaseStartup = Promise.withResolvers<void>();
  const f = await fixture(false, async (store, current) => {
    epoch = current; operationId = await seedRestartTask(store, oldEpoch);
    const page = store.page.bind(store);
    store.page = async input => { if (input.collection === 'operations') { startupEntered.resolve(); await releaseStartup.promise; } return page(input); };
  });
  try {
    f.state.turn = { kind: 'turn', turnId: 'restart-turn', triggerPromptId: 'restart-proof', state: 'running', steps: [{ frames: [{ kind: 'tool', toolCallId: 'restart-tool', name: kind === 'question' ? 'AskUserQuestion' : 'Bash' }] }] };
    f.state.interactions = [{ interactionId: 'restart-pending', interactionKind: kind, toolCallId: 'restart-tool', state: 'pending', request: kind === 'question' ? { session_id: session.nativeSessionId, questions: [] } : { sessionId: session.nativeSessionId, toolName: 'Bash' } }];
    await startupEntered.promise;
    const core = f.driver.registration.driver.core;
    if (sendFirst) await expect(core.send!({ ...context, params: { content: [{ type: 'text', text: 'first action after restart' }], idempotencyKey: 'restart-racing-send' } })).rejects.toMatchObject({ code: 'conflict' });
    const observation = await core.subscribe!(context) as { return(): Promise<unknown> };
    await f.driver.flush();
    expect((await f.store.getControl({ collection: 'operations', key: operationId }))?.value).toMatchObject({ scope: { epoch } });
    expect((await f.store.getControl({ collection: 'operations', key: `process:${fingerprint(encodeSessionKey(session))}` }))?.value).toMatchObject({ epoch, generation: 1, alive: true });
    expect(f.state.prompts).toBe(0);
    await observation.return();
    expect(f.driver.diagnostics()).toMatchObject({ observers: 0, selected: 1 });
    f.state.interactions = f.state.interactions.map(item => ({ ...item, state: kind === 'question' ? 'answered' : 'rejected' }));
    f.state.turn = { ...f.state.turn, state: 'completed' };
    f.send({ type: 'transcript.ops', session_id: session.nativeSessionId, payload: { agent_id: 'main', seq: ++f.state.seq, ops: [{ op: 'turn.upsert', turn: f.state.turn }] } });
    await expect.poll(async () => await f.store.getControl({ collection: 'operations', key: operationId })).toMatchObject({ value: { phase: 'terminal', outcome: 'completed' } });
    await expect.poll(() => f.driver.diagnostics().selected).toBe(0);
    await expect(core.send!({ ...context, params: { content: [{ type: 'text', text: 'next task' }], idempotencyKey: 'after-recovered-terminal' } })).resolves.toMatchObject({ phase: 'native-executed' });
    expect(f.state.prompts).toBe(1);
  } finally { releaseStartup.resolve(); await f.close(); }
});
it('preserves a replied/answered old interaction and recovers a following pending question over HTTP', async () => {
  const oldEpoch = randomUUID(); let epoch = '';
  const f = await fixture(false, async (store, current) => {
    epoch = current;
    const operationId = await seedRestartTask(store, oldEpoch);
    const scope = { target: environmentId, session, epoch: oldEpoch, processGeneration: 1 };
    const key = `interaction:${fingerprint([encodeSessionKey(session), oldEpoch, 1, 'already-answered'])}`;
    await store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'interactions', key, value: { kind: 'interaction', scope, nativeRequestId: 'already-answered', parentOperationId: operationId, phase: 'replied' } }] });
  });
  try {
    f.state.turn = { kind: 'turn', turnId: 'restart-turn', triggerPromptId: 'restart-proof', state: 'running', steps: [{ frames: [{ kind: 'tool', toolCallId: 'old-tool', name: 'AskUserQuestion' }, { kind: 'tool', toolCallId: 'new-tool', name: 'AskUserQuestion' }] }] };
    f.state.interactions = [
      { interactionId: 'already-answered', interactionKind: 'question', toolCallId: 'old-tool', state: 'answered' },
      { interactionId: 'new-pending', interactionKind: 'question', toolCallId: 'new-tool', state: 'pending', request: { session_id: session.nativeSessionId, questions: [] } },
    ];
    await expect.poll(() => f.driver.diagnostics().startupRecovery.state).toBe('complete');
    const rows = (await f.store.page({ collection: 'interactions', limit: 100 })).items;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.objectContaining({ nativeRequestId: 'already-answered', phase: 'replied', scope: expect.objectContaining({ epoch: oldEpoch }) }) }),
      expect.objectContaining({ value: expect.objectContaining({ nativeRequestId: 'new-pending', phase: 'pending', scope: expect.objectContaining({ epoch }) }) }),
    ]));
    expect(f.driver.diagnostics().lastEventError).toBeNull();
    expect(f.state.prompts).toBe(0);
  } finally { await f.close(); }
});
