// @vitest-environment node
import { ProtocolError, type JsonValue } from '../../../shared/runtime/capabilities.js';
import { KIMI_PLUGIN_OPERATIONS } from '../../../shared/runtime/native/kimiWeb/pluginOperations.js';
import { KIMI_PROVIDER_OPERATIONS } from '../../../shared/runtime/native/kimiWeb/providerOperations.js';
import { KIMI_SESSION_OPERATIONS } from '../../../shared/runtime/native/kimiWeb/sessionOperations.js';
import { describe, expect, it, vi } from 'vitest';
import { applyTranscriptOps, transcriptSnapshot } from '../../../shared/runtime/native/kimiWeb/transcript.js';
import {
  parseCatalogPage,
  recoverSnapshotFrames,
  updateDurableCursor,
  parseNativeCapabilities,
  sessionSummary,
} from '../../../shared/runtime/native/kimiWeb/protocol.js';

describe('Kimi Runtime protocol boundaries', () => {
  it('rejects a nonadvancing opaque native catalog cursor', () => {
    expect(() => parseCatalogPage({ items: [], has_more: true, next_page_token: 'same' }, 'same', 100))
      .toThrow('catalog_cursor');
  });
  it('does not advance durable cursors for live transcript or assistant deltas', () => {
    expect(updateDurableCursor({ epoch: 'e', seq: 4 }, { type: 'assistant.delta', session_id: 's', epoch: 'e', seq: 9, volatile: true }))
      .toEqual({ epoch: 'e', seq: 4 });
  });
  it('preserves the uncovered same-sequence volatile suffix at an authoritative snapshot boundary', () => {
    expect(recoverSnapshotFrames({ epoch: 'e', as_of_seq: 4, in_flight_turn: { assistant_text: 'hello ', thinking_text: '' } }, [
      { type: 'assistant.delta', epoch: 'e', seq: 4, volatile: true, offset: 0, payload: { delta: 'hello world' } },
      { type: 'turn.ended', epoch: 'e', seq: 5, payload: { reason: 'completed' } },
    ])).toEqual([
      { type: 'assistant.delta', epoch: 'e', seq: 4, volatile: true, payload: { delta: 'world' } },
      { type: 'turn.ended', epoch: 'e', seq: 5, payload: { reason: 'completed' } },
    ]);
  });
  it('retains steps produced earlier in the same native operation batch', () => {
    const state = applyTranscriptOps(transcriptSnapshot({ items: [], tasks: [] }), [
      { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't0', state: 'running' } },
      { op: 'step.upsert', turnId: 't0', step: { kind: 'step', stepId: 't0.1', state: 'running' } },
      { op: 'frame.upsert', turnId: 't0', stepId: 't0.1', frame: { kind: 'text', frameId: 'text', text: 'retained' } },
      { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't0', state: 'completed' } },
    ]);
    expect(state.items).toMatchObject([{ turnId: 't0', state: 'completed', steps: [{ frames: [{ text: 'retained' }] }] }]);
  });
  it('merges native agent metadata patches and clears explicitly removed modes', () => {
    const state = applyTranscriptOps(transcriptSnapshot({ items: [], tasks: [], meta: { goal: 'prior', agent: { model: 'local/model', phase: { kind: 'running' } }, modes: { plan: { active: true }, swarm: { active: true } } } }), [
      { op: 'meta.merge', meta: { agent: { phase: { kind: 'ended' } }, goal: null, modes: { plan: null } } },
    ]);
    expect(state.meta).toEqual({ agent: { model: 'local/model', phase: { kind: 'ended' } }, modes: { swarm: { active: true } } });
  });
  it('limits the undocumented abort alias to the native profile actually verified', () => {
    const spec = { paths: { '/api/v1/sessions/{session_id}:archive': { post: { operationId: 'runSessionArchiveAction' } } } };
    const ws = { components: { messages: {} } };
    expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.1.1' }, spec, ws).cancel).toBe(true);
    expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.1.2' }, spec, ws).cancel).toBe(false);
  });
  it('never enables native operations from an unknown capability or version alone', () => {
    expect(parseNativeCapabilities({ backend: 'v2', capabilities: { websocket: true } }, { paths: {} }, { components: { messages: {} } }).subscribeV2)
      .toBe(false);
  });
});

import { afterEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKimiWebDriver } from '../../../bridge/runtime/drivers/kimiWebDriver.js';
import { createKimiWebTransport } from '../../../bridge/runtime/drivers/kimiWebTransport.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeHost } from '../../../bridge/runtime/runtimeHost.js';
import { createHarnessRegistry } from '../../../shared/runtime/harnessContract.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import { createRawWebSocketPeer, createWebSocketAccept } from '../../../bridge/webSocketFrames.js';
import { createHistoryStream, createHistoryDiskBudget, HISTORY_STREAM_LIMITS } from '../../../bridge/runtime/historyStream.js';
import type { InternalNativeHistoryHandle } from '../../../bridge/runtime/historyService.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const epoch = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const nativeSessionId = 'session_kimi_fixture';
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId });
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const historyAuthority = { epoch, processGeneration: 1 };
const historySignal = () => new AbortController().signal;
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('native condition was not reached'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function turn(index: number, padding: number) {
  return { kind: 'turn', turnId: `turn_${String(index).padStart(6, '0')}`, ordinal: index, state: 'completed', steps: [{ kind: 'step', stepId: `turn_${index}.1`, state: 'completed', frames: [{ kind: 'text', frameId: 'text', text: 'x'.repeat(padding) }] }] };
}
/** A real-shaped Kimi transcript envelope of exactly `target` bytes: attachments, todos, prompts and unknown native fields included. */
function transcriptEnvelope(target: number, turns: number, epochValue = 'ep_fixture') {
  const head = Buffer.from('{"items":[');
  const tail = Buffer.from(`],"has_more":false,"seq":42,"tasks":[{"taskId":"task_1","title":"native task","output":"done"}],"interactions":[{"interactionId":"int_1","kind":"approval"}],"attachments":[{"attachmentId":"att_1","name":"native.bin","mimeType":"application/octet-stream","size":7}],"todos":[{"todoId":"todo_1","content":"native todo","status":"completed"}],"prompts":[{"promptId":"prompt_1","text":"native prompt"}],"meta":{"agent":{"model":"kimi-code/k3"},"unknownNativeField":{"nested":["preserved",1,true,null]}},"agents":[{"agentId":"main"}],"epoch":"${epochValue}"}`);
  const zero = Array.from({ length: turns }, (_, index) => Buffer.from(JSON.stringify(turn(index, 0))));
  const base = Buffer.concat([head, ...zero.flatMap((part, index) => index ? [Buffer.from(','), part] : [part]), tail]).byteLength;
  const per = Math.max(0, Math.floor((target - base) / turns));
  const items: unknown[] = [];
  const parts: Buffer[] = [head];
  for (let index = 0; index < turns; index += 1) {
    const padding = index === turns - 1 ? per + Math.max(0, target - base - per * turns) : per;
    const item = turn(index, padding);
    items.push(item);
    parts.push(Buffer.from(JSON.stringify(item)));
    if (index < turns - 1) parts.push(Buffer.from(','));
  }
  parts.push(tail);
  const body = Buffer.concat(parts);
  if (body.byteLength !== target) throw new Error(`envelope builder produced ${body.byteLength} instead of ${target}`);
  return { body, items };
}
const smallTranscript = () => Buffer.from(JSON.stringify({ items: [turn(0, 8), turn(1, 8)], has_more: false, seq: 7, tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, agents: [], epoch: 'ep_fixture' }));
async function controlledKimiWeb(nativePageMaximum = 200, agentTurns = false, agentSocket = false, goalSocket = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-kimi-http-')); temporary.push(dir);
  const calls: { method: string; path: string; origin: string | undefined }[] = [];
  const promptBodies: unknown[] = [];
  const transcriptPulls: { path: string; raw: boolean; agentId: string | null; beforeTurn: string | null }[] = [];
  const wsControls: { lane: string; type: string; payload: Record<string, unknown> }[] = [];
  const wsPongs: string[] = [];
  const peers: { send(message: string): void }[] = [];
  let authority = { epoch, processGeneration: 1 };
  let goalObjective: string | undefined;
  let transcriptBody: Buffer | undefined;
  let transcriptStatus = 0;
  let transcriptGate: Promise<void> | undefined;
  let transcriptChunks = 0;
  let unsubscribeGate: Promise<void> | undefined;
  let published = 39;
  let providerError = 0;
  let agentTerminalReads = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    calls.push({ method: request.method ?? '', path: route.pathname + route.search, origin: request.headers.origin });
    response.setHeader('Content-Type', 'application/json');
    if (agentTurns) {
      const send = (data: unknown) => response.end(JSON.stringify({ code: 0, data }));
      if (route.pathname === '/openapi.json') {
        response.end(JSON.stringify({ paths: {
          '/api/v1/sessions': { get: {} },
          '/api/v1/sessions/{session_id}': { get: {} },
          '/api/v1/sessions/{session_id}/prompts': { post: {} },
          '/api/v1/sessions/{session_id}/agents/{agent_id}/turns': { get: {} },
          ...(goalSocket ? { '/api/v1/sessions/{session_id}/profile': { post: { requestBody: { content: { 'application/json': { schema: { properties: { agent_config: { properties: { goal_objective: {}, goal_control: { enum: ['edit'] } } } } } } } } } } } : {}),
        } }));
        return;
      }
      if (route.pathname === '/asyncapi.json') {
        response.end(JSON.stringify({ components: { messages: { subscribe: { name: 'subscribe' }, ...(goalSocket ? { goal: { name: 'goal' } } : {}) } } }));
        return;
      }
      if (route.pathname === '/api/v1/meta') {
        send({ server_id: 'srv_fixture', server_version: '2.7.2', kimi_agent_protocol_version: '1.0.0', capabilities: { websocket: agentSocket } });
        return;
      }
      if (route.pathname === '/api/v1/sessions') {
        send({ items: [{ id: nativeSessionId, cwd: dir, title: 'Agent session' }], has_more: false });
        return;
      }
      if (goalSocket && route.pathname.endsWith('/profile')) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.agent_config.goal_control !== 'edit') { response.statusCode = 400; response.end('{}'); return; }
        goalObjective = body.agent_config.goal_objective;
        send({});
        return;
      }
      if (route.pathname.endsWith('/agents/main/turns')) {
        if (agentSocket && route.searchParams.get('page_size') === '1') {
          if (++agentTerminalReads === 1) { response.statusCode = 503; response.end('{}'); return; }
          const promptId = (promptBodies[0] as { prompt_id: string }).prompt_id;
          send({ turns: [{ ordinal: 1, turn_id: 'agent-terminal', status: 'ended', outcome: 'completed', items: [
            { item_id: 'opener', type: 'user_message', placement: 'opener', prompt_ids: [promptId] },
          ] }], has_more: false });
          return;
        }
        const before = route.searchParams.get('before_ordinal');
        const index = before === null ? 2 : 1;
        const count = before === null && nativePageMaximum === 20 ? 20 : 1;
        const repeat = before !== null ? 14_000 : count === 20 ? 22_000 : 430_000;
        const turns = Array.from({ length: count }, (_, offset) => ({
          ordinal: index + offset, turn_id: `turn-${index + offset}`, status: 'ended', items: [
            { item_id: 'prompt', type: 'user_message', placement: 'opener', text: 'hello' },
            { item_id: 'answer', type: 'assistant_message', text: 'world'.repeat(repeat) },
          ],
        }));
        send({ turns, has_more: before === null });
        return;
      }
    }
    if (providerError && route.pathname === '/api/v1/providers' && request.method === 'POST') { response.end(JSON.stringify({ code: providerError, data: null, msg: 'secret upstream details' })); return; }
    if (route.pathname === '/openapi.json' || route.pathname === '/asyncapi.json') {
      response.end(JSON.stringify(route.pathname === '/openapi.json' ? {
        paths: {
          ...Object.values(KIMI_SESSION_OPERATIONS).reduce<Record<string, Record<string, object>>>((paths, route) => { const path = `/api/v1/sessions/{session_id}${route.suffix}`; (paths[path] ??= {})[route.method.toLowerCase()] = {}; return paths; }, {}),
          '/api/v1/auth': { get: {} },
          '/api/v1/config': { get: {}, post: {} },
          '/api/v1/plugins': { get: {}, post: {} },
          '/api/v1/plugins/marketplace': { get: {} },
          '/api/v1/plugins/{tail}': { post: {} },
          '/api/v1/providers': { get: {}, post: {} },
          '/api/v1/providers/{provider_id}': { put: {}, delete: {} },
          '/api/v1/providers/{provider_id}:refresh': { post: {} },
          '/api/v1/providers:refresh': { post: {} },
          '/api/v1/providers:import_catalog': { post: {} },
          '/api/v1/catalog/providers': { get: {} },
          '/api/v1/catalog/providers/{provider_id}': { get: {} },
          '/api/v1/models/{model_id}:set_default': { post: {} },
          '/api/v2/sessions': { get: {} }, '/api/v1/sessions': { post: {} },
          '/api/v1/sessions/{session_id}/snapshot': { get: {} }, '/api/v1/sessions/{session_id}/transcript': { get: { parameters: [{ in: 'query', name: 'page_size', schema: { maximum: nativePageMaximum } }] } },
          '/api/v1/sessions/{session_id}/prompts': { post: {} }, '/api/v1/sessions/{session_id}:abort': { post: {} },
          '/api/v1/sessions/{session_id}/approvals/{approval_id}': { post: {} }, '/api/v1/sessions/{session_id}/questions/{tail}': { post: {} },
          '/api/v1/sessions/{session_id}/profile': { post: {} },
          '/api/v1/sessions/{session_id}:archive': { post: {} }, '/api/v1/sessions/{session_id}:restore': { post: {} }, '/api/v1/sessions/{session_id}:delete': { post: {} },
          '/api/v1/models': { get: {} }, '/api/v1/sessions/{session_id}/status': { get: {} },
        },
      } : { components: { messages: { subscribe_v2: { name: 'subscribe_v2' }, subscribe: { name: 'subscribe' } } } }));
      return;
    }
    if (route.pathname === '/api/v1/plugins' && request.method === 'GET') {
      response.end(JSON.stringify({ code: 0, data: { plugins: [{ id: 'local/tool', display_name: 'Local tool', enabled: true, state: 'ok' }] } }));
      return;
    }
    if (route.pathname === '/api/v1/meta') { response.end(JSON.stringify({ code: 0, data: { backend: 'v2', server_id: 'srv_fixture', server_version: '2.1.1', capabilities: { websocket: true } } })); return; }
    if (route.pathname === '/api/v2/sessions') { response.end(JSON.stringify({ code: 0, data: { items: [{ id: nativeSessionId, meta: { title: 'Fixture', archived: false }, workspace: { id: 'wd_fixture', cwd: dir }, busy: false, last_seq: 7 }], has_more: false, next_page_token: null } })); return; }
    const snapshotSession = /^\/api\/v1\/sessions\/([^/]+)\/snapshot$/.exec(route.pathname)?.[1];
    if (snapshotSession) {
      response.end(JSON.stringify({ code: 0, data: { epoch: 'ep_fixture', as_of_seq: 7, session: { id: decodeURIComponent(snapshotSession), meta: { title: 'Fixture' }, workspace: { id: 'wd_fixture', cwd: dir }, busy: false, last_seq: 7 }, messages: { items: [], has_more: false }, in_flight_turn: { assistant_text: '', thinking_text: '' }, subagents: [], pending_approvals: [], pending_questions: [] } }));
      return;
    }
    if (route.pathname === `/api/v1/sessions/${nativeSessionId}/prompts`) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      promptBodies.push(body);
      response.end(JSON.stringify({ code: 0, data: { prompt_id: body.prompt_id } })); return;
    }
    if (route.pathname === `/api/v1/sessions/${nativeSessionId}/status`) { response.end(JSON.stringify({ code: 0, data: { busy: false } })); return; }
    if (route.pathname.endsWith('/transcript')) {
      const raw = request.headers.accept === 'application/json';
      transcriptPulls.push({ path: route.pathname + route.search, raw, agentId: route.searchParams.get('agent_id'), beforeTurn: route.searchParams.get('before_turn') });
      response.on('error', () => {});
      if (transcriptGate) await transcriptGate;
      if (transcriptStatus) { response.statusCode = transcriptStatus; response.end('{}'); return; }
      if (!raw) { response.end(JSON.stringify({ code: 0, data: JSON.parse(smallTranscript().toString('utf8')) })); return; }
      const bytes = transcriptBody ?? smallTranscript();
      transcriptChunks = Math.ceil(bytes.byteLength / 65536);
      response.write(bytes.subarray(0, Math.min(65536, bytes.byteLength)));
      for (let offset = 65536; offset < bytes.byteLength; offset += 65536) response.write(bytes.subarray(offset, Math.min(offset + 65536, bytes.byteLength)));
      response.end(); return;
    }
    response.end(JSON.stringify({ code: 0, data: {} }));
  });
  server.on('upgrade', (request, socket) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    if (route.pathname !== '/api/v1/ws') { socket.destroy(); return; }
    const lane = peers.length === 0 ? 'source' : 'lifecycle';
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => chunks.push(chunk);
    socket.on('data', collect);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createWebSocketAccept(String(request.headers['sec-websocket-key']))}\r\n\r\n`);
    socket.removeListener('data', collect);
    const peer = createRawWebSocketPeer(socket, Buffer.concat(chunks));
    peers.push(peer);
    if (agentSocket) {
      peer.on('message', (text: string) => {
        const frame = JSON.parse(text);
        peer.send(JSON.stringify({ type: 'response', request_id: frame.request_id, code: 0 }));
        if (goalSocket && frame.type === 'subscribe') {
          peer.send(JSON.stringify({ type: 'goal', session_id: frame.session_id, agent_id: 'main',
            goal: goalObjective ? { objective: goalObjective, status: 'active', turns_used: 0, tokens_used: 0, wall_clock_ms: 0 } : undefined }));
        }
      });
      return;
    }
    peer.send(JSON.stringify({ type: 'server_hello', timestamp: new Date().toISOString(), payload: { ws_connection_id: `conn_${lane}`, protocol_version: 2, heartbeat_ms: 10000, max_event_buffer_size: 1000, capabilities: { event_batching: false, compression: false } } }));
    peer.on('message', (text: string) => {
      let frame: { type?: string; id?: string; payload?: Record<string, unknown> };
      try { frame = JSON.parse(text); } catch { return; }
      if (frame.type === 'pong') { wsPongs.push(String(frame.payload?.nonce ?? '')); return; }
      if (frame.type === 'ping') { peer.send(JSON.stringify({ type: 'pong', payload: { nonce: frame.payload?.nonce } })); return; }
      if (frame.type) wsControls.push({ lane, type: frame.type, payload: frame.payload ?? {} });
      const answer = (payload: Record<string, unknown>) => {
        if ((frame.type === 'unsubscribe_v2' || frame.type === 'unsubscribe') && unsubscribeGate) {
          void unsubscribeGate.then(() => peer.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, msg: '', payload })));
          return;
        }
        peer.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, msg: '', payload }));
      };
      if (frame.type === 'client_hello') answer({ cursors: {} });
      else if (frame.type === 'subscribe') answer({ cursors: { [nativeSessionId]: { epoch: 'ep_fixture', seq: 7 } }, resync_required: [] });
      else if (frame.type === 'subscribe_v2' || frame.type === 'unsubscribe_v2' || frame.type === 'unsubscribe' || frame.type === 'abort') answer({ cursors: {}, resync_required: [] });
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new TypeError('missing fixture address');
  const store = createRuntimeStore({ stateDirectory: path.join(dir, 'runtime'), environmentId, ownerId, epoch }); await store.ready;
  const runtime = createRuntimeHost({ environmentId, role: 'local' }); runtime.start();
  const options = { environmentId, harnessInstanceId, epoch, processGeneration: 1, endpoint: `http://127.0.0.1:${address.port}`, store, runtime, getAuthority: () => authority, getAuthorization: () => 'Bearer fixture-token', ownership: 'borrowed' as const };
  return {
    options, store, calls, promptBodies, transcriptPulls, wsControls, wsPongs,
    transcript(value: { body?: Buffer; status?: number; gate?: Promise<void> } | undefined) { transcriptBody = value?.body; transcriptStatus = value?.status ?? 0; transcriptGate = value?.gate; },
    transcriptChunks: () => transcriptChunks,
    publishAgentTerminal() {
      for (const peer of peers) peer.send(JSON.stringify({ type: 'turn.ended', session_id: nativeSessionId, agent_id: 'main', turn: { turn_id: 'agent-terminal', ordinal: 1 } }));
    },
    terminalReads: () => agentTerminalReads,
    setAuthority(value: { epoch: string; processGeneration: number }) { authority = value; },
    providerError(code: number) { providerError = code; },
    holdUnsubscribe(gate: Promise<void> | undefined) { unsubscribeGate = gate; },
    ping(nonce: string) { for (const peer of peers) peer.send(JSON.stringify({ type: 'ping', payload: { nonce } })); },
    publish(type: string, payload: Record<string, unknown> = {}, sessionId: string | undefined = nativeSessionId) {
      published += 1;
      const seq = published;
      for (const peer of peers) peer.send(JSON.stringify({ type, seq, epoch: 'ep_fixture', volatile: false, session_id: sessionId, timestamp: new Date().toISOString(), payload: { seq, ...payload } }));
    },
    async close() {
      await runtime.stop();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.close();
    },
  };
}
async function historyStore(scope: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-kimi-history-spool-')); temporary.push(root);
  return createHistoryStream({ scope, createDirectory: () => mkdtemp(path.join(root, 'spool-')), globalDisk: createHistoryDiskBudget() });
}
/** One driver plus its selected-history producer, with both always torn down even when a step fails. */
async function historyProducer(fixture: Awaited<ReturnType<typeof controlledKimiWeb>>) {
  const driver = await createKimiWebDriver(fixture.options);
  const method = driver.registration.driver.core.openHistory;
  if (typeof method !== 'function') throw new TypeError('missing openHistory producer');
  const handle = await method({ environmentId, harnessInstanceId, session, params: historyAuthority }) as InternalNativeHistoryHandle;
  return {
    driver, handle,
    async close() { try { await handle.close(); } finally { await driver.close(); } },
  };
}
async function drainDescriptor(handle: InternalNativeHistoryHandle, pageId: string, descriptorId: string) {
  const parts: Buffer[] = [];
  const sizes: number[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await handle.chunk({ pageId, descriptorId, offset, signal: historySignal() });
    sizes.push(chunk.bytes.byteLength);
    parts.push(Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength));
    const next = chunk.nextOffset;
    chunk.release();
    if (next === null) break;
    offset = next;
  }
  return { bytes: Buffer.concat(parts), sizes };
}
const rawPulls = (fixture: Awaited<ReturnType<typeof controlledKimiWeb>>) => fixture.transcriptPulls.filter((pull) => pull.raw);
const storeScope = JSON.stringify([environmentId, harnessInstanceId, session]);
const producerInput = { environmentId, harnessInstanceId, session, params: historyAuthority };

