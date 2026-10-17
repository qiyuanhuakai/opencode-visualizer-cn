import { randomUUID } from 'node:crypto';
import { parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { StoreError } from './storage/storeProtocol.js';
import { createDiscoveryScheduler } from './discoveryScheduler.js';
import { createIndexMutations } from './indexMutations.js';
import { createIndexDiscovery } from './indexDiscovery.js';
import { createNativeEventIntake, INTAKE_LIMITS } from './nativeEventIntake.js';
import { createRuntimeEventBus } from './eventBus.js';
import { createRuntimeSnapshots } from './snapshots.js';
import { sourceIdentity, sourceAuthority } from './sessionSummaries.js';

export function createSessionIndex({ store, registry, catalog, resolveWorkspace }) {
  const scheduler = createDiscoveryScheduler();
  const events = createRuntimeEventBus({ store });
  const snapshots = createRuntimeSnapshots({ store });
  let eventWork = null;
  function nudgeEvents() {
    if (!eventWork) eventWork = events.nudge().catch(() => {}).finally(() => { eventWork = null; });
  }
  const mutations = createIndexMutations({ store, catalog, resolveWorkspace, onCommit: nudgeEvents });
  const discovery = createIndexDiscovery({ store, scheduler, mutations });
  const sources = new Map();
  let closed = false;
  async function attach({ harnessInstanceId: input, authority, subscribe = true }) {
    const harnessInstanceId = parseHarnessInstanceId(input);
    const manifest = registry.list().find((item) => item.harnessInstanceId === harnessInstanceId);
    if (!manifest) throw new StoreError('source_unavailable', 'index_harness');
    const identity = sourceIdentity(manifest);
    const invocationScope = { environmentId: identity.environmentId, harnessInstanceId };
    if ((await store.ready).environment !== identity.environmentId) throw new StoreError('unauthorized', 'index_source_target');
    if (closed || sources.has(harnessInstanceId) || sources.size >= 128) throw new StoreError('conflict', 'index_source_registration');
    sourceAuthority(authority());
    let serial = 0;
    let detached = false;
    let refresh = null;
    let failureWork = null;
    let lastRequest = {};
    let intake;
    const source = {
      identity, authority, serial: () => serial,
      assertCurrent() { if (closed || detached || sources.get(harnessInstanceId) !== handle) throw new StoreError('reconcile_required', 'index_source_detached'); },
      list: (params) => registry.invoke({ ...invocationScope, channel: 'core', operation: 'listSessionPage', params }),
    };
    function dirty() {
      serial++;
      if (refresh !== null || detached || closed) return;
      refresh = setTimeout(() => {
        intake.flush().then(() => handle.discover(lastRequest)).catch(() => {}).finally(() => { refresh = null; });
      }, 20);
      refresh.unref?.();
    }
    intake = createNativeEventIntake({ source, mutations, dirty, onControl: nudgeEvents, onFailure: (reason) => {
      if (!failureWork) failureWork = mutations.progress(identity, {}, { status: 'partial', count: 0, reason, authority: sourceAuthority(authority()) }, source.assertCurrent).catch(() => {}).finally(() => { failureWork = null; });
    } });
    const handle = {
      identity,
      publish: intake.publish,
      flush: intake.flush,
      discover(request = {}) { source.assertCurrent(); lastRequest = request; return discovery.discover(source, request); },
      async close() {
        if (detached) return;
        detached = true;
        if (refresh !== null) clearTimeout(refresh);
        await intake.close();
        sources.delete(harnessInstanceId);
      },
      get state() { return { serial, intake: intake.state }; },
    };
    sources.set(harnessInstanceId, handle);
    if (subscribe && identity.kind !== 'dsh' && manifest.core.subscribe.state === 'supported') {
      try {
        await intake.subscribe(() => registry.invoke({ ...invocationScope, channel: 'core', operation: 'subscribe', params: identity.kind === 'acp' ? { ...sourceAuthority(authority()), subscriberId: `index:${randomUUID()}` } : {} }));
      } catch (error) { await handle.close(); throw error; }
    }
    return handle;
  }
  return {
    attach,
    async createDshSource({ create, authority }) {
      const pending = [];
      let bytes = 0;
      let overflow = false;
      let handle = null;
      const native = await create({ onEvent(event) {
        if (handle) { handle.publish(event); return; }
        const encoded = JSON.stringify(event);
        const size = Buffer.byteLength(encoded);
        if (pending.length >= INTAKE_LIMITS.events || bytes + size > INTAKE_LIMITS.bytes || size > INTAKE_LIMITS.frameBytes) { overflow = true; return; }
        pending.push(JSON.parse(encoded)); bytes += size;
      } });
      try {
        if (native.manifest.kind !== 'dsh') throw new StoreError('invalid_request', 'index_dsh_factory');
        registry.register({ manifest: native.manifest, driver: native.driver });
        handle = await attach({ harnessInstanceId: native.manifest.harnessInstanceId, authority, subscribe: false });
        for (const event of pending) handle.publish(event);
        if (overflow) handle.publish({ type: 'replay_required' });
        pending.length = 0;
        return { source: handle, native };
      } catch (error) { await native.close(); throw error; }
    },
    topology(input = {}) {
      if (!['harnesses', 'workspaces'].includes(input.collection ?? 'harnesses')) throw new StoreError('invalid_request', 'index_topology_collection');
      return store.page({ ...input, collection: input.collection ?? 'harnesses', limit: Math.min(input.limit ?? 100, 200) });
    },
    page(input = {}) { return store.page({ ...input, collection: 'session_summaries', limit: Math.min(input.limit ?? 100, 200) }); },
    probeWorkspace: (key, visibility) => catalog.probe(key, visibility),
    snapshots, events,
    async close() {
      closed = true;
      scheduler.close();
      await Promise.all([...sources.values()].map((source) => source.close()));
      await events.close();
    },
    get state() { return { sources: sources.size, discovery: discovery.active, scheduler: scheduler.state, events: events.state, closed }; },
  };
}
