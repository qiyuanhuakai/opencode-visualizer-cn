import { computed, shallowRef, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { TopPanelWorktree } from '../types/top-panel';
import type { SessionTreeData } from '../types/session-tree';
import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import { buildCodexSessionTreeData, buildCodexTopPanelTreeData } from '../utils/codexTopPanelTree';
import { isSandboxMarkedDeleted, type DeletedSandboxStore } from '../utils/deletedSandboxes';
import type { LocalPinnedSessionStore } from '../utils/pinnedSessions';
import { buildNativeOpenCodeTopPanelTreeData, buildOpenCodeSessionTreeData } from './openCodeSessionTrees';

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
        hash = mixStringIntoHash(hash, session.title ?? '');
        hash = mixStringIntoHash(hash, session.slug ?? '');
        hash = mixStringIntoHash(hash, session.status ?? '');
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
