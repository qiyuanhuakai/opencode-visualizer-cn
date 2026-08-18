import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import type { DirectorySessionHydration } from '../types/sse-worker';
import { normalizeMetadataPath } from './path';

export type LocalPinnedSessionStore = Record<string, number>;

export type ReconcilePinnedSessionMetadata = {
  gitInfoByDirectory?: Readonly<Record<string, NonNullable<SessionState['gitInfo']>>>;
  homePath?: string;
};

const PIN_HIERARCHY_MIGRATION_PREFIX = 'migration:pin-hierarchy:v1:';

export function isSamePinnedSessionStore(a: LocalPinnedSessionStore, b: LocalPinnedSessionStore) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

export function normalizePinnedAt(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parsePinnedSessionStore(raw: string | null, limit: number): LocalPinnedSessionStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const normalized: LocalPinnedSessionStore = {};
    Object.entries(record).forEach(([key, value]) => {
      if (!key || typeof key !== 'string') return;
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return;
      normalized[key] = value;
    });
    return limitPinnedSessionStore(normalized, limit);
  } catch {
    return {};
  }
}

export function limitPinnedSessionStore(
  store: LocalPinnedSessionStore,
  limit: number,
): LocalPinnedSessionStore {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const positiveEntries = Object.entries(store)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, normalizedLimit);
  const negativeEntries = Object.entries(store)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value < 0)
    .sort((a, b) => a[1] - b[1]);
  return Object.fromEntries([...positiveEntries, ...negativeEntries]);
}

export function pinnedSessionStoreKey(projectId: string, sessionId: string) {
  const pid = projectId.trim();
  const sid = sessionId.trim();
  if (!pid || !sid) return '';
  return `${pid}:${sid}`;
}

export function projectPinKey(projectId: string) {
  const pid = projectId.trim();
  if (!pid) return '';
  return `project:${pid}`;
}

export function repoPinKey(projectId: string, root: string) {
  const pid = projectId.trim();
  const repoRoot = root.trim();
  if (!pid || !repoRoot) return '';
  return `repo:${pid}:${repoRoot}`;
}

export function sandboxPinKey(projectId: string, directory: string) {
  const pid = projectId.trim();
  const dir = directory.trim();
  if (!pid || !dir) return '';
  return `sandbox:${pid}:${dir}`;
}

export function isProjectPinned(store: LocalPinnedSessionStore, projectId: string): boolean {
  const key = projectPinKey(projectId);
  if (!key) return false;
  return normalizePinnedAt(store[key]) > 0;
}

export function isSandboxPinned(
  store: LocalPinnedSessionStore,
  projectId: string,
  directory: string,
): boolean {
  const key = sandboxPinKey(projectId, directory);
  if (!key) return false;
  return normalizePinnedAt(store[key]) > 0;
}

export function isSessionEffectivelyPinned(
  store: LocalPinnedSessionStore,
  projectId: string,
  sessionId: string,
  _directory: string,
  serverPinnedAt?: number,
): boolean {
  const key = pinnedSessionStoreKey(projectId, sessionId);
  if (!key) return false;
  const localOverride = store[key];
  if (typeof localOverride === 'number' && Number.isFinite(localOverride) && localOverride !== 0) {
    return normalizePinnedAt(localOverride) > 0;
  }
  return normalizePinnedAt(serverPinnedAt) > 0;
}

export function getEffectivePinnedAt(serverPinnedAt: number | undefined, localOverride?: number) {
  if (typeof localOverride === 'number' && Number.isFinite(localOverride) && localOverride !== 0) {
    return normalizePinnedAt(localOverride);
  }
  return normalizePinnedAt(serverPinnedAt);
}