it.each([1, 20])('streams a large native Agent turns page with %i record(s)', async (count) => {
  const fixture = await controlledKimiWeb(count, true);
  const { driver, handle, close } = await historyProducer(fixture);
  const store = await historyStore('agent-turns');
  try {
    const list = driver.registration.driver.core.listSessionPage!;
    const catalog = await list({ environmentId, harnessInstanceId, params: { limit: 1 } });
    expect(catalog).toMatchObject({ items: [{ title: 'Agent session', directory: expect.any(String) }] });
    expect(handle.capabilities).toMatchObject({ archive: 'paged', live: 'unsupported' });
    await handle.open({ signal: historySignal(), streamStore: store });
    const first = await handle.page({ signal: historySignal() });
    expect(first).toMatchObject({ cursor: '2', completeness: 'partial' });
    const entry = first.items[0];
    if (!entry || entry.kind !== 'stream') throw new Error('Expected streamed turn');
    const { bytes } = await drainDescriptor(handle, first.pageId, entry.descriptor.id);
    expect(first.items).toHaveLength(count);
    expect(first.document!.totalBytes).toBeGreaterThan(2 * 1024 * 1024);
    if (count === 1) expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(JSON.parse(bytes.toString())).toMatchObject({ turn_id: 'turn-2', items: [{ text: 'hello' }, { type: 'assistant_message' }] });
    const second = await handle.page({ cursor: first.cursor ?? undefined, signal: historySignal() });
    expect(second).toMatchObject({ cursor: null, completeness: 'complete' });
    expect(fixture.calls.some(call => call.path.includes('before_ordinal=2'))).toBe(true);
  } finally {
    await close();
    await store.close();
    await fixture.close();
  }
});

