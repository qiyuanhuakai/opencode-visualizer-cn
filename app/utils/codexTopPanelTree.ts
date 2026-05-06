import type { ProjectState, SandboxState } from '../types/worker-state';
import type { SessionTreeData, SessionTreeProject, SessionTreeSandbox } from '../types/session-tree';
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
  pinDirectory?: string;
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

type BranchEntry = {
  directory: string;
  pinDirectory: string;
  pinnedAt: number;
  isPinned: boolean;
  isImplicitlyPinned: boolean;
  sessions: CodexTopPanelSession[];
};

type RepoEntry = {
  root: string;
  name: string;
  pinnedAt: number;
  isPinned: boolean;
  isImplicitlyPinned: boolean;
  branches: Map<string, BranchEntry>;
};

export function codexSessionRepoRoot(
  session: Pick<SandboxState['sessions'][string], 'gitInfo'>,
  homePath: string,
) {
  const root = session.gitInfo?.commonRoot || session.gitInfo?.root || '';
  return root ? normalizeCodexMetadataPath(root, homePath) : '';
}

function codexSessionWorktreeRoot(
  session: Pick<SandboxState['sessions'][string], 'gitInfo' | 'directory'>,
  homePath: string,
) {
  const root = session.gitInfo?.worktreeRoot || session.gitInfo?.root || session.directory || '';
  return root ? normalizeCodexMetadataPath(root, homePath) : '';
}

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

