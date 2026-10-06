// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOpenCodeStoreReader } from '../../../bridge/runtime/drivers/openCodeStoreReader.mjs';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function nativeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-opencode-reader-'));
  temporary.push(dir);
  const databasePath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 1005; i++) insert.run(`ses_${String(i).padStart(5, '0')}`, i % 2 ? 'global' : 'project', i % 3 ? null : 'ses_parent', i % 7 ? '/repo' : '', `Session ${i}`, '1.18.34', 10, 20, i % 5 ? null : 30);
  db.exec('COMMIT');
  return { db, databasePath };
}
describe('OpenCode read-only summary discovery', () => {
  it('enumerates every root child archived and orphan ID at equal timestamps', async () => {
    // Given a native-shaped database with more than the legacy cap and identical timestamps.
    const { db, databasePath } = await nativeFixture();
    const expected = db.prepare('SELECT id FROM session ORDER BY id').all().map((row) => row.id);
    const reader = createOpenCodeStoreReader({ databasePath, nativeVersion: '1.18.34' });
    try {
      // When the production reader follows bounded pages through native EOF.
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await reader.page({ cursor, limit: 100 });
        expect(page.items.length).toBeLessThanOrEqual(100);
        ids.push(...page.items.map((row) => row.id)); cursor = page.cursor;
      } while (cursor);
      // Then the independent storage inventory agrees exactly, without changing native data.
      expect(ids).toEqual(expected);
      expect(db.prepare('SELECT count(*) count FROM session').get()?.count).toBe(1005);
    } finally { await reader.close(); db.close(); }
  });
  it('failure rejects a source mutation between pages instead of declaring completeness', async () => {
    // Given an active enumeration.
    const { db, databasePath } = await nativeFixture();
    const reader = createOpenCodeStoreReader({ databasePath, nativeVersion: '1.18.34' });
    try {
      const first = await reader.page({ limit: 100 });
      db.exec("DELETE FROM session WHERE id='ses_00100'");
      // When another native writer changes the catalog.
      const next = reader.page({ cursor: first.cursor, limit: 100 });
      // Then the snapshot must be restarted, not silently completed.
      await expect(next).rejects.toMatchObject({ code: 'reconcile_required' });
    } finally { await reader.close(); db.close(); }
  });
});

