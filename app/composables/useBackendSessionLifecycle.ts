import { watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { BackendSessionInfo } from '../types/backend-domain';
import type { KimiWebSessionProfileInput } from '../utils/kimiWeb';
import type { DshNormalizeOp } from '../backends/dsh/ops';
import type { ProjectState } from '../types/worker-state';
import {
  applyDshSessionEvent,
  mapDshEventSession,
  normalizeDshSessionEvent,
  type DshMoreSessionCard,
  type DshMoreSessionsMenu,
} from './dshSessionEvents';

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
  getFsHome?: () => Promise<{ home: string; recent_roots: string[] }>;
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

/**
 * Structural view of the dsh session surface (`app/backends/dsh/dshAdapter.ts`).
 * The adapter's `createSession` writes the default model explicitly through
 * `session/selectModel` and reads `projections.modelSelection.lastUsed` back
 * onto the mapped session — dsh never silently ignores a create-time model —
 * so this seam only needs create + cancel.
 */
export type DshSessionApiLike = {
  createSession?: (directory: string) => Promise<unknown>;
  abortSession?: (sessionId: string) => Promise<unknown>;
};

/** The ONE shared dsh event transport seam (bridge + send path feed it). */
export type DshSessionEventSource = {
  onSessionEvent(
    listener: (op: DshNormalizeOp, context: { sessionId?: string; origin?: 'live' | 'snapshot-rebuild' }) => void,
  ): () => void;
};

function parseCreatedSession(value: unknown): BackendSessionInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const session = value as Record<string, unknown>;
  if (typeof session.id !== 'string' || !session.id.trim()) return undefined;
  return value as BackendSessionInfo;
}

