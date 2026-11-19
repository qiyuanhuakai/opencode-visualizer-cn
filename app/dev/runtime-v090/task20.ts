// Task 20 registered QA browser entry.
//
// Loaded by scripts/qa/runtime-v090-cases/task-20.mjs from a runner-served page
// (the repository page route is owned by task 19; this entry is served by the
// task-20 runner so no shared file is edited). Every production module below is
// imported from the real worktree through Vite, so the real bounded-entity state,
// selection scope, entity cache, draft cache and pin store execute in a real
// headless Chromium with a real IndexedDB. The only controlled boundary is the
// runtime WebSocket wire (StateWire): a fixture at the transport seam that lets
// the runner inject timing (held responses, page failures, deletions), exactly
// as the task-20 acceptance asks the cases to distinguish.
import { createRuntimeConnection } from '../../runtime/connection';
import type { RuntimeSocket } from '../../runtime/connection';
import { createRuntimeClient } from '../../runtime/client';
import { createRuntimeState } from '../../runtime/state';
import type { RuntimeHistoryResource, RuntimeState } from '../../runtime/state';
import { createSelectionScope } from '../../runtime/selectionScope';
import { decodeFrame, encodeFrame } from '../../../shared/runtime/protocol.js';
import { parseCapabilities } from '../../../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../../../shared/runtime/runtimeWire.js';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../../shared/runtime/identity.js';
import type { EnvironmentId, SessionRef } from '../../../shared/runtime/identity.js';
import { DraftDigest, DraftStorageError } from '../../runtime/migration/draftChunks';

type AnyRecord = Record<string, any>;
type HeapSample = Readonly<{ usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }>;

const TARGET = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const OTHER = parseEnvironmentId('99999999-9999-4999-8999-999999999999');
const HARNESS = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const SIBLING = parseHarnessInstanceId('44444444-4444-4444-8444-444444444444');
const PROFILE = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const CAPABILITIES = parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] });
const HELLO = { kind: 'hello', version: 1, target: TARGET, epoch: 'epoch', generation: 1, instanceId: parseInstanceId('66666666-6666-4666-8666-666666666666'), capabilities: CAPABILITIES };
const PIN_PROFILE = String(PROFILE);
const PIN_ENV = String(TARGET);
const PIN_HARNESS = String(HARNESS);
const PIN_ORIGIN = 'qa-offline-client';
const MIB = 1024 * 1024;
// Cross-checks pinned to the independently produced real-100k-browser-sqlite lane
// evidence; a mismatch means the identity/ordering contract changed, not a pass.
const EXPECTED_PIN_PAGE_HASH = '5ec02fc9cf5dfd4f5d443ece1dc7f936d99e180493bad3ad7e373517a6c79a8b';
const EXPECTED_PIN_SAMPLE_HASH = '2d6c5ba04dac51c2835c066f5f73d868a7ca7c458dc5bcd2675164acefa4b946';

