import { computed, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { TopPanelWorktree } from '../types/top-panel';
import type { SessionTreeData } from '../types/session-tree';
import type { ProjectState, SessionState } from '../types/worker-state';
import { buildCodexSessionTreeData, buildCodexTopPanelTreeData } from '../utils/codexTopPanelTree';
import { isSandboxMarkedDeleted, type DeletedSandboxStore } from '../utils/deletedSandboxes';
import type { LocalPinnedSessionStore } from '../utils/pinnedSessions';
import { buildNativeOpenCodeTopPanelTreeData, buildOpenCodeSessionTreeData } from './openCodeSessionTrees';

const NAVIGABLE_MAX_SESSIONS = 5;

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
  const topPanelTreeData = computed<TopPanelWorktree[]>(() => {
    return params.activeBackendKind.value === 'codex'
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
  });

  const sessionTreeData = computed<SessionTreeData>(() => {
    return params.activeBackendKind.value === 'codex' || params.activeBackendKind.value === 'acp'
      ? buildCodexSessionTreeData(topPanelTreeData.value)
      : buildOpenCodeSessionTreeData({
          projects: params.projects,
          pinnedStore: params.pinnedStore.value,
          resolveProjectColor: params.resolveProjectColor,
        });
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
    topPanelTreeData,
    sessionTreeData,
    navigableTree,
  };
}
