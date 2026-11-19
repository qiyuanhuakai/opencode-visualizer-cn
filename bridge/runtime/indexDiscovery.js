import { createHash, randomUUID } from 'node:crypto';
import { StoreError } from './storage/storeProtocol.js';
import { discoveryScope, nativePage, sameAuthority, sourceAuthority } from './sessionSummaries.js';

function nativeParams(kind, scope, cursor, authority) {
  const base = { cursor, limit: kind === 'kimi-web' ? 100 : 200 };
  if (kind === 'opencode') return { ...base, scope };
  if (kind === 'acp') return { ...base, ...authority };
  if (kind === 'kimi-web' && scope.workspaceId !== undefined) return { ...base, workspaceId: scope.workspaceId };
  return base;
}
export function createIndexDiscovery({ store, scheduler, mutations }) {
  const active = new Map();
  return {
    discover(source, request = {}) {
      const scope = discoveryScope(source.identity.kind, request.scope);
      const key = JSON.stringify([source.identity.environmentId, source.identity.harnessInstanceId, scope]);
      if (active.has(key)) {
        const existing = active.get(key);
        existing.demand.priority = request.priority ?? existing.demand.priority;
        existing.demand.interactive ||= request.interactive === true;
        if (existing.pending) scheduler.schedule(existing.demand, existing.pending).catch(() => {});
        return existing.promise;
      }
      if (active.size >= 261) return Promise.reject(new StoreError('source_unavailable', 'index_discovery_admission'));
      const state = { demand: { ...source.identity, scope: createHash('sha256').update(JSON.stringify(scope)).digest('hex'), priority: request.priority ?? 'background', interactive: request.interactive === true }, pending: null, promise: null };
      async function run() {
        let count = 0;
        let authority;
        for (let round = 0; round < 3; round++) {
          source.assertCurrent();
          authority = sourceAuthority(source.authority());
          const serial = source.serial();
          const assertCurrent = () => {
            source.assertCurrent();
            if (source.serial() !== serial || !sameAuthority(authority, sourceAuthority(source.authority()))) throw new StoreError('reconcile_required', 'index_generation_changed');
          };
          const scan = { id: randomUUID(), source: source.identity, scope, authority, startRevision: (await store.inspect()).revision, assertCurrent };
          let cursor = null;
          count = 0;
          const cursors = new Set();
          try {
            await mutations.progress(source.identity, scope, { status: 'loading', count, reason: 'native_discovery', authority }, assertCurrent);
            do {
              assertCurrent();
              const action = async (lease) => {
                lease.assertCurrent();
                assertCurrent();
                const raw = await source.list(nativeParams(source.identity.kind, scope, cursor, authority));
                lease.assertCurrent();
                assertCurrent();
                const page = nativePage(source.identity, raw);
                if (page.authority && !sameAuthority(authority, page.authority)) throw new StoreError('reconcile_required', 'index_page_generation');
                const fencedScan = { ...scan, assertCurrent() { lease.assertCurrent(); assertCurrent(); } };
                count += await mutations.apply(fencedScan, page.items);
                return page;
              };
              state.pending = action;
              const page = await scheduler.schedule(state.demand, action);
              state.pending = null;
              assertCurrent();
              cursor = page.cursor;
              if (cursor !== null) {
                const hash = createHash('sha256').update(cursor).digest('hex');
                if (cursors.has(hash) || cursors.size >= 10000) throw new StoreError('reconcile_required', 'index_cursor_cycle');
                cursors.add(hash);
              }
              if (cursor === null && page.completeness === 'complete') {
                const completed = await mutations.complete(scan, { completeness: 'complete', cursor: null, stable: true });
                count = completed.count;
              }
              const result = { status: cursor === null ? page.completeness : 'loading', count, reason: page.reason, authority };
              await mutations.progress(source.identity, scope, result, assertCurrent);
              if (cursor === null) return result;
            } while (cursor !== null);
          } catch (error) {
            state.pending = null;
            source.assertCurrent();
            if (error?.code === 'reconcile_required' && (source.serial() !== serial || !sameAuthority(authority, sourceAuthority(source.authority())))) continue;
            const result = { status: error?.code === 'unsupported' ? 'unsupported' : 'partial', count, reason: String(error?.reason ?? error?.field ?? error?.code ?? 'source_unavailable'), authority };
            await mutations.progress(source.identity, scope, result, () => source.assertCurrent());
            return result;
          }
        }
        const result = { status: 'partial', count, reason: 'native_catalog_changing', authority };
        await mutations.progress(source.identity, scope, result, () => source.assertCurrent());
        return result;
      }
      state.promise = run().finally(() => { if (active.get(key) === state) active.delete(key); });
      active.set(key, state);
      return state.promise;
    },
    get active() { return active.size; },
  };
}