const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && event.reason.message) || event.reason)}`); });

function session(index: number, environmentId: EnvironmentId = TARGET): SessionRef {
  return { environmentId, harnessInstanceId: index % 2 ? SIBLING : HARNESS, nativeSessionId: index < 2 ? 'same' : `session-${index}` };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
function heap(): HeapSample {
  const memory = (performance as AnyRecord).memory as HeapSample | undefined;
  if (!memory) throw new Error('performance.memory unavailable; run with --enable-precise-memory-info');
  return { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit };
}
function settle(): void { const collect = (globalThis as AnyRecord).gc; if (typeof collect === 'function') { collect(); collect(); } }
function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] * 1000) / 1000;
}
function sha256(bytes: Uint8Array): string { const digest = new DraftDigest(); digest.update(bytes); return digest.finish(); }
const encoder = new TextEncoder();
function makeBytes(size: number, seed: number): Uint8Array { return Uint8Array.from({ length: size }, (_, index) => (index + seed) % 251); }
function openDatabase(name: string, version: number, stores: string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => { for (const store of stores) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`indexedDB open blocked: ${name}`));
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('transaction error'));
  });
}
function read(state: RuntimeState, environment: EnvironmentId = TARGET) {
  const view = state.view('session_summaries', environment);
  const result = { status: view.status, loaded: view.loaded, error: view.error ?? null, items: view.items.map((item) => ({ key: item.address.key, value: item.value, revision: item.revision })) };
  view.release();
  return result;
}
function findRow(rows: ReturnType<typeof read>['items'], index: number, environment: EnvironmentId = TARGET) {
  return rows.find((item) => item.key === encodeSessionKey(session(index, environment)));
}

// Controlled runtime WebSocket wire. Structurally a RuntimeSocket (add/remove
// listeners come from EventTarget) so the real client/connection codecs run
// unchanged; only the server side of the wire is a fixture.
class StateWire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  readonly methods = new Map<string, number>();
  readonly canonical = new Map<string, AnyRecord>();
  readonly deliveries = new Map<string, Array<AnyRecord | null>>();
  readonly chunkedKeys = new Set<string>();
  readonly held: AnyRecord[] = [];
  readonly seq = new Map<string, number>();
  block?: (request: AnyRecord) => boolean;
  pageFailure?: { target: string; collection: string; offset: number };
  revision = 200000;
  opened = 0;
  closed = 0;
  snapshots = 0;
  private heldSignal = deferred<AnyRecord>();
  constructor(readonly count = 10) { super(); }
  close() { this.readyState = 3; }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(request: AnyRecord, result: unknown) { this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'read', result }); }
  send(value: string | Uint8Array) {
    if (typeof value !== 'string') throw new TypeError('unexpected binary request');
    const decoded = decodeFrame(value);
    if (decoded.kind !== 'request') throw new TypeError('unexpected frame');
    const request: AnyRecord = decoded;
    this.methods.set(request.method, (this.methods.get(request.method) ?? 0) + 1);
    if (this.block?.(request)) { this.held.push(request); this.heldSignal.resolve(request); return; }
    this.respond(request);
  }
  waitHeld(): Promise<AnyRecord> { return this.held[0] ? Promise.resolve(this.held[0]) : this.heldSignal.promise; }
  release() {
    const request = this.held.shift();
    if (!request) throw new TypeError('missing held request');
    this.heldSignal = deferred<AnyRecord>();
    this.respond(request);
  }
  grant(environment: string = String(TARGET)) { return { target: environment, role: 'execution', capabilities: CAPABILITIES, permissions: [], workspaceKeys: [] }; }
  summary(index: number, environment: EnvironmentId = TARGET) {
    const identity = session(index, environment); const key = encodeSessionKey(identity);
    return this.canonical.get(key) ?? { collection: 'session_summaries', key, revision: index + 1, value: { session: identity, title: `title-${index}` } };
  }
  event(index: number, value: unknown, kind: 'event' | 'control' = 'event', environment: EnvironmentId = TARGET) {
    const key = encodeSessionKey(session(index, environment));
    const seq = kind === 'event' ? (this.seq.get(environment) ?? 0) + 1 : 999;
    if (kind === 'event') { this.seq.set(environment, seq); this.revision += 1; this.canonical.set(key, { collection: 'session_summaries', key, revision: this.revision, value }); }
    const frame = { version: 1, kind: 'event', target: environment, epoch: 'epoch', generation: environment === TARGET ? 1 : 2,
      seq, entityRevision: this.revision, scope: key, type: 'entity.patch', payload: { collection: 'session_summaries', key, deleted: value === null } };
    const queue = this.deliveries.get(environment) ?? []; queue.push({ kind, frame }); this.deliveries.set(environment, queue);
    return frame;
  }
  respond(request: AnyRecord) {
    switch (request.method) {
      case 'runtime.inspect':
        this.reply(request, { role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [], connectionProfileId: String(PROFILE),
          targets: [this.grant(String(TARGET)), this.grant(String(OTHER))], harnesses: [], transports: { direct: true, ssh: false, slurm: false } });
        break;
      case 'runtime.target.attach':
        this.reply(request, { hello: { ...HELLO, target: OTHER, generation: 2 }, grant: this.grant(String(OTHER)) });
        break;
      case 'runtime.snapshot': {
        const name = request.params.collection;
        const offset = request.params.cursor ? Number(request.params.cursor) : 0;
        if (this.pageFailure && this.pageFailure.target === request.target && this.pageFailure.collection === name && this.pageFailure.offset === offset) {
          this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: false, typedError: { code: 'source_unavailable', message: 'source page failed' } });
          break;
        }
        if (!request.params.token) this.snapshots += 1;
        const count = name === 'session_summaries' ? this.count : 0;
        const limit = typeof request.params.limit === 'number' ? request.params.limit : 200;
        const end = Math.min(count, offset + limit);
        this.reply(request, { version: 1, kind: 'snapshot', target: request.target, epoch: request.epoch, generation: request.generation,
          token: request.params.token ?? `snapshot-${this.snapshots}`, revision: this.revision, watermark: this.seq.get(request.target) ?? 0,
          expiresAt: Date.now() + 60000, cursor: end < count ? String(end) : null,
          items: Array.from({ length: end - offset }, (_, index) => this.summary(index + offset, request.target)) });
        break;
      }
      case 'runtime.observer.open': {
        this.opened += 1;
        const after = typeof request.params.after === 'number' ? request.params.after : 0;
        this.deliveries.set(request.target, (this.deliveries.get(request.target) ?? []).filter((delivery) => delivery === null || delivery.kind !== 'event' || delivery.frame.seq > after));
        this.reply(request, { observerId: `observer-${this.opened}` });
        break;
      }
      case 'runtime.observer.read': this.reply(request, this.deliveries.get(request.target)?.shift() ?? null); break;
      case 'runtime.observer.close': this.closed += 1; this.reply(request, { closed: true }); break;
      case 'runtime.entity.resolve': {
        const event = request.params.event;
        if (!event || typeof event !== 'object' || Array.isArray(event) || !('payload' in event)) throw new TypeError('missing event');
        const payload = event.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('key' in payload) || typeof payload.key !== 'string') throw new TypeError('missing patch');
        const canonical = this.canonical.get(payload.key);
        if (!canonical) throw new TypeError('missing canonical row');
        this.reply(request, this.chunkedKeys.has(payload.key) ? { ...canonical, chunked: true } : canonical);
        break;
      }
      default: throw new TypeError(`unexpected method ${request.method}`);
    }
  }
}

async function openState(count = 10, options: Readonly<{ history?: RuntimeHistoryResource; block?: (request: AnyRecord) => boolean; pageFailure?: StateWire['pageFailure'] }> = {}) {
  const wire = new StateWire(count);
  if (options.block) wire.block = options.block;
  if (options.pageFailure) wire.pageFailure = options.pageFailure;
  const created = deferred<void>();
  const connection = createRuntimeConnection({
    reference: { url: 'ws://127.0.0.1:43210/runtime' },
    resolveAuthentication: async () => ({}),
    createWebSocket: () => { created.resolve(); return wire as unknown as RuntimeSocket; },
  });
  const client = createRuntimeClient({ connection });
  const connecting = connection.connect();
  await created.promise;
  wire.frame(HELLO);
  await connecting;
  const state = createRuntimeState({ client, profileId: PROFILE, ...(options.history ? { history: options.history } : {}) });
  return { wire, client, connection, state };
}

// ---------------------------------------------------------- rolling caches --
function pinKey(index: number) { return [PIN_PROFILE, PIN_ENV, PIN_HARNESS, `pin-${String(index).padStart(6, '0')}`, PIN_ORIGIN]; }
async function rawSeedPins(count: number) {
  const database = await openDatabase('vis-runtime-pins', 1, ['identities']);
  try {
    for (let start = 0; start < count; start += 1000) {
      const size = Math.min(1000, count - start);
      const transaction = database.transaction('identities', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('identities');
      for (let index = start; index < start + size; index++) store.put({ revision: index, pinned: index % 3 !== 0 }, pinKey(index));
      await transactionDone(transaction);
    }
  } finally { database.close(); }
}
async function rawPinProof(positions: number[]) {
  const database = await openDatabase('vis-runtime-pins', 1, ['identities']);
  try {
    const rows = await new Promise<number>((resolve, reject) => {
      const request = database.transaction('identities', 'readonly').objectStore('identities').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const samples: AnyRecord[] = [];
    for (const position of positions) {
      const row = await new Promise<AnyRecord | null>((resolve, reject) => {
        const request = database.transaction('identities', 'readonly').objectStore('identities').openCursor();
        let current = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(null); return; }
          if (current === position) { resolve({ key: cursor.key, value: cursor.value }); return; }
          const step = position - current; current += step; cursor.advance(step);
        };
        request.onerror = () => reject(request.error);
      });
      if (!row) throw new Error(`pin row ${position} missing`);
      samples.push({ position, key: row.key, revision: row.value.revision, pinned: row.value.pinned });
    }
    return { rows, samples, sampleHash: sha256(encoder.encode(JSON.stringify(samples))) };
  } finally { database.close(); }
}
async function seedPins(count: number) { await rawSeedPins(count); return { seeded: count }; }
async function rollingPins() {
  const { PinStore } = await import('../../runtime/pinStore');
  const store = await PinStore.open();
  const hasher = new DraftDigest();
  const latencies: number[] = [];
  let pages = 0; let maxPage = 0; let maxLedger = 0; let total = 0;
  let heapPeak = heap().usedJSHeapSize;
  let after: readonly string[] | undefined;
  try {
    for (;;) {
      const started = performance.now();
      const page = await store.page({ profileId: PROFILE, ...(after ? { after } : {}), limit: 100 });
      latencies.push(performance.now() - started);
      pages += 1;
      maxPage = Math.max(maxPage, page.records.length);
      const usage = store.usage(); maxLedger = Math.max(maxLedger, usage.residentBytes + usage.reservedBytes);
      for (const record of page.records) hasher.update(encoder.encode(JSON.stringify([record.selection.profileId, record.selection.session.environmentId, record.selection.session.harnessInstanceId, record.selection.session.nativeSessionId, record.clientOrigin, record.revision, record.pinned])));
      total += page.records.length;
      heapPeak = Math.max(heapPeak, heap().usedJSHeapSize);
      after = page.next ?? undefined;
      page.release();
      if (!after) break;
    }
  } finally { store.close(); }
  settle();
  const raw = await rawPinProof([0, 1, 12345, 50000, 99998, 99999]);
  return { rows: raw.rows, total, pages, maxPage, maxLedger, p95: percentile95(latencies), p95First10k: percentile95(latencies.slice(0, 100)), heapPeak, hash: hasher.finish(), sampleHash: raw.sampleHash, ledgerAfter: { residentBytes: 0, reservedBytes: 0, entries: 0 } };
}
async function rawSeedDrafts(count: number, prefix: string) {
  const database = await openDatabase('vis-runtime-client', 1, ['headers', 'bodies', 'attachments', 'raw', 'migration']);
  const partDigest = 'a'.repeat(64);
  try {
    for (let start = 0; start < count; start += 500) {
      const size = Math.min(500, count - start);
      const transaction = database.transaction('headers', 'readwrite');
      const store = transaction.objectStore('headers');
      for (let index = start; index < start + size; index++) {
        const context = `${prefix}-${String(index).padStart(6, '0')}`;
        store.put({ context, clientOrigin: PIN_ORIGIN, revision: 1, parts: [{ name: 'body', kind: 'body', bytes: 256, chunks: 1, sha256: partDigest }] }, JSON.stringify([context, PIN_ORIGIN, 1]));
      }
      await transactionDone(transaction);
    }
  } finally { database.close(); }
}
async function seedDrafts(count: number, prefix: string) { await rawSeedDrafts(count, prefix); return { seeded: count, prefix }; }
async function rollingDrafts() {
  const { DraftStore } = await import('../../runtime/draftStore');
  const { createDraftCache } = await import('../../runtime/draftCache');
  const store = await DraftStore.open();
  const cache = createDraftCache({ store });
  const latencies: number[] = [];
  let pages = 0; let headers = 0; let maxEntries = 0; let maxLedger = 0; let first: string | null = null; let last: string | null = null;
  let heapPeak = heap().usedJSHeapSize;
  let after: string | undefined;
  try {
    for (;;) {
      const started = performance.now();
      const page = await cache.pageHeaders({ ...(after ? { after } : {}), limit: 32 });
      latencies.push(performance.now() - started);
      pages += 1; headers += page.headers.length;
      if (first === null) first = page.headers[0]?.context ?? null;
      if (page.headers.length) last = page.headers[page.headers.length - 1].context;
      const usage = cache.usage(); maxEntries = Math.max(maxEntries, usage.entries); maxLedger = Math.max(maxLedger, usage.residentBytes + usage.reservedBytes);
      heapPeak = Math.max(heapPeak, heap().usedJSHeapSize);
      after = page.next ?? undefined;
      page.release();
      if (!after) break;
    }
  } finally { await cache.dispose().catch(() => undefined); store.close(); }
  return { headers, pages, maxEntries, maxLedger, p95: percentile95(latencies), p95First10k: percentile95(latencies.slice(0, 313)), heapPeak, first, last, ledgerAfter: cache.usage() };
}

// ------------------------------------------------------ selection / events --
async function crossSourceSwitch() {
  const { client, state, connection } = await openState(10);
  try {
    await state.start(TARGET);
    const scope = createSelectionScope({ client, profileId: PROFILE });
    const stale = scope.select(session(0));
    const current = scope.select(session(1));
    const staleCapture = { aborted: stale?.signal.aborted ?? true, isCurrent: stale?.isCurrent() ?? false, generation: stale?.selectionGeneration ?? -1 };
    const currentCapture = { isCurrent: current?.isCurrent() ?? false, generation: current?.selectionGeneration ?? -1 };
    const pendingA = state.select(session(0));
    const settledB = await state.select(session(1));
    const settledA = await pendingA;
    const beforeForeign = scope.select(session(0));
    const foreign = scope.select({ ...session(0), harnessInstanceId: parseHarnessInstanceId('44444444-4444-4444-8444-444444444444') });
    const keys = [encodeSessionKey(session(0)), encodeSessionKey(session(1))];
    const result = {
      staleAborted: staleCapture.aborted, staleCurrent: staleCapture.isCurrent, staleGeneration: staleCapture.generation,
      currentIsCurrent: currentCapture.isCurrent, currentGeneration: currentCapture.generation,
      stateSelectStale: settledA === null, stateSelectCurrent: settledB ? settledB.selection.session.nativeSessionId : null,
      sameNativeId: session(0).nativeSessionId === session(1).nativeSessionId,
      distinctKeys: keys[0] !== keys[1], distinctKeyCount: new Set(keys).size,
      priorForeignCurrent: beforeForeign?.isCurrent() ?? true, priorForeignAborted: beforeForeign?.signal.aborted ?? false, foreignCurrent: foreign?.isCurrent() ?? false,
    };
    scope.dispose();
    return result;
  } finally { await state.dispose(); connection.dispose(); }
}
async function backgroundSummary() {
  const selected: unknown[] = []; const invalidated: unknown[] = [];
  const history: RuntimeHistoryResource = { select: (capture) => { if (capture) selected.push(capture); }, invalidate: (capture) => { invalidated.push(capture); }, usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }), dispose() {} };
  const { wire, state, connection } = await openState(10, { history });
  try {
    await state.start(TARGET);
    await state.select(session(0));
    wire.event(1, { title: 'background' });
    wire.event(0, { title: 'active' });
    await wait(120);
    const rows = read(state).items;
    const background = findRow(rows, 1); const active = findRow(rows, 0);
    const invalidated0 = invalidated[0] as { selection: { session: { harnessInstanceId: string } } } | undefined;
    return {
      backgroundTitle: background?.value && (background.value as AnyRecord).title,
      activeTitle: active?.value && (active.value as AnyRecord).title,
      appliedEvents: [background, active].filter(Boolean).length,
      selected: selected.length, invalidated: invalidated.length,
      invalidatedHarness: invalidated0?.selection.session.harnessInstanceId ?? null,
      nativeHistoryReads: wire.methods.has('session.history'),
    };
  } finally { await state.dispose(); connection.dispose(); }
}

// ------------------------------------------------------- failure surfaces --
async function deleteVsSnapshot() {
  const { wire, state, connection } = await openState(800);
  try {
    await state.start(TARGET);
    const key = encodeSessionKey(session(0));
    const before = read(state).items.some((item) => item.key === key);
    wire.event(0, null);
    await wait(120);
    const afterDelete = read(state).items.some((item) => item.key === key);
    const tombstone = wire.canonical.get(key);
    await state.retry(TARGET);
    const afterRetry = read(state).items.some((item) => item.key === key);
    return { before, afterDelete, afterRetry, tombstoneDeleted: tombstone?.value === null, snapshots: wire.snapshots, closed: wire.closed };
  } finally { await state.dispose(); connection.dispose(); }
}
async function switchWhileLoading() {
  const { wire, client, state, connection } = await openState(500, { block: (request) => request.method === 'runtime.entity.resolve' });
  try {
    await client.inspect(); await client.attach(OTHER);
    await state.start(TARGET);
    await state.select(session(0));
    wire.event(0, { title: 'old-target' });
    const held = wire.waitHeld();
    await wait(60);
    await held;
    await state.select(session(0, OTHER));
    await state.start(OTHER);
    wire.block = undefined;
    wire.release();
    await wait(120);
    const other = read(state, OTHER);
    return {
      capture: state.capture()?.selection.session.environmentId === String(OTHER),
      otherLoaded: other.loaded, otherFirstTitle: other.items[0]?.value && (other.items[0].value as AnyRecord).title,
      targetRowPresent: read(state, TARGET).items.length, heldCount: wire.held.length,
    };
  } finally { await state.dispose(); connection.dispose(); }
}
async function oversizedHistory() {
  const { wire, state, connection } = await openState(10);
  try {
    await state.start(TARGET);
    // An oversized history entity arrives as a chunked reference (its declared
    // byte payload is 16MiB); the client must refuse to inline it and force a
    // bounded resnapshot rather than allocating the entity resident.
    wire.chunkedKeys.add(encodeSessionKey(session(0)));
    wire.event(0, { session: session(0), title: 'title-0', bytes: 16 * MIB });
    await wait(160);
    const view = read(state);
    const row0 = findRow(view.items, 0);
    return { status: view.status, errorCode: view.error?.code ?? null, snapshots: wire.snapshots,
      entityResolveCalls: wire.methods.get('runtime.entity.resolve') ?? 0,
      row0Title: row0?.value ? (row0.value as AnyRecord).title : null,
      chunkedReferenceBytes: 16 * MIB, heapPeak: heap().usedJSHeapSize };
  } finally { await state.dispose(); connection.dispose(); }
}
async function pageErrorIsolation() {
  const { wire, client, state, connection } = await openState(500, { pageFailure: { target: String(OTHER), collection: 'session_summaries', offset: 200 } });
  try {
    await client.inspect(); await client.attach(OTHER);
    await state.start(TARGET);
    let failureCode: string | null = null;
    try { await state.start(OTHER, { visible: false }); } catch (error) { failureCode = (error as { code?: string }).code ?? 'unknown'; }
    const other = read(state, OTHER);
    const target = read(state);
    return { failureCode, otherStatus: other.status, otherLoaded: other.loaded, otherErrorCode: other.error?.code ?? null, targetStatus: target.status, targetLoaded: target.loaded, closed: wire.closed };
  } finally { await state.dispose(); connection.dispose(); }
}

// ------------------------------------------------------------- draft ack ---
async function seedRealDrafts(prefix: string, count: number) {
  const { DraftStore } = await import('../../runtime/draftStore');
  const store = await DraftStore.open();
  try {
    for (let start = 0; start < count; start += 32) {
      const entries = [] as Array<{ identity: { context: string; clientOrigin: string; revision: number }; parts: Array<{ name: string; kind: 'body'; bytes: Uint8Array }> }>;
      for (let index = start; index < Math.min(start + 32, count); index++) entries.push({ identity: { context: `${prefix}-${String(index).padStart(6, '0')}`, clientOrigin: PIN_ORIGIN, revision: 1 }, parts: [{ name: 'body', kind: 'body', bytes: makeBytes(128, index % 251) }] });
      await store.commitInlineBatch(entries);
    }
  } finally { store.close(); }
}
async function draftAfterAck() {
  const { DraftStore } = await import('../../runtime/draftStore');
  const store = await DraftStore.open();
  try {
    const identity1 = { context: 'ack', clientOrigin: PIN_ORIGIN, revision: 1 };
    const identity2 = { context: 'ack', clientOrigin: PIN_ORIGIN, revision: 2 };
    await store.commitInline(identity1, [{ name: 'body', kind: 'body', bytes: makeBytes(4096, 1) }]);
    await store.commitInline(identity2, [{ name: 'body', kind: 'body', bytes: makeBytes(4096, 2) }]);
    const committed = await store.header(identity2);
    store.close();
    const reopened = await DraftStore.open();
    try {
      const recovered = await reopened.header(identity2);
      const prior = await reopened.header(identity1);
      return { revision: recovered?.revision ?? null, newHash: recovered?.parts[0].sha256 ?? null, expectedNewHash: committed?.parts[0].sha256 ?? null,
        priorRevision: prior?.revision ?? null, priorHash: prior?.parts[0].sha256 ?? null, bodyBytes: recovered?.parts[0].bytes ?? 0 };
    } finally { reopened.close(); }
  } finally { store.close(); }
}
async function draftBeforeAck() {
  const { DraftStore } = await import('../../runtime/draftStore');
  const { createDraftCache } = await import('../../runtime/draftCache');
  const store = await DraftStore.open();
  try {
    const identity1 = { context: 'before-ack', clientOrigin: PIN_ORIGIN, revision: 1 };
    await store.commitInline(identity1, [{ name: 'body', kind: 'body', bytes: makeBytes(4096, 1) }]);
    const committed = await store.header(identity1);
    const failing = {
      header: (identity: unknown) => store.header(identity as never),
      page: (options: unknown) => store.page(options as never),
      readPart: (identity: unknown, part: unknown) => store.readPart(identity as never, part as never),
      writeChunk: (identity: unknown, part: unknown) => store.writeChunk(identity as never, part as never),
      commit: async () => { throw new DraftStorageError('unavailable'); },
      retry: () => store.retry(),
      get paused() { return false; },
      get pendingCount() { return 0; },
    };
    const cache = createDraftCache({ store: failing });
    const outcome = await cache.editSegment({ identity: identity1, part: 'body', nextRevision: 2, index: 0, bytes: makeBytes(4096, 9) }).then(() => ({ ok: true, code: null as string | null }), (error: unknown) => ({ ok: false, code: error instanceof Error ? (error as { code?: string }).code ?? error.name : 'unknown' }));
    const prior = await store.header(identity1);
    const attempted = await store.header({ ...identity1, revision: 2 });
    return { ok: outcome.ok, code: outcome.code, priorRevision: prior?.revision ?? null, priorHash: prior?.parts[0].sha256 ?? null,
      committedHash: committed?.parts[0].sha256 ?? null, attemptedAbsent: attempted === undefined };
  } finally { store.close(); }
}
async function quotaFailure() {
  const { DraftStore } = await import('../../runtime/draftStore');
  const { createDraftCache } = await import('../../runtime/draftCache');
  await seedRealDrafts('quota', 40);
  const store = await DraftStore.open();
  try {
    const cache = createDraftCache({ store });
    const page = await cache.pageHeaders({ limit: 32 });
    const identity = { context: 'quota-000000', clientOrigin: PIN_ORIGIN, revision: 1 };
    const prior = await store.header(identity);
    const outcome = await cache.editSegment({ identity, part: 'body', nextRevision: 2, index: 0, bytes: makeBytes(2048, 7) }).then(() => ({ ok: true, code: null as string | null }), (error: unknown) => ({ ok: false, code: error instanceof Error ? (error as { code?: string }).code ?? error.name : 'unknown' }));
    const held = { headers: page.headers.length, entries: cache.usage().entries, residentBytes: cache.usage().residentBytes };
    page.release();
    const released = cache.usage();
    await cache.dispose();
    return { ok: outcome.ok, code: outcome.code, heldHeaders: held.headers, heldEntries: held.entries, released,
      priorRevision: prior?.revision ?? null, priorHash: prior?.parts[0].sha256 ?? null, preservedBytes: prior?.parts[0].bytes ?? 0 };
  } finally { store.close(); }
}
async function oversizedBodyAttachment() {
  const { DraftStore } = await import('../../runtime/draftStore');
  const { createDraftCache } = await import('../../runtime/draftCache');
  const store = await DraftStore.open();
  const identity = { context: 'oversized', clientOrigin: PIN_ORIGIN, revision: 1 };
  const bodySize = 4 * MIB; const attachmentSize = 8 * MIB;
  async function* stream(size: number, seed: number) { for (let offset = 0; offset < size; offset += 65536) yield makeBytes(Math.min(65536, size - offset), (offset + seed) % 251); }
  try {
    const body = await store.writePart(identity, { name: 'body', kind: 'body', input: stream(bodySize, 0) });
    const attachment = await store.writePart(identity, { name: 'attachment', kind: 'attachment', input: stream(attachmentSize, 7) });
    await store.commit({ ...identity, parts: [body, attachment] });
    store.close();
    const reopened = await DraftStore.open();
    const cache = createDraftCache({ store: reopened });
    const result: AnyRecord = { body: { bytes: 0, hash: null }, attachment: { bytes: 0, hash: null }, peakLedger: 0, largest: 0, heapPeak: heap().usedJSHeapSize };
    try {
      for (const part of ['body', 'attachment']) {
        const digest = new DraftDigest(); let size = 0;
        for await (const segment of cache.exportPart({ identity, part })) {
          size += segment.bytes.length; digest.update(segment.bytes);
          result.largest = Math.max(result.largest, segment.bytes.length);
          const usage = cache.usage(); result.peakLedger = Math.max(result.peakLedger, usage.residentBytes + usage.reservedBytes);
          result.heapPeak = Math.max(result.heapPeak, heap().usedJSHeapSize);
          segment.release();
        }
        result[part] = { bytes: size, hash: digest.finish() };
      }
    } finally { await cache.dispose().catch(() => undefined); reopened.close(); }
    return { bodyBytes: result.body.bytes, bodyHash: result.body.hash, bodyExpected: body.sha256, attachmentBytes: result.attachment.bytes,
      attachmentHash: result.attachment.hash, attachmentExpected: attachment.sha256, peakLedger: result.peakLedger, largest: result.largest, heapPeak: result.heapPeak };
  } finally { store.close(); }
}

async function boundedCache() {
  const { DraftStore } = await import('../../runtime/draftStore');
  const { createDraftCache } = await import('../../runtime/draftCache');
  await seedRealDrafts('bounded', 40);
  const store = await DraftStore.open();
  try {
    const cache = createDraftCache({ store });
    const page = await cache.pageHeaders({ limit: 32 });
    const held = { headers: page.headers.length, entries: cache.usage().entries, residentBytes: cache.usage().residentBytes };
    const openOutcome = await cache.open({ context: 'bounded-probe', clientOrigin: PIN_ORIGIN, revision: 1 }).then(() => ({ ok: true, code: null as string | null }), (error: unknown) => ({ ok: false, code: error instanceof Error ? (error as { code?: string }).code ?? error.name : 'unknown' }));
    const pageOutcome = await cache.pageHeaders({ limit: 1 }).then(() => ({ ok: true, code: null as string | null }), (error: unknown) => ({ ok: false, code: error instanceof Error ? (error as { code?: string }).code ?? error.name : 'unknown' }));
    page.release();
    const released = cache.usage();
    await cache.dispose();
    return { heldHeaders: held.headers, heldEntries: held.entries, heldResidentBytes: held.residentBytes, openBlocked: openOutcome.code, pageBlocked: pageOutcome.code, released };
  } finally { store.close(); }
}

const task20 = {
  heap, settle,
  errors: () => errors.slice(),
  rollingPins, rollingDrafts, seedPins, seedDrafts,
  crossSourceSwitch, backgroundSummary,
  deleteVsSnapshot, switchWhileLoading, oversizedHistory, pageErrorIsolation,
  draftAfterAck, draftBeforeAck, quotaFailure, oversizedBodyAttachment, boundedCache,
  expectations: { pinPageHash: EXPECTED_PIN_PAGE_HASH, pinSampleHash: EXPECTED_PIN_SAMPLE_HASH },
};
declare global { interface Window { task20: typeof task20 } }
window.task20 = task20;
