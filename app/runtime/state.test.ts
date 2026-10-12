import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { createRuntimeState } from './state';
import type { RuntimeHistoryResource, RuntimeState } from './state';
import { useRuntimeState } from '../composables/useRuntimeState';
import { createRuntimeClient } from './client';
import { createRuntimeConnection } from './connection';
import { decodeFrame, encodeFrame } from '../../shared/runtime/protocol.js';
import type { Hello, Request, RuntimeEvent } from '../../shared/runtime/protocol.js';
import { parseCapabilities } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../../shared/runtime/runtimeWire.js';
import type { CanonicalEntity, ObserverDelivery } from '../../shared/runtime/runtimeWire.js';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../shared/runtime/identity.js';
import type { EnvironmentId, SessionRef } from '../../shared/runtime/identity.js';
import type { SelectionCapture } from './selectionScope';

const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const other = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const harness = parseHarnessInstanceId('33333333-3333-4333-8333-333333333333');
const sibling = parseHarnessInstanceId('44444444-4444-4444-8444-444444444444');
const profileId = parseConnectionProfileId('55555555-5555-4555-8555-555555555555');
const capabilities = parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] });
const hello: Hello = { kind: 'hello', version: 1, target, epoch: 'epoch', generation: 1, instanceId: parseInstanceId('66666666-6666-4666-8666-666666666666'), capabilities };
const session = (index: number, environmentId = target): SessionRef => ({ environmentId, harnessInstanceId: index % 2 ? sibling : harness, nativeSessionId: index < 2 ? 'same' : `session-${index}` });

class StateWire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer'; readyState: 0 | 1 | 2 | 3 = 1; bufferedAmount = 0;
  readonly methods = new Map<string, number>();
  readonly canonical = new Map<string, CanonicalEntity>();
  readonly deliveries = new Map<EnvironmentId, ObserverDelivery[]>();
  readonly held: Request[] = [];
  readonly seq = new Map<EnvironmentId, number>();
  block: ((request: Request) => boolean) | undefined;
  pageFailure: Readonly<{ target: EnvironmentId; collection: string; offset: number }> | undefined;
  revision = 200000; opened = 0; closed = 0; snapshots = 0;
  private heldSignal = Promise.withResolvers<Request>();
  constructor(readonly count = 2400) { super(); }
  close() { this.readyState = 3; }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(request: Request, result: unknown) { this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'read', result }); }
  send(value: string | Uint8Array) {
    if (typeof value !== 'string') throw new TypeError('unexpected binary request');
    const request = decodeFrame(value); if (request.kind !== 'request') throw new TypeError('unexpected frame');
    this.methods.set(request.method, (this.methods.get(request.method) ?? 0) + 1);
    if (this.block?.(request)) { this.held.push(request); this.heldSignal.resolve(request); return; }
    this.respond(request);
  }
  waitHeld() { return this.held[0] ? Promise.resolve(this.held[0]) : this.heldSignal.promise; }
  release() { const request = this.held.shift(); if (!request) throw new TypeError('missing held request'); this.heldSignal = Promise.withResolvers<Request>(); this.respond(request); }
  grant(environment = target) { return { target: environment, role: 'execution', capabilities, permissions: [], workspaceKeys: [] }; }
  summary(index: number, environment = target) {
    const identity = session(index, environment); const key = encodeSessionKey(identity);
    return this.canonical.get(key) ?? { collection: 'session_summaries', key, revision: index + 1, value: { session: identity, title: `title-${index}` } };
  }
  event(index: number, value: JsonValue, kind: 'event' | 'control' = 'event', environment = target): RuntimeEvent {
    const key = encodeSessionKey(session(index, environment));
    const seq = kind === 'event' ? (this.seq.get(environment) ?? 0) + 1 : 999;
    if (kind === 'event') { this.seq.set(environment, seq); this.revision++; this.canonical.set(key, { collection: 'session_summaries', key, revision: this.revision, value }); }
    const frame: RuntimeEvent = { version: 1, kind: 'event', target: environment, epoch: 'epoch', generation: environment === target ? 1 : 2,
      seq, entityRevision: this.revision, scope: key, type: 'entity.patch', payload: { collection: 'session_summaries', key, deleted: value === null } };
    const queue = this.deliveries.get(environment) ?? []; queue.push({ kind, frame }); this.deliveries.set(environment, queue); return frame;
  }
  respond(request: Request) {
    switch (request.method) {
      case 'runtime.inspect': this.reply(request, { role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [], connectionProfileId: profileId, targets: [this.grant(), this.grant(other)], harnesses: [], transports: { direct: true, ssh: false, slurm: false } }); break;
      case 'runtime.target.attach': this.reply(request, { hello: { ...hello, target: other, generation: 2 }, grant: this.grant(other) }); break;
      case 'runtime.snapshot': {
        const name = request.params.collection; const offset = request.params.cursor ? Number(request.params.cursor) : 0;
        if (this.pageFailure?.target === request.target && this.pageFailure.collection === name && this.pageFailure.offset === offset) {
          this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: false, typedError: { code: 'source_unavailable', message: 'source page failed' } }); break;
        }
        if (!request.params.token) this.snapshots++;
        const count = name === 'session_summaries' ? this.count : 0;
        const limit = typeof request.params.limit === 'number' ? request.params.limit : 200;
        const end = Math.min(count, offset + limit);
        this.reply(request, { version: 1, kind: 'snapshot', target: request.target, epoch: request.epoch, generation: request.generation,
          token: request.params.token ?? `snapshot-${this.snapshots}`, revision: this.revision, watermark: this.seq.get(request.target) ?? 0,
          expiresAt: Date.now() + 60000, cursor: end < count ? String(end) : null,
          items: Array.from({ length: end - offset }, (_, index) => this.summary(index + offset, request.target)) }); break;
      }
      case 'runtime.observer.open': {
        this.opened++;
        const after = typeof request.params.after === 'number' ? request.params.after : 0;
        this.deliveries.set(request.target, (this.deliveries.get(request.target) ?? []).filter(delivery => delivery?.kind !== 'event' || delivery.frame.seq > after));
        this.reply(request, { observerId: `observer-${this.opened}` }); break;
      }
      case 'runtime.observer.read': this.reply(request, this.deliveries.get(request.target)?.shift() ?? null); break;
      case 'runtime.observer.close': this.closed++; this.reply(request, { closed: true }); break;
      case 'runtime.entity.resolve': {
        const event = request.params.event;
        if (!event || typeof event !== 'object' || Array.isArray(event) || !('payload' in event)) throw new TypeError('missing event');
        const payload = event.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('key' in payload) || typeof payload.key !== 'string') throw new TypeError('missing patch');
        const canonical = this.canonical.get(payload.key); if (!canonical) throw new TypeError('missing canonical row'); this.reply(request, canonical); break;
      }
      default: throw new TypeError(`unexpected method ${request.method}`);
    }
  }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); vi.useRealTimers(); });