import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createOpenCodeDriver } from '../../../bridge/runtime/drivers/openCodeDriver.js';
import { createOpenCodeDiscovery } from '../../../bridge/runtime/drivers/openCodeDiscovery.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeHost } from '../../../bridge/runtime/runtimeHost.js';
import { createHarnessRegistry } from '../../../shared/runtime/harnessContract.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { createInstanceOperations } from '../../../shared/runtime/native/opencode/instanceOperations.js';
import { fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { randomUUID } from 'node:crypto';
import type { Json, RuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { OPEN_CODE_OPERATIONS } from '../../../shared/runtime/native/opencode/operations.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const epoch = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const nativeSession = { id: 'ses_real', projectID: 'global', directory: '/non-git', title: 'Original', version: '1.18.34', time: { created: 10, updated: 20 } };
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: nativeSession.id });
const input = (params: Json = {}, ref = session) => ({ environmentId, harnessInstanceId, session: ref, params });
async function controlledNative() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-opencode-http-')); temporary.push(dir);
  const calls: { method: string; path: string; body: unknown }[] = [];
  const streams = new Set<ServerResponse>();
  let connections = 0;
  let generation = 1;
  const paths: Record<string, Record<string, object>> = {};
  for (const route of ['/session/{sessionID}', '/session/{sessionID}/fork', '/session/{sessionID}/revert', '/session/{sessionID}/unrevert', '/session/{sessionID}/diff', '/session/{sessionID}/children', '/session/{sessionID}/message/{messageID}', '/session/{sessionID}/todo', '/session/{sessionID}/command', '/session/{sessionID}/message/{messageID}/part/{partID}', '/global/config', '/provider', '/provider/auth', '/provider/{providerID}/oauth/authorize', '/provider/{providerID}/oauth/callback', '/auth/{providerID}', '/agent', '/command', '/session/status', '/permission', '/question', '/mcp', '/lsp', '/skill']) paths[route] = { get: {}, post: {}, patch: {}, put: {}, delete: {} };
  function publish(type: string, properties: Json) { for (const stream of streams) stream.write(`data: ${JSON.stringify({ directory: '/non-git', payload: { type, properties } })}\n\n`); }
  let responseGate: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(); const body: unknown = raw ? JSON.parse(raw) : null;
    calls.push({ method: request.method ?? '', path: route.pathname + route.search, body });
    response.setHeader('Content-Type', 'application/json');
    if (route.pathname === '/global/health') { response.end(JSON.stringify({ healthy: true, version: '1.18.34' })); return; }
    if (route.pathname === '/doc') { response.end(JSON.stringify({ paths })); return; }
    if (route.pathname === '/global/event') { connections++; response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders(); streams.add(response); response.on('close', () => streams.delete(response)); return; }
    if (responseGate) await responseGate;
    if (route.pathname === '/session' && request.method === 'POST') { response.end(JSON.stringify(nativeSession)); return; }
    if (route.pathname === '/session' && request.method === 'GET') { response.end(JSON.stringify([nativeSession])); return; }
    if (route.pathname === '/session/ses_real') { response.end(JSON.stringify(nativeSession)); return; }
    if (route.pathname.endsWith('/prompt_async')) { response.statusCode = 204; response.end(); return; }
    if (route.pathname.endsWith('/message')) {
      const before = route.searchParams.get('before');
      if (before && before !== 'opaque-native-page-token') { response.statusCode = 400; response.end('{}'); return; }
      if (!before) response.setHeader('X-Next-Cursor', 'opaque-native-page-token');
      response.end(JSON.stringify([{ info: { id: before ? 'msg_older' : 'msg_newer', sessionID: session.nativeSessionId }, parts: [] }])); return;
    }
    if (route.pathname === '/global/config') { response.end(JSON.stringify({ model: 'test/model', apiKey: 'fixture-secret', nested: { token: 'another-secret' } })); return; }
    response.end('true');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new TypeError('missing fixture address');
  const store = createRuntimeStore({ stateDirectory: path.join(dir, 'runtime'), environmentId, ownerId, epoch }); await store.ready;
  const runtime = createRuntimeHost({ environmentId, role: 'local' }); runtime.start();
  const options = { environmentId, harnessInstanceId, epoch, processGeneration: 1, endpoint: `http://127.0.0.1:${address.port}`, store, runtime, currentProcess: () => ({ epoch, processGeneration: generation }) };
  return { options, store, calls, publish, get connections() { return connections; }, setGeneration(value: number) { generation = value; }, gate(value: Promise<void> | undefined) { responseGate = value; }, async close() { await runtime.stop(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await store.close(); } };
}

