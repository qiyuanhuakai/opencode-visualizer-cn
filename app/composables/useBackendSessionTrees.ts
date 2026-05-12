import { computed, shallowRef, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { TopPanelWorktree } from '../types/top-panel';
import type { SessionTreeData, SessionTreeProject, SessionTreeSandbox, SessionTreeSession } from '../types/session-tree';
import type { ProjectState, SandboxState } from '../types/worker-state';
import { buildCodexSessionTreeData, buildCodexTopPanelTreeData } from '../utils/codexTopPanelTree';
import { isSandboxMarkedDeleted, type DeletedSandboxStore } from '../utils/deletedSandboxes';
import {
  normalizePinnedAt,
  pinnedSessionStoreKey,
  projectPinKey,
  sandboxPinKey,
  type LocalPinnedSessionStore,
} from '../utils/pinnedSessions';

const TREE_DATA_CACHE_TTL_MS = 15000;
const NAVIGABLE_MAX_SESSIONS = 5;

function mixStringIntoHash(hash: number, str: string): number {
  let nextHash = hash;
  for (let index = 0; index < str.length; index += 1) {
    nextHash = ((nextHash << 5) - nextHash + str.charCodeAt(index)) | 0;
  }
  return nextHash;
}

function computeProjectsHash(
  projects: Record<string, ProjectState>,
  pinnedStore: LocalPinnedSessionStore,
  deletedStore: DeletedSandboxStore,
): string {
  let hash = 0;
  const projectEntries = Object.entries(projects);
  for (const [id, project] of projectEntries) {
    hash ^= id.length + Object.keys(project.sandboxes).length;
    hash = mixStringIntoHash(hash, project.name ?? '');
    for (const sandbox of (Object.values(project.sandboxes) as SandboxState[])) {
      hash += sandbox.rootSessions.length;
      hash = mixStringIntoHash(hash, sandbox.name);
      hash = mixStringIntoHash(hash, sandbox.directory);
      for (const sessionId of sandbox.rootSessions) {
        const session = sandbox.sessions[sessionId];
        if (!session) continue;
        hash += (session.timeUpdated ?? session.timeCreated ?? 0) & 0xffff;
        hash += (session.timePinned ?? 0) & 0xffff;
        hash = mixStringIntoHash(hash, session.gitInfo?.root ?? '');
        hash = mixStringIntoHash(hash, session.gitInfo?.branch ?? '');
      }
    }
  }

  const pinnedEntries = Object.entries(pinnedStore).sort(([left], [right]) => left.localeCompare(right));
  const pinnedHash = pinnedEntries.map(([key, value]) => `${key}:${value}`).join('|');
  const deletedEntries = Object.entries(deletedStore)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([projectId, directories]) => `${projectId}:${directories.slice().sort().join(',')}`);
  return `${hash}-${projectEntries.length}-${pinnedHash}-${deletedEntries.join('|')}`;
}

