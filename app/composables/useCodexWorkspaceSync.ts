import { watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { ProjectState } from '../types/worker-state';
import { shouldPreservePendingCodexSelection } from '../utils/codexSessionSelection';
import { CODEX_PROJECT_ID } from './useCodexWorkspace';

export function useCodexWorkspaceSync(params: {
  activeBackendKind: Ref<BackendKind>;
  codexProject: Ref<ProjectState>;
  codexActiveSessionId: Ref<string>;
  codexHomeDir: Ref<string>;
  serverProjects: Record<string, ProjectState>;
  serverBootstrapped: Ref<boolean>;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  homePath: Ref<string>;
  codexPendingSessionLock: Ref<string>;
}) {
  watch(
    [
      params.activeBackendKind,
      params.codexProject,
      params.codexActiveSessionId,
      params.codexHomeDir,
    ],
    ([backendKind, project, activeSessionId, homeDir]) => {
      if (backendKind !== 'codex') return;
      Object.keys(params.serverProjects).forEach((key) => {
        if (key !== CODEX_PROJECT_ID) delete params.serverProjects[key];
      });
      params.serverProjects[CODEX_PROJECT_ID] = project;
      params.serverBootstrapped.value = true;
      params.selectedProjectId.value = CODEX_PROJECT_ID;

      const projectSandboxes = project.sandboxes;
      const hasSelectedSession = Boolean(
        params.selectedSessionId.value
        && Object.values(projectSandboxes).some((sandbox) => sandbox.sessions[params.selectedSessionId.value]),
      );
      if (
        params.codexPendingSessionLock.value
        && hasSelectedSession
        && params.selectedSessionId.value === params.codexPendingSessionLock.value
      ) {
        params.codexPendingSessionLock.value = '';
      }
      if (shouldPreservePendingCodexSelection({
        pendingSessionLock: params.codexPendingSessionLock.value,
        selectedSessionId: params.selectedSessionId.value,
        projectSandboxes,
      })) {
        if (homeDir && params.homePath.value !== homeDir) params.homePath.value = homeDir;
        return;
      }
      if (!hasSelectedSession && activeSessionId && params.selectedSessionId.value !== activeSessionId) {
        params.selectedSessionId.value = activeSessionId;
      }
      if (homeDir && params.homePath.value !== homeDir) params.homePath.value = homeDir;
    },
    { immediate: true },
  );
}
