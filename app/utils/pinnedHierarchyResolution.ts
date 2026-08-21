import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import { normalizeMetadataPath } from './path';
import {
  type LocalPinnedSessionStore,
  normalizePinnedAt,
  projectPinKey,
  repoPinKey,
  sandboxPinKey,
} from './pinnedSessions';

export type HierarchyMetadataAuthority =
  | { kind: 'untracked' }
  | {
      kind: 'tracked';
      gitInfoByDirectory: Readonly<Record<string, NonNullable<SessionState['gitInfo']>>>;
      homePath: string;
    };

type TrackedHierarchyMetadata = Extract<HierarchyMetadataAuthority, { kind: 'tracked' }>;

type SessionHierarchyLocation = {
  project: ProjectState;
  sandbox: SandboxState;
  session: SessionState;
};

type SessionDirectoryIdentity = {
  directory: string;
  normalizedDirectory: string;
};

type SessionHierarchyContext = {
  projectId: string;
  directory: string;
  gitInfo?: NonNullable<SessionState['gitInfo']>;
  parentKeys: string[];
};

function readGitInfo(
  gitInfoByDirectory: TrackedHierarchyMetadata['gitInfoByDirectory'],
  directory: string,
): NonNullable<SessionState['gitInfo']> | undefined {
  if (!directory || !Object.hasOwn(gitInfoByDirectory, directory)) return undefined;
  return gitInfoByDirectory[directory];
}

function readSandboxGitInfo(
  sandbox: SandboxState,
): NonNullable<SessionState['gitInfo']> | undefined {
  for (const candidate of Object.values(sandbox.sessions)) {
    if (candidate.gitInfo) return candidate.gitInfo;
  }
  return undefined;
}

function resolveTrackedGitInfo(
  location: SessionHierarchyLocation,
  identity: SessionDirectoryIdentity,
  hierarchy: TrackedHierarchyMetadata,
): NonNullable<SessionState['gitInfo']> | undefined {
  const { session, sandbox } = location;
  return (
    session.gitInfo ??
    readGitInfo(hierarchy.gitInfoByDirectory, identity.directory) ??
    readGitInfo(hierarchy.gitInfoByDirectory, identity.normalizedDirectory) ??
    readGitInfo(hierarchy.gitInfoByDirectory, sandbox.directory) ??
    readSandboxGitInfo(sandbox)
  );
}

function repoRootSource(gitInfo?: NonNullable<SessionState['gitInfo']>): string {
  if (!gitInfo) return '';
  return gitInfo.commonRoot || gitInfo.root || '';
}

function worktreeRootSource(
  gitInfo: NonNullable<SessionState['gitInfo']> | undefined,
  sandboxDirectory: string,
): string {
  if (!gitInfo) return sandboxDirectory;
  return gitInfo.worktreeRoot || gitInfo.root || sandboxDirectory;
}

function resolveTrackedContext(
  location: SessionHierarchyLocation,
  hierarchy: TrackedHierarchyMetadata,
): SessionHierarchyContext {
  const { project, sandbox, session } = location;
  const directory = session.directory || sandbox.directory;
  const normalizedDirectory = normalizeMetadataPath(directory, hierarchy.homePath);
  const normalizedSandbox = normalizeMetadataPath(sandbox.directory, hierarchy.homePath);
  const gitInfo = resolveTrackedGitInfo(location, { directory, normalizedDirectory }, hierarchy);
  const repoRoot = normalizeMetadataPath(repoRootSource(gitInfo), hierarchy.homePath);
  const worktreeRoot = normalizeMetadataPath(
    worktreeRootSource(gitInfo, sandbox.directory),
    hierarchy.homePath,
  );
  return {
    projectId: project.id,
    directory: normalizedDirectory,
    gitInfo,
    parentKeys: [
      projectPinKey(project.id),
      sandboxPinKey(project.id, sandbox.directory),
      sandboxPinKey(project.id, normalizedSandbox),
      repoRoot ? repoPinKey(project.id, repoRoot) : '',
      worktreeRoot ? sandboxPinKey(project.id, worktreeRoot) : '',
    ].filter(Boolean),
  };
}

function resolveHierarchyContext(
  location: SessionHierarchyLocation,
  hierarchy: HierarchyMetadataAuthority,
): SessionHierarchyContext {
  if (hierarchy.kind === 'tracked') {
    return resolveTrackedContext(location, hierarchy);
  }
  const { project, sandbox, session } = location;
  return {
    projectId: project.id,
    directory: session.directory || sandbox.directory,
    parentKeys: [projectPinKey(project.id), sandboxPinKey(project.id, sandbox.directory)],
  };
}

function isPathAtOrWithin(path: string, root: string): boolean {
  if (!path || !root) return false;
  if (path === root) return true;
  if (root === '/') return path.startsWith('/');
  return path.startsWith(`${root}/`);
}

function hierarchyMetadataPending(
  store: LocalPinnedSessionStore,
  context: SessionHierarchyContext,
  hierarchy: HierarchyMetadataAuthority,
): boolean {
  if (hierarchy.kind === 'untracked' || context.gitInfo) return false;
  const repoPrefix = `repo:${context.projectId}:`;
  const sandboxPrefix = `sandbox:${context.projectId}:`;
  return Object.entries(store).some(([parentKey, pinnedAt]) => {
    if (normalizePinnedAt(pinnedAt) <= 0 || context.parentKeys.includes(parentKey)) return false;
    if (parentKey.startsWith(repoPrefix)) {
      const repoRoot = normalizeMetadataPath(
        parentKey.slice(repoPrefix.length),
        hierarchy.homePath,
      );
      return isPathAtOrWithin(context.directory, repoRoot);
    }
    if (!parentKey.startsWith(sandboxPrefix)) return false;
    const sandboxDirectory = normalizeMetadataPath(
      parentKey.slice(sandboxPrefix.length),
      hierarchy.homePath,
    );
    return sandboxDirectory === context.directory;
  });
}

export type PersistedHierarchyRelation = 'member' | 'pending-metadata' | 'none';

export function resolvePersistedHierarchyRelation(input: {
  store: LocalPinnedSessionStore;
  project: ProjectState;
  sandbox: SandboxState;
  session: SessionState;
  hierarchy: HierarchyMetadataAuthority;
}): PersistedHierarchyRelation {
  const { store, project, sandbox, session, hierarchy } = input;
  const context = resolveHierarchyContext({ project, sandbox, session }, hierarchy);
  if (context.parentKeys.some((key) => normalizePinnedAt(store[key]) > 0)) return 'member';
  if (hierarchyMetadataPending(store, context, hierarchy)) return 'pending-metadata';
  return 'none';
}
