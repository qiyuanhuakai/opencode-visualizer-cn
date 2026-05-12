import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { BackendSessionInfo } from '../types/backend-domain';

type OpenCodeApiLike = {
  createSession: (directory: string) => Promise<BackendSessionInfo | undefined>;
};

type CodexApiLike = {
  homeDir: Ref<string>;
  activeThreadId: Ref<string>;
  visibleThreads: Ref<Array<{ id: string; cwd?: string; gitInfo?: { root?: string } | null }>>;
  startThread: (directory: string) => Promise<{ id?: string; cwd?: string; name?: string | null; preview?: string | null }>;
  refreshHomeDir: (force?: boolean) => Promise<string>;
  interruptActiveTurn: () => Promise<unknown>;
};

export function useBackendSessionLifecycle(params: {
  activeBackendKind: Ref<BackendKind>;
  codexProjectId: string;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  activeDirectory: Ref<string>;
  homePath: Ref<string>;
  codexPendingSessionLock: Ref<string>;
  codexSessionCreationByDirectory: Map<string, Promise<BackendSessionInfo | undefined>>;
  openCodeApi: OpenCodeApiLike;
  codexApi: CodexApiLike;
  normalizeProjectDirectoryForActiveBackend: (directory: string) => string;
  codexThreadDirectoryMatch: (thread: { cwd?: string; gitInfo?: { root?: string } | null }, directory: string) => boolean;
  ensureConnectionReady: (action: string) => boolean;
  translate: (key: string, params?: Record<string, unknown>) => string;
  toErrorMessage: (error: unknown) => string;
  setSessionError: (message: string) => void;
  clearSessionError: () => void;
  setSendStatusKey: (key: string, params?: Record<string, unknown>) => void;
  isAborting: Ref<boolean>;
  busyDescendantSessionIds: Ref<string[]>;
  backendAbortSession: ((sessionId: string, directory?: string) => Promise<unknown>) | undefined;
}) {
  async function createSessionInDirectory(directory: string) {
    if (params.activeBackendKind.value === 'codex') {
      const codexDirectory = params.normalizeProjectDirectoryForActiveBackend(directory);
      const existing = params.codexSessionCreationByDirectory.get(codexDirectory);
      if (existing) return existing;
      const creation = (async () => {
        const thread = await params.codexApi.startThread(codexDirectory);
        if (!thread?.id) return undefined;
        params.codexPendingSessionLock.value = thread.id;
        params.selectedProjectId.value = params.codexProjectId;
        params.selectedSessionId.value = thread.id;
        return {
          id: thread.id,
          projectID: params.codexProjectId,
          directory: params.normalizeProjectDirectoryForActiveBackend(thread.cwd || codexDirectory),
          title: thread.name || thread.preview || thread.id,
        } satisfies BackendSessionInfo;
      })().finally(() => {
        params.codexSessionCreationByDirectory.delete(codexDirectory);
      });
      params.codexSessionCreationByDirectory.set(codexDirectory, creation);
      return creation;
    }
    const session = await params.openCodeApi.createSession(directory);
    if (!session?.id) return undefined;
    const nextProjectId = (session.projectID || params.selectedProjectId.value).trim();
    if (nextProjectId) params.selectedProjectId.value = nextProjectId;
    params.selectedSessionId.value = session.id;
    return session;
  }

  async function openProjectPicker(isProjectPickerOpen: Ref<boolean>) {
    if (params.activeBackendKind.value === 'codex') {
      const home = await params.codexApi.refreshHomeDir(true);
      if (home) params.homePath.value = home;
    }
    isProjectPickerOpen.value = true;
  }

  async function createNewSession() {
    if (!params.ensureConnectionReady(params.translate('app.actions.creatingSession'))) return undefined;
    params.clearSessionError();
    try {
      const directory = params.activeDirectory.value.trim();
      if (!directory) throw new Error(params.translate('errors.sessionCreateEmptyDirectory'));
      return await createSessionInDirectory(directory);
    } catch (error) {
      params.setSessionError(params.translate('app.error.sessionCreateFailed', { message: params.toErrorMessage(error) }));
      return undefined;
    }
  }

  async function handleProjectDirectorySelect(directory: string) {
    if (!directory) return '';
    const targetDirectory = params.normalizeProjectDirectoryForActiveBackend(directory);
    if (params.activeBackendKind.value === 'codex') {
      const existing = params.codexApi.visibleThreads.value.find((thread) => params.codexThreadDirectoryMatch(thread, targetDirectory));
      const sessionId = existing?.id || (await createSessionInDirectory(targetDirectory))?.id || '';
      if (sessionId) {
        params.selectedProjectId.value = params.codexProjectId;
        params.selectedSessionId.value = sessionId;
      }
      return sessionId;
    }
    return targetDirectory;
  }

  async function abortSession() {
    if (!params.ensureConnectionReady(params.translate('app.actions.stopping'))) return;
    const sessionId = params.selectedSessionId.value;
    if (!sessionId || params.isAborting.value) return;
    params.isAborting.value = true;
    params.setSendStatusKey('app.status.stopping');
    try {
      if (params.activeBackendKind.value === 'codex') {
        await params.codexApi.interruptActiveTurn();
        params.setSendStatusKey('app.status.stopped');
        return;
      }
      const abortSession = params.backendAbortSession;
      if (!abortSession) throw new Error('Session abort is unavailable.');
      const directory = params.activeDirectory.value.trim();
      const abortPromises = [
        abortSession(sessionId, directory || undefined),
        ...params.busyDescendantSessionIds.value.map((sid) => abortSession(sid, directory || undefined).catch(() => {})),
      ];
      await Promise.all(abortPromises);
      params.setSendStatusKey('app.status.stopped');
    } catch (error) {
      params.setSendStatusKey('app.error.stopFailed', { message: params.toErrorMessage(error) });
    } finally {
      params.isAborting.value = false;
    }
  }

  return {
    createSessionInDirectory,
    openProjectPicker,
    createNewSession,
    handleProjectDirectorySelect,
    abortSession,
  };
}
