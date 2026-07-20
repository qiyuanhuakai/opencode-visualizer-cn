import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import type { LocalPinnedSessionStore } from './pinnedSessions';
import {
  normalizePinnedAt,
  pinnedSessionStoreKey,
  projectPinKey,
  repoPinKey,
  sandboxPinKey,
} from './pinnedSessions';
import { normalizeMetadataPath } from './path';

export type PinHierarchy = {
  projectKey: string;
  branches: Array<{
    key: string;
    sessionKeys: string[];
    serverPinnedBySession?: Record<string, boolean>;
  }>;
};

export type PinHierarchyTarget =
  | { level: 'project' }
  | { level: 'branch'; key: string }
  | { level: 'session'; key: string };

export function buildPinHierarchy(
  project: ProjectState,
  repoRoot?: string,
  gitInfoByDirectory: Record<string, NonNullable<SessionState['gitInfo']>> = {},
  homePath = '',
): PinHierarchy | null {
  const normalizedRepoRoot = repoRoot ? normalizeMetadataPath(repoRoot, homePath) : '';
  const projectKey = normalizedRepoRoot
    ? repoPinKey(project.id, normalizedRepoRoot)
    : projectPinKey(project.id);
  if (!projectKey) return null;

  if (!normalizedRepoRoot) {
    return {
      projectKey,
      branches: (Object.values(project.sandboxes) as SandboxState[])
        .map((sandbox) => {
          const sessions = Object.values(sandbox.sessions)
            .filter((session) => !session.parentID && !session.timeArchived)
            .map((session) => ({
              key: pinnedSessionStoreKey(project.id, session.id),
              serverPinned: normalizePinnedAt(session.timePinned) > 0,
            }))
            .filter((session) => Boolean(session.key));
          return {
            key: sandboxPinKey(project.id, sandbox.directory),
            sessionKeys: sessions.map((session) => session.key),
            serverPinnedBySession: Object.fromEntries(
              sessions.map((session) => [session.key, session.serverPinned]),
            ),
          };
        })
        .filter((branch) => Boolean(branch.key)),
    };
  }

  const branches = new Map<string, {
    sessionKeys: Set<string>;
    serverPinnedBySession: Record<string, boolean>;
  }>();
  for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
    for (const session of Object.values(sandbox.sessions)) {
      if (session.parentID || session.timeArchived) continue;
      const directory = session.directory || sandbox.directory;
      const normalizedDirectory = normalizeMetadataPath(directory, homePath);
      const gitInfo = session.gitInfo
        ?? gitInfoByDirectory[directory]
        ?? gitInfoByDirectory[normalizedDirectory]
        ?? gitInfoByDirectory[sandbox.directory];
      const sessionRepoRoot = normalizeMetadataPath(gitInfo?.commonRoot || gitInfo?.root || '', homePath);
      if (sessionRepoRoot !== normalizedRepoRoot) continue;
      const branchDirectory = normalizeMetadataPath(
        gitInfo?.worktreeRoot || gitInfo?.root || sandbox.directory,
        homePath,
      );
      const branchKey = sandboxPinKey(project.id, branchDirectory);
      const sessionKey = pinnedSessionStoreKey(project.id, session.id);
      if (!branchKey || !sessionKey) continue;
      const branch = branches.get(branchKey) ?? {
        sessionKeys: new Set<string>(),
        serverPinnedBySession: {},
      };
      branch.sessionKeys.add(sessionKey);
      branch.serverPinnedBySession[sessionKey] = normalizePinnedAt(session.timePinned) > 0;
      branches.set(branchKey, branch);
    }
  }

  return {
    projectKey,
    branches: Array.from(branches, ([key, branch]) => ({
      key,
      sessionKeys: Array.from(branch.sessionKeys),
      serverPinnedBySession: branch.serverPinnedBySession,
    })),
  };
}

function stateOf(store: LocalPinnedSessionStore, key: string, fallback?: boolean) {
  const value = store[key];
  return typeof value === 'number' && value !== 0 ? value > 0 : fallback;
}

function write(store: LocalPinnedSessionStore, key: string, pinned: boolean, timestamp: number) {
  store[key] = pinned ? timestamp : -timestamp;
}

function branchState(
  store: LocalPinnedSessionStore,
  branch: PinHierarchy['branches'][number],
) {
  const directState = stateOf(store, branch.key);
  if (directState !== undefined) return directState;
  const sessionStates = branch.sessionKeys.map((sessionKey) => stateOf(
    store,
    sessionKey,
    branch.serverPinnedBySession?.[sessionKey],
  ));
  if (sessionStates.length > 0 && sessionStates.every((state) => state === true)) return true;
  if (sessionStates.length > 0 && sessionStates.every((state) => state === false)) return false;
  return undefined;
}

function reconcileProject(store: LocalPinnedSessionStore, hierarchy: PinHierarchy, timestamp: number) {
  const states = hierarchy.branches.map((branch) => branchState(store, branch));
  if (states.length > 0 && states.every((state) => state === true)) {
    write(store, hierarchy.projectKey, true, timestamp);
  } else if (states.length > 0 && states.every((state) => state === false)) {
    write(store, hierarchy.projectKey, false, timestamp);
  }
}

export function applyPinHierarchyTransition(
  store: LocalPinnedSessionStore,
  hierarchy: PinHierarchy,
  target: PinHierarchyTarget,
  pinned: boolean,
  timestamp: number,
): LocalPinnedSessionStore {
  const next = { ...store };
  if (target.level === 'project') {
    write(next, hierarchy.projectKey, pinned, timestamp);
    for (const branch of hierarchy.branches) {
      write(next, branch.key, pinned, timestamp);
      for (const sessionKey of branch.sessionKeys) write(next, sessionKey, pinned, timestamp);
    }
    return next;
  }

  const branch = target.level === 'branch'
    ? hierarchy.branches.find((item) => item.key === target.key)
    : hierarchy.branches.find((item) => item.sessionKeys.includes(target.key));
  if (!branch) return next;

  if (target.level === 'branch') {
    write(next, branch.key, pinned, timestamp);
    for (const sessionKey of branch.sessionKeys) write(next, sessionKey, pinned, timestamp);
    reconcileProject(next, hierarchy, timestamp);
    return next;
  }

  write(next, target.key, pinned, timestamp);
  const sessionStates = branch.sessionKeys.map((sessionKey) => stateOf(
    next,
    sessionKey,
    branch.serverPinnedBySession?.[sessionKey],
  ));
  if (sessionStates.length > 0 && sessionStates.every((state) => state === true)) {
    write(next, branch.key, true, timestamp);
  } else if (sessionStates.length > 0 && sessionStates.every((state) => state === false)) {
    write(next, branch.key, false, timestamp);
  }
  reconcileProject(next, hierarchy, timestamp);
  return next;
}
