// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFollowState, historyPage } from '../../../shared/runtime/native/dsh/follow.js';
import { approvalOutcome, response, request, selectModel, summaries } from '../../../shared/runtime/native/dsh/protocol.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import { createDshDriver } from '../../../bridge/runtime/drivers/dshDriver.js';
import { createDshTransport } from '../../../bridge/runtime/drivers/dshTransport.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createWebSocketAccept, createRawWebSocketPeer } from '../../../bridge/webSocketFrames.js';
import { createHistoryStream, createHistoryDiskBudget, HISTORY_STREAM_LIMITS } from '../../../bridge/runtime/historyStream.js';
import type { InternalNativeHistoryHandle } from '../../../bridge/runtime/historyService.js';

const identity = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222') };
const snapshot = (cursor: number, version = 4) => ({ type: 'snapshot', header: { id: 'native', version }, cursor, records: [], hasMore: false });

describe('DSH Runtime native boundaries', () => {
  it('preserves literal events endpoint, argument envelope, void responses and classified remote failures without remote secrets', () => {
    expect(request('$events/result', { clientId: 'fresh', eventId: 'event', outcome: approvalOutcome('allowed-once') }, 'rpc')).toEqual({
      type: 'client-request', rpcId: 'rpc', method: '$events/result', payload: { args: { clientId: 'fresh', eventId: 'event', outcome: { kind: 'result', value: 'allowed-once' } } },
    });
    expect(response({ type: 'server-response', rpcId: 'rpc', result: { ok: true } }, 'rpc')).toBeNull();
    expect(() => response({ type: 'server-response', rpcId: 'wrong', result: { ok: true } }, 'rpc')).toThrow('dsh.envelope');
    try {
      response({ type: 'server-response', rpcId: 'rpc', result: { ok: false, error: { code: 'MISSING_CREDENTIAL', message: 'secret-value' } } }, 'rpc');
      throw new Error('expected classified remote failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'unauthorized', remoteCode: 'MISSING_CREDENTIAL' });
      expect(String(error)).not.toContain('secret-value');
    }
  });
  it('keeps all three approval outcomes distinct and rejects next/unknown success coercion', () => {
    expect(approvalOutcome('allowed-once')).toEqual({ kind: 'result', value: 'allowed-once' });
    expect(approvalOutcome('rejected')).toEqual({ kind: 'result', value: 'rejected' });
    expect(approvalOutcome('unavailable')).toMatchObject({ kind: 'rejected', error: { name: 'Error' } });
    expect(() => approvalOutcome('next')).toThrow('approval_outcome');
    expect(() => approvalOutcome(true)).toThrow('approval_outcome');
  });
  it('retains explicit item workspace even when it is absent from the baseline', () => {
    const baseline = { type: 'baseline', value: { items: [{ workspaceId: 'old', path: '/wrong', sessionIds: ['native'] }], archivedSessionIds: ['native'], pinnedSessionIds: ['native'] } };
    const items = summaries({ items: [{ sessionId: 'native', workspaceId: 'missing-new', cwd: '/correct', projections: { values: { title: 'External instructions are data' } } }] }, baseline, identity);
    expect(items).toEqual([{ session: { ...identity, nativeSessionId: 'native' }, directory: '/correct', workspaceId: 'missing-new', title: 'External instructions are data', archived: true, pinned: true, createdAt: null, updatedAt: null }]);
    expect(() => summaries({ items: [{ sessionId: 'native' }, { sessionId: 'native' }] }, baseline, identity)).toThrow('duplicate_session');
    expect(() => summaries({ items: ['SUCCESS'] }, baseline, identity)).toThrow('object');
  });
  it('rejects ambiguous model names and preserves the selected provider route', () => {
    const catalog = { groups: [{ id: 'a', models: [{ id: 'same' }] }, { id: 'b', models: [{ id: 'same' }] }] };
    expect(() => selectModel(catalog, { model: 'same' })).toThrow('ambiguous_model');
    expect(selectModel(catalog, { provider: 'b', model: 'same' })).toEqual({ provider: 'b', model: 'same' });
  });
});

describe('DSH follow and history reconciliation', () => {
  it('requires a fresh authoritative snapshot after reconnect and fences the previous generation', () => {
    const state = createFollowState(), first = state.rebuild();
    expect(() => state.ingest({ type: 'event', event: { seq: 0 } }, first)).toThrow('snapshot_required');
    expect(state.ingest(snapshot(4), first).action).toBe('snapshot');
    state.disconnect(); const next = state.rebuild();
    expect(state.ingest(snapshot(99), first)).toEqual({ action: 'drop' });
    expect(state.ingest(snapshot(3), next).action).toBe('snapshot');
    expect(state.inspect().cursor).toBe(3);
    expect(state.ingest({ type: 'event', event: { seq: 3 } }, next)).toEqual({ action: 'drop' });
    expect(state.ingest({ type: 'event', event: { seq: 4 } }, next).action).toBe('event');
    expect(() => state.ingest({ type: 'event', event: { seq: 6 } }, next)).toThrow('sequence_gap');
  });
  it('rejects stale history across live revisions and authoritative changes', () => {
    const state = createFollowState(), generation = state.rebuild();
    state.ingest(snapshot(3), generation); const history = state.historyFence();
    state.ingest({ type: 'assistant-stream', frame: { type: 'chunk', index: 0 } }, generation);
    expect(() => state.assertHistory(history)).toThrow('history_stale');
    expect(state.ingest(snapshot(2), generation).action).toBe('drop');
    expect(state.ingest(snapshot(1, 5), generation).action).toBe('snapshot');
    expect(state.inspect().cursor).toBe(1);
  });
  it('treats throughSeq as closed and beforeSeq as open without trusting native hasMore for completion', () => {
    const row = (seq: number) => ({ type: 'event', event: { seq } });
    expect(historyPage({ records: [row(2), row(3)], hasMore: false }, 3, 4, 2)).toMatchObject({ cursor: 2, completeness: 'partial', nativeHasMore: false });
    expect(historyPage({ records: [row(0), row(1)], hasMore: false }, 3, 2, 2)).toMatchObject({ cursor: null, completeness: 'complete' });
    expect(() => historyPage({ records: [row(3)], hasMore: true }, 3, 3, 2)).toThrow('history_bounds');
    expect(() => historyPage({ records: [], hasMore: true }, 3, 3, 2)).toThrow('history_no_progress');
    expect(historyPage({ records: [row(0), row(1), row(2), row(3)], hasMore: false }, 3, 4, 2)).toMatchObject({ records: [row(2), row(3)], cursor: 2, completeness: 'partial' });
    expect(historyPage({ records: [], hasMore: false }, -1, 0, 2)).toMatchObject({ records: [], cursor: null, completeness: 'complete' });
    expect(() => historyPage({ records: [row(2), row(2)], hasMore: false }, 3, 4, 2)).toThrow('history_bounds');
  });
});

const driverIdentity = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222') };
const epoch = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const nativeSessionId = 'session_dsh_fixture';
const sessionRef = parseSessionRef({ environmentId: driverIdentity.environmentId, harnessInstanceId: driverIdentity.harnessInstanceId, nativeSessionId });
const storeScope = JSON.stringify([driverIdentity.environmentId, driverIdentity.harnessInstanceId, sessionRef]);
const producerInput = { environmentId: driverIdentity.environmentId, harnessInstanceId: driverIdentity.harnessInstanceId, session: sessionRef, params: {} };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const historySignal = () => new AbortController().signal;
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('native condition was not reached'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
/** A real-shaped DSH `session/follow`/`session/page` event row; `padding` grows the row past every substrate bound. */
function eventRow(seq: number, padding = 0) {
  return { type: 'event', event: { seq, type: 'message', time: '2026-01-01T00:00:00.000Z', data: { text: 'x'.repeat(padding) } } };
}
function sequentialRecords(from: number, count: number, padding = 0) {
  return Array.from({ length: count }, (_, index) => eventRow(from + index, padding));
}
/** The raw `server-response` envelope `session/page` serves, never pre-parsed by the transport. */
function pageEnvelope(records: unknown[], hasMore: boolean) {
  return Buffer.from(JSON.stringify({ type: 'server-response', rpcId: 'rpc-page', result: { ok: true, value: { records, hasMore } } }));
}
/** A real-shaped cold-follow snapshot frame whose records are the full window up to `cursor`. */
function followSnapshot(cursor: number, records: unknown[], hasMore: boolean) {
  return { type: 'snapshot', header: { id: nativeSessionId, version: 4 }, cursor, records, hasMore };
}
/** One controlled loopback DSH: raw HTTP `session/page` plus the `/api/remote.mux` WebSocket mux that serves
 * the cold-follow snapshot and `$events`. Never a real `dsh web` install and never a paid or network call.
 */
async function controlledDsh() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-dsh-native-history-')); temporary.push(dir);
  const httpCalls: { method: string; path: string; args: Record<string, unknown> | null }[] = [];
  const openedStreams: { streamId: string; endpoint: string; args: unknown }[] = [];
  const cancelledStreams: string[] = [];
  const sentFrames: string[] = [];
  const peers: { send(message: string): void; close(): void }[] = [];
  let pageBody: Buffer = pageEnvelope([], false);
  let snapshotValue: unknown = followSnapshot(0, [], false);
  const snapshotSequence: unknown[] = [];
  let eventsStream = '';
  const server = createServer(async (request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let args: Record<string, unknown> | null = null;
    try { args = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { payload?: { args?: Record<string, unknown> } }).payload?.args ?? null; } catch { args = null; }
    httpCalls.push({ method: request.method ?? '', path: route.pathname, args });
    response.setHeader('Content-Type', 'application/json');
    if (route.pathname === '/api/session/page') { response.end(pageBody); return; }
    response.end(JSON.stringify({ type: 'server-response', rpcId: 'rpc-native', result: { ok: true, value: null } }));
  });
  server.on('upgrade', (request, socket) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    if (route.pathname !== '/api/remote.mux') { socket.destroy(); return; }
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => chunks.push(chunk);
    socket.on('data', collect);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createWebSocketAccept(String(request.headers['sec-websocket-key']))}\r\n\r\n`);
    socket.removeListener('data', collect);
    const peer = createRawWebSocketPeer(socket, Buffer.concat(chunks));
    peers.push(peer);
    peer.on('message', (text: string) => {
      let frame: { type?: string; streamId?: string; endpoint?: string; payload?: { args?: unknown } };
      try { frame = JSON.parse(text) as typeof frame; } catch { return; }
      if (frame.type !== 'open') { if (frame.type === 'cancel') cancelledStreams.push(String(frame.streamId)); return; }
      const streamId = String(frame.streamId), endpoint = String(frame.endpoint);
      openedStreams.push({ streamId, endpoint, args: frame.payload?.args ?? null });
      if (endpoint === '$events') {
        eventsStream = streamId;
        const message = JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'fixture-client', host: 'fixture-host' } });
        sentFrames.push(message); peer.send(message); return;
      }
      if (endpoint === 'session/follow') {
        const value = snapshotSequence.length ? snapshotSequence.shift() : snapshotValue;
        const message = JSON.stringify({ type: 'item', streamId, value });
        sentFrames.push(message); peer.send(message); return;
      }
      const message = JSON.stringify({ type: 'end', streamId });
      sentFrames.push(message); peer.send(message);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('missing fixture address');
  const store = createRuntimeStore({ stateDirectory: path.join(dir, 'runtime'), environmentId: driverIdentity.environmentId, ownerId, epoch });
  await store.ready;
  const origin = `http://127.0.0.1:${address.port}`;
  const options = {
    environmentId: driverIdentity.environmentId, harnessInstanceId: driverIdentity.harnessInstanceId, epoch, store,
    getOwnedEndpoint: () => ({ state: 'ready' as const, origin, nativeVersion: '0.2.0-rc.2', ownership: 'owned' as const, generation: 1 }),
    auth: { getCookie: async () => 'fixture-cookie', invalidate: () => {} },
    onEvent: () => {},
  };
  return {
    options, store, httpCalls, openedStreams, cancelledStreams, sentFrames,
    page(value: Buffer) { pageBody = value; },
    snapshot(value: unknown) { snapshotValue = value; },
    snapshots(values: unknown[]) { snapshotSequence.push(...values); },
    /** The raw mux frame the producer's own cold-follow stream consumed, identified by its unique streamId. */
    coldFollowFrame() {
      const opens = openedStreams.filter((entry) => entry.endpoint === 'session/follow');
      const own = opens.at(-1);
      return own ? sentFrames.find((frame) => frame.includes(`"streamId":"${own.streamId}"`)) : undefined;
    },
    waterfall(eventId: string, agentId: string, event: string) {
      for (const peer of peers) peer.send(JSON.stringify({ type: 'item', streamId: eventsStream, value: { type: 'waterfall', eventId, agentId, event, request: { questions: [{ id: 'q1', prompt: 'choose' }] } } }));
    },
    async close() {
      for (const peer of peers) peer.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await store.close();
    },
  };
}
async function historyStore() {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-dsh-history-spool-')); temporary.push(root);
  return createHistoryStream({ scope: storeScope, createDirectory: () => mkdtemp(path.join(root, 'spool-')), globalDisk: createHistoryDiskBudget() });
}
/** One driver plus its selected-history producer, with both always torn down even when a step fails. */
async function historyProducer(fixture: Awaited<ReturnType<typeof controlledDsh>>) {
  const driver = createDshDriver(fixture.options);
  const method = driver.driver.core.openHistory;
  if (typeof method !== 'function') throw new TypeError('missing openHistory producer');
  const handle = await method(producerInput) as InternalNativeHistoryHandle;
  return { driver, handle, async close() { try { await handle.close(); } finally { await driver.close(); } } };
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
const pageCalls = (fixture: Awaited<ReturnType<typeof controlledDsh>>) => fixture.httpCalls.filter((call) => call.path === '/api/session/page');

describe('DSH native selected-history producer over controlled raw HTTP and cold-follow WebSocket', () => {
  it('declares the native selected-history producer supported and leaves every other operation unchanged', async () => {
    const fixture = await controlledDsh();
    try {
      const driver = createDshDriver(fixture.options);
      expect(driver.manifest.core.openHistory).toEqual({ state: 'supported' });
      expect(typeof driver.driver.core.openHistory).toBe('function');
      for (const [name, support] of Object.entries(driver.manifest.core)) {
        if (name === 'openHistory') continue;
        expect(support).toEqual({ state: 'supported' });
      }
      expect(driver.manifest.core.readHistoryPage).toEqual({ state: 'supported' });
    } finally { await fixture.close(); }
  });
  it('streams the cold-follow WS snapshot through the bounded substrate before any parse', async () => {
    const fixture = await controlledDsh();
    const records = sequentialRecords(0, 4, 64);
    fixture.snapshot(followSnapshot(3, records, false));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document) throw new TypeError('missing native document');
      expect(page.items.map((item) => item.recordId)).toEqual(['0', '1', '2', '3']);
      expect(page.items.every((item) => item.kind === 'stream')).toBe(true);
      expect(page).toMatchObject({ completeness: 'complete', cursor: null, reason: 'native-follow-snapshot' });
      const frame = fixture.coldFollowFrame();
      if (!frame) throw new TypeError('missing cold-follow snapshot frame');
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      expect(document.sizes.every((size) => size <= HISTORY_STREAM_LIMITS.chunkBytes)).toBe(true);
      expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(page.document.sha256);
      expect(createHash('sha256').update(Buffer.from(frame, 'utf8')).digest('hex')).toBe(page.document.sha256);
      expect(document.bytes.equals(Buffer.from(frame, 'utf8'))).toBe(true);
      const first = page.items[0];
      if (first?.kind !== 'stream') throw new TypeError('missing native record');
      const record = await drainDescriptor(producer.handle, page.pageId, first.descriptor.id);
      expect(record.bytes.toString('utf8')).toBe(JSON.stringify(records[0]));
      expect(createHash('sha256').update(record.bytes).digest('hex')).toBe(first.descriptor.sha256);
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
      expect(store.usage().diskBytes).toBe(page.document.totalBytes);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('streams the raw HTTP session/page body through the bounded substrate before any concat or parse', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(399, sequentialRecords(200, 4, 64), true));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const first = await producer.handle.page({ signal: historySignal() });
      expect(first).toMatchObject({ completeness: 'partial', cursor: '200' });
      const body = pageEnvelope(sequentialRecords(0, 3, 32), false);
      fixture.page(body);
      const second = await producer.handle.page({ cursor: '200', signal: historySignal() });
      if (!second.document) throw new TypeError('missing native document');
      expect(second.items.map((item) => item.recordId)).toEqual(['0', '1', '2']);
      expect(second).toMatchObject({ completeness: 'complete', cursor: null, reason: 'native-session-page' });
      const document = await drainDescriptor(producer.handle, second.pageId, second.document.id);
      expect(document.sizes.every((size) => size <= HISTORY_STREAM_LIMITS.chunkBytes)).toBe(true);
      expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(second.document.sha256);
      expect(createHash('sha256').update(body).digest('hex')).toBe(second.document.sha256);
      expect(document.bytes.equals(body)).toBe(true);
      expect(pageCalls(fixture)).toHaveLength(1);
      expect(pageCalls(fixture)[0]?.args).toMatchObject({ request: { address: { kind: 'session', sessionId: nativeSessionId }, throughSeq: 399, beforeSeq: 200 } });
      expect(JSON.stringify(pageCalls(fixture)[0]?.args)).not.toContain('maxMessages');
      expect(store.usage().pages).toBe(2);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('rejects a real-shaped HTTP history response past the substrate byte bound before any parse', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(399, sequentialRecords(200, 4, 64), true));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await producer.handle.page({ signal: historySignal() });
      const body = pageEnvelope(sequentialRecords(0, 120, 20000), false);
      expect(body.byteLength).toBeGreaterThan(2097152);
      fixture.page(body);
      await expect(producer.handle.page({ cursor: '200', signal: historySignal() })).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.output_quota' });
      expect(store.usage()).toMatchObject({ pages: 1, fileHandles: 0, pendingWrites: 0, outputs: 0 });
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('rejects a cold-follow snapshot past the substrate record bound before any parse', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(299, sequentialRecords(100, 260, 16), true));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'source_unavailable', field: 'history.record_limit' });
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0, fileHandles: 0, pendingWrites: 0, outputs: 0 });
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('rejects a cold-follow snapshot whose record carries no native identity', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(3, [{ type: 'event', event: { type: 'message' } }], false));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'invalid_request', field: 'dsh.history_seq' });
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0 });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('rejects a cold-follow snapshot addressed to a different native session', async () => {
    const fixture = await controlledDsh();
    fixture.snapshots([followSnapshot(3, sequentialRecords(0, 2, 8), false), { type: 'snapshot', header: { id: 'other-session', version: 4 }, cursor: 3, records: sequentialRecords(0, 2, 8), hasMore: false }]);
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      await expect(producer.handle.page({ signal: historySignal() })).rejects.toMatchObject({ code: 'reconcile_required', field: 'dsh.history_scope' });
      expect(store.usage()).toMatchObject({ diskBytes: 0, pages: 0 });
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('pages the whole history through the substrate instead of truncating at the old maxMessages cap', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(399, sequentialRecords(200, 200, 8), true));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const first = await producer.handle.page({ signal: historySignal() });
      expect(first.items).toHaveLength(200);
      expect(first).toMatchObject({ completeness: 'partial', cursor: '200' });
      fixture.page(pageEnvelope(sequentialRecords(0, 200, 8), false));
      const second = await producer.handle.page({ cursor: '200', signal: historySignal() });
      expect(second.items).toHaveLength(200);
      expect(second).toMatchObject({ completeness: 'complete', cursor: null });
      expect(store.usage().pages).toBe(2);
      expect(pageCalls(fixture)).toHaveLength(1);
      expect(JSON.stringify(pageCalls(fixture)[0]?.args)).not.toContain('maxMessages');
      // The producer's own cold-follow admission (opened after the driver's monitor) also carries no maxMessages.
      const followOpens = fixture.openedStreams.filter((entry) => entry.endpoint === 'session/follow');
      expect(followOpens.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(followOpens.at(-1)?.args)).not.toContain('maxMessages');
      expect(JSON.stringify(followOpens.at(-1)?.args)).toContain('assistantStream');
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
  it('releasing the selected-history owner leaves the minimal operation/control monitor alive', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(399, sequentialRecords(200, 4, 16), true));
    fixture.page(pageEnvelope(sequentialRecords(0, 4, 16), false));
    const driver = createDshDriver(fixture.options);
    const method = driver.driver.core.openHistory;
    if (typeof method !== 'function') throw new TypeError('missing openHistory producer');
    const first = await method(producerInput) as InternalNativeHistoryHandle;
    const second = await method(producerInput) as InternalNativeHistoryHandle;
    const store = await historyStore();
    try {
      await first.open({ signal: historySignal(), streamStore: store });
      await second.open({ signal: historySignal(), streamStore: store });
      // The driver opened exactly one operation/control monitor; producers open their own cold-follow later.
      const monitor = fixture.openedStreams.filter((entry) => entry.endpoint === 'session/follow');
      expect(monitor).toHaveLength(1);
      const monitorStream = monitor[0]?.streamId;
      expect(monitorStream).toBeTypeOf('string');
      expect((await first.page({ signal: historySignal() })).cursor).toBe('200');
      await first.close();
      expect(fixture.cancelledStreams).not.toContain(monitorStream);
      expect((await second.page({ signal: historySignal() })).cursor).toBe('200');
      expect((await second.page({ cursor: '200', signal: historySignal() })).completeness).toBe('complete');
      await second.close();
      expect(fixture.cancelledStreams).not.toContain(monitorStream);
      // The monitor itself still answers the driver's own session read.
      const getSession = driver.driver.core.getSession;
      if (typeof getSession !== 'function') throw new TypeError('missing getSession operation');
      expect(await getSession({ ...producerInput, params: {} })).toMatchObject({ session: sessionRef, cursor: 399 });
    } finally { await store.close(); await driver.close(); await fixture.close(); }
  });
  it('answers a native user-questions waterfall frame with a terminal response', async () => {
    const fixture = await controlledDsh();
    const producer = await historyProducer(fixture);
    try {
      await waitFor(() => fixture.openedStreams.some((entry) => entry.endpoint === '$events'));
      fixture.waterfall('evt-questions-1', nativeSessionId, 'user-questions');
      await waitFor(() => fixture.httpCalls.some((call) => call.path === '/api/$events/result'));
      const call = fixture.httpCalls.find((entry) => entry.path === '/api/$events/result');
      expect(call?.method).toBe('POST');
      expect(call?.args).toMatchObject({ clientId: 'fixture-client', eventId: 'evt-questions-1' });
      expect((call?.args as { outcome?: { kind?: string } } | null)?.outcome?.kind).toBe('rejected');
    } finally { await producer.close(); await fixture.close(); }
  });
  it('keeps every raw source piece inside the 64KiB substrate bound including its backing allocation', async () => {
    const fixture = await controlledDsh();
    const body = pageEnvelope(sequentialRecords(0, 60, 40000), false);
    expect(body.byteLength).toBeGreaterThan(2097152);
    fixture.page(body);
    const transport = createDshTransport({ ...fixture.options, deadlineMs: 15000 });
    try {
      const pulled = await transport.pullRaw('session/page', { request: { address: { kind: 'session', sessionId: nativeSessionId }, throughSeq: 59, beforeSeq: 60 } });
      const reader = pulled.body.getReader();
      let pieces = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          expect(next.value).toBeInstanceOf(Uint8Array);
          expect(next.value.byteLength).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.chunkBytes);
          expect(next.value.buffer.byteLength).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.chunkBytes);
          pieces += 1;
        }
      } finally { await reader.cancel(); }
      expect(pieces).toBeGreaterThan(32);
    } finally { transport.close(); await fixture.close(); }
  });
  it('ingests a within-budget native history document with a full SHA-256 equality proof', async () => {
    const fixture = await controlledDsh();
    fixture.snapshot(followSnapshot(399, sequentialRecords(200, 200, 8), true));
    const producer = await historyProducer(fixture);
    const store = await historyStore();
    try {
      await producer.handle.open({ signal: historySignal(), streamStore: store });
      const page = await producer.handle.page({ signal: historySignal() });
      if (!page.document) throw new TypeError('missing native document');
      const frame = fixture.coldFollowFrame();
      if (!frame) throw new TypeError('missing cold-follow snapshot frame');
      expect(page.items).toHaveLength(200);
      const document = await drainDescriptor(producer.handle, page.pageId, page.document.id);
      expect(document.sizes).toHaveLength(Math.ceil(Buffer.byteLength(frame, 'utf8') / HISTORY_STREAM_LIMITS.chunkBytes));
      expect(Math.max(...document.sizes)).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.chunkBytes);
      expect(createHash('sha256').update(document.bytes).digest('hex')).toBe(page.document.sha256);
      expect(createHash('sha256').update(Buffer.from(frame, 'utf8')).digest('hex')).toBe(page.document.sha256);
      expect(document.bytes.equals(Buffer.from(frame, 'utf8'))).toBe(true);
      expect(store.usage().diskBytes).toBe(page.document.totalBytes);
      expect(store.usage().peakMemoryBytes).toBeLessThanOrEqual(HISTORY_STREAM_LIMITS.workingBytes + 2097152);
    } finally { await producer.close(); await store.close(); await fixture.close(); }
  });
});