describe('OpenCode Bridge driver over controlled HTTP/SSE with real durable store', () => {
  it('owns one SSE upstream for two subscribers and keeps it after a subscriber leaves', async () => {
    // Given one Runtime-owned native driver.
    const fixture = await controlledNative();
    try {
      const driver = await createOpenCodeDriver(fixture.options);
      const registry = createHarnessRegistry(); registry.register(driver.registration);
      // When two Runtime subscribers observe it and one disconnects.
      const first: unknown = await registry.invoke({ ...input(), channel: 'core', operation: 'subscribe' });
      if (typeof first !== 'object' || first === null || !('return' in first) || typeof first.return !== 'function') throw new TypeError('missing subscription iterator');
      const second: unknown = await registry.invoke({ ...input(), channel: 'core', operation: 'subscribe' });
      expect(second).toHaveProperty('next');
      await first.return();
      // Then there remains exactly one native connection and the source stays ready.
      expect(fixture.connections).toBe(1);
      expect(await registry.invoke({ ...input(), channel: 'core', operation: 'inspect' })).toEqual({ state: 'ready', protocolVersion: 1 });
    } finally { await fixture.close(); }
  });
  it('journals native create before invocation and binds only its returned native session', async () => {
    const fixture = await controlledNative();
    try {
      const driver = await createOpenCodeDriver(fixture.options); const registry = createHarnessRegistry(); registry.register(driver.registration);
      const params = { processGeneration: 1, idempotencyKey: 'create-1', directory: '/non-git', body: { title: 'new' } };
      // When a scoped create traverses the real worker then HTTP boundary.
      const result: unknown = await registry.invoke({ ...input(params), channel: 'core', operation: 'createSession' });
      // Then the actual native request occurs once and duplicate execution is never replayed.
      expect(result).toMatchObject({ phase: 'native-executed', accepted: { phase: 'durable-accepted' }, result: { session } });
      await expect(registry.invoke({ ...input(params), channel: 'core', operation: 'createSession' })).rejects.toMatchObject({ code: 'conflict' });
      expect(fixture.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/session?'))).toHaveLength(1);
    } finally { await fixture.close(); }
  });
  it('failure rejects foreign SessionRef before any native action', async () => {
    const fixture = await controlledNative();
    try {
      const driver = await createOpenCodeDriver(fixture.options); const before = fixture.calls.length;
      const foreign = parseSessionRef({ ...session, harnessInstanceId: '55555555-5555-4555-8555-555555555555' });
      const method = driver.registration.driver.core.send; if (!method) throw new TypeError('missing send');
      // When a caller bypasses the registry with a foreign session.
      await expect(method(input({ processGeneration: 1, idempotencyKey: 'foreign', body: { parts: [] } }, foreign))).rejects.toMatchObject({ code: 'unauthorized' });
      // Then no network mutation occurred.
      expect(fixture.calls).toHaveLength(before);
    } finally { await fixture.close(); }
  });
  it('redacts provider credentials and keeps the native extension inventory', async () => {
    const fixture = await controlledNative();
    try {
      const driver = await createOpenCodeDriver(fixture.options); const registry = createHarnessRegistry(); registry.register(driver.registration);
      // When settings return native credential fields.
      const result = await registry.invoke({ ...input(), channel: 'native', operation: 'getGlobalConfig', permissions: ['opencode.read'] });
      // Then secret values never enter the Runtime response and all previous native handlers remain declared.
      expect(JSON.stringify(result)).not.toContain('fixture-secret'); expect(JSON.stringify(result)).not.toContain('another-secret');
      expect(driver.registration.manifest.extensions.map((entry) => entry.name).sort()).toEqual(Object.keys(OPEN_CODE_OPERATIONS).sort());
      expect(driver.registration.manifest.capabilities.sessionPin).toMatchObject({ state: 'unsupported' });
    } finally { await fixture.close(); }
  });
});

describe('OpenCode discovery fences', () => {
  it('failure does not resurrect a deleted summary returned by an in-flight native snapshot', async () => {
    let finish: (value: { items: typeof nativeSession[]; cursor: null; completeness: 'complete'; reason: string; provenance: { nativeVersion: string; readOnly: true; summaryOnly: true; schemaVersion: number } }) => void = () => { throw new TypeError('not waiting'); };
    const page = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
    const discovery = createOpenCodeDiscovery({ reader: { ready: Promise.resolve({ nativeVersion: '1.18.34', readOnly: true, summaryOnly: true, schemaVersion: 1 }), page: () => page, close: async () => {} }, request: async () => [], current: () => ({ epoch, processGeneration: 1, seq: 0 }), assertCurrent: () => {} });
    // Given a snapshot read held at the native boundary.
    const pending = discovery.listSessionPage(); await Promise.resolve(); await Promise.resolve();
    // When SSE reports deletion before the snapshot completes.
    discovery.event({ epoch, processGeneration: 1, seq: 1, type: 'session.deleted', session });
    finish({ items: [nativeSession], cursor: null, completeness: 'complete', reason: 'native-store-eof', provenance: { nativeVersion: '1.18.34', readOnly: true, summaryOnly: true, schemaVersion: 1 } });
    // Then the deleted ID is absent and source completeness is explicitly provisional.
    expect(await pending).toMatchObject({ items: [], completeness: 'partial', reason: 'native-source-changed' });
  });
});

describe('OpenCode instance intent authority', () => {
  it('failure fences a foreign store even when the caller current predicate is permissive', async () => {
    const fixture = await controlledNative();
    try {
      // Given trusted worker environment A and a forged requested environment B.
      const operations = createInstanceOperations({ store: fixture.store, scope: { environmentId: parseEnvironmentId('55555555-5555-4555-8555-555555555555'), harnessInstanceId, epoch, processGeneration: 1 }, current: () => ({ epoch, processGeneration: 1 }), fingerprint, randomUUID });
      // When the instance binds.
      await expect(operations.ready).rejects.toMatchObject({ code: 'unauthorized' });
      // Then the durable catalog contains no operation for that forged target.
      expect((await fixture.store.page({ collection: 'operations' })).items).toEqual([]);
    } finally { await fixture.close(); }
  });
});

import { createEventSubscriptions, createSseDecoder } from '../../../shared/runtime/native/opencode/sse.js';
import { ProtocolError } from '../../../shared/runtime/capabilities.js';

it('failure keeps a fallback API sample provisional and filters an SSE delete during its read', async () => {
  let finish: (value: unknown) => void = () => { throw new TypeError('not waiting'); };
  const response = new Promise<unknown>((resolve) => { finish = resolve; });
  const discovery = createOpenCodeDiscovery({ request: () => response, current: () => ({ epoch, processGeneration: 1, seq: 0 }), assertCurrent: () => {} });
  // Given an unavailable native store and an API request still in flight.
  const pending = discovery.listSessionPage(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  // When the native SSE tombstone precedes that response.
  discovery.event({ epoch, processGeneration: 1, seq: 1, type: 'session.deleted', session }); finish([nativeSession]);
  // Then the fallback must not revive the deleted ID or assert native completeness.
  expect(await pending).toMatchObject({ items: [], completeness: 'partial' });
});

it('failure invalidates a consumed native cursor instead of returning its same page twice', async () => {
  const { db, databasePath } = await nativeFixture(); const reader = createOpenCodeStoreReader({ databasePath, nativeVersion: '1.18.34' });
  try {
    const first = await reader.page({ limit: 200 }); await reader.page({ cursor: first.cursor, limit: 200 });
    await expect(reader.page({ cursor: first.cursor, limit: 200 })).rejects.toMatchObject({ code: 'reconcile_required' });
  } finally { await reader.close(); db.close(); }
});

it('failure rejects an unknown native schema without repairing or writing the database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vis-opencode-unknown-')); temporary.push(dir); const databasePath = path.join(dir, 'db');
  const db = new DatabaseSync(databasePath); db.exec('CREATE TABLE session(id INTEGER PRIMARY KEY, body TEXT)'); db.close();
  const before = await import('node:fs/promises').then((fs) => fs.readFile(databasePath));
  const reader = createOpenCodeStoreReader({ databasePath, nativeVersion: '1.18.34' });
  try { await expect(reader.page()).rejects.toMatchObject({ code: 'unsupported' }); }
  finally { await reader.close(); }
  expect(await import('node:fs/promises').then((fs) => fs.readFile(databasePath))).toEqual(before);
});