async function fixture(count = 2400, history?: RuntimeHistoryResource) {
  vi.useFakeTimers();
  const wire = new StateWire(count); const created = Promise.withResolvers<void>();
  const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:43210/runtime' }, resolveAuthentication: async () => ({}), createWebSocket: () => { created.resolve(); return wire; } });
  const client = createRuntimeClient({ connection }); const ready = connection.connect(); await created.promise; wire.frame(hello); await ready;
  const state = createRuntimeState({ client, profileId, ...(history ? { history } : {}) });
  cleanup.push(async () => { await state.dispose(); client.dispose(); connection.dispose(); });
  return { state, wire, client, connection };
}
function read(state: RuntimeState, environment = target) {
  const view = state.view('session_summaries', environment);
  const result = { status: view.status, loaded: view.loaded, items: view.items.map(item => ({ key: item.address.key, value: item.value, revision: item.revision })), error: view.error };
  view.release(); return result;
}

describe('runtime state through production client and frame codecs', () => {
  it('streams 100k rows with bounded cache and view while retaining honest snapshot progress', async () => {
    const { state, wire } = await fixture(100000);
    let peakEntries = 0; let peakBytes = 0; let peakWindow = 0; let partial = false;
    state.subscribe(() => {
      const usage = state.usage().entities; peakEntries = Math.max(peakEntries, usage.entries); peakBytes = Math.max(peakBytes, usage.residentBytes + usage.reservedBytes);
      const view = state.view('session_summaries'); peakWindow = Math.max(peakWindow, view.items.length); partial ||= view.status === 'partial'; view.release();
    });
    await state.start(target);
    expect(read(state)).toMatchObject({ status: 'complete', loaded: 100000 });
    expect(peakEntries).toBeLessThanOrEqual(2000); expect(peakBytes).toBeLessThanOrEqual(16 * 1024 * 1024); expect(peakWindow).toBe(200); expect(partial).toBe(true);
    expect(wire.methods.get('runtime.snapshot')).toBe(504); expect(wire.opened).toBe(1);
    console.info(JSON.stringify({ scenario: 'actual-client-100k-snapshot', rows: 100000, snapshotRequests: wire.methods.get('runtime.snapshot'), peakEntries, peakBytes, peakWindow, partialObserved: partial }));
    await state.dispose(); expect(state.usage().entities).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 }); expect(wire.closed).toBe(1);
  }, 20000);

  it('keeps same-native-ID sources separate and applies background summaries without native subscriptions', async () => {
    const selected: SelectionCapture[] = []; const invalidated: SelectionCapture[] = [];
    const history: RuntimeHistoryResource = { select: capture => { if (capture) selected.push(capture); }, invalidate: capture => { invalidated.push(capture); }, usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }), dispose() {} };
    const { state, wire } = await fixture(10, history); await state.start(target); await state.select(session(0));
    wire.event(1, { title: 'background' }); wire.event(0, { title: 'active' });
    await vi.advanceTimersByTimeAsync(25);
    const rows = read(state).items;
    expect(rows.find(item => item.key === encodeSessionKey(session(1)))?.value).toEqual({ title: 'background' });
    expect(rows.find(item => item.key === encodeSessionKey(session(0)))?.value).toEqual({ title: 'active' });
    expect(selected).toHaveLength(1); expect(invalidated).toHaveLength(1); expect(invalidated[0].selection.session.harnessInstanceId).toBe(harness);
    expect(wire.methods.has('session.history')).toBe(false);
  });

  it('uses the canonical newer deletion and ignores a later event for that same revision', async () => {
    const { state, wire } = await fixture(10); await state.start(target);
    wire.event(0, { title: 'superseded' }); wire.event(0, null);
    await vi.advanceTimersByTimeAsync(25);
    expect(read(state).items.some(item => item.key === encodeSessionKey(session(0)))).toBe(false);
    await state.retry(target);
    expect(read(state).items.some(item => item.key === encodeSessionKey(session(0)))).toBe(false);
    expect(wire.closed).toBe(1);
  });

  it('does not let an awaited canonical response restore a retired target view', async () => {
    const { state, wire, client } = await fixture(10); await client.inspect(); await client.attach(other); await state.start(target); await state.select(session(0));
    wire.block = request => request.method === 'runtime.entity.resolve'; wire.event(0, { title: 'old-target' });
    const held = wire.waitHeld(); await vi.advanceTimersByTimeAsync(25); await held;
    await state.select(session(0, other)); await state.start(other);
    wire.block = undefined; wire.release(); await vi.advanceTimersByTimeAsync(25);
    expect(state.capture()?.selection.session.environmentId).toBe(other);
    expect(read(state, other).items[0]?.value).toMatchObject({ title: 'title-0' });
  });

  it('isolates a middle-page error from another target and never marks the failed traversal complete', async () => {
    const { state, wire, client } = await fixture(500); await client.inspect(); await client.attach(other); await state.start(target);
    wire.pageFailure = { target: other, collection: 'session_summaries', offset: 200 };
    await expect(state.start(other, { visible: false })).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(read(state, other)).toMatchObject({ status: 'error', loaded: 200, error: { code: 'source_unavailable' } });
    expect(read(state)).toMatchObject({ status: 'complete', loaded: 500 });
    expect(wire.closed).toBe(1);
  });

  it('marks completed views unavailable and clears their rows when the client detaches', async () => {
    const { state, client } = await fixture(10); await state.start(target);
    expect(read(state).status).toBe('complete'); client.dispose();
    expect(read(state)).toMatchObject({ status: 'error', items: [], error: { code: 'reconcile_required' } });
  });

  it('revisits an offscreen range by a fresh traversal rather than retaining all keys', async () => {
    const { state, wire } = await fixture(5000); await state.start(target);
    expect(read(state).items[0]?.key).toBe(encodeSessionKey(session(0)));
    await state.start(target, { offset: 4000 });
    expect(read(state).items[0]?.key).toBe(encodeSessionKey(session(4000)));
    expect(read(state).items).toHaveLength(200); expect(wire.snapshots).toBe(2); expect(state.usage().entities.entries).toBeLessThanOrEqual(2000);
  });

  it('does not advance ordered application for a control hint with an unrelated sequence', async () => {
    const { state, wire } = await fixture(10); await state.start(target);
    wire.event(0, { title: 'hint-only' }, 'control'); wire.event(0, { title: 'ordered' });
    await vi.advanceTimersByTimeAsync(25);
    expect(read(state).items[0]?.value).toEqual({ title: 'ordered' }); expect(wire.methods.get('runtime.entity.resolve')).toBe(1);
  });

  it('reconciles periodic fence-window rollover without losing an intervening deletion', async () => {
    const { state, wire } = await fixture(800); await state.start(target);
    for (let index = 0; index < 513; index++) wire.event(index, index === 0 ? null : { title: `updated-${index}` });
    await vi.advanceTimersByTimeAsync(25);
    expect(wire.snapshots).toBe(2); expect(read(state).status).toBe('complete');
    expect(read(state).items.some(item => item.key === encodeSessionKey(session(0)))).toBe(false);
    expect(read(state).items.find(item => item.key === encodeSessionKey(session(1)))?.value).toEqual({ title: 'updated-1' });
    expect(wire.closed).toBe(1); expect(state.usage().entities.entries).toBeLessThanOrEqual(2000);
  });

  it('releases selected history and every observer on disposal during an in-flight resolve', async () => {
    let closed = 0;
    const history: RuntimeHistoryResource = { select() {}, usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }), dispose() { closed++; } };
    const { state, wire } = await fixture(10, history); await state.start(target); await state.select(session(0));
    const captured = state.capture(); wire.block = request => request.method === 'runtime.entity.resolve'; wire.event(0, { title: 'late' });
    await vi.advanceTimersByTimeAsync(25); await wire.waitHeld(); await state.dispose();
    wire.block = undefined; wire.release();
    expect(captured?.signal.aborted).toBe(true); expect(closed).toBe(1); expect(wire.closed).toBe(1);
    expect(state.usage().entities).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });

  it('keeps Vue presentation shallow and releases view leases when its effect scope closes', async () => {
    const { client } = await fixture(500); const scope = effectScope();
    const composed = scope.run(() => useRuntimeState({ client, profileId })); if (!composed) throw new TypeError('missing scope');
    await composed.start(target);
    expect(composed.page.value?.items).toHaveLength(200); expect(Object.isFrozen(composed.page.value?.items)).toBe(true);
    scope.stop(); await composed.dispose(); expect(composed.page.value).toBeNull();
    expect(composed.usage.value.entities).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });

  it('admits a first session into an empty visible window without losing completion', async () => {
    const { state, wire } = await fixture(0); await state.start(target);
    expect(read(state)).toMatchObject({ status: 'complete', loaded: 0, items: [] });
    wire.event(5, { title: 'first' });
    await vi.advanceTimersByTimeAsync(25);
    const view = read(state);
    expect(view.status).toBe('complete');
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.key).toBe(encodeSessionKey(session(5)));
    expect(state.usage().entities.entries).toBeLessThanOrEqual(2000);
  });

  it('shows a session added to a not yet full visible page', async () => {
    const { state, wire } = await fixture(5); await state.start(target);
    expect(read(state).items).toHaveLength(5);
    const snapshots = wire.methods.get('runtime.snapshot');
    wire.event(9, { title: 'added' });
    await vi.advanceTimersByTimeAsync(25);
    const view = read(state);
    expect(view.status).toBe('complete');
    expect(view.items).toHaveLength(6);
    expect(view.items.some(item => item.key === encodeSessionKey(session(9)))).toBe(true);
    expect(wire.methods.get('runtime.snapshot')).toBe(snapshots);
    expect(state.usage().entities.entries).toBeLessThanOrEqual(2000);
  });

  it('backfills the visible window when a shown session is deleted', async () => {
    const { state, wire } = await fixture(300); await state.start(target);
    const removed = read(state);
    expect(removed.items).toHaveLength(200);
    const removedKey = removed.items[0]?.key;
    expect(removedKey).toBe(encodeSessionKey(session(0)));
    const snapshots = wire.methods.get('runtime.snapshot');
    wire.event(0, null);
    await vi.advanceTimersByTimeAsync(25);
    const view = read(state);
    expect(view.status).toBe('complete');
    expect(view.items).toHaveLength(200);
    expect(view.items.some(item => item.key === removedKey)).toBe(false);
    expect(view.items.some(item => item.key === encodeSessionKey(session(200)))).toBe(true);
    expect(wire.methods.get('runtime.snapshot')).toBe(snapshots);
    expect(state.usage().entities.entries).toBeLessThanOrEqual(2000);
  });
});