export function reconcilePinnedSessionStore(
  currentStore: LocalPinnedSessionStore,
  projects: Record<string, ProjectState>,
  limit: number,
  sessionHydrationByDirectory?: Readonly<Record<string, DirectorySessionHydration>>,
  metadata?: ReconcilePinnedSessionMetadata,
): LocalPinnedSessionStore {
  if (Object.keys(currentStore).length === 0) return currentStore;

  const nextStore: LocalPinnedSessionStore = { ...limitPinnedSessionStore(currentStore, limit) };
  const activeSessionKeys = new Set<string>();
  const incompleteProjectIds = new Set<string>();

  if (sessionHydrationByDirectory) {
    for (const project of Object.values(projects)) {
      const directories = new Set(
        [project.worktree, ...Object.values(project.sandboxes).map((sandbox) => sandbox.directory)]
          .map((directory) => directory.trim())
          .filter(Boolean),
      );
      if (
        directories.size === 0
        || Array.from(directories).some(
          (directory) => sessionHydrationByDirectory[directory]?.status !== 'loaded',
        )
      ) {
        incompleteProjectIds.add(project.id);
      }
    }
  }

  for (const project of Object.values(projects)) {
    const projectKey = projectPinKey(project.id);
    const projectPinnedAt = normalizePinnedAt(nextStore[projectKey]);
    const descendants = (Object.values(project.sandboxes) as SandboxState[]).map((sandbox) => ({
      sandboxKey: sandboxPinKey(project.id, sandbox.directory),
      sessionKeys: Object.values(sandbox.sessions)
        .filter((session) => !session.parentID && !session.timeArchived)
        .map((session) => pinnedSessionStoreKey(project.id, session.id))
        .filter(Boolean),
    }));
    const migrationKey = `${PIN_HIERARCHY_MIGRATION_PREFIX}${project.id}`;
    const hasPositiveParent = projectPinnedAt > 0 || descendants.some(
      ({ sandboxKey }) => normalizePinnedAt(nextStore[sandboxKey]) > 0,
    );
    if (
      nextStore[migrationKey] !== -1
      && hasPositiveParent
      && !incompleteProjectIds.has(project.id)
    ) {
      for (const { sandboxKey, sessionKeys } of descendants) {
        const sandboxOverride = nextStore[sandboxKey];
        const hasSandboxOverride = typeof sandboxOverride === 'number' && sandboxOverride !== 0;
        if (!hasSandboxOverride && projectPinnedAt > 0) {
          nextStore[sandboxKey] = projectPinnedAt;
        }
        const inheritedPinnedAt = hasSandboxOverride
          ? normalizePinnedAt(sandboxOverride)
          : projectPinnedAt;
        if (inheritedPinnedAt === 0) continue;
        for (const sessionKey of sessionKeys) {
          if (typeof nextStore[sessionKey] !== 'number') {
            nextStore[sessionKey] = inheritedPinnedAt;
          }
        }
      }
      nextStore[migrationKey] = -1;
    }

    for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
      for (const session of Object.values(sandbox.sessions)) {
        const key = pinnedSessionStoreKey(project.id, session.id);
        if (!key) continue;
        activeSessionKeys.add(key);

        if (Boolean(session.timeArchived) || Boolean(session.parentID)) {
          delete nextStore[key];
          continue;
        }

        const localOverride = nextStore[key];
        if (typeof localOverride !== 'number' || !Number.isFinite(localOverride) || localOverride === 0) {
          continue;
        }

        const localPinnedAt = normalizePinnedAt(localOverride);
        const serverPinnedAt = normalizePinnedAt(session.timePinned);
        const directory = session.directory || sandbox.directory;
        const normalizedDirectory = normalizeMetadataPath(directory, metadata?.homePath ?? '');
        const gitInfo = session.gitInfo
          ?? metadata?.gitInfoByDirectory?.[directory]
          ?? metadata?.gitInfoByDirectory?.[normalizedDirectory]
          ?? metadata?.gitInfoByDirectory?.[sandbox.directory];
        const repoRoot = normalizeMetadataPath(
          gitInfo?.commonRoot || gitInfo?.root || '',
          metadata?.homePath ?? '',
        );
        const worktreeRoot = normalizeMetadataPath(
          gitInfo?.worktreeRoot || gitInfo?.root || sandbox.directory,
          metadata?.homePath ?? '',
        );
        const normalizedSandboxDirectory = normalizeMetadataPath(
          sandbox.directory,
          metadata?.homePath ?? '',
        );
        const hierarchyParentKeys = [
          projectPinKey(project.id),
          sandboxPinKey(project.id, sandbox.directory),
          sandboxPinKey(project.id, normalizedSandboxDirectory),
          repoRoot ? repoPinKey(project.id, repoRoot) : '',
          worktreeRoot ? sandboxPinKey(project.id, worktreeRoot) : '',
        ].filter(Boolean);
        const belongsToPersistedHierarchy = hierarchyParentKeys.some(
          (parentKey) => normalizePinnedAt(nextStore[parentKey]) > 0,
        );
        const repoPrefix = `repo:${project.id}:`;
        const sandboxPrefix = `sandbox:${project.id}:`;
        const hierarchyMetadataPending =
          metadata !== undefined &&
          !gitInfo &&
          Object.entries(nextStore).some(
            ([parentKey, pinnedAt]) =>
              normalizePinnedAt(pinnedAt) > 0 &&
              (parentKey.startsWith(repoPrefix) ||
                (parentKey.startsWith(sandboxPrefix) &&
                  !hierarchyParentKeys.includes(parentKey))),
          );
        if (
          localPinnedAt === serverPinnedAt &&
          !belongsToPersistedHierarchy &&
          !hierarchyMetadataPending
        ) {
          delete nextStore[key];
        }
      }
    }
  }

  const incompleteProjectSessionPrefixes = Array.from(
    incompleteProjectIds,
    (projectId) => `${projectId}:`,
  );
  Object.keys(nextStore).forEach((key) => {
    if (
      key.startsWith('project:')
      || key.startsWith('repo:')
      || key.startsWith('sandbox:')
      || key.startsWith(PIN_HIERARCHY_MIGRATION_PREFIX)
    ) {
      return;
    }
    if (incompleteProjectSessionPrefixes.some((prefix) => key.startsWith(prefix))) return;
    if (!activeSessionKeys.has(key)) {
      delete nextStore[key];
    }
  });

  return nextStore;
}
