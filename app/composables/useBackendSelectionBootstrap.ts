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
  // Target-directed OpenCode bootstrap (useOpenCodeSelectionBootstrap). When
  // provided, the OpenCode branch delegates to it and never falls back to a
  // global unhydrated scan. Optional until App.vue is rewired.
  bootstrapOpenCodeSelection?: () => Promise<void>;
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

    if (params.bootstrapOpenCodeSelection) {
      await params.bootstrapOpenCodeSelection();
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
