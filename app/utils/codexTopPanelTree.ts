import type { ProjectState, SandboxState } from '../types/worker-state';
import type {
  SessionTreeData,
  SessionTreeProject,
  SessionTreeSandbox,
} from '../types/session-tree';
import type { ContainerPinScope } from '../types/pin';
import {
  normalizePinnedAt,
  pinnedSessionStoreKey,
  repoPinKey,
  sandboxPinKey,
  type LocalPinnedSessionStore,
} from './pinnedSessions';
import { normalizeDirectory, normalizeMetadataPath } from './path';

const CODEX_TOP_PANEL_DEFAULT_DIRECTORY = '/';
const CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME = 'Global';

export type BuildCodexTopPanelTreeOptions = {
  pinnedStore: LocalPinnedSessionStore;
  homePath?: string;
  defaultDirectory?: string;
  globalSandboxName?: string;
  keyPrefix?: string;
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
  pinScope?: ContainerPinScope;
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
  pinScope?: ContainerPinScope;
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
  branch: string;
  directory: string;
  pinScope: ContainerPinScope;
  pinnedAt: number;
  isPinned: boolean;
  sessions: CodexTopPanelSession[];
};

type RepoEntry = {
  root: string;
  name: string;
  pinnedAt: number;
  isPinned: boolean;
  branches: Map<string, BranchEntry>;
};

function codexSessionRepoRoot(
  session: Pick<SandboxState['sessions'][string], 'gitInfo'>,
  homePath: string,
) {
  const root = session.gitInfo?.commonRoot || session.gitInfo?.root || '';
  return root ? normalizeMetadataPath(root, homePath, CODEX_TOP_PANEL_DEFAULT_DIRECTORY) : '';
}

function codexSessionWorktreeRoot(
  session: Pick<SandboxState['sessions'][string], 'gitInfo' | 'directory'>,
  homePath: string,
) {
  const root = session.gitInfo?.worktreeRoot || session.gitInfo?.root || session.directory || '';
  return root ? normalizeMetadataPath(root, homePath, CODEX_TOP_PANEL_DEFAULT_DIRECTORY) : '';
}

function basenameForDisplay(path: string, fallback: string) {
  return path.replace(/\/+$/u, '').split('/').filter(Boolean).at(-1) || fallback;
}

function buildTopPanelSession(
  projectId: string,
  session: SandboxState['sessions'][string],
  pinnedStore: LocalPinnedSessionStore,
): CodexTopPanelSession {
  const localValue = pinnedStore[pinnedSessionStoreKey(projectId, session.id)];
  const sessionServerPinnedAt = normalizePinnedAt(session.timePinned);
  const pinnedAt =
    typeof localValue === 'number' && localValue !== 0
      ? normalizePinnedAt(localValue)
      : sessionServerPinnedAt;
  return {
    id: session.id,
    title: session.title,
    slug: session.slug,
    status: (session.status ?? 'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
    timeCreated: session.timeCreated,
    timeUpdated: session.timeUpdated ?? session.timeCreated,
    archivedAt: session.timeArchived,
    pinnedAt,
    isPinned: pinnedAt > 0,
    isImplicitlyPinned: false,
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
  pinScope?: ContainerPinScope;
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
  const oldestCreated =
    sessions.length > 0
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
  const keyPrefix = options.keyPrefix ?? 'codex';
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
        const folderDirectory = normalizeDirectory(
          session.directory || sandbox.directory || defaultDirectory,
        );
        const folderSessions = globalFolders.get(folderDirectory) ?? [];
        folderSessions.push(buildTopPanelSession(project.id, session, pinnedStore));
        globalFolders.set(folderDirectory, folderSessions);
        continue;
      }

      const repoPinnedAt = normalizePinnedAt(pinnedStore[repoPinKey(project.id, repoRoot)]);
      const repo = repos.get(repoRoot) ?? {
        root: repoRoot,
        name: basenameForDisplay(repoRoot, globalSandboxName),
        pinnedAt: repoPinnedAt,
        isPinned: repoPinnedAt > 0,
        branches: new Map<string, BranchEntry>(),
      };
      const branchName = session.gitInfo?.branch?.trim() || 'detached';
      const branchDirectory = worktreeRoot || repoRoot;
      const branchPinnedAt = normalizePinnedAt(
        pinnedStore[sandboxPinKey(project.id, branchDirectory)],
      );
      const branch = repo.branches.get(branchDirectory) ?? {
        branch: branchName,
        directory: branchDirectory,
        pinScope: { level: 'branch', directory: branchDirectory, repoRoot },
        pinnedAt: branchPinnedAt,
        isPinned: branchPinnedAt > 0,
        sessions: [],
      };
      branch.sessions.push(buildTopPanelSession(project.id, session, pinnedStore));
      repo.branches.set(branchDirectory, branch);
      repos.set(repoRoot, repo);
    }
  }

  const projectColor = options.resolveProjectColor?.(project.icon?.color);
  const worktrees: CodexTopPanelWorktree[] = [];
  if (globalFolders.size > 0) {
    const globalSandboxes = Array.from(globalFolders.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, sessions]) =>
        createTopPanelSandboxEntry({
          key: `${keyPrefix}:global-folder:${directory}`,
          directory,
          branch: basenameForDisplay(directory, globalSandboxName),
          kind: 'folder',
          sessions,
          pinnedAt: 0,
          isPinned: false,
          isImplicitlyPinned: false,
        }),
      );
    worktrees.push({
      key: `${keyPrefix}:global`,
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
      pinnedAt: 0,
      isPinned: false,
    });
  }

  Array.from(repos.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((repo) => {
      const branchSandboxes = Array.from(repo.branches.values())
        .sort((left, right) => left.branch.localeCompare(right.branch))
        .map((branch) =>
          createTopPanelSandboxEntry({
            key: `${keyPrefix}:branch:${repo.root}:${branch.directory}`,
            directory: branch.directory,
            pinScope: branch.pinScope,
            branch: branch.branch,
            kind: 'branch',
            sessions: branch.sessions,
            pinnedAt: branch.pinnedAt,
            isPinned: branch.isPinned,
            isImplicitlyPinned: false,
          }),
        );
      worktrees.push({
        key: `${keyPrefix}:repo:${repo.root}`,
        directory: repo.root,
        pinScope: { level: 'repo', root: repo.root },
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
        .filter(
          (session) => !session.archivedAt && (session.isPinned || session.isImplicitlyPinned),
        )
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
        pinScope: sandbox.pinScope,
        projectId: worktree.projectId ?? '',
        name:
          sandbox.branch ||
          basenameForDisplay(sandbox.directory, CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME),
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
      pinScope: worktree.pinScope,
      kind: worktree.kind,
      name:
        worktree.name ||
        worktree.label ||
        basenameForDisplay(worktree.directory, CODEX_TOP_PANEL_GLOBAL_SANDBOX_NAME),
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