function buildOpenCodeTopPanelTreeData(params: {
  projects: Record<string, ProjectState>;
  pinnedStore: LocalPinnedSessionStore;
  deletedSandboxStore: DeletedSandboxStore;
  replaceHomePrefix: (path: string) => string;
  resolveProjectColor: (color?: string) => string | undefined;
}): TopPanelWorktree[] {
  const { projects, pinnedStore, deletedSandboxStore, replaceHomePrefix, resolveProjectColor } = params;
  return Object.values(projects)
    .map((project) => {
      const worktreeDirectory = project.worktree;
      const sandboxes = (Object.values(project.sandboxes) as SandboxState[])
        .filter(
          (sandbox) =>
            sandbox.directory === worktreeDirectory
            || !isSandboxMarkedDeleted(deletedSandboxStore, project.id, sandbox.directory),
        )
        .map((sandbox) => {
          const projectPinnedAt = normalizePinnedAt(pinnedStore[projectPinKey(project.id)]);
          const sandboxLocalValue = pinnedStore[sandboxPinKey(project.id, sandbox.directory)];
          const sandboxPinnedAt = normalizePinnedAt(sandboxLocalValue);
          const isSandboxDirectlyPinned = sandboxPinnedAt > 0;
          const isSandboxExplicitlyUnpinned = typeof sandboxLocalValue === 'number' && sandboxLocalValue < 0;
          const isSandboxPinned = isSandboxDirectlyPinned || (projectPinnedAt > 0 && !isSandboxExplicitlyUnpinned);
          const sandboxEffectivePinnedAt = isSandboxPinned
            ? (isSandboxDirectlyPinned ? sandboxPinnedAt : projectPinnedAt)
            : 0;
          const sessions = sandbox.rootSessions
            .map((sessionId) => sandbox.sessions[sessionId])
            .filter((session): session is NonNullable<typeof session> => Boolean(session))
            .map((session) => {
              const sessionLocalValue = pinnedStore[pinnedSessionStoreKey(project.id, session.id)];
              const sessionLocalPinnedAt = normalizePinnedAt(sessionLocalValue);
              const sessionServerPinnedAt = normalizePinnedAt(session.timePinned);
              const isSessionDirectlyPinned = sessionLocalPinnedAt > 0 || sessionServerPinnedAt > 0;
              const isSessionExplicitlyUnpinned = typeof sessionLocalValue === 'number' && sessionLocalValue < 0;
              const isSessionImplicitlyPinned = !isSessionDirectlyPinned && !isSessionExplicitlyUnpinned && isSandboxPinned;
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
                  : (isSessionImplicitlyPinned ? sandboxEffectivePinnedAt : 0),
                isPinned: isSessionDirectlyPinned,
                isImplicitlyPinned: isSessionImplicitlyPinned,
              };
            })
            .sort((left, right) => {
              const pinDiff = (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0);
              if (pinDiff !== 0) return pinDiff;
              return (right.timeUpdated ?? right.timeCreated ?? 0) - (left.timeUpdated ?? left.timeCreated ?? 0);
            });
          const latestUpdated = sessions.reduce(
            (max, session) => Math.max(max, session.timeUpdated ?? session.timeCreated ?? 0),
            0,
          );
          const oldestCreated = sessions.length > 0
            ? Math.min(...sessions.map((session) => session.timeCreated ?? Infinity))
            : 0;
          return {
            directory: sandbox.directory,
            branch: sandbox.name || undefined,
            sessions,
            latestUpdated,
            oldestCreated,
            pinnedAt: sandboxEffectivePinnedAt,
            isPinned: isSandboxDirectlyPinned,
            isImplicitlyPinned: isSandboxPinned && !isSandboxDirectlyPinned,
          };
        })
        .sort((left, right) => {
          const leftIsPrimary = left.directory === worktreeDirectory;
          const rightIsPrimary = right.directory === worktreeDirectory;
          if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
          return (right.oldestCreated || 0) - (left.oldestCreated || 0);
        });
      const latestUpdated = sandboxes
        .flatMap((sandbox) => sandbox.sessions)
        .reduce((max, session) => Math.max(max, session.timeUpdated ?? 0), 0);
      const name = project.name?.trim() || worktreeDirectory.replace(/\/+$/, '').split('/').pop() || undefined;
      const projectPinnedAt = normalizePinnedAt(pinnedStore[projectPinKey(project.id)]);
      return {
        directory: worktreeDirectory,
        label: replaceHomePrefix(worktreeDirectory),
        name,
        projectId: project.id,
        projectColor: resolveProjectColor(project.icon?.color),
        sandboxes,
        latestUpdated,
        pinnedAt: projectPinnedAt,
        isPinned: projectPinnedAt > 0,
      } satisfies TopPanelWorktree;
    })
    .sort((left, right) => {
      if (left.directory === '/' && right.directory !== '/') return 1;
      if (right.directory === '/' && left.directory !== '/') return -1;
      return (left.name || left.label).localeCompare(right.name || right.label);
    });
}

