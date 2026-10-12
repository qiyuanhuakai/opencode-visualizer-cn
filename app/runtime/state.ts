import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import type { ErrorCode, JsonValue } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, SessionRef } from '../../shared/runtime/identity.js';
import type { Snapshot } from '../../shared/runtime/protocol.js';
import { INDEX_COLLECTIONS } from '../../shared/runtime/runtimeWire.js';
import type { CanonicalEntity, IndexCollection, ObserverDelivery } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeClient, RuntimeScope } from './client';
import { createEntityCache, createMemoryBudget, ENTITY_LIMITS, estimateRetainedBytes } from './entityCache';
import type { CachedEntity, CacheUsage, EntityFence, EntityLease, MemoryLease } from './entityCache';
import { createSelectionScope } from './selectionScope';
import type { SelectionCapture } from './selectionScope';

export type RuntimeResource = Readonly<{ usage(): CacheUsage; dispose(): void | Promise<void> }>;
export type RuntimeHistoryResource = RuntimeResource & Readonly<{ select(capture: SelectionCapture | null): void | Promise<void>; invalidate?(capture: SelectionCapture): void | Promise<void> }>;
export type RuntimeStateOptions = Readonly<{ client: RuntimeClient; profileId: ConnectionProfileId; drafts?: RuntimeResource; history?: RuntimeHistoryResource; pins?: RuntimeResource }>;
export type PageState<T> = Readonly<{ status: 'loading' | 'partial' | 'complete' | 'error'; items: readonly T[]; cursor: string | null; loaded: number; error?: Readonly<{ code: ErrorCode; retryable: boolean }> }>;
export type RuntimePageView = PageState<CachedEntity> & Readonly<{ release(): void }>;
export type RuntimeViewRequest = Readonly<{ collection?: IndexCollection; offset?: number; visible?: boolean }>;
type Progress = { status: PageState<never>['status']; loaded: number; cursor: string | null; error?: Readonly<{ code: ErrorCode; retryable: boolean }> };
type Observer = Awaited<ReturnType<RuntimeClient['observe']>>;
type TargetState = {
  readonly target: EnvironmentId; readonly scope: RuntimeScope; readonly controller: AbortController;
  readonly request: RuntimeViewRequest; readonly metadata: MemoryLease; readonly progress: Map<IndexCollection, Progress>;
  applicationGeneration: number; fence?: EntityFence; observer?: Observer; running?: Promise<void>;
  pendingCollection: IndexCollection; visibleCaptured: boolean; events: number;
};
const emptyUsage = (): CacheUsage => ({ residentBytes: 0, reservedBytes: 0, entries: 0 });
function record(value: JsonValue): value is Readonly<Record<string, JsonValue>> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function collection(value: JsonValue | undefined): value is IndexCollection { return INDEX_COLLECTIONS.some(name => name === value); }
function row(value: JsonValue, name: IndexCollection): CanonicalEntity {
  requireValue(record(value) && value.collection === name && typeof value.key === 'string' && value.key.length <= 4096
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0, 'state.entity');
  requireValue(value.chunked === undefined || value.chunked === true, 'state.chunked');
  requireValue(value.bytes === undefined || typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'state.bytes');
  return { collection: name, key: value.key, revision: value.revision,
    ...(value.value === undefined ? {} : { value: value.value }), ...(value.chunked === true ? { chunked: true } : {}),
    ...(typeof value.bytes === 'number' ? { bytes: value.bytes } : {}) };
}
function idle(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 25);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export function createRuntimeState(options: RuntimeStateOptions) {
  const { client, profileId } = options;
  const budget = createMemoryBudget({ maxBytes: ENTITY_LIMITS.bytes, maxEntries: ENTITY_LIMITS.entries });
  const cache = createEntityCache({ budget });
  const selection = createSelectionScope({ client, profileId });
  const targets = new Map<EnvironmentId, TargetState>();
  const starting = new Set<EnvironmentId>();
  const listeners = new Map<() => void, MemoryLease>();
  let visible: Readonly<{ target: EnvironmentId; collection: IndexCollection }> | undefined;
  let window: EntityLease[] = [];
  // Bounded one-page backfill source; never a server re-fetch, so refreshes cannot clone the project.
  let lookahead: EntityLease[] = [];
  let generation = 0;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  const notify = () => { for (const listener of listeners.keys()) listener(); };
  const clearWindow = () => { for (const lease of window) lease.release(); window = []; for (const lease of lookahead) lease.release(); lookahead = []; };
  const current = (entry: TargetState) => !disposed && !entry.controller.signal.aborted && targets.get(entry.target) === entry && entry.scope.isCurrent();
  const check = (entry: TargetState) => requireValue(current(entry), 'state.scope', 'cancelled');
  const address = (entry: TargetState, item: CanonicalEntity) => ({ profileId, target: entry.target, collection: item.collection, key: item.key });
  function progress(entry: TargetState, name: IndexCollection): Progress {
    const value = entry.progress.get(name); requireValue(value !== undefined, 'state.collection'); return value;
  }
  function fail(entry: TargetState, error: unknown) {
    const code = error instanceof ProtocolError ? error.code : 'source_unavailable';
    for (const [name, value] of entry.progress) if (name === entry.pendingCollection || value.status === 'complete') {
      value.status = 'error'; value.error = { code, retryable: code !== 'unauthorized' && code !== 'unsupported' };
    }
    if (!disposed) notify();
  }
  function publishPage(entry: TargetState, name: IndexCollection, page: Snapshot) {
    check(entry);
    requireValue(page.items.length <= ENTITY_LIMITS.page, 'state.page_size');
    const retained = cache.reserve({ bytes: 2048 + 2 * estimateRetainedBytes(page.items) + 4 * (page.token.length + (page.cursor?.length ?? 0)), entries: 0 });
    requireValue(retained !== null, 'state.page_budget', 'source_unavailable');
    try {
      if (!entry.fence) {
        entry.fence = Object.freeze({ binding: entry.scope.binding, localGeneration: entry.scope.generation,
          snapshotRevision: page.revision, snapshotWatermark: page.watermark, applicationGeneration: entry.applicationGeneration });
        cache.begin(entry.fence);
      }
      const position = progress(entry, name); const offset = entry.request.offset ?? 0;
      const show = visible?.target === entry.target && visible.collection === name && !entry.visibleCaptured && position.loaded + page.items.length > offset;
      if (show) clearWindow();
      for (let index = 0; index < page.items.length; index++) {
        const item = row(page.items[index], name);
        requireValue(item.revision <= page.revision, 'state.snapshot_revision', 'replay_required');
        const result = cache.admit({ ...item, address: address(entry, item), fence: entry.fence });
        requireValue(result !== 'budget', 'state.entity_budget', 'source_unavailable');
        if (show && position.loaded + index >= offset && item.value !== null) {
          const lease = cache.get(address(entry, item)); requireValue(lease !== null, 'state.view_budget', 'source_unavailable'); window.push(lease);
        } else if (entry.visibleCaptured && visible?.target === entry.target && visible.collection === name
          && lookahead.length < ENTITY_LIMITS.page && item.value !== null) {
          const lease = cache.get(address(entry, item)); requireValue(lease !== null, 'state.view_budget', 'source_unavailable'); lookahead.push(lease);
        }
      }
      if (show) entry.visibleCaptured = true;
      position.loaded += page.items.length; position.cursor = page.cursor; position.status = 'partial';
      entry.pendingCollection = page.cursor === null ? INDEX_COLLECTIONS[INDEX_COLLECTIONS.indexOf(name) + 1] ?? name : name;
      notify();
    } finally { retained.release(); }
  }
  function holds(lease: EntityLease, entry: TargetState, canonical: CanonicalEntity) {
    const at = lease.entity.address;
    return at.target === entry.target && at.collection === canonical.collection && at.key === canonical.key;
  }
  function reconcile(entry: TargetState, canonical: CanonicalEntity) {
    const index = window.findIndex(lease => holds(lease, entry, canonical));
    if (index >= 0) {
      window[index].release(); window.splice(index, 1);
      if (canonical.value !== null) {
        const lease = cache.get(address(entry, canonical)); requireValue(lease !== null, 'state.view_budget', 'replay_required'); window.splice(index, 0, lease);
      } else {
        const backfill = lookahead.shift(); if (backfill !== undefined) window.splice(index, 0, backfill);
      }
      return;
    }
    const pending = lookahead.findIndex(lease => holds(lease, entry, canonical));
    if (pending >= 0) {
      lookahead[pending].release(); lookahead.splice(pending, 1);
      if (canonical.value !== null) {
        const lease = cache.get(address(entry, canonical)); requireValue(lease !== null, 'state.view_budget', 'replay_required'); lookahead.splice(pending, 0, lease);
      }
      return;
    }
    if (canonical.value !== null) {
      const lease = cache.get(address(entry, canonical)); requireValue(lease !== null, 'state.view_budget', 'replay_required');
      if (window.length < ENTITY_LIMITS.page) window.push(lease);
      else if (lookahead.length < ENTITY_LIMITS.page) lookahead.push(lease);
      else lease.release();
    }
  }
  async function deliver(entry: TargetState, delivery: ObserverDelivery) {
    check(entry);
    if (delivery === null) return;
    switch (delivery.kind) {
      case 'control': notify(); return;
      case 'binary': return;
      case 'replay_required': return;
      case 'event': break;
      default: delivery satisfies never; return;
    }
    requireValue(entry.events++ < 512, 'state.fence_window', 'replay_required');
    const applicationGeneration = entry.applicationGeneration;
    const frame = delivery.frame;
    requireValue(record(frame.payload) && collection(frame.payload.collection) && typeof frame.payload.key === 'string', 'state.patch');
    const canonical = await client.request(entry.target, 'runtime.entity.resolve', { event: frame }, { signal: entry.controller.signal, selectionCurrent: () => current(entry) });
    check(entry);
    requireValue(applicationGeneration === entry.applicationGeneration && entry.fence !== undefined, 'state.application', 'reconcile_required');
    requireValue(canonical.collection === frame.payload.collection && canonical.key === frame.payload.key && canonical.revision >= frame.entityRevision, 'state.canonical', 'replay_required');
    const result = cache.admit({ ...canonical, address: address(entry, canonical), fence: entry.fence });
    requireValue(result !== 'budget', 'state.event_budget', 'replay_required');
    if (result === 'applied') {
      if (visible?.target === entry.target && visible.collection === canonical.collection) reconcile(entry, canonical);
      const captured = selection.capture();
      if (captured && captured.selection.session.environmentId === entry.target && encodeSessionKey(captured.selection.session) === canonical.key) {
        await options.history?.invalidate?.(captured); check(entry);
      }
      notify();
    }
  }
  async function snapshot(entry: TargetState) {
    entry.applicationGeneration = ++generation; entry.fence = undefined; entry.events = 0; entry.visibleCaptured = false;
    entry.pendingCollection = INDEX_COLLECTIONS[0];
    if (visible?.target === entry.target) clearWindow();
    for (const value of entry.progress.values()) { value.loaded = 0; value.cursor = null; value.status = 'loading'; delete value.error; }
    const firstPage = cache.reserve({ bytes: 2 * 1024 * 1024, entries: 0 });
    requireValue(firstPage !== null, 'state.first_page_budget', 'source_unavailable');
    try {
      let first = true;
      const result = await client.snapshot(entry.target, INDEX_COLLECTIONS, {
        signal: entry.controller.signal, selectionCurrent: () => current(entry),
        onPage: (name, page) => {
          if (first) { requireValue(firstPage.resize(2048 + 2 * estimateRetainedBytes(page.items) + 4 * page.token.length), 'state.first_page_budget', 'source_unavailable'); first = false; }
          publishPage(entry, name, page);
        }, onDelivery: delivery => deliver(entry, delivery),
      });
      entry.observer = result.observer; check(entry);
      for (const value of entry.progress.values()) value.status = 'complete';
      notify();
    } finally { firstPage.release(); }
  }
  async function run(entry: TargetState, ready: ReturnType<typeof Promise.withResolvers<void>>) {
    let recoveries = 0;
    const ingress = cache.reserve({ bytes: 4 * 1024 * 1024, entries: 0 });
    try {
      requireValue(ingress !== null, 'state.ingress_budget', 'source_unavailable');
      while (current(entry)) {
        try {
          await snapshot(entry); recoveries = 0; ready.resolve();
          requireValue(entry.observer !== undefined, 'state.observer');
          while (current(entry)) { const delivery = await entry.observer.read(); if (delivery === null) await idle(entry.controller.signal); }
        } catch (error) {
          if (error instanceof ProtocolError && error.code === 'replay_required' && current(entry) && recoveries++ < 3) {
            await entry.observer?.close(); entry.observer = undefined; continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (current(entry)) fail(entry, error);
      ready.reject(error instanceof ProtocolError ? error : new ProtocolError('source_unavailable', 'state.failure'));
    } finally {
      const closed = await Promise.allSettled([entry.observer?.close()]);
      if (closed[0]?.status === 'rejected') fail(entry, closed[0].reason);
      entry.observer = undefined; ingress?.release();
      ready.reject(new ProtocolError('cancelled', 'state.stopped'));
    }
  }
  async function stop(entry: TargetState) { entry.controller.abort(); await entry.running; }
  const onDetach = client.onDetach(target => {
    const entry = targets.get(target);
    if (entry) entry.controller.abort();
    if (visible?.target === target) clearWindow();
    cache.clear(target);
    if (entry) fail(entry, new ProtocolError('reconcile_required', 'state.detached'));
  });
  async function start(target: EnvironmentId, request: RuntimeViewRequest = {}) {
    requireValue(!disposed, 'state.disposed', 'cancelled');
    requireValue(Number.isSafeInteger(request.offset ?? 0) && (request.offset ?? 0) >= 0, 'state.offset');
    requireValue(!starting.has(target), 'state.starting', 'conflict'); starting.add(target);
    try {
    const old = targets.get(target);
    if (old) { await stop(old); old.metadata.release(); targets.delete(target); }
    requireValue(!disposed, 'state.disposed', 'cancelled');
    const scope = client.scope(target); const metadata = cache.reserve({ bytes: 8192, entries: 0 });
    requireValue(metadata !== null, 'state.target_budget', 'source_unavailable'); metadata.commit();
    const entry: TargetState = { target, scope, controller: new AbortController(), request, metadata,
      progress: new Map(INDEX_COLLECTIONS.map(name => [name, { status: 'loading', loaded: 0, cursor: null }])),
      applicationGeneration: 0, pendingCollection: INDEX_COLLECTIONS[0], visibleCaptured: false, events: 0 };
    if (request.visible !== false) { clearWindow(); visible = { target, collection: request.collection ?? 'session_summaries' }; }
    targets.set(target, entry);
    const ready = Promise.withResolvers<void>(); entry.running = run(entry, ready);
    return await ready.promise;
    } finally { starting.delete(target); }
  }
  function view(name: IndexCollection, target = selection.capture()?.selection.session.environmentId ?? visible?.target): RuntimePageView {
    requireValue(!disposed, 'state.disposed', 'cancelled');
    const entry = target === undefined ? undefined : targets.get(target); const status = entry?.progress.get(name);
    const leases: EntityLease[] = [];
    const container = cache.reserve({ bytes: 512 + ENTITY_LIMITS.page * 64, entries: 0 });
    requireValue(container !== null, 'state.output_budget', 'source_unavailable'); container.commit();
    if (visible?.target === target && visible?.collection === name) for (const held of window) {
      const lease = cache.get(held.entity.address); if (lease) leases.push(lease);
    }
    let released = false;
    return { status: status?.status ?? 'loading', loaded: status?.loaded ?? 0, cursor: status?.cursor ?? null,
      items: Object.freeze(leases.map(lease => lease.entity)), ...(status?.error ? { error: status.error } : {}),
      release() { if (released) return; released = true; for (const lease of leases) lease.release(); container.release(); },
    };
  }
  return {
    start,
    capture: selection.capture,
    async select(session: SessionRef | null) {
      const captured = selection.select(session);
      if (captured && visible?.target !== captured.selection.session.environmentId) clearWindow();
      notify(); await options.history?.select(captured);
      return captured?.isCurrent() ? captured : null;
    },
    view,
    subscribe(listener: () => void) {
      requireValue(!disposed && !listeners.has(listener), 'state.listener');
      const lease = cache.reserve({ bytes: 512, entries: 0 }); requireValue(lease !== null, 'state.listener_budget', 'source_unavailable');
      lease.commit(); listeners.set(listener, lease); return () => { listeners.delete(listener); lease.release(); };
    },
    retry(target: EnvironmentId) { return start(target, targets.get(target)?.request); },
    usage: () => ({ entities: cache.usage(), drafts: options.drafts?.usage() ?? emptyUsage(), history: options.history?.usage() ?? emptyUsage(), pins: options.pins?.usage() ?? emptyUsage() }),
    dispose(): Promise<void> {
      if (disposing) return disposing;
      disposed = true; selection.dispose(); onDetach();
      disposing = (async () => {
        await Promise.all([...targets.values()].map(stop)); clearWindow(); cache.clear();
        for (const entry of targets.values()) entry.metadata.release(); targets.clear();
        for (const lease of listeners.values()) lease.release(); listeners.clear();
        const results = await Promise.allSettled([options.history?.dispose(), options.drafts?.dispose(), options.pins?.dispose()]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      })();
      return disposing;
    },
  };
}
export type RuntimeState = ReturnType<typeof createRuntimeState>;