/** Parse a dsh create response (mapped session or wire item) into a session. */
function parseDshCreatedSession(value: unknown, directory: string): BackendSessionInfo | undefined {
  const mapped = mapDshEventSession(value);
  if (!mapped) return undefined;
  return {
    id: mapped.id,
    projectID: mapped.workspaceId || undefined,
    directory: mapped.directory || directory,
    title: mapped.title,
    status: mapped.status,
    ...(mapped.parentID ? { parentID: mapped.parentID } : {}),
    time: {
      ...(mapped.timeCreated !== undefined ? { created: mapped.timeCreated } : {}),
      ...(mapped.timeUpdated !== undefined ? { updated: mapped.timeUpdated } : {}),
    },
  } satisfies BackendSessionInfo;
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
    case 'dsh':
      throw new Error('dsh sessions use their workspace id, not a synthetic project id.');
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
  selectKimiWebSession?: (projectId: string, sessionId: string) => Promise<void>;
  dshApi?: DshSessionApiLike;
  onDshSessionCreated?: (session: BackendSessionInfo) => void;
  selectDshSession?: (projectId: string, sessionId: string) => Promise<void>;
}) {
  let kimiWebCreationGeneration = 0;
  watch(
    [params.selectedProjectId, params.selectedSessionId, params.activeBackendKind],
    () => {
      kimiWebCreationGeneration += 1;
    },
    { flush: 'sync' },
  );
  let dshCreationGeneration = 0;
  watch(
    [params.selectedProjectId, params.selectedSessionId, params.activeBackendKind],
    () => {
      dshCreationGeneration += 1;
    },
    { flush: 'sync' },
  );
  /** The live shared-transport subscription; a re-subscribe cancels it first. */
  let detachDshSessionEvents: (() => void) | undefined;

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
    const session = updated
      ? {
          ...created,
          ...updated,
          projectID: updated.projectID || created.projectID,
          directory: updated.directory || created.directory,
          title: updated.title === updated.id ? created.title : updated.title,
          time: {
            created: updated.time?.created ?? created.time?.created,
            updated: updated.time?.updated ?? created.time?.updated,
          },
        }
      : created;
    if (params.activeBackendKind.value === 'kimi-web') {
      params.onKimiWebSessionCreated?.(session);
      if (generation === kimiWebCreationGeneration) {
        if (session.projectID && params.selectKimiWebSession) {
          await params.selectKimiWebSession(session.projectID, session.id);
        } else {
          if (session.projectID) params.selectedProjectId.value = session.projectID;
          params.selectedSessionId.value = session.id;
        }
      }
    }
    return session;
  }

  /**
   * dsh session creation. The adapter writes the default model explicitly
   * (`session/selectModel`) and reads `projections.modelSelection.lastUsed`
   * back onto the mapped session, so no second profile write is needed here.
   * The created session is registered with the host BEFORE its selection is
   * published, behind the same generation fence as kimi: a superseded
   * creation (backend switch, newer user selection) never overwrites it.
   */
  async function createDshSessionInDirectory(directory: string) {
    const api = params.dshApi;
    if (!api?.createSession) {
      throw new Error('dsh session creation is unavailable.');
    }
    const generation = ++dshCreationGeneration;
    const created = parseDshCreatedSession(await api.createSession(directory), directory);
    if (!created?.id) throw new Error('dsh session creation returned no session id.');
    if (params.activeBackendKind.value === 'dsh') {
      params.onDshSessionCreated?.(created);
      if (generation === dshCreationGeneration) {
        if (created.projectID && params.selectDshSession) {
          await params.selectDshSession(created.projectID, created.id);
        } else {
          if (created.projectID) params.selectedProjectId.value = created.projectID;
          params.selectedSessionId.value = created.id;
        }
      }
    }
    return created;
  }

  async function createSessionInDirectory(
    directory: string,
    options?: { reuseExisting?: boolean },
  ) {
    if (params.activeBackendKind.value === 'kimi-web') {
      return createKimiWebSessionInDirectory(directory);
    }
    if (params.activeBackendKind.value === 'dsh') {
      return createDshSessionInDirectory(directory);
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
    } else if (params.activeBackendKind.value === 'kimi-web' && params.kimiWebApi?.getFsHome) {
      try {
        const landing = await params.kimiWebApi.getFsHome();
        params.homePath.value = landing.home.trim();
      } catch {
        params.homePath.value = '';
      }
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
    if (params.activeBackendKind.value === 'dsh') {
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
      if (params.activeBackendKind.value === 'dsh') {
        const dshAbort = params.dshApi?.abortSession;
        if (!dshAbort) throw new Error('Session abort is unavailable.');
        await dshAbort(sessionId);
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

  /**
   * Subscribe the ONE shared dsh event transport to the projects store.
   * Every inbox/thread event normalizes onto the shared
   * `serverSessionsChanged` record and applies per session id — there is no
   * per-session transport, and a session's events never overwrite another's.
   *
   * Fork safety: a re-subscription (fresh follow stream after a fork or an
   * R16 reopen) cancels the previous subscription FIRST, so the superseded
   * stream's late frames can no longer reach the shared state. The backend
   * kind is re-checked per frame, so a backend switch fences stale applies.
   */
  function subscribeSessionEvents(options: {
    source: DshSessionEventSource;
    projects: () => Record<string, ProjectState>;
  }): () => void {
    detachDshSessionEvents?.();
    const unsubscribe = options.source.onSessionEvent((op, context) => {
      if (params.activeBackendKind.value !== 'dsh') return;
      const change = normalizeDshSessionEvent(op, context);
      if (!change) return;
      applyDshSessionEvent(options.projects(), change);
    });
    detachDshSessionEvents = unsubscribe;
    return unsubscribe;
  }

  /**
   * Apply the bootstrap `workspace/follow` archive baseline
   * (`archivedSessionIds`, Todo 16) onto the projects store. The baseline is
   * authoritative and idempotent: a listed session is stamped once, and an
   * unlisted session is never force-unarchived from a stale read.
   */
  function loadSessionArchives(options: {
    projects: Record<string, ProjectState>;
    archivedSessionIds: readonly string[];
  }): number {
    const archived = new Set(options.archivedSessionIds);
    let applied = 0;
    for (const project of Object.values(options.projects)) {
      for (const sandbox of Object.values(project.sandboxes)) {
        for (const session of Object.values(sandbox.sessions)) {
          if (!archived.has(session.id) || session.timeArchived !== undefined) continue;
          session.timeArchived = Date.now();
          applied += 1;
        }
      }
    }
    return applied;
  }

  /**
   * The dsh more-sessions sidebar contract: shared SessionCard entries (the
   * Kimi Web App.vue choice — no native scrollbar), root sessions only (a
   * child/subagent session is never a top-level entry), archived sessions
   * excluded, most recently active first. Every card carries the pid
   * empty-string contract.
   */
  function showMoreSessionsMenu(options: {
    projects: Record<string, ProjectState>;
    projectId: string;
    selectedSessionId?: string;
    limit?: number;
  }): DshMoreSessionsMenu {
    const project = options.projects[options.projectId];
    const cards: DshMoreSessionCard[] = [];
    if (project) {
      for (const sandbox of Object.values(project.sandboxes)) {
        for (const session of Object.values(sandbox.sessions)) {
          if (session.parentID || session.timeArchived !== undefined) continue;
          cards.push({
            sessionId: session.id,
            title: session.title || session.id,
            status: session.status,
            ...(session.timeCreated !== undefined ? { timeCreated: session.timeCreated } : {}),
            ...(session.timeUpdated !== undefined ? { timeUpdated: session.timeUpdated } : {}),
            directory: session.directory || sandbox.directory,
            workspaceId: project.id,
            // dsh never reports a pid: the empty-string contract, never undefined.
            pid: '',
          });
        }
      }
      cards.sort(
        (left, right) =>
          (right.timeUpdated ?? right.timeCreated ?? 0) - (left.timeUpdated ?? left.timeCreated ?? 0) ||
          left.sessionId.localeCompare(right.sessionId),
      );
    }
    const limit = options.limit ?? 50;
    return {
      contract: 'shared-session-cards',
      cards: cards.slice(0, Math.max(0, limit)),
      selectedSessionId: options.selectedSessionId,
    };
  }

  return {
    createSessionInDirectory,
    openProjectPicker,
    createNewSession,
    handleProjectDirectorySelect,
    abortSession,
    subscribeSessionEvents,
    loadSessionArchives,
    showMoreSessionsMenu,
  };
}
