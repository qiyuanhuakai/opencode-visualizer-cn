import type { ProjectState, SandboxState } from '../types/worker-state';
import {
  normalizePinnedAt,
  pinnedSessionStoreKey,
  projectPinKey,
  sandboxPinKey,
  type LocalPinnedSessionStore,
} from './pinnedSessions';
import { normalizeDirectory } from './path';

export const CODEX_TOP_PANEL_DEFAULT_DIRECTORY = '/';
export const CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME = 'Global';

export type BuildCodexTopPanelTreeOptions = {
  pinnedStore: LocalPinnedSessionStore;
  homePath?: string;
  defaultDirectory?: string;
  globalSandboxName?: string;
  resolveProjectColor?: (color?: string) => string | undefined;
};

export type CodexTopPanelSession = {
  id: string;
  title?: string;
  slug?: string;
  status: 'busy' | 'idle' | 'retry' | 'unknown';
  timeCreated?: number;
  timeUpdated?: number;
  archivedAt?: number;
  pinnedAt?: number;
  isPinned?: boolean;
  isImplicitlyPinned?: boolean;
};

export type CodexTopPanelSandbox = {
  key?: string;
  directory: string;
  branch?: string;
  kind?: 'global' | 'sandbox' | 'folder' | 'branch';
  sessions: CodexTopPanelSession[];
  latestUpdated?: number;
  oldestCreated?: number;
  pinnedAt?: number;
  isPinned?: boolean;
  isImplicitlyPinned?: boolean;
};

export type CodexTopPanelWorktree = {
  key?: string;
  directory: string;
  label: string;
  name?: string;
  projectId?: string;
  projectColor?: string;
  kind?: 'global' | 'sandbox';
  sandboxes: CodexTopPanelSandbox[];
  latestUpdated?: number;
  pinnedAt?: number;
  isPinned?: boolean;
};

type TopPanelSandboxEntry = CodexTopPanelSandbox & {
  latestUpdated: number;
  oldestCreated: number;
};

function basenameForDisplay(path: string, fallback: string) {
  return path.replace(/\/+$/u, '').split('/').filter(Boolean).at(-1) || fallback;
}

function normalizeCodexMetadataPath(path: string, homePath: string) {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const home = homePath.trim();
  if (trimmed === '~') return normalizeDirectory(home || CODEX_TOP_PANEL_DEFAULT_DIRECTORY);
  if (trimmed.startsWith('~/')) {
    return normalizeDirectory(`${(home || CODEX_TOP_PANEL_DEFAULT_DIRECTORY).replace(/\/+$/u, '')}/${trimmed.slice(2).replace(/^\/+/, '')}`);
  }
  return normalizeDirectory(trimmed);
}