function buildOpenCodeSessionTreeData(params: {
  projects: Record<string, ProjectState>;
  pinnedStore: LocalPinnedSessionStore;
  resolveProjectColor: (color?: string) => string | undefined;
}): SessionTreeData {
  const { projects, pinnedStore, resolveProjectColor } = params;
  const result: SessionTreeProject[] = [];
  for (const project of Object.values(projects)) {
    const projectName = project.name?.trim() || project.worktree.replace(/\/+$/, '').split('/').pop() || project.id;
    const projectLocal = pinnedStore[projectPinKey(project.id)];
    const isProjectPinned = typeof projectLocal === 'number' && projectLocal > 0;
    const isProjectUnpinned = typeof projectLocal === 'number' && projectLocal < 0;
    if (isProjectUnpinned) continue;

    const sandboxes: SessionTreeSandbox[] = [];
    for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
      const sandboxLocal = pinnedStore[sandboxPinKey(project.id, sandbox.directory)];
      const isSandboxDirectlyPinned = typeof sandboxLocal === 'number' && sandboxLocal > 0;
      const isSandboxUnpinned = typeof sandboxLocal === 'number' && sandboxLocal < 0;
      const isSandboxPinned = isSandboxDirectlyPinned || isProjectPinned;
      if (isSandboxUnpinned) continue;

      const sessions: SessionTreeSession[] = [];
      for (const session of Object.values(sandbox.sessions)) {
        if (session.parentID || session.timeArchived) continue;
        const sessionLocal = pinnedStore[pinnedSessionStoreKey(project.id, session.id)];
        const isSessionDirectlyPinned = typeof sessionLocal === 'number' && sessionLocal > 0;
        const isSessionUnpinned = typeof sessionLocal === 'number' && sessionLocal < 0;
        if (isSessionUnpinned) continue;

        const serverPinnedAt = session.timePinned;
        const isSessionPinned = isSessionDirectlyPinned || normalizePinnedAt(serverPinnedAt) > 0;
        const isSessionInPinnedTree = isSessionPinned || isSandboxPinned || isProjectPinned;
        if (!isSessionInPinnedTree) continue;

        const isSessionImplicitlyPinned = isSessionInPinnedTree && !isSessionPinned;
        const pinnedAt = isSessionPinned
          ? (isSessionDirectlyPinned ? (sessionLocal as number) : normalizePinnedAt(serverPinnedAt))
          : isSandboxDirectlyPinned
            ? (sandboxLocal as number)
            : (projectLocal as number);
        sessions.push({
          type: 'session',
          sessionId: session.id,
          projectId: project.id,
          directory: sandbox.directory,
          title: session.title || session.slug || session.id,
          status: (session.status ?? 'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
          pinnedAt,
          isPinned: isSessionPinned,
          isImplicitlyPinned: isSessionImplicitlyPinned,
        });
      }

      if (sessions.length === 0 && !isSandboxPinned) continue;
      sessions.sort((left, right) => {
        if (right.pinnedAt !== left.pinnedAt) return right.pinnedAt - left.pinnedAt;
        return left.title.localeCompare(right.title);
      });
      const isSandboxImplicitlyPinned = isSandboxPinned && !isSandboxDirectlyPinned;
      sandboxes.push({
        type: 'sandbox',
        directory: sandbox.directory,
        projectId: project.id,
        name: sandbox.name || 'main',
        pinnedAt: isSandboxPinned ? (isSandboxDirectlyPinned ? (sandboxLocal as number) : (projectLocal as number)) : 0,
        isPinned: isSandboxPinned && !isSandboxImplicitlyPinned,
        isImplicitlyPinned: isSandboxImplicitlyPinned,
        sessions,
      });
    }

    if (sandboxes.length === 0 && !isProjectPinned) continue;
    sandboxes.sort((left, right) => {
      const leftIsPrimary = left.directory === project.worktree;
      const rightIsPrimary = right.directory === project.worktree;
      if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    result.push({
      type: 'project',
      projectId: project.id,
      name: projectName,
      color: resolveProjectColor(project.icon?.color),
      pinnedAt: typeof projectLocal === 'number' ? projectLocal : 0,
      isPinned: isProjectPinned,
      sandboxes,
    });
  }

  return result.sort((left, right) => {
    if (left.pinnedAt !== right.pinnedAt) return right.pinnedAt - left.pinnedAt;
    return left.name.localeCompare(right.name);
  });
}

export function useBackendSessionTrees(params: {
  activeBackendKind: Ref<BackendKind>;
  projects: Record<string, ProjectState>;
  pinnedStore: Ref<LocalPinnedSessionStore>;
  deletedSandboxStore: Ref<DeletedSandboxStore>;
  homePath: Ref<string>;
  replaceHomePrefix: (path: string) => string;
  resolveProjectColor: (color?: string) => string | undefined;
  codexProjectId?: string;
}) {
  const treeDataCache = shallowRef<{ data: TopPanelWorktree[]; hash: string; timestamp: number } | null>(null);
  const sessionTreeDataCache = shallowRef<{ data: SessionTreeData; hash: string; timestamp: number } | null>(null);

  const treeDataHash = computed(() => computeProjectsHash(
    params.projects,
    params.pinnedStore.value,
    params.deletedSandboxStore.value,
  ));

  const topPanelTreeData = computed<TopPanelWorktree[]>(() => {
    const currentHash = `${params.activeBackendKind.value}:${treeDataHash.value}:top-panel`;
    const now = Date.now();
    if (
      treeDataCache.value
      && treeDataCache.value.hash === currentHash
      && now - treeDataCache.value.timestamp < TREE_DATA_CACHE_TTL_MS
    ) {
      return treeDataCache.value.data;
    }
    const data = params.activeBackendKind.value === 'codex'
      ? (() => {
          const project = params.projects[params.codexProjectId ?? 'codex'];
          return project
            ? buildCodexTopPanelTreeData(project, {
                pinnedStore: params.pinnedStore.value,
                homePath: params.homePath.value,
                resolveProjectColor: params.resolveProjectColor,
              })
            : [];
        })()
      : buildOpenCodeTopPanelTreeData({
          projects: params.projects,
          pinnedStore: params.pinnedStore.value,
          deletedSandboxStore: params.deletedSandboxStore.value,
          replaceHomePrefix: params.replaceHomePrefix,
          resolveProjectColor: params.resolveProjectColor,
        });
    treeDataCache.value = { data, hash: currentHash, timestamp: now };
    return data;
  });

  const sessionTreeData = computed<SessionTreeData>(() => {
    const currentHash = `${params.activeBackendKind.value}:${treeDataHash.value}:session-tree`;
    const now = Date.now();
    if (
      sessionTreeDataCache.value
      && sessionTreeDataCache.value.hash === currentHash
      && now - sessionTreeDataCache.value.timestamp < TREE_DATA_CACHE_TTL_MS
    ) {
      return sessionTreeDataCache.value.data;
    }
    const data = params.activeBackendKind.value === 'codex'
      ? buildCodexSessionTreeData(topPanelTreeData.value)
      : buildOpenCodeSessionTreeData({
          projects: params.projects,
          pinnedStore: params.pinnedStore.value,
          resolveProjectColor: params.resolveProjectColor,
        });
    sessionTreeDataCache.value = { data, hash: currentHash, timestamp: now };
    return data;
  });

  const navigableTree = computed(() => topPanelTreeData.value
    .map((worktree) => ({
      ...worktree,
      sandboxes: worktree.sandboxes
        .map((sandbox) => ({
          ...sandbox,
          sessions: sandbox.sessions.filter((session) => !session.archivedAt).slice(0, NAVIGABLE_MAX_SESSIONS),
        }))
        .filter((sandbox) => worktree.projectId !== 'global' || sandbox.sessions.length > 0),
    }))
    .filter((worktree) => worktree.sandboxes.some((sandbox) => sandbox.sessions.length > 0)));

  return {
    treeDataHash,
    topPanelTreeData,
    sessionTreeData,
    navigableTree,
  };
}
