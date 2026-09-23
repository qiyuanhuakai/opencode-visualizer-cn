import { watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { BackendSessionInfo } from '../types/backend-domain';
import type { KimiWebSessionProfileInput } from '../utils/kimiWeb';

type OpenCodeApiLike = {
  createSession: (directory: string) => Promise<BackendSessionInfo | undefined>;
};

/**
 * Structural view of the kimi web REST client (`app/utils/kimiWeb.ts`) that
 * the session lifecycle/action composables depend on. Every method is optional
 * so a partially wired host fails closed per action instead of silently
 * falling through to the OpenCode path. Todo 25 injects the real client.
 */
export type KimiWebSessionApiLike = {
  createSession?: (input: { metadata: { cwd: string } }) => Promise<unknown>;
  updateProfile?: (sessionId: string, input: KimiWebSessionProfileInput) => Promise<unknown>;
  deleteSession?: (sessionId: string) => Promise<unknown>;
  archiveSession?: (sessionId: string) => Promise<unknown>;
  restoreSession?: (sessionId: string) => Promise<unknown>;
  abortSession?: (sessionId: string) => Promise<unknown>;
};

function parseKimiWebCreatedSession(
  value: unknown,
  directory: string,
): BackendSessionInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return undefined;
  const workspaceId = typeof record.workspace_id === 'string' ? record.workspace_id.trim() : '';
  const title = typeof record.title === 'string' && record.title.trim() ? record.title : id;
  const created = typeof record.created_at === 'string' ? Date.parse(record.created_at) : NaN;
  const updated = typeof record.updated_at === 'string' ? Date.parse(record.updated_at) : NaN;
  const metadata = Reflect.get(record, 'metadata');
  const cwd = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'cwd') : undefined;
  return {
    id,
    projectID: workspaceId || undefined,
    directory: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : directory,
    title,
    status: 'unknown',
    time: {
      created: Number.isFinite(created) ? created : undefined,
      updated: Number.isFinite(updated) ? updated : undefined,
    },
  } satisfies BackendSessionInfo;
}

type CodexApiLike = {
  homeDir: Ref<string>;
  activeThreadId: Ref<string>;
  visibleThreads: Ref<Array<{ id: string; cwd?: string; gitInfo?: { root?: string } | null }>>;
  startThread: (
    directory: string,
  ) => Promise<{ id?: string; cwd?: string; name?: string | null; preview?: string | null }>;
  refreshHomeDir: (force?: boolean) => Promise<string>;
  interruptActiveTurn: () => Promise<unknown>;
};

function parseCreatedSession(value: unknown): BackendSessionInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const session = value as Record<string, unknown>;
  if (typeof session.id !== 'string' || !session.id.trim()) return undefined;
  return value as BackendSessionInfo;
}

type AbortBackend = {
  abortSession?: (sessionId: string, directory?: string) => Promise<unknown>;
};

export function createDynamicBackendAbortSession(getBackend: () => AbortBackend) {
  return async (sessionId: string, directory?: string) => {
    const backend = getBackend();
    if (!backend.abortSession) throw new Error('Session abort is unavailable.');
    return backend.abortSession.call(backend, sessionId, directory);
  };
}

export function sessionProjectIdForBackend(
  kind: BackendKind,
  codexProjectId: string,
  acpProjectId: string,
) {
  switch (kind) {
    case 'codex':
      return codexProjectId;
    case 'acp':
      return acpProjectId;
    case 'kimi-web':
      throw new Error('Kimi Web sessions use their workspace id, not a synthetic project id.');
    case 'opencode':
      throw new Error('OpenCode sessions do not use a synthetic project id.');
  }
}