function codexBranchPinDirectory(repoRoot: string, branchName: string) {
  return `codex-branch:${repoRoot}:${branchName}`;
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
  pinDirectory?: string;
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
  const repos = new Map<string, RepoEntry>();

  for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
    const sandboxRootSessions = sandbox.rootSessions
      .map((sessionId) => sandbox.sessions[sessionId])
      .filter((session): session is NonNullable<typeof session> => Boolean(session));
    for (const session of sandboxRootSessions) {
      const repoRoot = codexSessionRepoRoot(session, homePath);
      const worktreeRoot = codexSessionWorktreeRoot(session, homePath);
      if (!repoRoot) {
        const folderDirectory = normalizeDirectory(session.directory || sandbox.directory || defaultDirectory);
        const folderSessions = globalFolders.get(folderDirectory) ?? [];
        folderSessions.push(buildTopPanelSession(project.id, session, projectPinnedAt, pinnedStore));
        globalFolders.set(folderDirectory, folderSessions);
        continue;
      }

      const repoLocalValue = pinnedStore[sandboxPinKey(project.id, repoRoot)];
      const repoPinnedAt = normalizePinnedAt(repoLocalValue);
      const isRepoDirectlyPinned = repoPinnedAt > 0;
      const isRepoExplicitlyUnpinned = typeof repoLocalValue === 'number' && repoLocalValue < 0;
      const isRepoPinned = isRepoDirectlyPinned || (projectPinnedAt > 0 && !isRepoExplicitlyUnpinned);
      const repoEffectivePinnedAt = isRepoPinned
        ? (isRepoDirectlyPinned ? repoPinnedAt : projectPinnedAt)
        : 0;
      const repo = repos.get(repoRoot) ?? {
        root: repoRoot,
        name: basenameForDisplay(repoRoot, globalSandboxName),
        pinnedAt: repoEffectivePinnedAt,
        isPinned: isRepoDirectlyPinned,
        isImplicitlyPinned: isRepoPinned && !isRepoDirectlyPinned,
        branches: new Map<string, BranchEntry>(),
      };
      repo.pinnedAt = Math.max(repo.pinnedAt, repoEffectivePinnedAt);
      repo.isPinned = repo.isPinned || isRepoDirectlyPinned;
      repo.isImplicitlyPinned = repo.isImplicitlyPinned || (isRepoPinned && !isRepoDirectlyPinned);
      const branchName = session.gitInfo?.branch?.trim() || 'detached';
      const branchDirectory = worktreeRoot || repoRoot;
      const branchPinDirectory = codexBranchPinDirectory(repoRoot, branchName);
      const branchLocalValue = pinnedStore[sandboxPinKey(project.id, branchPinDirectory)];
      const branchPinnedAt = normalizePinnedAt(branchLocalValue);
      const isBranchDirectlyPinned = branchPinnedAt > 0;
      const isBranchExplicitlyUnpinned = typeof branchLocalValue === 'number' && branchLocalValue < 0;
      const isBranchPinned = isBranchDirectlyPinned || (repoEffectivePinnedAt > 0 && !isBranchExplicitlyUnpinned);
      const branchEffectivePinnedAt = isBranchPinned
        ? (isBranchDirectlyPinned ? branchPinnedAt : repoEffectivePinnedAt)
        : 0;
      const branch = repo.branches.get(branchName) ?? {
        directory: branchDirectory,
        pinDirectory: branchPinDirectory,
        pinnedAt: branchEffectivePinnedAt,
        isPinned: isBranchDirectlyPinned,
        isImplicitlyPinned: isBranchPinned && !isBranchDirectlyPinned,
        sessions: [],
      };
      if (branch.directory === repoRoot && branchDirectory !== repoRoot) branch.directory = branchDirectory;
      branch.pinnedAt = Math.max(branch.pinnedAt, branchEffectivePinnedAt);
      branch.isPinned = branch.isPinned || isBranchDirectlyPinned;
      branch.isImplicitlyPinned = branch.isImplicitlyPinned || (isBranchPinned && !isBranchDirectlyPinned);
      branch.sessions.push(buildTopPanelSession(project.id, session, branchEffectivePinnedAt, pinnedStore));
      repo.branches.set(branchName, branch);
      repos.set(repoRoot, repo);
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
        .map(([branchName, branch]) => createTopPanelSandboxEntry({
          key: `codex:branch:${repo.root}:${branchName}`,
          directory: branch.directory,
          pinDirectory: branch.pinDirectory,
          branch: branchName,
          kind: 'branch',
          sessions: branch.sessions,
          pinnedAt: branch.pinnedAt,
          isPinned: branch.isPinned,
          isImplicitlyPinned: branch.isImplicitlyPinned,
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

export function buildCodexSessionTreeData(worktrees: CodexTopPanelWorktree[]): SessionTreeData {
  const projects: SessionTreeProject[] = [];
  for (const worktree of worktrees) {
    const sandboxes: SessionTreeSandbox[] = [];
    for (const sandbox of worktree.sandboxes) {
      const sessions = sandbox.sessions
        .filter((session) => !session.archivedAt && (session.isPinned || session.isImplicitlyPinned))
        .map((session) => ({
          type: 'session' as const,
          sessionId: session.id,
          projectId: worktree.projectId ?? '',
          directory: sandbox.directory,
          title: session.title || session.slug || session.id,
          status: session.status,
          pinnedAt: session.pinnedAt ?? 0,
          isPinned: Boolean(session.isPinned),
          isImplicitlyPinned: Boolean(session.isImplicitlyPinned),
        }));
      const sandboxPinned = Boolean(sandbox.isPinned || sandbox.isImplicitlyPinned);
      if (sessions.length === 0 && !sandboxPinned) continue;
      sandboxes.push({
        type: 'sandbox',
        key: sandbox.key,
        directory: sandbox.directory,
        pinDirectory: sandbox.pinDirectory,
        projectId: worktree.projectId ?? '',
        name: sandbox.branch || basenameForDisplay(sandbox.directory, CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME),
        kind: sandbox.kind,
        pinnedAt: sandbox.pinnedAt ?? 0,
        isPinned: Boolean(sandbox.isPinned),
        isImplicitlyPinned: Boolean(sandbox.isImplicitlyPinned),
        sessions,
      });
    }
    const worktreePinned = Boolean(worktree.isPinned);
    if (sandboxes.length === 0 && !worktreePinned) continue;
    projects.push({
      type: 'project',
      key: worktree.key,
      projectId: worktree.projectId ?? '',
      directory: worktree.directory,
      pinDirectory: worktree.kind === 'sandbox' ? worktree.directory : undefined,
      kind: worktree.kind,
      name: worktree.name || worktree.label || basenameForDisplay(worktree.directory, CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME),
      color: worktree.projectColor,
      pinnedAt: worktree.pinnedAt ?? 0,
      isPinned: worktreePinned,
      sandboxes,
    });
  }
  return projects.sort((a, b) => {
    if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt;
    return a.name.localeCompare(b.name);
  });
}