it('failure drops a bounded slow-subscriber backlog with an explicit replay error', async () => {
  let overflow = 0;
  const bus = createEventSubscriptions<Json>({ maxBytes: 128, onOverflow: () => { overflow++; } });
  const subscriber = bus.subscribe();
  bus.publish({ text: 'x'.repeat(90) }); bus.publish({ text: 'y'.repeat(90) });
  await expect(subscriber.next()).rejects.toMatchObject({ code: 'replay_required' });
  expect(bus.bufferedBytes).toBe(0); expect(overflow).toBe(1); bus.close();
});

it('decodes split Unicode SSE and rejects an unterminated oversized native frame', () => {
  const decoder = createSseDecoder(128); const bytes = new TextEncoder().encode('data: {"value":"中文"}\r\n\r\n');
  const split = bytes.findIndex((byte) => byte > 127) + 1;
  expect(decoder.push(bytes.slice(0, split))).toEqual([]);
  expect(decoder.push(bytes.slice(split))).toEqual([{ value: '中文' }]); decoder.finish();
  expect(() => decoder.push(new TextEncoder().encode('data: ' + 'x'.repeat(129)))).toThrow(ProtocolError);
});

it('failure reconciles an instance response after generation loss instead of reporting native success', async () => {
  const fixture = await controlledNative();
  try {
    let generation = 1; let sends = 0;
    const operations = createInstanceOperations({ store: fixture.store, scope: { environmentId, harnessInstanceId, epoch, processGeneration: 1 }, current: () => ({ epoch, processGeneration: generation }), fingerprint, randomUUID });
    await operations.ready;
    const accepted = await operations.accept({ idempotencyKey: 'lost', method: 'createSession', payload: { title: 'durable body' } });
    await expect(operations.execute(accepted.operationId, async () => { sends++; generation = 2; return nativeSession; })).rejects.toMatchObject({ code: 'reconcile_required' });
    expect((await operations.get(accepted.operationId)).phase).toBe('reconciling');
    await expect(operations.execute(accepted.operationId, async () => { sends++; return nativeSession; })).rejects.toMatchObject({ code: 'reconcile_required' });
    expect(sends).toBe(1); await operations.close();
  } finally { await fixture.close(); }
});