export function useBackendSessionLifecycle(params: {
  activeBackendKind: Ref<BackendKind>;
  codexProjectId: string;
  acpProjectId: string;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  activeDirectory: Ref<string>;
  homePath: Ref<string>;
  codexPendingSessionLock: Ref<string>;
  codexSessionCreationByDirectory: Map<string, Promise<BackendSessionInfo | undefined>>;
  openCodeApi: OpenCodeApiLike;
  codexApi: CodexApiLike;
  normalizeProjectDirectoryForActiveBackend: (directory: string) => string;
  codexThreadDirectoryMatch: (
    thread: { cwd?: string; gitInfo?: { root?: string } | null },
    directory: string,
  ) => boolean;
  ensureConnectionReady: (action: string) => boolean;
  translate: (key: string, params?: Record<string, unknown>) => string;
  toErrorMessage: (error: unknown) => string;
  setSessionError: (message: string) => void;
  clearSessionError: () => void;
  setSendStatusKey: (key: string, params?: Record<string, unknown>) => void;
  isAborting: Ref<boolean>;
  busyDescendantSessionIds: Ref<string[]>;
  backendCreateSession: (directory: string) => Promise<unknown>;
  findAcpSessionByDirectory?: (directory: string) => BackendSessionInfo | undefined;
  backendAbortSession: ((sessionId: string, directory?: string) => Promise<unknown>) | undefined;
  kimiWebApi?: KimiWebSessionApiLike;
  kimiWebCreateProfile?: (directory: string) => KimiWebSessionProfileInput | undefined;
  onKimiWebSessionCreated?: (session: BackendSessionInfo) => void;
}) {
  let kimiWebCreationGeneration = 0;
  watch(
    [params.selectedProjectId, params.selectedSessionId, params.activeBackendKind],
    () => {
      kimiWebCreationGeneration += 1;
    },
    { flush: 'sync' },
  );

  async function createKimiWebSessionInDirectory(directory: string) {
    const api = params.kimiWebApi;
    if (!api?.createSession || !api.updateProfile) {
      throw new Error('Kimi Web session creation is unavailable.');
    }
    const generation = ++kimiWebCreationGeneration;
    const profile = params.kimiWebCreateProfile?.(directory) ?? {};
    const created = parseKimiWebCreatedSession(
      await api.createSession({ metadata: { cwd: directory } }),
      directory,
    );
    if (!created?.id) throw new Error('Kimi Web session creation returned no session id.');
    const updated = parseKimiWebCreatedSession(
      await api.updateProfile(created.id, profile),
      created.directory || directory,
    );
    const session = updated ?? created;
    if (params.activeBackendKind.value === 'kimi-web') {
      params.onKimiWebSessionCreated?.(session);
      if (generation === kimiWebCreationGeneration) {
        if (session.projectID) params.selectedProjectId.value = session.projectID;
        params.selectedSessionId.value = session.id;
      }
    }
    return session;
  }

  async function createSessionInDirectory(
    directory: string,
    options?: { reuseExisting?: boolean },
  ) {
    if (params.activeBackendKind.value === 'kimi-web') {
      return createKimiWebSessionInDirectory(directory);
    }
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
    if (params.activeBackendKind.value === 'acp' && options?.reuseExisting !== false) {
      const existing = params.findAcpSessionByDirectory?.(
        params.normalizeProjectDirectoryForActiveBackend(directory),
      );
      if (existing) {
        params.selectedProjectId.value = params.acpProjectId;
        params.selectedSessionId.value = existing.id;
        return existing;
      }
    }
    const created =
      params.activeBackendKind.value === 'acp'
        ? await params.backendCreateSession(directory)
        : await params.openCodeApi.createSession(directory);
    const session = parseCreatedSession(created);
    if (!session?.id) return undefined;
    const nextProjectId =
      params.activeBackendKind.value === 'acp'
        ? sessionProjectIdForBackend(
            params.activeBackendKind.value,
            params.codexProjectId,
            params.acpProjectId,
          )
        : (session.projectID || params.selectedProjectId.value).trim();
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
    if (!params.ensureConnectionReady(params.translate('app.actions.creatingSession')))
      return undefined;
    params.clearSessionError();
    try {
      const directory = params.activeDirectory.value.trim();
      if (!directory) throw new Error(params.translate('errors.sessionCreateEmptyDirectory'));
      return await createSessionInDirectory(directory, { reuseExisting: false });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      params.setSessionError(
        params.translate('app.error.sessionCreateFailed', {
          message: params.toErrorMessage(cause),
        }),
      );
      return undefined;
    }
  }

  async function handleProjectDirectorySelect(directory: string) {
    if (!directory) return '';
    const targetDirectory = params.normalizeProjectDirectoryForActiveBackend(directory);
    if (params.activeBackendKind.value === 'codex') {
      const existing = params.codexApi.visibleThreads.value.find((thread) =>
        params.codexThreadDirectoryMatch(thread, targetDirectory),
      );
      const sessionId = existing?.id || (await createSessionInDirectory(targetDirectory))?.id || '';
      if (sessionId) {
        params.selectedProjectId.value = params.codexProjectId;
        params.selectedSessionId.value = sessionId;
      }
      return sessionId;
    }
    if (params.activeBackendKind.value === 'acp') {
      return (await createSessionInDirectory(targetDirectory))?.id ?? '';
    }
    if (params.activeBackendKind.value === 'kimi-web') {
      return (await createSessionInDirectory(targetDirectory))?.id ?? '';
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
      if (params.activeBackendKind.value === 'kimi-web') {
        const kimiAbort = params.kimiWebApi?.abortSession;
        if (!kimiAbort) throw new Error('Session abort is unavailable.');
        await kimiAbort(sessionId);
        params.setSendStatusKey('app.status.stopped');
        return;
      }
      const abortSession = params.backendAbortSession;
      if (!abortSession) throw new Error('Session abort is unavailable.');
      const directory = params.activeDirectory.value.trim();
      const abortPromises = [
        abortSession(sessionId, directory || undefined),
        ...params.busyDescendantSessionIds.value.map((sid) =>
          abortSession(sid, directory || undefined).catch(() => {}),
        ),
      ];
      await Promise.all(abortPromises);
      params.setSendStatusKey('app.status.stopped');
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      params.setSendStatusKey('app.error.stopFailed', { message: params.toErrorMessage(cause) });
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