it.each([['idle', null], ['turn', 'running'], ['background', 'running']])(
  'maps the catalog activity %s to the observed session state',
  (activity, expected) => {
    expect(sessionSummary({ id: nativeSessionId, activity }, { environmentId, harnessInstanceId }).status).toBe(expected);
  },
);

it('reads and edits the goal through the current Kimi protocol without a REST goal route', async () => {
  const fixture = await controlledKimiWeb(200, true, true, true);
  const driver = await createKimiWebDriver(fixture.options);
  try {
    const { manifest, driver: native } = driver.registration;
    for (const name of ['kimi.goal', 'kimi.goal.update']) {
      expect(manifest.extensions.find(extension => extension.name === name)?.support.state).toBe('supported');
    }
    for (const control of ['pause', 'resume', 'cancel']) {
      expect(manifest.extensions.find(extension => extension.name === `kimi.goal.${control}`)?.support.state).toBe('unsupported');
    }
    const context = { environmentId, harnessInstanceId, session };
    await expect(native.native['kimi.goal']!({ ...context, params: {} })).resolves.toBeNull();
    await expect(native.native['kimi.goal.update']!({ ...context, params: { body: { objective: 'Verify native goal' }, idempotencyKey: 'update-goal' } }))
      .resolves.toMatchObject({ phase: 'native-executed' });
    await expect(native.native['kimi.goal']!({ ...context, params: {} })).resolves.toMatchObject({
      objective: 'Verify native goal', status: 'active', turnsUsed: 0,
    });
    expect(fixture.calls.some(call => call.path.endsWith('/goal'))).toBe(false);
  } finally { await driver.close(); await fixture.close(); }
});

it('retries a transient Agent terminal read and releases the exact prompt lease', async () => {
  const fixture = await controlledKimiWeb(200, true, true);
  const driver = await createKimiWebDriver(fixture.options);
  try {
    const send = driver.registration.driver.core.send!;
    const submit = (idempotencyKey: string) => send({ environmentId, harnessInstanceId, session,
      params: { content: [{ type: 'text', text: 'hello' }], idempotencyKey } });
    const first = await submit('first') as { phase: string; operationId: string };
    expect(first.phase).toBe('native-executed');
    fixture.publishAgentTerminal();
    await vi.waitFor(async () => {
      expect(await fixture.store.get({ collection: 'operations', key: first.operationId })).toMatchObject({ value: { phase: 'terminal' } });
    });
    expect(fixture.terminalReads()).toBe(2);
    await expect(submit('second')).resolves.toMatchObject({ phase: 'native-executed' });
    expect(fixture.promptBodies).toHaveLength(2);
  } finally { await driver.close(); await fixture.close(); }
});

