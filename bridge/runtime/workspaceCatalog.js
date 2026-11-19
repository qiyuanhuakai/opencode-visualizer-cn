import { randomUUID } from 'node:crypto';
import {
  encodeWorkspaceKey,
  parseWorkspaceRef,
  parseHarnessInstanceId,
} from '../../shared/runtime/identity.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

export function createWorkspaceCatalog({ store, git }) {
  let writes = Promise.resolve();
  function write(operation) {
    const current = writes.then(operation);
    writes = current.then(() => {}, () => {});
    return current;
  }
  async function registerMany(inputs) {
    requireValue(Array.isArray(inputs) && inputs.length <= 200, 'git.catalog_batch');
    const environment = (await store.ready).environment;
    const pending = new Map(), keys = [];
    for (const { workspace: input, harnessInstanceId, harness, orphan = false } of inputs) {
      const workspace = parseWorkspaceRef(input), key = encodeWorkspaceKey(workspace);
      requireValue(workspace.environmentId === environment, 'git.catalog_target', 'unauthorized');
      requireValue(['opencode', 'codex', 'kimi', 'dsh', 'acp'].includes(harness), 'git.harness');
      const source = { harnessInstanceId: parseHarnessInstanceId(harnessInstanceId), harness };
      const entry = pending.get(key) ?? { workspace, sources: new Map(), orphan };
      entry.sources.set(source.harnessInstanceId, source); entry.orphan = orphan;
      pending.set(key, entry); keys.push(key);
    }
    if (!pending.size) return keys;
    const workspaceKeys = [...pending.keys()];
    return write(async () => {
      // Keep catalog commits from invalidating one another's revisions during
      // concurrent discovery. Other store writers still use the CAS fences.
      for (let attempt = 0; attempt < 8; attempt++) {
        const priors = new Map();
        for (let offset = 0; offset < workspaceKeys.length; offset += 20) {
          const rows = await store.getMany({ collection: 'workspaces', keys: workspaceKeys.slice(offset, offset + 20) });
          for (const row of rows) priors.set(row.key, row);
        }
        const changes = [];
        for (const [key, entry] of pending) {
          const prior = priors.get(key);
          if (prior?.value && prior.value.orphan === entry.orphan && [...entry.sources.values()].every(source => prior.value.sources?.some(item => item.harnessInstanceId === source.harnessInstanceId && item.harness === source.harness))) continue;
          const sources = [...(prior?.value?.sources ?? []).filter(source => !entry.sources.has(source.harnessInstanceId)), ...entry.sources.values()];
          changes.push({ collection: 'workspaces', key, expectedRevision: prior?.revision ?? 0,
            value: { ...prior?.value, kind: 'workspace', workspace: entry.workspace, sources, orphan: entry.orphan } });
        }
        if (!changes.length) return keys;
        try { await store.mutate({ intentId: randomUUID(), changes }); return keys; }
        catch (error) { if (error?.code !== 'conflict') throw error; }
      }
      requireValue(false, 'git.catalog_contention', 'conflict');
    });
  }
  return {
    registerMany,
    async register(input) { return (await registerMany([input]))[0]; },
    page(options = {}) {
      return store.page({
        ...options,
        collection: 'workspaces',
        limit: Math.min(options.limit ?? 100, 200),
      });
    },
    async probe(key, { selected = false, visible = false, identityOnly = false } = {}) {
      requireValue(selected || visible, 'git.probe_visibility');
      const prior = await store.get({ collection: 'workspaces', key });
      requireValue(prior?.value?.workspace, 'git.workspace');
      const info = await (identityOnly ? git.repository(prior.value.workspace) : git.probe(prior.value.workspace));
      const repoKey = info.kind === 'git' ? info.repoKey : null;
      return write(async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const latest = await store.get({ collection: 'workspaces', key });
          requireValue(latest?.value?.workspace, 'git.workspace');
          if (latest.value.gitKind === info.kind && latest.value.repoKey === repoKey) return info;
          const value = { ...latest.value, gitKind: info.kind, repoKey };
          try {
            await store.mutate({
              intentId: randomUUID(),
              changes: [{ collection: 'workspaces', key, expectedRevision: latest.revision, value }],
            });
            return info;
          } catch (error) {
            if (error?.code !== 'conflict') throw error;
          }
        }
        requireValue(false, 'git.catalog_contention', 'conflict');
      });
    },
    // A root the runtime is not PERMITTED to inspect (its grant carries no
    // command permission, so `git.probe` refuses before it runs anything) is
    // recorded as an explicit unknown instead of being probed: the entry stays
    // visible, but its repo identity is honestly undetermined — `repoKey` null
    // makes every consumer that gates on a repository refuse, which is the
    // truthful answer, rather than a silent `non-git` claim about a repository
    // the runtime simply may not run git in.
    async recordUnknown(key) {
      return write(async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const latest = await store.get({ collection: 'workspaces', key });
          requireValue(latest?.value?.workspace, 'git.workspace');
          try {
            await store.mutate({
              intentId: randomUUID(),
              changes: [{
                collection: 'workspaces',
                key,
                expectedRevision: latest.revision,
                value: { ...latest.value, gitKind: 'unknown', repoKey: null },
              }],
            });
            return;
          } catch (error) {
            if (error?.code !== 'conflict') throw error;
          }
        }
        requireValue(false, 'git.catalog_contention', 'conflict');
      });
    },
  };
}