it('failure accepts an instance intent once under duplicate concurrent submissions', async () => {
  const fixture = await controlledNative();
  try {
    const operations = createInstanceOperations({ store: fixture.store, scope: { environmentId, harnessInstanceId, epoch, processGeneration: 1 }, current: () => ({ epoch, processGeneration: 1 }), fingerprint, randomUUID }); await operations.ready;
    const intents = await Promise.all([operations.accept({ idempotencyKey: 'same', method: 'createSession', payload: { title: 'same' } }), operations.accept({ idempotencyKey: 'same', method: 'createSession', payload: { title: 'same' } })]);
    expect(intents[0]?.operationId).toBe(intents[1]?.operationId);
    let sends = 0; const send = async () => { sends++; return nativeSession; };
    const outcomes = await Promise.allSettled(intents.map((intent) => operations.execute(intent.operationId, send)));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1); expect(sends).toBe(1);
    await operations.close();
  } finally { await fixture.close(); }
});

import { nativeEvent } from '../../../shared/runtime/native/opencode/protocol.js';
it('passes the actual native history header cursor unchanged instead of inventing a message-ID cursor', async () => {
  const fixture = await controlledNative();
  try {
    const driver = await createOpenCodeDriver(fixture.options); const registry = createHarnessRegistry(); registry.register(driver.registration);
    const first = await registry.invoke({ ...input({ limit: 1 }), channel: 'core', operation: 'readHistoryPage' });
    if (typeof first !== 'object' || first === null || !('cursor' in first) || typeof first.cursor !== 'string') throw new TypeError('missing history cursor');
    const older = await registry.invoke({ ...input({ limit: 1, cursor: first.cursor }), channel: 'core', operation: 'readHistoryPage' });
    expect(older).toMatchObject({ completeness: 'complete', cursor: null, items: [{ info: { id: 'msg_older' } }] });
    expect(fixture.calls.at(-1)?.path).toContain('before=opaque-native-page-token');
  } finally { await fixture.close(); }
});
it('normalizes the actual 1.18.34 sync envelope paired with each native session event', () => {
  // Given the installed binary's second envelope for a single session.created event.
  const wire = { directory: '/non-git', payload: { id: 'evt_native', type: 'sync', syncEvent: { id: 'evt_native', type: 'session.created.1', seq: 0, aggregateID: session.nativeSessionId, data: { sessionID: session.nativeSessionId, info: nativeSession } } } };
  // When parsing at the native boundary.
  const parsed = nativeEvent(wire);
  // Then both wire forms have one stable native event identity and canonical properties.
  expect(parsed).toMatchObject({ nativeEventId: 'evt_native', type: 'session.created', properties: { sessionID: session.nativeSessionId, info: nativeSession } });
});

