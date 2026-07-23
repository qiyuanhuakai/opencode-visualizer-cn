import { computed, shallowRef, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { TopPanelWorktree } from '../types/top-panel';
import type { SessionTreeData, SessionTreeProject, SessionTreeSandbox, SessionTreeSession } from '../types/session-tree';
import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
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
  gitInfoByDirectory: Record<string, NonNullable<SessionState['gitInfo']>>,
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
        hash = mixStringIntoHash(hash, String(session.timeArchived ?? ''));
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
  const gitInfoEntries = Object.entries(gitInfoByDirectory)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, info]) => `${directory}:${info.root}:${info.branch ?? ''}:${info.worktreeRoot ?? ''}`);
  return `${hash}-${projectEntries.length}-${pinnedHash}-${deletedEntries.join('|')}-${gitInfoEntries.join('|')}`;
}

function buildNativeOpenCodeTopPanelTreeData(params: {
  projects: Record<string, ProjectState>;
  pinnedStore: LocalPinnedSessionStore;
  deletedSandboxStore: DeletedSandboxStore;
  gitInfoByDirectory: Record<string, NonNullable<SessionState['gitInfo']>>;
  homePath: string;
  replaceHomePrefix: (path: string) => string;
  resolveProjectColor: (color?: string) => string | undefined;
}): TopPanelWorktree[] {
  const {
    projects,
    pinnedStore,
    deletedSandboxStore,
    replaceHomePrefix,
    resolveProjectColor,
  } = params;
  return Object.values(projects).map((project) => {
    const projectPinnedAt = normalizePinnedAt(pinnedStore[projectPinKey(project.id)]);
    const sandboxes = (Object.values(project.sandboxes) as SandboxState[])
      .filter((sandbox) => sandbox.directory === project.worktree
        || !isSandboxMarkedDeleted(deletedSandboxStore, project.id, sandbox.directory))
      .map((sandbox) => {
        const pinnedAt = normalizePinnedAt(pinnedStore[sandboxPinKey(project.id, sandbox.directory)]);
        return {
          directory: sandbox.directory,
          branch: sandbox.name,
          kind: 'sandbox' as const,
          pinnedAt,
          isPinned: pinnedAt > 0,
          sessions: sandbox.rootSessions.map((id) => sandbox.sessions[id]).filter(Boolean).map((session) => {
            const sessionPinnedAt = normalizePinnedAt(pinnedStore[pinnedSessionStoreKey(project.id, session.id)])
              || normalizePinnedAt(session.timePinned);
            return {
              id: session.id,
              title: session.title,
              slug: session.slug,
              status: (session.status ?? 'unknown') as 'busy' | 'idle' | 'retry' | 'unknown',
              timeCreated: session.timeCreated,
              timeUpdated: session.timeUpdated,
              pinnedAt: sessionPinnedAt,
              isPinned: sessionPinnedAt > 0,
            };
          }),
        };
      });
    return {
      directory: project.worktree,
      label: replaceHomePrefix(project.worktree),
      name: project.name,
      projectId: project.id,
      projectColor: resolveProjectColor(project.icon?.color),
      kind: 'sandbox' as const,
      pinnedAt: projectPinnedAt,
      isPinned: projectPinnedAt > 0,
      sandboxes,
    };
  });
}

function buildAcpTopPanelTreeData(params: {
  projects: Record<string, ProjectState>;
  pinnedStore: LocalPinnedSessionStore;
  deletedSandboxStore: DeletedSandboxStore;
  gitInfoByDirectory: Record<string, NonNullable<SessionState['gitInfo']>>;
  homePath: string;
  replaceHomePrefix: (path: string) => string;
  resolveProjectColor: (color?: string) => string | undefined;
}): TopPanelWorktree[] {
  const { projects, pinnedStore, deletedSandboxStore, gitInfoByDirectory, homePath, replaceHomePrefix, resolveProjectColor } = params;
  return Object.values(projects).flatMap((project) => {
    const sandboxes = Object.fromEntries(Object.entries(project.sandboxes)
      .filter(([, sandbox]) => sandbox.directory === project.worktree || !isSandboxMarkedDeleted(deletedSandboxStore, project.id, sandbox.directory))
      .map(([directory, sandbox]) => [directory, {
        ...sandbox,
        sessions: Object.fromEntries(Object.entries(sandbox.sessions).map(([id, session]) => {
          const gitInfo = session.gitInfo ?? gitInfoByDirectory[session.directory || sandbox.directory];
          return [id, gitInfo ? { ...session, gitInfo } : session];
        })),
      }]));
    return buildCodexTopPanelTreeData({ ...project, sandboxes }, {
      pinnedStore, homePath, defaultDirectory: '/', keyPrefix: `backend:${project.id}`, resolveProjectColor,
    });
  }).map((worktree) => ({
    ...worktree,
    label: worktree.kind === 'global' ? worktree.label : replaceHomePrefix(worktree.directory),
  }));
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
      const isSandboxPinned = isSandboxDirectlyPinned;
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
        const isSessionInPinnedTree = isSessionPinned;
        if (!isSessionInPinnedTree) continue;

        const isSessionImplicitlyPinned = false;
        const pinnedAt = isSessionPinned
          ? (isSessionDirectlyPinned ? (sessionLocal as number) : normalizePinnedAt(serverPinnedAt))
          : 0;
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
      const isSandboxImplicitlyPinned = false;
      sandboxes.push({
        type: 'sandbox',
        directory: sandbox.directory,
        projectId: project.id,
        name: sandbox.name || 'main',
        pinnedAt: isSandboxPinned ? (isSandboxDirectlyPinned ? (sandboxLocal as number) : (projectLocal as number)) : 0,
        isPinned: isSandboxPinned,
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
  gitInfoByDirectory?: Ref<Record<string, NonNullable<SessionState['gitInfo']>>>;
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
    params.gitInfoByDirectory?.value ?? {},
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
          : params.activeBackendKind.value === 'acp'
            ? buildAcpTopPanelTreeData({
                projects: params.projects,
                pinnedStore: params.pinnedStore.value,
                deletedSandboxStore: params.deletedSandboxStore.value,
                gitInfoByDirectory: params.gitInfoByDirectory?.value ?? {},
                homePath: params.homePath.value,
                replaceHomePrefix: params.replaceHomePrefix,
                resolveProjectColor: params.resolveProjectColor,
              })
            : buildNativeOpenCodeTopPanelTreeData({
          projects: params.projects,
          pinnedStore: params.pinnedStore.value,
          deletedSandboxStore: params.deletedSandboxStore.value,
          gitInfoByDirectory: params.gitInfoByDirectory?.value ?? {},
          homePath: params.homePath.value,
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
    const data = params.activeBackendKind.value === 'codex' || params.activeBackendKind.value === 'acp'
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