function buildTopPanelSession(
  projectId: string,
  session: SandboxState['sessions'][string],
  inheritedPinnedAt: number,
  pinnedStore: LocalPinnedSessionStore,
): CodexTopPanelSession {
  const sessionLocalValue = pinnedStore[pinnedSessionStoreKey(projectId, session.id)];
  const sessionLocalPinnedAt = normalizePinnedAt(sessionLocalValue);
  const sessionServerPinnedAt = normalizePinnedAt(session.timePinned);
  const isSessionDirectlyPinned = sessionLocalPinnedAt > 0 || sessionServerPinnedAt > 0;
  const isSessionExplicitlyUnpinned = typeof sessionLocalValue === 'number' && sessionLocalValue < 0;
  const isSessionImplicitlyPinned = !isSessionDirectlyPinned && !isSessionExplicitlyUnpinned && inheritedPinnedAt > 0;
  return {
    id: session.id,
    title: session.title,
    slug: session.slug,
    status: (session.status ?? 'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
    timeCreated: session.timeCreated,
    timeUpdated: session.timeUpdated ?? session.timeCreated,
    archivedAt: session.timeArchived,
    pinnedAt: isSessionDirectlyPinned
      ? (sessionLocalPinnedAt || sessionServerPinnedAt)
      : (isSessionImplicitlyPinned ? inheritedPinnedAt : 0),
    isPinned: isSessionDirectlyPinned,
    isImplicitlyPinned: isSessionImplicitlyPinned,
  };
}

function sortTopPanelSessions(sessions: CodexTopPanelSession[]) {
  return sessions.slice().sort((a, b) => {
    const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    if (pinDiff !== 0) return pinDiff;
    return (b.timeUpdated ?? b.timeCreated ?? 0) - (a.timeUpdated ?? a.timeCreated ?? 0);
  });
}

function createTopPanelSandboxEntry(params: {
  key?: string;
  directory: string;
  branch?: string;
  kind?: 'global' | 'sandbox' | 'folder' | 'branch';
  sessions: CodexTopPanelSession[];
  pinnedAt?: number;
  isPinned?: boolean;
  isImplicitlyPinned?: boolean;
}): TopPanelSandboxEntry {
  const sessions = sortTopPanelSessions(params.sessions);
  const latestUpdated = sessions.reduce(
    (max, session) => Math.max(max, session.timeUpdated ?? session.timeCreated ?? 0),
    0,
  );
  const oldestCreated = sessions.length > 0
    ? Math.min(...sessions.map((session) => session.timeCreated ?? Infinity))
    : 0;
  return {
    ...params,
    sessions,
    latestUpdated,
    oldestCreated,
  };
}

export function buildCodexTopPanelTreeData(
  project: ProjectState,
  options: BuildCodexTopPanelTreeOptions,
): CodexTopPanelWorktree[] {
  const pinnedStore = options.pinnedStore;
  const homePath = options.homePath ?? '';
  const defaultDirectory = options.defaultDirectory ?? CODEX_TOP_PANEL_DEFAULT_DIRECTORY;
  const globalSandboxName = options.globalSandboxName ?? CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME;
  const projectPinnedAt = normalizePinnedAt(pinnedStore[projectPinKey(project.id)]);
  const globalFolders = new Map<string, CodexTopPanelSession[]>();
  const repos = new Map<string, {
    root: string;
    name: string;
    pinnedAt: number;
    isPinned: boolean;
    isImplicitlyPinned: boolean;
    branches: Map<string, CodexTopPanelSession[]>;
  }>();

  for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
    const sandboxRootSessions = sandbox.rootSessions
      .map((sessionId) => sandbox.sessions[sessionId])
      .filter((session): session is NonNullable<typeof session> => Boolean(session));
    for (const session of sandboxRootSessions) {
      const gitRoot = session.gitInfo?.root ? normalizeCodexMetadataPath(session.gitInfo.root, homePath) : '';
      if (!gitRoot) {
        const folderDirectory = normalizeDirectory(session.directory || sandbox.directory || defaultDirectory);
        const folderSessions = globalFolders.get(folderDirectory) ?? [];
        folderSessions.push(buildTopPanelSession(project.id, session, projectPinnedAt, pinnedStore));
        globalFolders.set(folderDirectory, folderSessions);
        continue;
      }

      const repoLocalValue = pinnedStore[sandboxPinKey(project.id, gitRoot)];
      const repoPinnedAt = normalizePinnedAt(repoLocalValue);
      const isRepoDirectlyPinned = repoPinnedAt > 0;
      const isRepoExplicitlyUnpinned = typeof repoLocalValue === 'number' && repoLocalValue < 0;
      const isRepoPinned = isRepoDirectlyPinned || (projectPinnedAt > 0 && !isRepoExplicitlyUnpinned);
      const repoEffectivePinnedAt = isRepoPinned
        ? (isRepoDirectlyPinned ? repoPinnedAt : projectPinnedAt)
        : 0;
      const repo = repos.get(gitRoot) ?? {
        root: gitRoot,
        name: basenameForDisplay(gitRoot, globalSandboxName),
        pinnedAt: repoEffectivePinnedAt,
        isPinned: isRepoDirectlyPinned,
        isImplicitlyPinned: isRepoPinned && !isRepoDirectlyPinned,
        branches: new Map<string, CodexTopPanelSession[]>(),
      };
      repo.pinnedAt = Math.max(repo.pinnedAt, repoEffectivePinnedAt);
      repo.isPinned = repo.isPinned || isRepoDirectlyPinned;
      repo.isImplicitlyPinned = repo.isImplicitlyPinned || (isRepoPinned && !isRepoDirectlyPinned);
      const branchName = session.gitInfo?.branch?.trim() || 'detached';
      const branchSessions = repo.branches.get(branchName) ?? [];
      branchSessions.push(buildTopPanelSession(project.id, session, repoEffectivePinnedAt, pinnedStore));
      repo.branches.set(branchName, branchSessions);
      repos.set(gitRoot, repo);
    }
  }

  const projectColor = options.resolveProjectColor?.(project.icon?.color);
  const worktrees: CodexTopPanelWorktree[] = [];
  if (globalFolders.size > 0) {
    const globalSandboxes = Array.from(globalFolders.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, sessions]) => createTopPanelSandboxEntry({
        key: `codex:global-folder:${directory}`,
        directory,
        branch: basenameForDisplay(directory, globalSandboxName),
        kind: 'folder',
        sessions,
        pinnedAt: projectPinnedAt,
        isPinned: false,
        isImplicitlyPinned: projectPinnedAt > 0,
      }));
    worktrees.push({
      key: 'codex:global',
      directory: defaultDirectory,
      label: globalSandboxName,
      name: globalSandboxName,
      projectId: project.id,
      projectColor,
      kind: 'global',
      sandboxes: globalSandboxes,
      latestUpdated: globalSandboxes
        .flatMap((sandbox) => sandbox.sessions)
        .reduce((max, session) => Math.max(max, session.timeUpdated ?? 0), 0),
      pinnedAt: projectPinnedAt,
      isPinned: false,
    });
  }

  Array.from(repos.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((repo) => {
      const branchSandboxes = Array.from(repo.branches.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([branchName, sessions]) => createTopPanelSandboxEntry({
          key: `codex:branch:${repo.root}:${branchName}`,
          directory: repo.root,
          branch: branchName,
          kind: 'branch',
          sessions,
          pinnedAt: repo.pinnedAt,
          isPinned: false,
          isImplicitlyPinned: repo.pinnedAt > 0,
        }));
      worktrees.push({
        key: `codex:repo:${repo.root}`,
        directory: repo.root,
        label: repo.name,
        name: repo.name,
        projectId: project.id,
        projectColor,
        kind: 'sandbox',
        sandboxes: branchSandboxes,
        latestUpdated: branchSandboxes
          .flatMap((sandbox) => sandbox.sessions)
          .reduce((max, session) => Math.max(max, session.timeUpdated ?? 0), 0),
        pinnedAt: repo.pinnedAt,
        isPinned: repo.isPinned,
      });
    });

  return worktrees;
}