describe('OpenCode cancellation retains the original durable session lease', () => {
  const leaseKey = `lease:${fingerprint(encodeSessionKey(session))}`;
  const processKey = `opencode-process:${fingerprint([environmentId, harnessInstanceId])}`;
  const modes = ['foreign-before', 'lease-read-race', 'lease-commit-race', 'process-read-race', 'generation-read-race', 'lease-after-commit', 'generation-after-commit', 'ack-after-commit', 'final-lease-read-race', 'final-process-read-race', 'final-generation-read-race'] as const;
  it.each(modes)('rejects %s without an unauthorized native abort', async (mode) => {
    const fixture = await controlledNative();
    let armed = false;
    let leaseReads = 0;
    async function replaceLease() {
      const lease = await fixture.store.getControl({ collection: 'operations', key: leaseKey });
      if (!lease) throw new TypeError('missing original lease');
      await fixture.store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key: leaseKey, expectedRevision: lease.revision, value: { operationId: 'foreign-operation', runtimeOwner: true } }] });
    }
    const store: RuntimeStore = {
      ...fixture.store,
      async getControl(query) {
        const result = await fixture.store.getControl(query);
        if (armed && query.key === leaseKey && mode.endsWith('read-race')) {
          leaseReads++;
          if (mode.startsWith('final-') && leaseReads === 1) return result;
          armed = false;
          if (mode.endsWith('lease-read-race')) await replaceLease();
          if (mode.endsWith('generation-read-race')) fixture.setGeneration(2);
          if (mode.endsWith('process-read-race')) {
            const process = await fixture.store.getControl({ collection: 'operations', key: processKey });
            if (!process || typeof process.value !== 'object' || process.value === null || Array.isArray(process.value)) throw new TypeError('missing process registration');
            await fixture.store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key: processKey, expectedRevision: process.revision, value: { ...process.value, alive: false } }] });
          }
        }
        return result;
      },
      async mutateControl(mutation) {
        const cancelling = mutation.changes.some((change) => typeof change.value === 'object' && change.value !== null && 'cancelRequested' in change.value && change.value.cancelRequested === true);
        const inject = armed && cancelling && (mode === 'lease-commit-race' || mode.endsWith('after-commit'));
        if (inject) { armed = false; if (mode === 'lease-commit-race') await replaceLease(); }
        const result = await fixture.store.mutateControl(mutation);
        if (inject && mode === 'lease-after-commit') await replaceLease();
        if (inject && mode === 'generation-after-commit') fixture.setGeneration(2);
        if (inject && mode === 'ack-after-commit') throw new ProtocolError('source_unavailable', 'injected.cancel_commit_ack');
        return result;
      },
    };
    try {
      const driver = await createOpenCodeDriver({ ...fixture.options, store }); const registry = createHarnessRegistry(); registry.register(driver.registration);
      const invoke = (operation: 'send' | 'cancel', idempotencyKey: string) => registry.invoke({ ...input({ processGeneration: 1, idempotencyKey, body: { parts: [{ type: 'text', text: 'controlled lease owner' }] } }), channel: 'core', operation });
      const sent = await invoke('send', 'lease-owner');
      if (typeof sent !== 'object' || sent === null || !('operationId' in sent) || typeof sent.operationId !== 'string') throw new TypeError('missing operation identity');
      const before = await fixture.store.getControl({ collection: 'operations', key: sent.operationId });
      expect(before).toMatchObject({ value: { cancelRequested: false } });
      if (mode === 'foreign-before') await replaceLease(); else armed = true;
      await expect(invoke('cancel', `cancel-${mode}`)).rejects.toBeInstanceOf(Error);
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(0);
      const after = await fixture.store.getControl({ collection: 'operations', key: sent.operationId });
      const committed = mode.endsWith('after-commit') || mode.startsWith('final-');
      expect(after).toMatchObject({ value: { cancelRequested: committed, ...(committed ? { phase: 'reconciling' } : {}) } });
    } finally { await fixture.close(); }
  });
  it('lets only one concurrent owning cancellation reach HTTP and preserves the original payload', async () => {
    const fixture = await controlledNative();
    try {
      const driver = await createOpenCodeDriver(fixture.options); const registry = createHarnessRegistry(); registry.register(driver.registration);
      const sent = await registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'owned-turn', body: { parts: [{ type: 'text', text: 'preserved body' }] } }), channel: 'core', operation: 'send' });
      if (typeof sent !== 'object' || sent === null || !('operationId' in sent) || typeof sent.operationId !== 'string') throw new TypeError('missing operation identity');
      const before = await fixture.store.getControl({ collection: 'operations', key: sent.operationId });
      const cancel = () => registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'same-owning-cancel' }), channel: 'core', operation: 'cancel' });
      const results = await Promise.allSettled([cancel(), cancel()]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(1);
      const after = await fixture.store.getControl({ collection: 'operations', key: sent.operationId });
      if (!before || typeof before.value !== 'object' || before.value === null || !('payloadRef' in before.value)) throw new TypeError('missing durable payload');
      expect(after).toMatchObject({ value: { payloadRef: before.value.payloadRef, cancelRequested: true } });
      const cancelKey = `op:${fingerprint([encodeSessionKey(session), 'same-owning-cancel'])}`;
      expect(await fixture.store.getControl({ collection: 'operations', key: cancelKey })).toMatchObject({ value: { kind: 'opencode-cancellation', phase: 'observed', operationId: sent.operationId } });
      expect(await fixture.store.getControl({ collection: 'operations', key: leaseKey })).toMatchObject({ value: { operationId: sent.operationId, runtimeOwner: true } });
      await expect(cancel()).rejects.toMatchObject({ code: 'reconcile_required' });
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(1);
      fixture.publish('message.updated', { info: { id: 'msg_observed_cancel', sessionID: session.nativeSessionId, role: 'user', time: { created: Date.now() } } });
      fixture.publish('session.idle', { sessionID: session.nativeSessionId });
      const deadline = Date.now() + 3000;
      for (;;) {
        const settled = await fixture.store.getControl({ collection: 'operations', key: sent.operationId });
        if (typeof settled?.value === 'object' && settled.value !== null && 'phase' in settled.value && settled.value.phase === 'terminal') break;
        if (Date.now() > deadline) throw new Error('native idle did not settle turn');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(cancel()).rejects.toMatchObject({ code: 'conflict' });
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(1);
    } finally { await fixture.close(); }
  });
  it('reconciles an unknown abort acknowledgement and refuses duplicate or restarted dispatch', async () => {
    const fixture = await controlledNative();
    let release: (() => void) | undefined;
    try {
      const driver = await createOpenCodeDriver({ ...fixture.options, requestTimeoutMs: 150 }); const registry = createHarnessRegistry(); registry.register(driver.registration);
      const sent = await registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'unknown-turn', body: { parts: [{ type: 'text', text: 'durable original' }] } }), channel: 'core', operation: 'send' });
      if (typeof sent !== 'object' || sent === null || !('operationId' in sent) || typeof sent.operationId !== 'string') throw new TypeError('missing operation identity');
      fixture.gate(new Promise<void>((resolve) => { release = resolve; }));
      const cancelInput = input({ processGeneration: 1, idempotencyKey: 'unknown-cancel' });
      await expect(registry.invoke({ ...cancelInput, channel: 'core', operation: 'cancel' })).rejects.toMatchObject({ code: 'timeout' });
      expect(await fixture.store.getControl({ collection: 'operations', key: sent.operationId })).toMatchObject({ value: { phase: 'reconciling', cancelRequested: true } });
      expect(await fixture.store.getControl({ collection: 'operations', key: `op:${fingerprint([encodeSessionKey(session), 'unknown-cancel'])}` })).toMatchObject({ value: { phase: 'reconciling' } });
      release?.(); fixture.gate(undefined);
      await expect(registry.invoke({ ...cancelInput, channel: 'core', operation: 'cancel' })).rejects.toMatchObject({ code: 'reconcile_required' });
      await driver.close(); fixture.setGeneration(2);
      const restarted = await createOpenCodeDriver({ ...fixture.options, processGeneration: 2 }); const next = createHarnessRegistry(); next.register(restarted.registration);
      await expect(next.invoke({ ...input({ processGeneration: 2, idempotencyKey: 'unknown-cancel' }), channel: 'core', operation: 'cancel' })).rejects.toMatchObject({ code: 'conflict' });
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(1);
      expect(await fixture.store.getControl({ collection: 'operations', key: leaseKey })).toMatchObject({ value: { operationId: sent.operationId, runtimeOwner: true } });
    } finally { release?.(); fixture.gate(undefined); await fixture.close(); }
  });
  it.each(['lease', 'process', 'generation'] as const)('does not report native success after %s loss while abort response is pending', async (loss) => {
    const fixture = await controlledNative(); let release: (() => void) | undefined;
    try {
      const driver = await createOpenCodeDriver(fixture.options); const registry = createHarnessRegistry(); registry.register(driver.registration);
      const sent = await registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'pending-turn', body: { parts: [] } }), channel: 'core', operation: 'send' });
      if (typeof sent !== 'object' || sent === null || !('operationId' in sent) || typeof sent.operationId !== 'string') throw new TypeError('missing operation identity');
      fixture.gate(new Promise<void>((resolve) => { release = resolve; }));
      const pending = registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'pending-cancel' }), channel: 'core', operation: 'cancel' });
      const expected = expect(pending).rejects.toBeInstanceOf(Error);
      const deadline = Date.now() + 3000;
      while (!fixture.calls.some((call) => call.path.includes('/abort'))) { if (Date.now() > deadline) throw new Error('abort did not reach fixture'); await new Promise((resolve) => setTimeout(resolve, 5)); }
      if (loss === 'generation') fixture.setGeneration(2);
      else {
        const key = loss === 'lease' ? leaseKey : processKey;
        const previous = await fixture.store.getControl({ collection: 'operations', key });
        if (!previous || typeof previous.value !== 'object' || previous.value === null || Array.isArray(previous.value)) throw new TypeError('missing durable owner');
        await fixture.store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key, expectedRevision: previous.revision, value: loss === 'lease' ? { operationId: 'foreign-operation', runtimeOwner: true } : { ...previous.value, alive: false } }] });
      }
      release?.(); fixture.gate(undefined); await expected;
      expect(await fixture.store.getControl({ collection: 'operations', key: sent.operationId })).toMatchObject({ value: { phase: 'reconciling', cancelRequested: true } });
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(1);
    } finally { release?.(); fixture.gate(undefined); await fixture.close(); }
  });
  it('rejects cancellation idempotency collisions without changing the frozen journal record', async () => {
    const fixture = await controlledNative();
    try {
      const driver = await createOpenCodeDriver(fixture.options); const registry = createHarnessRegistry(); registry.register(driver.registration);
      const sent = await registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'collision-turn', body: { parts: [] } }), channel: 'core', operation: 'send' });
      if (typeof sent !== 'object' || sent === null || !('operationId' in sent) || typeof sent.operationId !== 'string') throw new TypeError('missing operation identity');
      await expect(registry.invoke({ ...input({ processGeneration: 1, idempotencyKey: 'occupied-key', body: { title: 'queued change' } }), channel: 'native', operation: 'updateSession', permissions: ['opencode.write'] })).rejects.toMatchObject({ code: 'conflict' });
      const occupied = `op:${fingerprint([encodeSessionKey(session), 'occupied-key'])}`;
      const before = await fixture.store.getControl({ collection: 'operations', key: occupied });
      expect(before).toMatchObject({ value: { kind: 'operation', phase: 'accepted', method: 'updateSession' } });
      for (const idempotencyKey of ['occupied-key', 'collision-turn']) await expect(registry.invoke({ ...input({ processGeneration: 1, idempotencyKey }), channel: 'core', operation: 'cancel' })).rejects.toMatchObject({ code: 'conflict' });
      expect(await fixture.store.getControl({ collection: 'operations', key: occupied })).toEqual(before);
      expect(await fixture.store.getControl({ collection: 'operations', key: sent.operationId })).toMatchObject({ value: { cancelRequested: false } });
      expect(fixture.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(0);
    } finally { await fixture.close(); }
  });
});
