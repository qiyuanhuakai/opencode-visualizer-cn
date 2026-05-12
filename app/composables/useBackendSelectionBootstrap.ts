import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';

export function useBackendSelectionBootstrap(params: {
  activeBackendKind: Ref<BackendKind>;
  codexProjectId: string;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  codexActiveSessionId: Ref<string>;
  initialProjectId: () => string;
  initialSessionId: () => string;
  sessionExistsInProjects: (projectId: string, sessionId: string) => boolean;
  switchSessionSelection: (projectId: string, sessionId: string) => Promise<void>;
  initializeSessionSelection: () => Promise<void>;
}) {
  async function bootstrapSelection() {
    const initialProjectId = params.initialProjectId().trim();
    const initialSessionId = params.initialSessionId().trim();

    if (params.activeBackendKind.value === 'codex') {
      params.selectedProjectId.value = params.codexProjectId;
      const activeSessionId = params.codexActiveSessionId.value;
      if (!params.selectedSessionId.value && activeSessionId) {
        params.selectedSessionId.value = activeSessionId;
      }
      return;
    }

    if (initialProjectId && initialSessionId && params.sessionExistsInProjects(initialProjectId, initialSessionId)) {
      await params.switchSessionSelection(initialProjectId, initialSessionId);
      return;
    }

    await params.initializeSessionSelection();
  }

  return {
    bootstrapSelection,
  };
}
