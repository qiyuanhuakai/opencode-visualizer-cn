import { randomUUID } from 'node:crypto';
import {
  encodeWorkspaceKey,
  parseWorkspaceRef,
  parseHarnessInstanceId,
} from '../../shared/runtime/identity.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

export function createWorkspaceCatalog({ store, git }) {
  return {
    async register({ workspace: input, harnessInstanceId, harness, orphan = false }) {
      const workspace = parseWorkspaceRef(input);
      requireValue(['opencode', 'codex', 'kimi', 'dsh', 'acp'].includes(harness), 'git.harness');
      const source = { harnessInstanceId: parseHarnessInstanceId(harnessInstanceId), harness };
      requireValue(
        (await store.ready).environment === workspace.environmentId,
        'git.catalog_target',
        'unauthorized',
      );
      const key = encodeWorkspaceKey(workspace);
      for (let attempt = 0; attempt < 8; attempt++) {
        const prior = await store.get({ collection: 'workspaces', key });
        const sources = [
          ...(prior?.value?.sources ?? []).filter(
            (item) => item.harnessInstanceId !== source.harnessInstanceId,
          ),
          source,
        ];
        const value = { ...prior?.value, kind: 'workspace', workspace, sources, orphan };
        try {
          await store.mutate({
            intentId: randomUUID(),
            changes: [
              { collection: 'workspaces', key, expectedRevision: prior?.revision ?? 0, value },
            ],
          });
          return key;
        } catch (error) {
          if (error?.code !== 'conflict') throw error;
        }
      }
      requireValue(false, 'git.catalog_contention', 'conflict');
    },
    page(options = {}) {
      return store.page({
        ...options,
        collection: 'workspaces',
        limit: Math.min(options.limit ?? 100, 200),
      });
    },
    async probe(key, { selected = false, visible = false } = {}) {
      requireValue(selected || visible, 'git.probe_visibility');
      const prior = await store.get({ collection: 'workspaces', key });
      requireValue(prior?.value?.workspace, 'git.workspace');
      const info = await git.probe(prior.value.workspace);
      for (let attempt = 0; attempt < 8; attempt++) {
        const latest = await store.get({ collection: 'workspaces', key });
        const value = {
          ...latest.value,
          gitKind: info.kind,
          repoKey: info.kind === 'git' ? info.repoKey : null,
        };
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
    },
  };
}