describe('Kimi Web native selected-history producer over controlled raw HTTP and WebSocket', () => {
  it('discovers advanced session routes and keeps query and mutation identity on the captured session', async () => {
    const fixture = await controlledKimiWeb(), driver = await createKimiWebDriver(fixture.options);
    try {
      for (const name of ['forkSession', 'compactSession', 'kimi.btw', 'kimi.undo', 'kimi.children.create', 'kimi.tasks.cancel']) {
        expect(driver.registration.manifest.extensions.find(entry => entry.name === name)?.support.state).toBe('supported');
        const invoke = driver.registration.driver.native[name];
        if (!invoke) throw new Error('missing discovered session route');
        await expect(invoke({ environmentId, harnessInstanceId, session, params: { id: 'task/a', body: { count: 1 }, idempotencyKey: name, sessionId: 'foreign' } })).resolves.toMatchObject({ phase: 'native-executed' });
      }
      const read = driver.registration.driver.native['kimi.fileContent'];
      if (!read) throw new Error('missing file history route');
      await read({ environmentId, harnessInstanceId, session, params: { query: { turn_id: 5, path: 'proof.txt', phase: 'start' } } });
      expect(fixture.calls.some(call => call.path === `/api/v1/sessions/${nativeSessionId}/file-history/content?turn_id=5&path=proof.txt&phase=start`)).toBe(true);
      expect(fixture.calls.some(call => call.path === `/api/v1/sessions/${nativeSessionId}/tasks/task%2Fa:cancel`)).toBe(true);
      await expect(read({ environmentId, harnessInstanceId, session, params: { query: { session_id: 'foreign' } } })).rejects.toThrow('kimi.session_query');
      expect(fixture.calls.some(call => call.path.includes('/sessions/foreign'))).toBe(false);
    } finally { await driver.close(); await fixture.close(); }
  });
  it('declares the native selected-history producer supported and leaves every other operation unchanged', async () => {
    const fixture = await controlledKimiWeb();
    try {
      const driver = await createKimiWebDriver(fixture.options);
      expect(driver.registration.manifest.core.openHistory).toEqual({ state: 'supported' });
      expect(typeof driver.registration.driver.core.openHistory).toBe('function');
      for (const [name, support] of Object.entries(driver.registration.manifest.core)) {
        if (name === 'openHistory') continue;
        expect(support).toEqual({ state: 'supported' });
      }
      expect(driver.registration.manifest.extensions.map((entry) => entry.name).sort()).toEqual([...Object.keys(KIMI_PROVIDER_OPERATIONS), ...Object.keys(KIMI_PLUGIN_OPERATIONS), ...Object.keys(KIMI_SESSION_OPERATIONS), 'kimi.goal.pause', 'kimi.goal.resume', 'kimi.goal.cancel', 'archiveSession', 'deleteSession', 'kimi.listWorkspacePage', 'kimi.meta', 'kimi.sessionStatus', 'kimi.updateProfile', 'listProviders', 'restoreSession'].sort());
    } finally { await fixture.close(); }
  });
  it('updates goals with PATCH on the captured session and rejects invalid objectives before dispatch', async () => {
    const fixture = await controlledKimiWeb(), driver = await createKimiWebDriver(fixture.options);
    try {
      const invoke = driver.registration.driver.native['kimi.goal.update'];
      if (!invoke) throw new Error('Missing goal update');
      const params = { body: { objective: 'Keep native goal' }, idempotencyKey: 'goal-patch', sessionId: 'foreign' };
      await expect(invoke({ environmentId, harnessInstanceId, session, params })).resolves.toMatchObject({ phase: 'native-executed' });
      expect(fixture.calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/goal'))).toEqual([expect.objectContaining({ path: `/api/v1/sessions/${nativeSessionId}/goal` })]);
      for (const body of [{ objective: '' }, { objective: '  ' }, { objective: 5 }, { objective: 'valid', sessionId: 'foreign' }] as JsonValue[]) {
        await expect(invoke({ environmentId, harnessInstanceId, session, params: { body, idempotencyKey: 'invalid-goal' } })).rejects.toThrow('kimi.goal_objective');
      }
      expect(fixture.calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/goal'))).toHaveLength(1);
    } finally { await driver.close(); await fixture.close(); }
  });
  it('discovers each provider route and executes mutations with the captured instance journal', async () => {
    const fixture = await controlledKimiWeb(), driver = await createKimiWebDriver(fixture.options);
    try {
      for (const [operation, route] of Object.entries(KIMI_PROVIDER_OPERATIONS)) {
        expect(driver.registration.manifest.extensions.find(entry => entry.name === operation)?.support.state).toBe('supported');
        const invoke = driver.registration.driver.native[operation];
        if (!invoke) throw new Error('Missing provider operation');
        const result = await invoke({ environmentId, harnessInstanceId, params: { id: 'provider/model', body: {}, idempotencyKey: operation } });
        if (route.method !== 'GET') expect(result).toMatchObject({ phase: 'native-executed' });
        expect(fixture.calls.some(call => call.method === route.method && call.path === route.path.replace('{id}', 'provider%2Fmodel'))).toBe(true);
      }
    } finally { await driver.close(); await fixture.close(); }
  });
  it('reads installed plugins and confines management actions to the captured server', async () => {
    const fixture = await controlledKimiWeb(), driver = await createKimiWebDriver(fixture.options);
    try {
      const native = driver.registration.driver.native;
      const context = { environmentId, harnessInstanceId };
      expect(driver.registration.manifest.extensions.find(entry => entry.name === 'kimi.plugins.list')?.support.state).toBe('supported');
      await expect(native['kimi.plugins.list']({ ...context, params: {} })).resolves.toMatchObject({
        plugins: [{ id: 'local/tool', display_name: 'Local tool', state: 'ok' }],
      });
      await expect(native['kimi.plugins.action']({ ...context, params: { id: 'local/tool', action: 'disable', idempotencyKey: 'fixture-plugin-disable' } })).resolves.toMatchObject({ phase: 'native-executed' });
      expect(fixture.calls.some(call => call.method === 'POST' && call.path === '/api/v1/plugins/local%2Ftool:disable')).toBe(true);
      await expect(native['kimi.plugins.action']({ ...context, params: { id: 'local/tool', action: 'unrecognized', idempotencyKey: 'fixture-invalid' } })).rejects.toThrow('kimi.plugin_action');
    } finally { await driver.close(); await fixture.close(); }
  });
  it('preserves provider conflict codes as terminal rejection without exposing upstream error text', async () => {
    const fixture = await controlledKimiWeb(), driver = await createKimiWebDriver(fixture.options);
    try {
      fixture.providerError(40921);
      const invoke = driver.registration.driver.native['kimi.providers.create'];
      if (!invoke) throw new Error('Missing provider create');
      const result = await invoke({ environmentId, harnessInstanceId, params: { body: {}, idempotencyKey: 'provider-conflict' } });
      expect(result).toMatchObject({ phase: 'native-executed', result: { __kimiBusinessError: 40921 } });
      expect(JSON.stringify(result)).not.toContain('secret upstream details');
    } finally { await driver.close(); await fixture.close(); }
  });
  it('preserves bounded native attachment content and rejects server file paths before sending', async () => {
    const fixture = await controlledKimiWeb(), driver = await createKimiWebDriver(fixture.options);
    try {
      const send = driver.registration.driver.core.send;
      if (!send) throw new Error('Missing send');
      const content: JsonValue[] = [{ type: 'text', text: 'Inspect image' }, { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'YWJj' } }, { type: 'file', file_id: 'uploaded-1', name: 'notes.txt' }];
      expect(await send({ environmentId, harnessInstanceId, session, params: { content, idempotencyKey: 'attachment-send' } })).toMatchObject({ phase: 'native-executed' });
      expect(fixture.promptBodies).toEqual([expect.objectContaining({ content })]);
      await expect(send({ environmentId, harnessInstanceId, session, params: { content: [{ type: 'file', file_id: 'x', path: '/private' }], idempotencyKey: 'refused-path' } })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(fixture.promptBodies).toHaveLength(1);
    } finally { await driver.close(); await fixture.close(); }
  });
  it('routes discovered lifecycle and profile mutations through durable native operation journals', async () => {
    const fixture = await controlledKimiWeb();
    const driver = await createKimiWebDriver(fixture.options);
    try {
      for (const [operation, suffix] of [['kimi.updateProfile', '/profile'], ['archiveSession', ':archive'], ['restoreSession', ':restore'], ['deleteSession', ':delete']]) {
        const invoke = driver.registration.driver.native[operation];
        if (!invoke) throw new Error('Missing discovered native operation');
        const result = await invoke({ environmentId, harnessInstanceId, session, params: { idempotencyKey: operation, body: { model: 'kimi-test' } } });
        expect(result).toMatchObject({ phase: 'native-executed' });
        expect(fixture.calls.some(call => call.method === 'POST' && call.path === `/api/v1/sessions/${nativeSessionId}${suffix}`)).toBe(true);
      }
    } finally { await driver.close(); await fixture.close(); }
  });
  it('streams the raw native transcript envelope through the bounded substrate before any concat or parse', async () => {
    const fixture = await controlledKimiWeb();
    const { body, items } = transcriptEnvelope(240000, 4);
    fixture.transcript({ body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document) throw new TypeError('missing native document');
      expect(page.items.map((item) => item.recordId)).toEqual(['turn:turn_000000', 'turn:turn_000001', 'turn:turn_000002', 'turn:turn_000003']);
      expect(page.items.every((item) => item.kind === 'stream')).toBe(true);
      expect(page).toMatchObject({ completeness: 'complete', cursor: null });
      expect(rawPulls(fixture)).toHaveLength(1);
      expect(rawPulls(fixture)[0]?.path).toContain('page_size=200');
      expect(rawPulls(fixture)[0]?.path).not.toContain('before_turn=');
      expect(rawPulls(fixture)[0]?.path).toContain('agent_id=main');
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      expect(document.sizes.every((size) => size <= HISTORY_STREAM_LIMITS.chunkBytes)).toBe(true);
      expect(document.sizes).toHaveLength(Math.ceil(240000 / 65536));
      expect(document.sizes.at(-1)).toBe(240000 % 65536);
      expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(page.document.sha256);
      expect(createHash('sha256').update(body).digest('hex')).toBe(page.document.sha256);
      expect(document.bytes.equals(body)).toBe(true);
      const first = page.items[0];
      if (first?.kind !== 'stream') throw new TypeError('missing native record');
      const record = await drainDescriptor(producer.handle, page.pageId, first.descriptor.id);
      expect(record.bytes.toString('utf8')).toBe(JSON.stringify(items[0]));
      expect(createHash('sha256').update(record.bytes).digest('hex')).toBe(first.descriptor.sha256);
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
      expect(store.usage().diskBytes).toBe(page.document.totalBytes);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('streams a code/data native transcript envelope with exact document and turn bytes', async () => {
    const fixture = await controlledKimiWeb();
    const inner = transcriptEnvelope(240000, 4);
    const body = Buffer.concat([Buffer.from('{"code":0,"msg":"success","data":'), inner.body, Buffer.from('}')]);
    fixture.transcript({ body });
    const producer = await historyProducer(fixture), store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document || page.items[0]?.kind !== 'stream') throw new Error('missing wrapped transcript descriptors');
      expect(page.items.map(item => item.recordId)).toEqual(inner.items.map((_, index) => `turn:turn_${String(index).padStart(6, '0')}`));
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      expect(document.bytes.equals(body)).toBe(true);
      expect(page.document.sha256).toBe(createHash('sha256').update(body).digest('hex'));
      const first = await drainDescriptor(producer.handle, page.pageId, page.items[0].descriptor.id);
      expect(first.bytes.toString('utf8')).toBe(JSON.stringify(inner.items[0]));
      expect(document.sizes.every(size => size <= 65536)).toBe(true);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it.each([
    { code: 40112, data: { items: [], has_more: false, seq: 7 } },
    { code: 0, items: [turn(3, 0)], data: { items: [turn(0, 0)], has_more: false, seq: 7 } },
  ])('rejects failed or mixed native envelopes and removes partial history', async value => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: Buffer.from(JSON.stringify(value)) });
    const producer = await historyProducer(fixture), store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toThrow(value.code === 40112 ? 'kimi.history_native_envelope' : 'kimi.history_mixed_envelope');
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0 });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('preserves attachments, todos, prompts and unknown native fields byte-exactly through the raw path', async () => {
    const fixture = await controlledKimiWeb();
    const { body } = transcriptEnvelope(120000, 3);
    fixture.transcript({ body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document) throw new TypeError('missing native document');
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      const text = document.bytes.toString('utf8');
      expect(text).toContain('"attachmentId":"att_1"');
      expect(text).toContain('"todoId":"todo_1"');
      expect(text).toContain('"promptId":"prompt_1"');
      expect(text).toContain('"interactionId":"int_1"');
      expect(text).toContain('"taskId":"task_1"');
      expect(text).toContain('"unknownNativeField":{"nested":["preserved",1,true,null]}');
      expect(JSON.parse(text)).toMatchObject({ has_more: false, seq: 42, epoch: 'ep_fixture' });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('rejects a real-shaped native envelope past the substrate record bound before any parse', async () => {
    const fixture = await controlledKimiWeb();
    const { body } = transcriptEnvelope(2400000, 260);
    fixture.transcript({ body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.record_limit' });
      expect(body.byteLength).toBeGreaterThan(2097152);
      expect(rawPulls(fixture)).toHaveLength(1);
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0, fileHandles: 0, pendingWrites: 0, outputs: 0 });
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('failure rejects a native envelope whose record carries no native identity', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: Buffer.from(JSON.stringify({ items: [{ kind: 'turn', state: 'completed' }], has_more: false, seq: 3, epoch: 'ep_fixture' })) });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'replay_required', field: 'kimi.history_record_identity' });
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0 });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('failure rejects a late native epoch change on the selected session explicitly', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: transcriptEnvelope(40000, 2, 'ep_rotated').body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'replay_required', field: 'kimi.history_epoch_changed' });
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0 });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('failure rejects a producer whose captured driver authority no longer matches', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: transcriptEnvelope(40000, 2).body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      fixture.setAuthority({ epoch: '99999999-9999-4999-8999-999999999999', processGeneration: 1 });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'reconcile_required', field: 'kimi.generation' });
      await expect(producer.handle.read({ after: 0, signal: historySignal() })).rejects.toMatchObject({ code: 'reconcile_required', field: 'kimi.generation' });
      expect(producer.driver.diagnostics().state).toBe('ready');
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('ingests a real-shaped 16MiB native envelope with a full SHA-256 equality proof and 64KiB chunks', async () => {
    const fixture = await controlledKimiWeb();
    const { body } = transcriptEnvelope(16779990, 200);
    fixture.transcript({ body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document) throw new TypeError('missing native document');
      expect(page.items).toHaveLength(200);
      expect(fixture.transcriptChunks()).toBe(257);
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      expect(document.sizes).toHaveLength(257);
      expect(Math.max(...document.sizes)).toBe(65536);
      expect(document.sizes.filter((size) => size === 65536)).toHaveLength(256);
      expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(document.bytes).digest('hex'));
      expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(page.document.sha256);
      expect(document.bytes.equals(body)).toBe(true);
      expect(store.usage().diskBytes).toBe(16779990);
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('ingests a 64MiB native attachment inside the envelope with a full SHA-256 equality proof', async () => {
    const fixture = await controlledKimiWeb();
    const { body } = transcriptEnvelope(67109247, 1);
    fixture.transcript({ body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document) throw new TypeError('missing native document');
      expect(fixture.transcriptChunks()).toBe(1025);
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      expect(document.sizes).toHaveLength(1025);
      expect(Math.max(...document.sizes)).toBe(65536);
      expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(document.bytes).digest('hex'));
      expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(page.document.sha256);
      expect(document.bytes.equals(body)).toBe(true);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  }, 60_000);
  it('keeps every raw source piece inside the 64KiB substrate bound including its backing allocation', async () => {
    const fixture = await controlledKimiWeb();
    try {
      const transport = createKimiWebTransport({ endpoint: fixture.options.endpoint, getAuthorization: () => 'Bearer fixture-token' });
      try {
        const pulled = await transport.stream(`/api/v1/sessions/${nativeSessionId}/transcript?agent_id=main&page_size=200`);
        if (!pulled) throw new TypeError('missing raw body');
        let pieces = 0;
        for await (const piece of pulled.body) {
          expect(piece).toBeInstanceOf(Uint8Array);
          expect(piece.byteLength).toBeLessThanOrEqual(65536);
          expect(piece.buffer.byteLength).toBeLessThanOrEqual(65536);
          pieces++;
        }
        expect(pieces).toBeGreaterThan(0);
      } finally { await transport.close(); }
    } finally { await fixture.close(); }
  });
  it('refcounts the native subscription so releasing one owner does not cancel another', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: transcriptEnvelope(60000, 2).body });
    const driver = await createKimiWebDriver(fixture.options);
    try {
      const method = driver.registration.driver.core.openHistory;
      if (typeof method !== 'function') throw new TypeError('missing openHistory producer');
      const registry = createHarnessRegistry(); registry.register(driver.registration);
      const first = await method(producerInput) as InternalNativeHistoryHandle;
      const second = await method(producerInput) as InternalNativeHistoryHandle;
      const store = await historyStore(storeScope);
      try {
        await first.open({ signal: historySignal(), streamStore: store });
        await second.open({ signal: historySignal(), streamStore: store });
        expect((await first.page({ signal: historySignal() })).items.length).toBeGreaterThan(0);
        expect(fixture.wsControls.filter((control) => control.type === 'subscribe_v2')).toHaveLength(1);
        await first.close();
        expect(fixture.wsControls.some((control) => control.type === 'unsubscribe_v2')).toBe(false);
        expect(fixture.wsControls.some((control) => control.type === 'unsubscribe')).toBe(false);
        expect((await second.page({ signal: historySignal() })).items.length).toBeGreaterThan(0);
        expect(await registry.invoke({ ...producerInput, channel: 'core', operation: 'getSession', params: {} })).toMatchObject({ session });
        await second.close();
        await waitFor(() => fixture.wsControls.some((control) => control.type === 'unsubscribe_v2'));
        expect(fixture.wsControls.filter((control) => control.type === 'unsubscribe_v2')).toHaveLength(1);
        expect(fixture.wsControls.filter((control) => control.type === 'unsubscribe')).toHaveLength(1);
        expect(driver.diagnostics().connected).toBe(true);
        expect(await registry.invoke({ ...producerInput, channel: 'core', operation: 'getSession', params: {} })).toMatchObject({ session });
      } finally { await store.close(); }
    } finally { await driver.close(); await fixture.close(); }
  });
  it('cleans up a late unsubscribe acknowledgement without tearing down operation or control traffic', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: transcriptEnvelope(60000, 2).body });
    const driver = await createKimiWebDriver(fixture.options);
    const gate = Promise.withResolvers<void>();
    fixture.holdUnsubscribe(gate.promise);
    try {
      const method = driver.registration.driver.core.openHistory;
      if (typeof method !== 'function') throw new TypeError('missing openHistory producer');
      const registry = createHarnessRegistry(); registry.register(driver.registration);
      const first = await method(producerInput) as InternalNativeHistoryHandle;
      const second = await method(producerInput) as InternalNativeHistoryHandle;
      const store = await historyStore(storeScope);
      try {
        await first.open({ signal: historySignal(), streamStore: store });
        await second.open({ signal: historySignal(), streamStore: store });
        await first.close();
        const closing = second.close();
        await waitFor(() => fixture.wsControls.some((control) => control.type === 'unsubscribe_v2'));
        expect(driver.diagnostics().connected).toBe(true);
        gate.resolve();
        await closing;
        await waitFor(() => fixture.wsControls.some((control) => control.type === 'unsubscribe'));
        expect(driver.diagnostics().connected).toBe(true);
        expect(await registry.invoke({ ...producerInput, channel: 'core', operation: 'getSession', params: {} })).toMatchObject({ session });
        expect(await registry.invoke({ ...producerInput, channel: 'core', operation: 'inspect', params: {} })).toEqual({ state: 'ready', protocolVersion: 1 });
        await expect(registry.invoke({ ...producerInput, channel: 'core', operation: 'readHistoryPage', params: { limit: 2 } })).resolves.toMatchObject({ completeness: 'complete' });
      } finally { gate.resolve(); fixture.holdUnsubscribe(undefined); await store.close(); }
    } finally { await driver.close(); await fixture.close(); }
  });
  it('reports native invalidation from the selected observer and releases it without cancelling driver activity', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: transcriptEnvelope(60000, 2).body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      const registry = createHarnessRegistry(); registry.register(producer.driver.registration);
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const waiting = producer.handle.read({ after: 0, signal: historySignal() });
      let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      fixture.publish('transcript.ops', { ops: [] }, 'session_other');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      fixture.publish('transcript.ops', { ops: [] });
      expect(await waiting).toMatchObject({ through: 1, changed: true, status: 'current' });
      const later = producer.handle.read({ after: 1, signal: historySignal() });
      fixture.publish('transcript.reset', { snapshot: { items: [] } });
      expect(await later).toMatchObject({ through: 2, changed: true, status: 'current' });
      await producer.handle.close();
      expect(await registry.invoke({ ...producerInput, channel: 'core', operation: 'inspect', params: {} })).toEqual({ state: 'ready', protocolVersion: 1 });
      expect(await registry.invoke({ ...producerInput, channel: 'core', operation: 'getSession', params: {} })).toMatchObject({ session });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('answers the native application heartbeat and never depends on a non-loopback origin', async () => {
    const fixture = await controlledKimiWeb();
    fixture.transcript({ body: transcriptEnvelope(60000, 2).body });
    const producer = await historyProducer(fixture);
    const store = await historyStore(storeScope);
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await producer.handle.page({ signal: historySignal() });
      fixture.ping('nonce_kimi_1');
      await waitFor(() => fixture.wsPongs.includes('nonce_kimi_1'));
      expect(producer.driver.diagnostics().heartbeats.pongs).toBeGreaterThanOrEqual(1);
      expect(fixture.calls.every((call) => call.origin === undefined)).toBe(true);
      expect(fixture.calls.every((call) => call.path.startsWith('/api/') || call.path === '/openapi.json' || call.path === '/asyncapi.json')).toBe(true);
      expect(fixture.calls.every((call) => new URL(call.path, 'http://fixture').origin === 'http://fixture')).toBe(true);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('leaves the legacy selected-history read unchanged beside the raw producer', async () => {
    const fixture = await controlledKimiWeb();
    try {
      const driver = await createKimiWebDriver(fixture.options);
      const registry = createHarnessRegistry(); registry.register(driver.registration);
      const page: unknown = await registry.invoke({ ...producerInput, channel: 'core', operation: 'readHistoryPage', params: { limit: 2 } });
      expect(page).toMatchObject({ completeness: 'complete', cursor: null });
      expect(driver.registration.manifest.core.readHistoryPage).toEqual({ state: 'supported' });
      expect(fixture.transcriptPulls.some((pull) => !pull.raw)).toBe(true);
      await driver.close();
    } finally { await fixture.close(); }
  });
});

 it('rejects a raw transcript pull when authorization fails before response admission', async () => {
  const fixture = await controlledKimiWeb();
  let refuse = false;
  const driver = await createKimiWebDriver({ ...fixture.options, getAuthorization() {
    if (refuse) throw new Error('controlled credential failure');
    return fixture.options.getAuthorization();
  } });
  const method = driver.registration.driver.core.openHistory;
  if (!method) throw new Error('missing native history producer');
  const handle = await method(producerInput) as InternalNativeHistoryHandle;
  const store = await historyStore(storeScope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await handle.open({ signal: historySignal(), streamStore: store });
    refuse = true;
    const failure = handle.page({ signal: historySignal() }).then(
      () => ({ status: 'resolved' }),
      (error: unknown) => ({ status: 'rejected', code: error instanceof ProtocolError ? error.code : 'unknown' }),
    );
    const guard = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'deadline' }), 300); });
    expect(await Promise.race([failure, guard])).toEqual({ status: 'rejected', code: 'unauthorized' });
  } finally {
    clearTimeout(timer); refuse = false;
    await handle.close(); await driver.close(); await store.close(); await fixture.close();
  }
});

