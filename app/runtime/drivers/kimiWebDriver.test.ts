// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyTranscriptOps, transcriptSnapshot } from '../../../shared/runtime/native/kimiWeb/transcript.js';
import {
  parseCatalogPage,
  recoverSnapshotFrames,
  updateDurableCursor,
  parseNativeCapabilities,
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
async function controlledKimiWeb() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-kimi-http-')); temporary.push(dir);
  const calls: { method: string; path: string; origin: string | undefined }[] = [];
  const transcriptPulls: { path: string; raw: boolean; agentId: string | null; beforeTurn: string | null }[] = [];
  const wsControls: { lane: string; type: string; payload: Record<string, unknown> }[] = [];
  const wsPongs: string[] = [];
  const peers: { send(message: string): void }[] = [];
  let authority = { epoch, processGeneration: 1 };
  let transcriptBody: Buffer | undefined;
  let transcriptStatus = 0;
  let transcriptGate: Promise<void> | undefined;
  let transcriptChunks = 0;
  let unsubscribeGate: Promise<void> | undefined;
  let published = 39;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    calls.push({ method: request.method ?? '', path: route.pathname + route.search, origin: request.headers.origin });
    response.setHeader('Content-Type', 'application/json');
    if (route.pathname === '/openapi.json' || route.pathname === '/asyncapi.json') {
      response.end(JSON.stringify(route.pathname === '/openapi.json' ? {
        paths: {
          '/api/v2/sessions': { get: {} }, '/api/v1/sessions': { post: {} },
          '/api/v1/sessions/{session_id}/snapshot': { get: {} }, '/api/v1/sessions/{session_id}/transcript': { get: {} },
          '/api/v1/sessions/{session_id}/prompts': { post: {} }, '/api/v1/sessions/{session_id}:abort': { post: {} },
          '/api/v1/sessions/{session_id}/approvals/{approval_id}': { post: {} }, '/api/v1/sessions/{session_id}/questions/{tail}': { post: {} },
          '/api/v1/models': { get: {} }, '/api/v1/sessions/{session_id}/status': { get: {} },
        },
      } : { components: { messages: { subscribe_v2: { name: 'subscribe_v2' }, subscribe: { name: 'subscribe' } } } }));
      return;
    }
    if (route.pathname === '/api/v1/meta') { response.end(JSON.stringify({ code: 0, data: { backend: 'v2', server_id: 'srv_fixture', server_version: '2.1.1', capabilities: { websocket: true } } })); return; }
    if (route.pathname === '/api/v2/sessions') { response.end(JSON.stringify({ code: 0, data: { items: [{ id: nativeSessionId, meta: { title: 'Fixture', archived: false }, workspace: { id: 'wd_fixture', cwd: dir }, busy: false, last_seq: 7 }], has_more: false, next_page_token: null } })); return; }
    if (route.pathname === `/api/v1/sessions/${nativeSessionId}/snapshot`) {
      response.end(JSON.stringify({ code: 0, data: { epoch: 'ep_fixture', as_of_seq: 7, session: { id: nativeSessionId, meta: { title: 'Fixture' }, workspace: { id: 'wd_fixture', cwd: dir }, busy: false, last_seq: 7 }, messages: { items: [], has_more: false }, in_flight_turn: { assistant_text: '', thinking_text: '' }, subagents: [], pending_approvals: [], pending_questions: [] } }));
      return;
    }
    if (route.pathname === `/api/v1/sessions/${nativeSessionId}/status`) { response.end(JSON.stringify({ code: 0, data: { busy: false } })); return; }
    if (route.pathname.endsWith('/transcript')) {
      const raw = route.searchParams.get('page_size') === '200';
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
    options, store, calls, transcriptPulls, wsControls, wsPongs,
    transcript(value: { body?: Buffer; status?: number; gate?: Promise<void> } | undefined) { transcriptBody = value?.body; transcriptStatus = value?.status ?? 0; transcriptGate = value?.gate; },
    transcriptChunks: () => transcriptChunks,
    setAuthority(value: { epoch: string; processGeneration: number }) { authority = value; },
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

describe('Kimi Web native selected-history producer over controlled raw HTTP and WebSocket', () => {
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
      expect(driver.registration.manifest.extensions.map((entry) => entry.name).sort()).toEqual(['kimi.listWorkspacePage', 'kimi.sessionStatus', 'listProviders']);
    } finally { await fixture.close(); }
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
