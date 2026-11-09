import { randomUUID } from 'node:crypto';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import { StoreError } from './storage/storeProtocol.js';
import { matchesScope } from './sessionSummaries.js';

export function createIndexMutations({ store, catalog, resolveWorkspace, onCommit = () => {} }) {
  const workspaces = new Map();
  async function workspaceFor(source, authority, directory, assertCurrent) {
    if (directory === null) return null;
    const cacheKey = JSON.stringify([source.environmentId, source.harnessInstanceId, authority, directory]);
    if (workspaces.has(cacheKey)) return workspaces.get(cacheKey);
    const workspace = await resolveWorkspace({ source, directory });
    assertCurrent();
    if (workspace.environmentId !== source.environmentId) throw new StoreError('unauthorized', 'index_workspace_target');
    const key = await catalog.register({ workspace, harnessInstanceId: source.harnessInstanceId, harness: source.kind === 'kimi-web' ? 'kimi' : source.kind });
    assertCurrent();
    if (workspaces.size >= 512) workspaces.delete(workspaces.keys().next().value);
    workspaces.set(cacheKey, key);
    return key;
  }
  async function workspaceBatch(scan, items) {
    const resolved = new Map([[null, null]]), pending = [];
    for (const { directory } of items) {
      if (resolved.has(directory)) continue;
      const cacheKey = JSON.stringify([scan.source.environmentId, scan.source.harnessInstanceId, scan.authority, directory]);
      if (workspaces.has(cacheKey)) { resolved.set(directory, workspaces.get(cacheKey)); continue; }
      const workspace = await resolveWorkspace({ source: scan.source, directory });
      scan.assertCurrent();
      if (workspace.environmentId !== scan.source.environmentId) throw new StoreError('unauthorized', 'index_workspace_target');
      pending.push({ directory, cacheKey, workspace });
      resolved.set(directory, null);
    }
    const keys = await catalog.registerMany(pending.map(({ workspace }) => ({ workspace, harnessInstanceId: scan.source.harnessInstanceId, harness: scan.source.kind === 'kimi-web' ? 'kimi' : scan.source.kind })));
    scan.assertCurrent();
    pending.forEach(({ directory, cacheKey }, index) => {
      const key = keys[index];
      if (workspaces.size >= 512) workspaces.delete(workspaces.keys().next().value);
      workspaces.set(cacheKey, key); resolved.set(directory, key);
    });
    return resolved;
  }
  async function replace(key, build, assertCurrent) {
    for (let attempt = 0; attempt < 8; attempt++) {
      assertCurrent();
      const prior = await store.get({ collection: 'session_summaries', key });
      assertCurrent();
      const value = build(prior);
      if (value === undefined) return false;
      try {
        await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key, expectedRevision: prior?.revision ?? 0, value }] });
        onCommit();
        assertCurrent();
        return true;
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
      }
    }
    throw new StoreError('conflict', 'index_contention');
  }
  return {
    async apply(scan, items) {
      if (!Array.isArray(items) || items.length > (scan.source.kind === 'acp' ? 1000 : 200)) throw new StoreError('invalid_request', 'index_page_budget');
      const summaries = new Map();
      async function flush() {
      for (let attempt = 0; attempt < 8; attempt++) {
        scan.assertCurrent();
        const changes = [];
        let applied = 0;
        for (const [key, { summary, workspaceKey }] of summaries) {
          const prior = await store.get({ collection: 'session_summaries', key });
          scan.assertCurrent();
          if (prior && prior.value === null && prior.revision > scan.startRevision) continue;
          if (!prior?.value?._index?.seen?.includes(scan.id)) applied++;
          const seen = [...(prior?.value?._index?.seen ?? []).filter((id) => id !== scan.id), scan.id].slice(-8);
          const value = prior?.value && prior.revision > scan.startRevision && prior.value._index?.scanId !== scan.id
            ? { ...prior.value, _index: { ...prior.value._index, seen } }
            : { ...summary, workspaceKey, _index: { authority: scan.authority, scanId: scan.id, seen } };
          changes.push({ collection: 'session_summaries', key, expectedRevision: prior?.revision ?? 0, value });
        }
        if (!changes.length) return 0;
        try {
          await store.mutate({ intentId: randomUUID(), changes });
          onCommit(); scan.assertCurrent(); return applied;
        } catch (error) { if (error?.code !== 'conflict') throw error; }
      }
      throw new StoreError('conflict', 'index_contention');
      }
      let applied = 0;
      const matching = items.filter(summary => matchesScope(summary, scan.scope));
      for (let offset = 0; offset < matching.length; offset += 20) {
        scan.assertCurrent();
        const chunk = matching.slice(offset, offset + 20), resolved = await workspaceBatch(scan, chunk);
        for (const summary of chunk) summaries.set(encodeSessionKey(summary.session), { summary, workspaceKey: resolved.get(summary.directory) });
        applied += await flush(); summaries.clear();
      }
      return applied;
    },
    async complete(scan, proof) {
      scan.assertCurrent();
      if (proof.completeness !== 'complete' || proof.cursor !== null || proof.stable !== true) throw new StoreError('invalid_request', 'index_absence_proof');
      let cursor = null;
      let count = 0;
      let deleted = 0;
      do {
        const page = await store.page({ collection: 'session_summaries', cursor, limit: 200 });
        scan.assertCurrent();
        for (const item of page.items) {
          const value = item.value;
          if (!value || value.session.environmentId !== scan.source.environmentId || value.session.harnessInstanceId !== scan.source.harnessInstanceId || !matchesScope(value, scan.scope)) continue;
          if (value._index?.seen?.includes(scan.id)) { count++; continue; }
          if (item.revision > scan.startRevision) continue;
          if (await replace(item.key, (prior) => prior?.value && prior.revision <= scan.startRevision && !prior.value._index?.seen?.includes(scan.id) ? null : undefined, scan.assertCurrent)) deleted++;
        }
        cursor = page.cursor;
      } while (cursor !== null);
      return { count, deleted };
    },
    async event({ source, authority, summary, session, deleted, assertCurrent }) {
      const ref = deleted ? session : summary.session;
      if (ref.environmentId !== source.environmentId || ref.harnessInstanceId !== source.harnessInstanceId) throw new StoreError('unauthorized', 'index_event_scope');
      const workspaceKey = deleted ? null : await workspaceFor(source, authority, summary.directory, assertCurrent);
      return replace(encodeSessionKey(ref), () => deleted ? null : { ...summary, workspaceKey, _index: { authority, scanId: null, seen: [] } }, assertCurrent);
    },
    async progress(source, scope, progress, assertCurrent) {
      const scopeKey = JSON.stringify(scope);
      for (let attempt = 0; attempt < 8; attempt++) {
        assertCurrent();
        const prior = await store.get({ collection: 'harnesses', key: source.harnessInstanceId });
        assertCurrent();
        const scopes = [...(prior?.value?.indexDiscovery ?? []).filter((entry) => entry.scopeKey !== scopeKey), { scopeKey, ...progress }].slice(-8);
        try {
          await store.mutate({ intentId: randomUUID(), changes: [{ collection: 'harnesses', key: source.harnessInstanceId, expectedRevision: prior?.revision ?? 0, value: { ...prior?.value, ...source, indexDiscovery: scopes } }] });
          onCommit();
          return;
        } catch (error) { if (error?.code !== 'conflict') throw error; }
      }
      throw new StoreError('conflict', 'index_progress_contention');
    },
  };
}
