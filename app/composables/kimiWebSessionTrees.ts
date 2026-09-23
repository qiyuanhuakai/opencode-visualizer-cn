import type { TopPanelSandbox, TopPanelWorktree } from '../types/top-panel';
import { buildNativeOpenCodeTopPanelTreeData } from './openCodeSessionTrees';

export function buildKimiWebTopPanelTreeData(
  params: Parameters<typeof buildNativeOpenCodeTopPanelTreeData>[0],
): TopPanelWorktree[] {
  const groups = new Map<string, TopPanelWorktree>();
  for (const project of buildNativeOpenCodeTopPanelTreeData(params)) {
    for (const sandbox of project.sandboxes) {
      const git = params.gitInfoByDirectory[sandbox.directory];
      const root = git?.commonRoot || git?.root;
      const key = root ? `kimi-web:repo:${root}` : 'kimi-web:global';
      let group = groups.get(key);
      if (!group) {
        const name = root?.split('/').filter(Boolean).at(-1) || 'Global';
        group = {
          key,
          directory: root || params.homePath || '/',
          label: name,
          name,
          projectId: project.projectId,
          kind: root ? 'sandbox' : 'global',
          sandboxes: [],
        };
        groups.set(key, group);
      }
      const sessions = sandbox.sessions.map((session) => ({ ...session, projectId: project.projectId }));
      const branch: TopPanelSandbox = {
        ...sandbox,
        key: `${key}:directory:${sandbox.directory}`,
        kind: root ? 'branch' : 'folder',
        branch: git?.branch || sandbox.branch,
        sessions,
      };
      const existing = group.sandboxes.find((item) => item.directory === branch.directory);
      if (existing) existing.sessions.push(...sessions);
      else group.sandboxes.push(branch);
    }
  }
  for (const group of groups.values()) {
    group.sandboxes.sort((left, right) => left.directory.localeCompare(right.directory));
    for (const sandbox of group.sandboxes) {
      sandbox.sessions.sort((left, right) =>
        (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) ||
        (right.timeUpdated ?? right.timeCreated ?? 0) - (left.timeUpdated ?? left.timeCreated ?? 0));
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.kind === 'global' ? -1 : right.kind === 'global' ? 1 : left.label.localeCompare(right.label));
}