it('requires the native GET session route for modern session reads', () => {
  const meta = { backend: 'v2', server_version: '2.5.2' };
  const ws = { components: { messages: {} } };
  expect(parseNativeCapabilities(meta, { paths: {} }, ws).sessionRead).toBe(false);
  expect(parseNativeCapabilities(meta, { paths: { '/api/v1/sessions/{session_id}': { post: {} } } }, ws).sessionRead).toBe(false);
  const capabilities = parseNativeCapabilities(meta, { paths: { '/api/v1/sessions/{session_id}': { get: {} } } }, ws);
  expect(capabilities.sessionRead).toBe(true);
  expect(capabilities.snapshot).toBe(false);
});

it.each(['close', 'abort'] as const)('does not issue raw history after %s during credential lookup', async action => {
  const fixture = await controlledKimiWeb();
  let admit: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { admit = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const transport = createKimiWebTransport({ endpoint: fixture.options.endpoint,
    getAuthorization: async () => { entered?.(); await gate; return fixture.options.getAuthorization(); } });
  try {
    const controller = new AbortController();
    const result = transport.stream(`/api/v1/sessions/${nativeSessionId}/transcript`, controller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await waiting;
    if (action === 'close') await transport.close(); else controller.abort();
    admit?.();
    const outcome = await result;
    outcome.value?.release();
    expect(outcome.error).toMatchObject(action === 'close' ? { code: 'source_unavailable', field: 'driver_closed' } : { code: 'cancelled', field: 'native_cancelled' });
    expect(fixture.transcriptPulls).toHaveLength(0);
  } finally { admit?.(); await transport.close(); await fixture.close(); }
});

it('recovers modern transcript cursors per agent without reading or fabricating a legacy snapshot epoch', async () => {
  const { createKimiWebHistory } = await import('../../../bridge/runtime/drivers/kimiWebHistory.js');
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const history = createKimiWebHistory({ legacySnapshot: () => false, transport: {
    async request(_method: string, path: string) {
      calls.push(path);
      await gate;
      return { agent_id: 'main', items: [], has_more: false, interactions: [], attachments: [], prompts: [], agents: [], seq: 5 };
    },
  } });
  history.selected('modern-session');
  const recovering = history.recover('modern-session');
  const frame = { type: 'transcript.ops', session_id: 'modern-session', payload: { agent_id: 'main', seq: 6, ops: [{ op: 'turn.upsert', turn: { kind: 'turn', turnId: 't0', state: 'running' } }] } };
  expect(history.receive(frame, 1)).toBe(false);
  release?.();
  expect(await recovering).toEqual({ cursor: null, recovered: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/transcript?');
  expect(history.cursor('modern-session')).toBeUndefined();
  expect(history.transcriptCursors('modern-session')).toEqual({ main: 6 });
  expect(history.inspect('modern-session').snapshot.items).toMatchObject([{ turnId: 't0' }]);
  history.receive(frame, 1);
  expect(history.inspect('modern-session').snapshot.items).toHaveLength(1);
});

it.each([50, 100, 1000])('honors native transcript page maximum %s within the host page bound', async nativeMaximum => {
  const fixture = await controlledKimiWeb(nativeMaximum);
  fixture.transcript({ body: transcriptEnvelope(2400, 4).body });
  const producer = await historyProducer(fixture);
  const store = await historyStore(storeScope);
  try {
    await producer.handle.open({ signal: historySignal(), streamStore: store });
    const page = await producer.handle.page({ signal: historySignal() });
    expect(page.items).toHaveLength(4);
    expect(rawPulls(fixture)[0]?.path).toContain(`page_size=${Math.min(200, nativeMaximum)}`);
  } finally { await producer.close(); await store.close(); await fixture.close(); }
});

it('limits the modern prompt abort alias to the verified dispatcher profile', () => {
  const spec = { paths: { '/api/v1/sessions/{session_id}/prompts/{tail}': { post: { operationId: 'promptAction' } } } };
  const ws = { components: { messages: {} } };
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.2' }, spec, ws).promptAbort).toBe(true);
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.3' }, spec, ws).promptAbort).toBe(false);
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.2' }, { paths: {} }, ws).promptAbort).toBe(false);
  expect(parseNativeCapabilities({ backend: 'v2', server_version: '2.5.2' }, { paths: { '/api/v1/sessions/{session_id}/prompts/{tail}': { post: { operationId: 'otherAction' } } } }, ws).promptAbort).toBe(false);
});

it.each(['history only', 'subscription first', 'history first'] as const)('reclaims 33 distinct history slots (%s)', async order => {
  const fixture = await controlledKimiWeb();
  const driver = await createKimiWebDriver(fixture.options);
  try {
    const open = driver.registration.driver.core.openHistory;
    const subscribe = driver.registration.driver.core.subscribe;
    if (!open || !subscribe) throw new Error('missing native history producer');
    for (let index = 0; index < 33; index++) {
      const input = { ...producerInput, session: { ...session, nativeSessionId: `capacity-${index}` } };
      const stream = order === 'history only' ? null : await subscribe(input) as { return(): Promise<unknown> };
      const handle = await open(input) as InternalNativeHistoryHandle;
      if (order === 'subscription first') await stream?.return();
      await handle.close();
      if (order === 'history first') await stream?.return();
      expect(driver.diagnostics()).toMatchObject({ observers: 0, selected: 0, historySessions: 0 });
    }
  } finally { await driver.close(); await fixture.close(); }
}, 30000);

it('accepts newer Kimi servers that still advertise the verified Agent protocol', () => {
  const meta = { server_version: '2.8.0', kimi_agent_protocol_version: '1.0.0' };
  const spec = { paths: { '/api/v1/sessions/{session_id}/agents/{agent_id}/turns': { get: {} } } };
  expect(parseNativeCapabilities(meta, spec, {}).agentTurns).toBe(true);
  expect(parseNativeCapabilities({ ...meta, kimi_agent_protocol_version: '2.0.0' }, spec, {}).agentTurns).toBe(false);
});
