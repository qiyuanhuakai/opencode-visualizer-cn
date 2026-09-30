import type { TopPanelSandbox, TopPanelWorktree } from '../types/top-panel';
import type { ProjectState } from '../types/worker-state';
import { buildNativeOpenCodeTopPanelTreeData } from './openCodeSessionTrees';

type TreeParams = Parameters<typeof buildNativeOpenCodeTopPanelTreeData>[0];

/**
 * dsh exposes an independent child session (a subagent run) as a real session
 * with its own id and a `parentSession` (mapped to `parentID`). It must never
 * appear as a top-level tree session: subagent content is projected under the
 * parent by the Todo 18 content mapping. Strip such sessions at the input
 * boundary so no downstream path (top panel or session tree) can surface them.
 */
function withoutChildSessions(projects: Record<string, ProjectState>): Record<string, ProjectState> {
  const result: Record<string, ProjectState> = {};
  for (const [projectId, project] of Object.entries(projects)) {
    const sandboxes: ProjectState['sandboxes'] = {};
    for (const [directory, sandbox] of Object.entries(project.sandboxes)) {
      sandboxes[directory] = {
        ...sandbox,
        rootSessions: sandbox.rootSessions.filter((id) => !sandbox.sessions[id]?.parentID),
      };
    }
    result[projectId] = { ...project, sandboxes };
  }
  return result;
}

/**
 * dsh session tree. Mirrors the Kimi Web grouping algorithm: a stable
 * `workspace → directory/branch → session` attribution where every branch and
 * worktree of the SAME Git repository is folded into one sandbox group, keyed by
 * the repository root (never the branch name, so a rename cannot re-group,
 * duplicate, or lose sessions). Non-Git directories fall under one Global group.
 */
export function buildDshTopPanelTreeData(params: TreeParams): TopPanelWorktree[] {
  const groups = new Map<string, TopPanelWorktree>();
  const filtered: TreeParams = { ...params, projects: withoutChildSessions(params.projects) };
  for (const project of buildNativeOpenCodeTopPanelTreeData(filtered)) {
    for (const sandbox of project.sandboxes) {
      const git = filtered.gitInfoByDirectory[sandbox.directory];
      const root = git?.commonRoot || git?.root;
      const key = root ? `dsh:repo:${root}` : 'dsh:global';
      let group = groups.get(key);
      if (!group) {
        const name = root?.split('/').filter(Boolean).at(-1) || 'Global';
        group = {
          key,
          directory: root || filtered.homePath || '/',
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
