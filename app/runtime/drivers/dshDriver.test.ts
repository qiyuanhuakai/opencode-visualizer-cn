// @vitest-environment node
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFollowState, historyPage } from '../../../shared/runtime/native/dsh/follow.js';
import { approvalOutcome, response, request, selectModel, summaries } from '../../../shared/runtime/native/dsh/protocol.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, encodeSessionKey, type SessionRef } from '../../../shared/runtime/identity.js';
import { createDshDriver } from '../../../bridge/runtime/drivers/dshDriver.js';
import { createDshTransport } from '../../../bridge/runtime/drivers/dshTransport.js';
import { createRuntimeStore, type RuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createWebSocketAccept, createRawWebSocketPeer } from '../../../bridge/webSocketFrames.js';
import { createHistoryStream, createHistoryDiskBudget, HISTORY_STREAM_LIMITS } from '../../../bridge/runtime/historyStream.js';
import type { InternalNativeHistoryHandle } from '../../../bridge/runtime/historyService.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { CoreOperation, HarnessContext, HarnessMethod } from '../../../shared/runtime/harnessContract.js';
import { fingerprint } from '../../../bridge/runtime/operationJournal.js';

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

{
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

}

{
const epoch = '33333333-3333-4333-8333-333333333333';
const driverIdentity = { ...identity, epoch };
const sessionRef = (nativeSessionId: string): SessionRef => ({ ...identity, nativeSessionId });
const coreContext = (params: JsonValue, session?: SessionRef): HarnessContext => ({ environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, ...(session ? { session } : {}), params });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
type DshDriverInstance = ReturnType<typeof createDshDriver>;

interface DshSubscription {
  readonly ready: Promise<unknown>;
  next(): Promise<{ readonly value?: unknown; readonly done: boolean }>;
  return(): Promise<{ readonly value?: unknown; readonly done: boolean }>;
}
interface DshListPage {
  readonly items: readonly { readonly session: { readonly nativeSessionId: string } }[];
  readonly cursor: string | null;
  readonly completeness: string;
  readonly total: number;
}
interface DshSendResult { readonly accepted: { readonly operationId: string } }

function isSubscription(value: unknown): value is DshSubscription {
  return isRecord(value) && value.ready instanceof Promise && typeof value.next === 'function' && typeof value.return === 'function';
}
function isListPage(value: unknown): value is DshListPage {
  return isRecord(value) && Array.isArray(value.items) && typeof value.total === 'number' && typeof value.completeness === 'string'
    && (value.cursor === null || typeof value.cursor === 'string')
    && value.items.every((item: unknown) => isRecord(item) && isRecord(item.session) && typeof item.session.nativeSessionId === 'string');
}
function isSendResult(value: unknown): value is DshSendResult {
  return isRecord(value) && isRecord(value.accepted) && typeof value.accepted.operationId === 'string';
}
function coreMethod(driver: DshDriverInstance, name: CoreOperation): HarnessMethod {
  const method = driver.driver.core[name];
  if (typeof method !== 'function') throw new Error(`dsh driver is missing core operation ${name}`);
  return method;
}
async function subscribeSession(driver: DshDriverInstance, session: SessionRef): Promise<DshSubscription> {
  const result = await coreMethod(driver, 'subscribe')(coreContext({}, session));
  if (!isSubscription(result)) throw new Error('unexpected subscribe result');
  return result;
}
async function listPage(driver: DshDriverInstance, params: JsonValue): Promise<DshListPage> {
  const result = await coreMethod(driver, 'listSessionPage')(coreContext(params));
  if (!isListPage(result)) throw new Error('unexpected listSessionPage result');
  return result;
}
async function getSession(driver: DshDriverInstance, session: SessionRef): Promise<void> {
  await coreMethod(driver, 'getSession')(coreContext({}, session));
}
async function sendPrompt(driver: DshDriverInstance, session: SessionRef, idempotencyKey: string): Promise<DshSendResult> {
  const result = await coreMethod(driver, 'send')(coreContext({ idempotencyKey, request: { parts: [] } }, session));
  if (!isSendResult(result)) throw new Error('unexpected send result');
  return result;
}

const nativeBaseline = { type: 'baseline', value: { items: [{ workspaceId: 'work-fixture', path: '/fixture/workspace', sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] } };

type ControlledStream = {
  readonly endpoint: string;
  readonly nativeSessionId: string | undefined;
  readonly send: (value: unknown) => void;
  readonly controller: AbortController;
};

type ControlledDsh = {
  readonly origin: string;
  readonly summaries: Array<Record<string, unknown>>;
  readonly snapshots: Map<string, { cursor: number; records: Array<Record<string, unknown>> }>;
  readonly openedFollows: Set<string>;
  readonly cancelledFollows: string[];
  readonly liveFollows: () => number;
  readonly follow: (value: Record<string, unknown>, nativeSessionId: string) => void;
  readonly holdPage: () => void;
  readonly releasePage: () => void;
  readonly heldPageCount: () => number;
  readonly approval: (nativeSessionId: string, eventId: string) => void;
  readonly cancelApproval: (eventId: string) => void;
  readonly disconnect: () => void;
  readonly close: () => Promise<void>;
};

const snapshotRecords = (cursor: number) => Array.from({ length: cursor + 1 }, (_, seq) => ({ type: 'event', event: { seq, time: seq, type: seq ? 'assistant/message' : 'turn/start', data: { text: `record-${seq}` } } }));

async function createControlledDsh(summaries: Array<Record<string, unknown>>): Promise<ControlledDsh> {
  const snapshots = new Map<string, { cursor: number; records: Array<Record<string, unknown>> }>();
  const streams = new Set<ControlledStream>();
  const sockets = new Set<Duplex>();
  const openedFollows = new Set<string>();
  const cancelledFollows: string[] = [];
  let pageGate: Promise<void> | undefined, releasePageGate: (() => void) | undefined, heldPages = 0;
  const snapshotFrame = (nativeSessionId: string) => {
    const stored = snapshots.get(nativeSessionId);
    const cursor = stored?.cursor ?? 2;
    return {
      type: 'snapshot',
      header: { id: nativeSessionId, version: 4, cwd: '/fixture/workspace', createdAt: 1, agentPreset: 'minimal' },
      cursor, records: stored?.records ?? snapshotRecords(cursor), hasMore: false,
      projections: { asOfSeq: cursor, values: { modelSelection: { next: { provider: 'provider-a', model: 'shared-model' } } } },
    };
  };
  const server = createServer();
  server.on('request', (req, res) => {
    void (async () => {
      if (req.headers.cookie !== 'private-fixture-cookie') { res.writeHead(401); res.end('unauthorized'); return; }
      let bytes = '';
      for await (const chunk of req) { bytes += chunk; if (bytes.length > 1048576) { req.destroy(); return; } }
      const envelope = JSON.parse(bytes) as { rpcId: string; payload: { args: { request?: Record<string, unknown> } } };
      const method = (req.url ?? '').slice('/api/'.length), args = envelope.payload.args;
      let value: unknown;
      if (method === 'session/list') value = { items: summaries };
      else if (method === 'session/page') {
        if (pageGate) { heldPages += 1; await pageGate; }
        const sessionId = String((args.request as { address: { sessionId: string } }).address.sessionId);
        const entry = snapshots.get(sessionId);
        value = { records: (entry?.records ?? []).filter((row) => Number((row.event as { seq: number }).seq) < Number(args.request?.beforeSeq)), hasMore: false };
      } else if (method === 'session/create') value = { sessionId: `created-${randomUUID()}`, agentPreset: 'minimal' };
      else if (method === 'session/prompt' || method === 'session/cancel') value = { accepted: true };
      else if (method === 'session/modelCatalog') value = { groups: [{ id: 'provider-a', models: [{ id: 'shared-model' }] }], failures: [] };
      else value = {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
    })().catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end('fixture-error'); } });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.cookie !== 'private-fixture-cookie') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const acceptKey = req.headers['sec-websocket-key'];
    if (typeof acceptKey !== 'string') { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createWebSocketAccept(acceptKey)}\r\n\r\n`);
    const peer = createRawWebSocketPeer(socket, head, { heartbeatIntervalMs: 0 });
    const local = new Map<string, ControlledStream>();
    peer.on('message', (text) => {
      const frame = JSON.parse(text) as { type: string; streamId: string; endpoint: string; payload: { args: { request?: { address?: { sessionId: string } } } } };
      if (frame.type === 'cancel') {
        const entry = local.get(frame.streamId);
        if (entry) { cancelledFollows.push(String(entry.nativeSessionId)); entry.controller.abort(); }
        return;
      }
      const controller = new AbortController();
      const nativeSessionId = frame.payload?.args?.request?.address?.sessionId;
      const entry: ControlledStream = {
        endpoint: frame.endpoint, nativeSessionId, controller,
        send: (value) => peer.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value })),
      };
      streams.add(entry); local.set(frame.streamId, entry);
      controller.signal.addEventListener('abort', () => { streams.delete(entry); local.delete(frame.streamId); });
      if (frame.endpoint === '$events') peer.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'fixture-client' } }));
      else if (frame.endpoint === 'workspace/follow') entry.send(nativeBaseline);
      else if (frame.endpoint === 'session/follow') { openedFollows.add(String(nativeSessionId)); entry.send(snapshotFrame(String(nativeSessionId))); }
    });
    peer.on('close', () => { for (const entry of local.values()) entry.controller.abort(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    summaries, snapshots, openedFollows, cancelledFollows,
    liveFollows: () => [...streams].filter((entry) => entry.endpoint === 'session/follow').length,
    follow(value, nativeSessionId) {
      const previous = snapshots.get(nativeSessionId);
      if (value.type === 'event' && previous && Number((value.event as { seq: number }).seq) > previous.cursor) {
        snapshots.set(nativeSessionId, { cursor: Number((value.event as { seq: number }).seq), records: [...previous.records, value] });
      }
      for (const entry of streams) if (entry.endpoint === 'session/follow' && entry.nativeSessionId === nativeSessionId) entry.send(value);
    },
    holdPage() { pageGate = new Promise<void>((resolve) => { releasePageGate = resolve; }); },
    releasePage() { const release = releasePageGate; pageGate = undefined; releasePageGate = undefined; release?.(); },
    heldPageCount: () => heldPages,
    approval(nativeSessionId, eventId) { for (const entry of streams) if (entry.endpoint === '$events') entry.send({ type: 'waterfall', event: 'approval/request', eventId, agentId: nativeSessionId, request: { toolName: 'owned-capacity-probe', args: {} } }); },
    cancelApproval(eventId) { for (const entry of streams) if (entry.endpoint === '$events') entry.send({ type: 'cancel', eventId }); },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

type DshHarness = {
  readonly driver: ReturnType<typeof createDshDriver>;
  readonly controlled: ControlledDsh;
  readonly store: RuntimeStore;
  readonly events: Array<Record<string, unknown>>;
  readonly leaseKey: (session: SessionRef) => string;
  readonly leaseRows: () => Promise<number>;
  readonly operationPhase: (operationId: string) => Promise<string | undefined>;
  dispose: () => Promise<void>;
};

async function withDshDriver(summaries: Array<Record<string, unknown>>, action: (harness: DshHarness) => Promise<void>, decorate?: (store: RuntimeStore) => RuntimeStore): Promise<void> {
  const controlled = await createControlledDsh(summaries);
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-driver-test-'));
  const created = createRuntimeStore({ stateDirectory: directory, environmentId: identity.environmentId, ownerId: identity.harnessInstanceId, epoch });
  await created.ready;
  const events: Array<Record<string, unknown>> = [];
  const store = decorate ? decorate(created) : created;
  const driver = createDshDriver({
    ...driverIdentity, store, onEvent: (event) => { events.push(event as Record<string, unknown>); },
    getOwnedEndpoint: () => ({ state: 'ready', ownership: 'owned', nativeVersion: '0.2.0-rc.2', origin: controlled.origin, generation: 1 }),
    auth: { getCookie: async () => 'private-fixture-cookie', invalidate: () => {} },
  });
  const harness: DshHarness = {
    driver, controlled, store, events,
    leaseKey: (session) => `lease:${fingerprint(encodeSessionKey(session))}`,
    leaseRows: async () => (await store.page({ collection: 'operations', limit: 200 })).items
      .filter((item) => item.key.startsWith('lease:') && item.value != null).length,
    operationPhase: async (operationId) => ((await store.getControl({ collection: 'operations', key: operationId }))?.value as { phase?: string } | undefined)?.phase,
    dispose: async () => { await driver.close(); await created.close(); await controlled.close(); await rm(directory, { recursive: true, force: true }); },
  };
  try { await action(harness); } finally { await harness.dispose(); }
}

const summaryOf = (nativeSessionId: string) => ({ sessionId: nativeSessionId, cwd: '/fixture/workspace', projections: { values: { title: nativeSessionId } } });
const SELECTED_SLOTS = 4;

describe('DSH driver selected-slot lifecycle', () => {
  it('releases the selected slot of an ended subscription so sequential browsing past the cap succeeds', async () => {
    const browsed = Array.from({ length: 7 }, (_, index) => `seq-${index + 1}`);
    await withDshDriver(browsed.map(summaryOf), async ({ driver, controlled }) => {
      for (const nativeSessionId of browsed) controlled.snapshots.set(nativeSessionId, { cursor: 2, records: [] });
      const accepted: string[] = [], refused: string[] = [];
      for (const nativeSessionId of browsed) {
        const subscription = await subscribeSession(driver, sessionRef(nativeSessionId));
        try { await subscription.ready; await subscription.next(); await subscription.return(); accepted.push(nativeSessionId); }
        catch (error) { refused.push(`${nativeSessionId}:${(error as { code: string; field: string }).code}/${(error as { field: string }).field}`); }
      }
      expect(refused).toEqual([]);
      expect(accepted).toEqual(browsed);
      expect(controlled.openedFollows.size).toBe(browsed.length);
      expect(controlled.liveFollows()).toBeLessThanOrEqual(SELECTED_SLOTS);
      expect(controlled.liveFollows()).toBeLessThan(browsed.length);
      expect(controlled.cancelledFollows.length).toBe(browsed.length - controlled.liveFollows());
    });
  });

  it('releases the selected slot of a finished getSession so a fifth distinct session is served', async () => {
    const browsed = Array.from({ length: 8 }, (_, index) => `read-${index + 1}`);
    await withDshDriver(browsed.map(summaryOf), async ({ driver, controlled }) => {
      for (const nativeSessionId of browsed) controlled.snapshots.set(nativeSessionId, { cursor: 2, records: [] });
      const accepted: string[] = [], refused: string[] = [];
      for (const nativeSessionId of browsed) {
        try { await getSession(driver, sessionRef(nativeSessionId)); accepted.push(nativeSessionId); }
        catch (error) { refused.push(`${nativeSessionId}:${(error as { code: string; field: string }).code}/${(error as { field: string }).field}`); }
      }
      expect(refused).toEqual([]);
      expect(accepted).toEqual(browsed);
      expect(controlled.openedFollows.size).toBe(browsed.length);
      expect(controlled.liveFollows()).toBeLessThanOrEqual(SELECTED_SLOTS);
      expect(controlled.liveFollows()).toBeLessThan(browsed.length);
      expect(controlled.cancelledFollows.length).toBe(browsed.length - controlled.liveFollows());
    });
  });

  it('keeps a followed session selected while its subscription is live', async () => {
    const browsed = Array.from({ length: 6 }, (_, index) => `held-peer-${index + 1}`);
    await withDshDriver([summaryOf('held'), ...browsed.map(summaryOf)], async ({ driver, controlled }) => {
      controlled.snapshots.set('held', { cursor: 2, records: [] });
      for (const nativeSessionId of browsed) controlled.snapshots.set(nativeSessionId, { cursor: 2, records: [] });
      const held = await subscribeSession(driver, sessionRef('held'));
      await held.ready;
      const accepted: string[] = [], refused: string[] = [];
      for (const nativeSessionId of browsed) {
        try { await getSession(driver, sessionRef(nativeSessionId)); accepted.push(nativeSessionId); }
        catch (error) { refused.push(`${nativeSessionId}:${(error as { code: string; field: string }).code}/${(error as { field: string }).field}`); }
      }
      expect(refused).toEqual([]);
      expect(accepted).toEqual(browsed);
      expect(controlled.cancelledFollows).not.toContain('held');
      expect(controlled.liveFollows()).toBeGreaterThanOrEqual(2);
      await held.return();
    });
  });
});

describe('DSH driver reclaim and paging interleaving', () => {
  it('keeps a subscription acquired while the reclaim query is in flight from being cancelled by the stale answer', { timeout: 30000 }, async () => {
    const browsed = Array.from({ length: 5 }, (_, index) => `race-${index + 1}`);
    type LeaseReadGate = { readonly key: string; entered: number; readonly held: Promise<void>; readonly release: () => void };
    let leaseGate: LeaseReadGate | undefined;
    await withDshDriver(browsed.map(summaryOf), async ({ driver, controlled, events }) => {
      for (const nativeSessionId of browsed) controlled.snapshots.set(nativeSessionId, { cursor: 2, records: snapshotRecords(2) });
      for (const nativeSessionId of browsed.slice(0, SELECTED_SLOTS)) await getSession(driver, sessionRef(nativeSessionId));
      expect(controlled.liveFollows()).toBe(SELECTED_SLOTS);
      let releaseLeaseRead = () => {};
      const leaseReadHeld = new Promise<void>((resolve) => { releaseLeaseRead = resolve; });
      leaseGate = { key: `lease:${fingerprint(encodeSessionKey(sessionRef('race-1')))}`, entered: 0, held: leaseReadHeld, release: releaseLeaseRead };
      // The fifth selection fills the last slot, so the reclaim query for race-1 is issued and held in flight.
      const fifth = getSession(driver, sessionRef('race-5'));
      expect(leaseGate.entered).toBe(1);
      // The re-subscription is fully acquired (snapshot delivered) while that query is still in flight.
      const subscription = await subscribeSession(driver, sessionRef('race-1'));
      await subscription.ready;
      const snapshotItem = await subscription.next();
      expect(snapshotItem.done).toBe(false);
      expect(snapshotItem.value).toMatchObject({ type: 'session-snapshot', session: { nativeSessionId: 'race-1' } });
      leaseGate.release();
      await fifth;
      expect(leaseGate.entered).toBe(1);
      // Only the subscribe refresh may cancel race-1; the reclaim must never cancel the re-acquired follow.
      expect(controlled.cancelledFollows.filter((nativeSessionId) => nativeSessionId === 'race-1')).toEqual(['race-1']);
      expect(controlled.liveFollows()).toBe(2);
      expect(events.filter((event) => event.type === 'source-disconnected' || event.type === 'source-error')).toEqual([]);
      controlled.follow({ type: 'event', event: { seq: 3, type: 'assistant/message', data: { text: 'after-reacquire' } } }, 'race-1');
      const eventItem = await subscription.next();
      expect(eventItem.done).toBe(false);
      expect(eventItem.value).toMatchObject({ type: 'session-event', value: { type: 'event', event: { seq: 3 } } });
      await subscription.return();
    }, (created) => ({
      ...created,
      getControl: async (params) => {
        const gate = leaseGate;
        if (gate && params.collection === 'operations' && params.key === gate.key) {
          gate.entered += 1;
          await gate.held;
        }
        return created.getControl(params);
      },
    }));
  });

  it('keeps a subscription acquired after the final idle check from losing its registration', { timeout: 30000 }, async () => {
    const browsed = Array.from({ length: 5 }, (_, index) => `race-${index + 1}`);
    const held = Promise.withResolvers<void>();
    let entered = 0;
    const leaseKey = `lease:${fingerprint(encodeSessionKey(sessionRef('race-1')))}`;
    let subscription: DshSubscription | undefined;
    let driverRef: DshDriverInstance | undefined;
    await withDshDriver(browsed.map(summaryOf), async ({ driver, controlled }) => {
      driverRef = driver;
      for (const nativeSessionId of browsed) controlled.snapshots.set(nativeSessionId, { cursor: 2, records: snapshotRecords(2) });
      for (const nativeSessionId of browsed.slice(0, SELECTED_SLOTS)) await getSession(driver, sessionRef(nativeSessionId));
      expect(controlled.liveFollows()).toBe(SELECTED_SLOTS);
      // The fifth selection fills the last slot, so the reclaim query for race-1 is issued and held in flight.
      const fifth = getSession(driver, sessionRef('race-5'));
      const deadline = Date.now() + 10000;
      while (entered === 0 && Date.now() < deadline) await sleep(5);
      expect(entered).toBe(1);
      held.resolve();
      await fifth;
      // The re-subscription is acquired after the reclaim's final idle check has already
      // answered but before its eviction runs: two continuation links past the driver's
      // own reaction on the held store response land the re-acquisition in that gap.
      const settle = Date.now() + 10000;
      while (!subscription && Date.now() < settle) await sleep(5);
      expect(subscription).toBeDefined();
      await subscription!.ready;
      await subscription!.next();
      // A later selection of the same session must reuse the registered entry: one native
      // follow per selected session, never a second one beside the live subscription.
      await getSession(driver, sessionRef('race-1'));
      expect(controlled.liveFollows()).toBe(2);
      controlled.follow({ type: 'event', event: { seq: 3, time: 3, type: 'assistant/message', data: { text: 'after-reacquire' } } }, 'race-1');
      // getSession refreshes the follow, so its snapshot may still be queued ahead of the event.
      let item = await subscription!.next();
      while (isRecord(item.value) && item.value.type === 'session-snapshot') item = await subscription!.next();
      expect(item.value).toMatchObject({ type: 'session-event', value: { type: 'event', event: { seq: 3 } } });
      await subscription!.return();
    }, (created) => ({
      ...created,
      getControl(params: Parameters<RuntimeStore['getControl']>[0]) {
        if (params.collection !== 'operations' || params.key !== leaseKey) return created.getControl(params);
        entered += 1;
        const response = created.getControl(params);
        const deferred = Promise.withResolvers<Awaited<ReturnType<typeof created.getControl>>>();
        void held.promise.then(() => {
          response.then(
            (value) => deferred.resolve(value),
            (error) => deferred.reject(error),
          );
          queueMicrotask(() => {
            let chain: Promise<unknown> = response;
            for (let index = 0; index < 3; index++) chain = chain.then(() => undefined);
            void chain.then(async () => {
              if (driverRef) subscription = await subscribeSession(driverRef, sessionRef('race-1'));
            });
          });
        });
        return deferred.promise;
      },
    }));
  });

  it('holds the read token across in-flight history paging while another session takes the slot', { timeout: 30000 }, async () => {
    const browsed = Array.from({ length: 5 }, (_, index) => `page-${index + 1}`);
    await withDshDriver(browsed.map(summaryOf), async ({ driver, controlled, events }) => {
      for (const nativeSessionId of browsed) controlled.snapshots.set(nativeSessionId, { cursor: 2, records: snapshotRecords(2) });
      for (const nativeSessionId of browsed.slice(0, SELECTED_SLOTS)) await getSession(driver, sessionRef(nativeSessionId));
      expect(controlled.liveFollows()).toBe(SELECTED_SLOTS);
      // The native page response is held in flight while the fifth session is selected.
      controlled.holdPage();
      const reading = coreMethod(driver, 'readHistoryPage')(coreContext({}, sessionRef('page-1')));
      const deadline = Date.now() + 10000;
      while (controlled.heldPageCount() === 0 && Date.now() < deadline) await sleep(5);
      expect(controlled.heldPageCount()).toBe(1);
      await getSession(driver, sessionRef('page-5'));
      controlled.releasePage();
      const page = await reading;
      expect(page).toMatchObject({ completeness: 'complete', cursor: null, nativeHasMore: false, throughSeq: 2 });
      expect((page as { records: unknown[] }).records).toHaveLength(3);
      expect(controlled.cancelledFollows).not.toContain('page-1');
      expect(controlled.liveFollows()).toBe(2);
      expect(events.filter((event) => event.type === 'source-disconnected' || event.type === 'source-error')).toEqual([]);
    });
  });
});

describe('DSH driver summary snapshot slot lifecycle', () => {
  it('does not retain a snapshot slot for a complete single-page result', async () => {
    await withDshDriver(Array.from({ length: 6 }, (_, index) => summaryOf(`single-${index + 1}`)), async ({ driver }) => {
      const pages = [];
      for (let attempt = 1; attempt <= 10; attempt++) pages.push(await listPage(driver, {}));
      expect(pages.map((page) => page.items.length)).toEqual(Array.from({ length: 10 }, () => 6));
      expect(pages.every((page) => page.cursor === null && page.completeness === 'complete')).toBe(true);
    });
  });

  it('reclaims an exhausted pagination snapshot so later listings still get a slot', async () => {
    await withDshDriver(Array.from({ length: 6 }, (_, index) => summaryOf(`paged-${index + 1}`)), async ({ driver }) => {
      const rounds = [];
      for (let round = 1; round <= 4; round++) {
        const first = await listPage(driver, { limit: 2 });
        let cursor = first.cursor, pages = 1, last = first;
        while (cursor) { last = await listPage(driver, { limit: 2, cursor }); cursor = last.cursor; pages += 1; }
        rounds.push({ pages, items: last.items.length, cursor, total: last.total });
      }
      expect(rounds).toEqual(Array.from({ length: 4 }, () => ({ pages: 3, items: 2, cursor: null, total: 6 })));
    });
  });

  it('keeps a handed-out cursor resumable across pages of a live snapshot', async () => {
    await withDshDriver(Array.from({ length: 6 }, (_, index) => summaryOf(`live-${index + 1}`)), async ({ driver }) => {
      const first = await listPage(driver, { limit: 2 });
      const second = await listPage(driver, { limit: 2, cursor: first.cursor });
      const third = await listPage(driver, { limit: 2, cursor: second.cursor });
      expect(first.items.map((item) => item.session.nativeSessionId)).toEqual(['live-1', 'live-2']);
      expect(second.items.map((item) => item.session.nativeSessionId)).toEqual(['live-3', 'live-4']);
      expect(third.items.map((item) => item.session.nativeSessionId)).toEqual(['live-5', 'live-6']);
      expect([first.cursor, second.cursor, third.cursor].every((cursor) => cursor === null || typeof cursor === 'string')).toBe(true);
      expect(second.cursor?.startsWith(String(first.cursor).split(':')[0])).toBe(true);
      expect(third.cursor).toBeNull();
      expect(third.completeness).toBe('complete');
      expect(third.total).toBe(6);
    });
  });
});

describe('DSH driver operation lease reconciliation', () => {
  it('releases the session lease when the turn ends during a WebSocket disconnect', { timeout: 30000 }, async () => {
    await withDshDriver([summaryOf('native-1')], async ({ driver, controlled, store, leaseKey, leaseRows, operationPhase }) => {
      controlled.snapshots.set('native-1', { cursor: 2, records: [] });
      const session = sessionRef('native-1');
      const subscription = await subscribeSession(driver, session);
      await subscription.ready;
      const prompt = await sendPrompt(driver, session, 'prompt-1');
      const operationId = prompt.accepted.operationId;
      expect((await store.getControl({ collection: 'operations', key: leaseKey(session) }))?.value).toMatchObject({ operationId, runtimeOwner: true });
      expect(await leaseRows()).toBe(1);
      expect(await operationPhase(operationId)).toBe('observed');
      controlled.disconnect();
      await sleep(50);
      controlled.follow({ type: 'event', event: { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } } }, 'native-1');
      const deadline = Date.now() + 10000;
      while ((await store.getControl({ collection: 'operations', key: leaseKey(session) }))?.value && Date.now() < deadline) await sleep(25);
      expect((await store.getControl({ collection: 'operations', key: leaseKey(session) }))?.value ?? null).toBeNull();
      expect(await leaseRows()).toBe(0);
      expect(await operationPhase(operationId)).toBe('terminal');
      await subscription.return();
      const again = await sendPrompt(driver, session, 'prompt-2');
      expect(again.accepted.operationId).not.toBe(operationId);
      expect(await leaseRows()).toBe(1);
    });
  });

  it('does not terminate a pending prompt on a historical turn/end covered by the rebuilt snapshot', { timeout: 30000 }, async () => {
    await withDshDriver([summaryOf('native-1')], async ({ driver, controlled, store, leaseKey, leaseRows }) => {
      const session = sessionRef('native-1');
      controlled.snapshots.set('native-1', {
        cursor: 3,
        records: [
          { type: 'event', event: { seq: 0, type: 'turn/start', data: {} } },
          { type: 'event', event: { seq: 1, type: 'assistant/message', data: {} } },
          { type: 'event', event: { seq: 2, type: 'assistant/message', data: {} } },
          { type: 'event', event: { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
        ],
      });
      const subscription = await subscribeSession(driver, session);
      await subscription.ready;
      const prompt = await sendPrompt(driver, session, 'prompt-1');
      const operationId = prompt.accepted.operationId;
      controlled.disconnect();
      await sleep(50);
      await subscription.next().catch(() => undefined);
      const deadline = Date.now() + 10000;
      while (controlled.liveFollows() === 0 && Date.now() < deadline) await sleep(25);
      await sleep(200);
      expect(await store.getControl({ collection: 'operations', key: leaseKey(session) })).toMatchObject({ value: { operationId, runtimeOwner: true } });
      expect(await leaseRows()).toBe(1);
      await expect(sendPrompt(driver, session, 'prompt-2'))
        .rejects.toMatchObject({ code: 'conflict', field: 'runtime.store.session_busy' });
      await subscription.return();
    });
  });
});


it.each([33, 65])('closes %s pending interactions without overflowing the real reserved store queue', async count => {
  await withDshDriver([summaryOf('capacity')], async ({ driver, controlled, store, events }) => {
    await listPage(driver, {});
    const subscription = await subscribeSession(driver, sessionRef('capacity')); await subscription.ready;
    for (let index = 0; index < count; index++) {
      controlled.approval('capacity', `capacity-${index}`);
      const deadline = Date.now() + 3000;
      while (events.filter(event => event.type === 'interaction-pending').length <= index && Date.now() < deadline) await sleep(5);
      expect(events.filter(event => event.type === 'interaction-pending')).toHaveLength(index + 1);
    }
    const closed = await driver.close().then(() => ({ error: undefined }), error => ({ error }));
    try {
      expect(closed.error).toBeUndefined();
      const page = await store.page({ collection: 'interactions', limit: 200 });
      const rows = page.items.filter(item => isRecord(item.value) && item.value.kind === 'interaction');
      expect(rows).toHaveLength(count);
      expect(rows.every(item => isRecord(item.value) && item.value.phase === 'invalidated')).toBe(true);
    } finally { for (let attempt = 0; attempt < 16; attempt++) { try { await driver.close(); break; } catch { /* drain the RED control without orphaning its worker */ } } }
  });
}, 30000);
it.each([33, 65])('cleans %s disconnected interactions before the first replacement native connection', async count => {
  await withDshDriver([summaryOf('capacity')], async ({ driver, controlled, store, events }) => {
    await listPage(driver, {});
    const subscription = await subscribeSession(driver, sessionRef('capacity')); await subscription.ready;
    for (let index = 0; index < count; index++) {
      controlled.approval('capacity', `capacity-${index}`);
      const deadline = Date.now() + 3000;
      while (events.filter(event => event.type === 'interaction-pending').length <= index && Date.now() < deadline) await sleep(5);
      expect(events.filter(event => event.type === 'interaction-pending')).toHaveLength(index + 1);
    }
    controlled.disconnect();
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.type === 'source-disconnected') && Date.now() < deadline) await sleep(5);
    try {
      await expect(getSession(driver, sessionRef('capacity'))).resolves.toBeUndefined();
      const page = await store.page({ collection: 'interactions', limit: 200 });
      const rows = page.items.filter(item => isRecord(item.value) && item.value.kind === 'interaction');
      expect(rows).toHaveLength(count);
      expect(rows.every(item => isRecord(item.value) && item.value.phase === 'invalidated')).toBe(true);
      expect(events.some(event => event.type === 'source-error')).toBe(false);
    } finally { for (let attempt = 0; attempt < 16; attempt++) { try { await driver.close(); break; } catch { /* drain the RED control without orphaning its worker */ } } }
  });
}, 30000);

async function capacityApprovals(harness: DshHarness, count: number) {
  await listPage(harness.driver, {});
  const subscription = await subscribeSession(harness.driver, sessionRef('capacity')); await subscription.ready;
  for (let index = 0; index < count; index++) {
    harness.controlled.approval('capacity', `capacity-${index}`);
    const deadline = Date.now() + 3000;
    while (harness.events.filter(event => event.type === 'interaction-pending').length <= index && Date.now() < deadline) await sleep(5);
    expect(harness.events.filter(event => event.type === 'interaction-pending')).toHaveLength(index + 1);
  }
}
it.each([33, 65])('serializes %s native cancellation invalidations while keeping the source usable', async count => {
  await withDshDriver([summaryOf('capacity')], async harness => {
    await capacityApprovals(harness, count);
    for (let index = 0; index < count; index++) harness.controlled.cancelApproval(`capacity-${index}`);
    const deadline = Date.now() + 5000;
    while (harness.events.filter(event => event.type === 'interaction-invalidated').length < count && Date.now() < deadline) await sleep(5);
    expect(harness.events.filter(event => event.type === 'interaction-invalidated')).toHaveLength(count);
    const page = await harness.store.page({ collection: 'interactions', limit: 200 });
    const rows = page.items.filter(item => isRecord(item.value) && item.value.kind === 'interaction');
    expect(rows).toHaveLength(count);
    expect(rows.every(item => isRecord(item.value) && item.value.phase === 'invalidated')).toBe(true);
    expect(harness.events.some(event => event.type === 'source-error')).toBe(false);
    await expect(getSession(harness.driver, sessionRef('capacity'))).resolves.toBeUndefined();
  });
}, 30000);
it('preserves an actual cleanup failure for retry while draining the other 32 interactions', async () => {
  let failRead = false;
  let blockedKey: string | undefined;
  await withDshDriver([summaryOf('capacity')], async harness => {
    await capacityApprovals(harness, 33);
    failRead = true;
    try {
      await expect(harness.driver.close()).rejects.toThrow('DSH interaction cleanup failed');
      const page = await harness.store.page({ collection: 'interactions', limit: 200 });
      const rows = page.items.filter(item => isRecord(item.value) && item.value.kind === 'interaction');
      expect(rows.filter(item => isRecord(item.value) && item.value.phase === 'pending')).toHaveLength(1);
      expect(rows.filter(item => isRecord(item.value) && item.value.phase === 'invalidated')).toHaveLength(32);
      expect(harness.events.some(event => event.type === 'source-closed')).toBe(false);
      failRead = false;
      await expect(harness.driver.close()).resolves.toBeUndefined();
      const retried = await harness.store.page({ collection: 'interactions', limit: 200 });
      expect(retried.items.filter(item => isRecord(item.value) && item.value.kind === 'interaction').every(item => isRecord(item.value) && item.value.phase === 'invalidated')).toBe(true);
      expect(harness.events.filter(event => event.type === 'source-closed')).toHaveLength(1);
    } finally { failRead = false; await harness.driver.close(); }
  }, store => ({ ...store, async getControl(input) {
    if (failRead && input.collection === 'interactions') { blockedKey ??= input.key; if (input.key === blockedKey) throw new Error('owned durable cleanup failure'); }
    return store.getControl(input);
  } }));
}, 30000);
}
