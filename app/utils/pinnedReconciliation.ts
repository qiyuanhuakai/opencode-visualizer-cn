import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import type { DirectorySessionHydration } from '../types/sse-worker';
import {
  type HierarchyMetadataAuthority,
  resolvePersistedHierarchyRelation,
} from './pinnedHierarchyResolution';
import {
  type LocalPinnedSessionStore,
  limitPinnedSessionStore,
  normalizePinnedAt,
  pinnedSessionStoreKey,
  projectPinKey,
  sandboxPinKey,
} from './pinnedSessions';

export type { HierarchyMetadataAuthority } from './pinnedHierarchyResolution';

const PIN_HIERARCHY_MIGRATION_PREFIX = 'migration:pin-hierarchy:v1:';

/**
 * How the session inventory is known. OpenCode reports per-directory hydration
 * status; other backends are assumed complete once their project tree arrives.
 */
export type SessionInventoryAuthority =
  | {
      kind: 'directory-hydration';
      byDirectory: Readonly<Record<string, DirectorySessionHydration>>;
    }
  | { kind: 'assume-complete' };

export type ReconcileInput = {
  store: LocalPinnedSessionStore;
  projects: Record<string, ProjectState>;
  limit: number;
  inventory: SessionInventoryAuthority;
  hierarchy: HierarchyMetadataAuthority;
};

export function forEachProjectSession(
  projects: Record<string, ProjectState>,
  visit: (project: ProjectState, sandbox: SandboxState, session: SessionState) => void,
): void {
  for (const project of Object.values(projects)) {
    for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
      for (const session of Object.values(sandbox.sessions)) {
        visit(project, sandbox, session);
      }
    }
  }
}

function projectIsIncomplete(project: ProjectState, inventory: SessionInventoryAuthority): boolean {
  if (inventory.kind === 'assume-complete') return false;
  const directories = new Set(
    [project.worktree, ...Object.values(project.sandboxes).map((sandbox) => sandbox.directory)]
      .map((directory) => directory.trim())
      .filter(Boolean),
  );
  if (directories.size === 0) return true;
  return Array.from(directories).some(
    (directory) => inventory.byDirectory[directory]?.status !== 'loaded',
  );
}

type LegacyHierarchyDescendant = {
  sandboxKey: string;
  sessionKeys: string[];
};

function collectLegacyHierarchyDescendants(project: ProjectState): LegacyHierarchyDescendant[] {
  return Object.values(project.sandboxes).map((sandbox) => ({
    sandboxKey: sandboxPinKey(project.id, sandbox.directory),
    sessionKeys: Object.values(sandbox.sessions)
      .filter((session) => !session.parentID && !session.timeArchived)
      .map((session) => pinnedSessionStoreKey(project.id, session.id))
      .filter(Boolean),
  }));
}

function inheritLegacyHierarchyDescendant(
  store: LocalPinnedSessionStore,
  descendant: LegacyHierarchyDescendant,
  projectPinnedAt: number,
): void {
  const sandboxOverride = store[descendant.sandboxKey];
  const hasSandboxOverride = typeof sandboxOverride === 'number' && sandboxOverride !== 0;
  if (!hasSandboxOverride && projectPinnedAt > 0) {
    store[descendant.sandboxKey] = projectPinnedAt;
  }
  const inheritedPinnedAt = hasSandboxOverride
    ? normalizePinnedAt(sandboxOverride)
    : projectPinnedAt;
  if (inheritedPinnedAt === 0) return;
  for (const sessionKey of descendant.sessionKeys) {
    if (typeof store[sessionKey] !== 'number') store[sessionKey] = inheritedPinnedAt;
  }
}

function expandHierarchy(
  nextStore: LocalPinnedSessionStore,
  project: ProjectState,
  incompleteProjectIds: Set<string>,
): void {
  if (incompleteProjectIds.has(project.id)) return;
  const projectKey = projectPinKey(project.id);
  const projectPinnedAt = normalizePinnedAt(nextStore[projectKey]);
  const migrationKey = `${PIN_HIERARCHY_MIGRATION_PREFIX}${project.id}`;
  if (nextStore[migrationKey] === -1) return;
  const descendants = collectLegacyHierarchyDescendants(project);
  const hasPositiveParent =
    projectPinnedAt > 0 ||
    descendants.some(({ sandboxKey }) => normalizePinnedAt(nextStore[sandboxKey]) > 0);
  if (!hasPositiveParent) return;
  for (const descendant of descendants) {
    inheritLegacyHierarchyDescendant(nextStore, descendant, projectPinnedAt);
  }
  nextStore[migrationKey] = -1;
}

function shouldConvergeOverride(
  localOverride: number,
  serverTimePinned: number | undefined,
): boolean {
  if (serverTimePinned === undefined) return false;
  if (localOverride > 0) return true;
  return serverTimePinned === 0;
}

function pruneStale(
  nextStore: LocalPinnedSessionStore,
  activeSessionKeys: Set<string>,
  incompleteProjectIds: Set<string>,
): void {
  const incompleteProjectSessionPrefixes = Array.from(
    incompleteProjectIds,
    (projectId) => `${projectId}:`,
  );
  Object.keys(nextStore).forEach((key) => {
    if (
      key.startsWith('project:') ||
      key.startsWith('repo:') ||
      key.startsWith('sandbox:') ||
      key.startsWith(PIN_HIERARCHY_MIGRATION_PREFIX)
    ) {
      return;
    }
    if (incompleteProjectSessionPrefixes.some((prefix) => key.startsWith(prefix))) return;
    if (!activeSessionKeys.has(key)) {
      delete nextStore[key];
    }
  });
}

export function reconcilePinnedSessionStore(input: ReconcileInput): LocalPinnedSessionStore {
  const { store, projects, limit, inventory, hierarchy } = input;
  if (Object.keys(store).length === 0) return store;

  const nextStore: LocalPinnedSessionStore = { ...limitPinnedSessionStore(store, limit) };
  const activeSessionKeys = new Set<string>();
  const incompleteProjectIds = new Set<string>();

  for (const project of Object.values(projects)) {
    if (projectIsIncomplete(project, inventory)) {
      incompleteProjectIds.add(project.id);
    }
  }

  for (const project of Object.values(projects)) {
    expandHierarchy(nextStore, project, incompleteProjectIds);
  }

  forEachProjectSession(projects, (project, sandbox, session) => {
    const key = pinnedSessionStoreKey(project.id, session.id);
    if (!key) return;
    activeSessionKeys.add(key);

    if (Boolean(session.timeArchived) || Boolean(session.parentID)) {
      delete nextStore[key];
      return;
    }

    const localOverride = nextStore[key];
    if (
      typeof localOverride !== 'number' ||
      !Number.isFinite(localOverride) ||
      localOverride === 0
    ) {
      return;
    }

    if (!shouldConvergeOverride(localOverride, session.timePinned)) return;

    const relation = resolvePersistedHierarchyRelation({
      store: nextStore,
      project,
      sandbox,
      session,
      hierarchy,
    });
    if (relation === 'none') {
      delete nextStore[key];
    }
  });

  pruneStale(nextStore, activeSessionKeys, incompleteProjectIds);
  return nextStore;
}
