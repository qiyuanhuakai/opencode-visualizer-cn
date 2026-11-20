import { randomUUID } from 'node:crypto';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import { StoreError } from './storage/storeProtocol.js';
import { matchesScope, sameAuthority } from './sessionSummaries.js';

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
      pending.push({ directory, cacheKey });
      resolved.set(directory, null);
    }
    // The caller supplies at most twenty summaries. Resolve their distinct roots
    // in small groups before making any catalog writes.
    const authorized = [];
    for (let offset = 0; offset < pending.length; offset += 4) {
      scan.assertCurrent();
      const batch = await Promise.all(pending.slice(offset, offset + 4).map(async ({ directory }) => {
        const workspace = await resolveWorkspace({ source: scan.source, directory });
        if (workspace.environmentId !== scan.source.environmentId) throw new StoreError('unauthorized', 'index_workspace_target');
        return workspace;
      }));
      scan.assertCurrent();
      authorized.push(...batch);
    }
    const keys = await catalog.registerMany(authorized.map(workspace => ({ workspace, harnessInstanceId: scan.source.harnessInstanceId, harness: scan.source.kind === 'kimi-web' ? 'kimi' : scan.source.kind })));
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
      if (!Array.isArray(items) || items.length > 200) throw new StoreError('invalid_request', 'index_page_budget');
      const summaries = new Map();
      async function flush() {
      for (let attempt = 0; attempt < 8; attempt++) {
        scan.assertCurrent();
        const priors = new Map((await store.getMany({ collection: 'session_summaries', keys: [...summaries.keys()] }))
          .map(row => [row.key, row]));
        scan.assertCurrent();
        const changes = [];
        let applied = 0;
        for (const [key, { summary, workspaceKey }] of summaries) {
          const prior = priors.get(key);
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
    async event({ source, authority, summary, session, deleted, assertCurrent, reconcile }) {
      const ref = deleted ? session : summary.session;
      if (ref.environmentId !== source.environmentId || ref.harnessInstanceId !== source.harnessInstanceId) throw new StoreError('unauthorized', 'index_event_scope');
      const workspaceKey = deleted ? null : await workspaceFor(source, authority, summary.directory, assertCurrent);
      let needsReconcile = false;
      const changed = await replace(encodeSessionKey(ref), (prior) => {
        if (deleted) return null;
        const current = prior?.value;
        const sameGeneration = Boolean(current?._index?.authority && sameAuthority(current._index.authority, authority));
        const ordered = typeof summary.updatedAt === 'number' && typeof current?.updatedAt === 'number';
        needsReconcile = false;
        if (reconcile && sameGeneration && ordered && summary.updatedAt < current.updatedAt) return undefined;
        const titleOnly = Boolean(reconcile && sameGeneration && ordered && summary.updatedAt > current.updatedAt
          && current.workspaceKey === workspaceKey
          && Object.keys(summary).every(key => key === 'title' || key === 'updatedAt'
            || JSON.stringify(summary[key]) === JSON.stringify(current[key])));
        needsReconcile = !titleOnly;
        return { ...summary, workspaceKey, _index: { authority, scanId: null, seen: titleOnly ? (current._index.seen ?? []) : [] } };
      }, assertCurrent);
      if (changed && needsReconcile) reconcile?.();
      return changed;
    },
    async activity({ source, authority, session, status, assertCurrent }) {
      if (session.environmentId !== source.environmentId || session.harnessInstanceId !== source.harnessInstanceId) throw new StoreError('unauthorized', 'index_activity_scope');
      if (!['running', 'idle'].includes(status)) throw new StoreError('invalid_request', 'index_activity_status');
      return replace(encodeSessionKey(session), prior => {
        if (!prior?.value || prior.value.status === status) return undefined;
        if (!prior.value._index?.authority || !sameAuthority(prior.value._index.authority, authority)) throw new StoreError('reconcile_required', 'index_activity_generation');
        return { ...prior.value, status };
      }, assertCurrent);
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
