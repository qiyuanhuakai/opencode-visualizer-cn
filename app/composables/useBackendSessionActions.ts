import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { BackendSessionInfo } from '../types/backend-domain';
import type {
  TopPanelBatchSessionActionPayload,
  TopPanelBatchSessionTarget,
} from '../types/top-panel';
import type { SandboxState, ProjectState, SessionState } from '../types/worker-state';
import type { LocalPinnedSessionStore } from '../utils/pinnedSessions';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';
import { isBatchSessionAction, normalizeBatchSessionTargets } from '../utils/batchSessionTargets';
import type { KimiWebSessionApiLike } from './useBackendSessionLifecycle';
import type { KimiWebSession } from '../utils/kimiWeb';
import { mapKimiWebSession, upsertKimiWebSessionIntoProjects } from '../backends/kimiWeb/kimiWebAdapter';

export type OpenCodeApiLike = {
  deleteSession: (payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }) => Promise<void>;
  archiveSession: (payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }) => Promise<unknown>;
  unarchiveSession: (payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }) => Promise<unknown>;
  renameSession: (payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
    title: string;
  }) => Promise<unknown>;
  pinSession: (payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
    pinnedAt?: number;
  }) => Promise<unknown>;
  unpinSession: (payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }) => Promise<unknown>;
  forkSession: (payload: {
    sessionId: string;
    messageId: string;
    directory?: string;
    projectId: string;
  }) => Promise<BackendSessionInfo>;
  revertSession: (payload: {
    sessionId: string;
    messageId: string;
    projectId: string;
    directory?: string;
  }) => Promise<void>;
};

export type CodexApiLike = {
  hiddenThreadIds: Ref<Set<string>>;
  visibleThreads: Ref<Array<{ id: string }>>;
  activeThreadId: Ref<string>;
  archiveThread: (sessionId: string) => Promise<unknown>;
  hideThread: (sessionId: string) => void;
  unhideThread: (sessionId: string) => void;
  setThreadName: (sessionId: string, name: string) => Promise<unknown>;
  forkThread: (sessionId: string) => Promise<{ id?: string }>;
  rollbackThread: (sessionId: string, target?: number | string) => Promise<{ id?: string }>;
  startThreadCompaction: (sessionId: string) => Promise<unknown>;
  selectThread: (sessionId: string) => Promise<unknown>;
};

export function useBackendSessionActions(params: {
  activeBackendKind: Ref<BackendKind>;
  codexProjectId: string;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  activeDirectory: Ref<string>;
  localPinnedSessionStore: Ref<LocalPinnedSessionStore>;
  serverProjects: Record<string, ProjectState>;
  openCodeApi: OpenCodeApiLike;
  codexApi: CodexApiLike;
  ensureConnectionReady: (action: string) => boolean;
  setSessionError: (message: string) => void;
  clearSessionError: () => void;
  toErrorMessage: (error: unknown) => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  showPrompt: (title: string, value?: string) => Promise<string | null>;
  showConfirm: (message: string) => Promise<boolean>;
  findSessionInProjects: (
    sessionId: string,
  ) => { projectId: string; sandbox: SandboxState; session: BackendSessionInfo } | null;
  resolveProjectIdForSession: (sessionId: string) => string;
  resolveSessionOperationPayload: (
    sessionId: string,
    projectIdHint?: string,
    directoryHint?: string,
  ) => { projectId: string; directory?: string };
  getSessionPinnedOverride: (projectId: string, sessionId: string) => number | undefined;
  setLocalPinnedSession: (projectId: string, sessionId: string, pinnedAt: number) => void;
  setLocalUnpinnedSession: (projectId: string, sessionId: string) => void;
  clearLocalPinnedSessionOverride: (projectId: string, sessionId: string) => void;
  restoreLocalPinnedSessionOverride: (
    projectId: string,
    sessionId: string,
    previousOverride?: number,
  ) => void;
  switchSessionSelection: (projectId: string, sessionId: string) => Promise<void>;
  reloadSelectedSessionState: (sessionId?: string, oldId?: string, forceReset?: boolean) => Promise<void>;
  seedForkedSessionComposerDraft: (
    payload: { sessionId: string; messageId: string },
    session: BackendSessionInfo,
  ) => void;
  setSendStatusKey: (key: string) => void;
  setLocalSessionArchived: (sessionId: string, archived?: number) => void;
  batchConcurrency: number;
  backendDeleteSession: (sessionId: string, directory?: string) => Promise<unknown>;
  backendUpdateSession: (
    sessionId: string,
    payload: { time?: { archived?: number } },
    directory?: string,
  ) => Promise<unknown>;
  kimiWebApi?: KimiWebSessionApiLike & {
    forkSession?: (sessionId: string) => Promise<KimiWebSession>;
    compactSession?: (sessionId: string) => Promise<unknown>;
    forkSessionAtMessage?: (sessionId: string, messageId: string) => Promise<KimiWebSession>;
    undoSessionFromMessage?: (sessionId: string, messageId: string) => Promise<void>;
  };
}) {
  type MutationRollback = () => void;
  type SessionOperationHints = { projectId?: string; directory?: string };
  type OpenCodeSessionPayload = { sessionId: string; projectId: string; directory?: string };

  async function runSessionMutation(options: {
    sessionId: string;
    actionLabel: string;
    errorKey: string;
    apply: (scope: { registerRollback: (rollback: MutationRollback) => void }) => Promise<void>;
  }): Promise<void> {
    if (!params.ensureConnectionReady(params.translate(options.actionLabel))) return;
    params.clearSessionError();
    if (!options.sessionId) return;
    let rollback: MutationRollback | undefined;
    const scope = {
      registerRollback: (fn: MutationRollback) => {
        rollback = fn;
      },
    };
    try {
      await options.apply(scope);
    } catch (error) {
      rollback?.();
      params.setSessionError(
        params.translate(options.errorKey, { message: params.toErrorMessage(error) }),
      );
    }
  }

  function fallbackSelectedSessionId() {
    return (
      params.codexApi.activeThreadId.value || params.codexApi.visibleThreads.value[0]?.id || ''
    );
  }

  function removeKimiWebSession(sessionId: string) {
    for (const project of Object.values(params.serverProjects)) {
      for (const sandbox of Object.values(project.sandboxes)) {
        if (!sandbox.sessions[sessionId]) continue;
        delete sandbox.sessions[sessionId];
        sandbox.rootSessions = sandbox.rootSessions.filter((id) => id !== sessionId);
      }
    }
    if (params.selectedSessionId.value === sessionId) {
      params.selectedSessionId.value = '';
    }
  }

  function updateKimiWebSession(sessionId: string, patch: Partial<SessionState>) {
    if (params.activeBackendKind.value !== 'kimi-web') return;
    for (const project of Object.values(params.serverProjects)) {
      for (const sandbox of Object.values(project.sandboxes)) {
        const session = sandbox.sessions[sessionId];
        if (session) Object.assign(session, patch);
      }
    }
  }

  async function deleteCodexSession(sessionId: string) {
    await params.codexApi.archiveThread(sessionId);
    if (params.selectedSessionId.value === sessionId) {
      params.selectedSessionId.value = fallbackSelectedSessionId();
    }
  }

  async function deleteAcpSession(
    sessionId: string,
    hints?: { projectId?: string; directory?: string },
  ) {
    const { directory } = params.resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    await params.backendDeleteSession(sessionId, directory);
  }

  function prepareOpenCodeSessionMutation(
    sessionId: string,
    hints: SessionOperationHints | undefined,
    registerRollback: (rollback: MutationRollback) => void,
  ): OpenCodeSessionPayload {
    const { projectId, directory } = params.resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    const previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
    registerRollback(() =>
      params.restoreLocalPinnedSessionOverride(projectId, sessionId, previousOverride),
    );
    return { sessionId, projectId, directory };
  }

  async function runOpenCodeSessionMutation(
    sessionId: string,
    hints: SessionOperationHints | undefined,
    registerRollback: (rollback: MutationRollback) => void,
    mutate: (payload: OpenCodeSessionPayload) => Promise<unknown>,
  ) {
    const payload = prepareOpenCodeSessionMutation(sessionId, hints, registerRollback);
    params.clearLocalPinnedSessionOverride(payload.projectId, payload.sessionId);
    await mutate(payload);
  }

  async function deleteSession(sessionId: string, hints?: SessionOperationHints) {
    await runSessionMutation({
      sessionId,
      actionLabel: 'app.actions.deletingSession',
      errorKey: 'app.error.sessionDeleteFailed',
      apply: async ({ registerRollback }) => {
        const backendKind = params.activeBackendKind.value;
        if (backendKind === 'codex') {
          await deleteCodexSession(sessionId);
          return;
        }
        if (backendKind === 'acp') {
          await deleteAcpSession(sessionId, hints);
          return;
        }
        if (backendKind === 'kimi-web') {
          const api = params.kimiWebApi;
          if (!api?.deleteSession) throw new Error('Kimi Web session deletion is unavailable.');
          await api.deleteSession(sessionId);
          removeKimiWebSession(sessionId);
          return;
        }
        await runOpenCodeSessionMutation(
          sessionId,
          hints,
          registerRollback,
          params.openCodeApi.deleteSession,
        );
      },
    });
  }

  async function archiveAcpSession(
    sessionId: string,
    hints?: { projectId?: string; directory?: string },
  ) {
    const { directory } = params.resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    params.setSendStatusKey('app.status.archiving');
    const archivedAt = Date.now();
    await params.backendUpdateSession(sessionId, { time: { archived: archivedAt } }, directory);
    params.setLocalSessionArchived(sessionId, archivedAt);
    params.setSendStatusKey('app.status.archived');
  }

  async function archiveCodexSession(sessionId: string) {
    params.codexApi.hideThread(sessionId);
    if (params.selectedSessionId.value === sessionId) {
      params.selectedSessionId.value = fallbackSelectedSessionId();
    }
  }

  async function archiveSession(sessionId: string, hints?: SessionOperationHints) {
    await runSessionMutation({
      sessionId,
      actionLabel: 'app.actions.archivingSession',
      errorKey: 'app.error.sessionArchiveFailed',
      apply: async ({ registerRollback }) => {
        const backendKind = params.activeBackendKind.value;
        if (backendKind === 'acp') {
          await archiveAcpSession(sessionId, hints);
          return;
        }
        if (backendKind === 'codex') {
          await archiveCodexSession(sessionId);
          return;
        }
        if (backendKind === 'kimi-web') {
          const api = params.kimiWebApi;
          if (!api?.archiveSession) throw new Error('Kimi Web session archive is unavailable.');
          params.setSendStatusKey('app.status.archiving');
          await api.archiveSession(sessionId);
          updateKimiWebSession(sessionId, { timeArchived: Date.now() });
          params.setSendStatusKey('app.status.archived');
          return;
        }
        await runOpenCodeSessionMutation(
          sessionId,
          hints,
          registerRollback,
          params.openCodeApi.archiveSession,
        );
      },
    });
  }

  async function unarchiveAcpSession(
    sessionId: string,
    hints?: { projectId?: string; directory?: string },
  ) {
    const { directory } = params.resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    params.setSendStatusKey('app.status.unarchiving');
    await params.backendUpdateSession(sessionId, { time: { archived: 0 } }, directory);
    params.setLocalSessionArchived(sessionId, undefined);
    params.setSendStatusKey('app.status.unarchived');
  }

  async function unarchiveCodexSession(sessionId: string) {
    if (!params.codexApi.hiddenThreadIds.value.has(sessionId)) {
      throw new Error('Codex recoverable archive not found.');
    }
    params.codexApi.unhideThread(sessionId);
    params.selectedProjectId.value = params.codexProjectId;
    params.selectedSessionId.value = sessionId;
    await params.codexApi.selectThread(sessionId);
  }

  async function unarchiveSession(sessionId: string, hints?: SessionOperationHints) {
    await runSessionMutation({
      sessionId,
      actionLabel: 'app.actions.unarchivingSession',
      errorKey: 'app.error.sessionUnarchiveFailed',
      apply: async ({ registerRollback }) => {
        const backendKind = params.activeBackendKind.value;
        if (backendKind === 'acp') {
          await unarchiveAcpSession(sessionId, hints);
          return;
        }
        if (backendKind === 'codex') {
          await unarchiveCodexSession(sessionId);
          return;
        }
        if (backendKind === 'kimi-web') {
          const api = params.kimiWebApi;
          if (!api?.restoreSession) throw new Error('Kimi Web session restore is unavailable.');
          params.setSendStatusKey('app.status.unarchiving');
          await api.restoreSession(sessionId);
          updateKimiWebSession(sessionId, { timeArchived: undefined });
          params.setSendStatusKey('app.status.unarchived');
          return;
        }
        await runOpenCodeSessionMutation(
          sessionId,
          hints,
          registerRollback,
          params.openCodeApi.unarchiveSession,
        );
      },
    });
  }

  async function renameSession(
    sessionId: string,
    hints?: { projectId?: string; directory?: string },
  ) {
    if (!params.ensureConnectionReady(params.translate('app.actions.renamingSession'))) return;
    params.clearSessionError();
    if (!sessionId) return;
    const backendKind = params.activeBackendKind.value;
    try {
      if (backendKind === 'acp') {
        throw new Error('ACP agent does not support session/set_name.');
      }
      const resolved = params.findSessionInProjects(sessionId);
      const currentTitle =
        resolved?.session.title?.trim() || resolved?.session.slug?.trim() || sessionId;
      const nextTitle = await params.showPrompt(
        params.translate('topPanel.sessionActions.rename'),
        currentTitle,
      );
      if (nextTitle === null) return;
      if (params.activeBackendKind.value !== backendKind) return;
      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle || trimmedTitle === currentTitle) return;
      if (backendKind === 'codex') {
        await params.codexApi.setThreadName(sessionId, trimmedTitle);
        return;
      }
      if (backendKind === 'kimi-web') {
        const api = params.kimiWebApi;
        if (!api?.updateProfile) throw new Error('Kimi Web session rename is unavailable.');
        await api.updateProfile(sessionId, { title: trimmedTitle });
        updateKimiWebSession(sessionId, { title: trimmedTitle });
        return;
      }
      const { projectId, directory } = params.resolveSessionOperationPayload(
        sessionId,
        hints?.projectId,
        hints?.directory,
      );
      await params.openCodeApi.renameSession({
        sessionId,
        projectId,
        directory,
        title: trimmedTitle,
      });
    } catch (error) {
      params.setSessionError(
        params.translate('app.error.sessionRenameFailed', {
          message: params.toErrorMessage(error),
        }),
      );
    }
  }

  async function pinOpenCodeSession(
    sessionId: string,
    hints: SessionOperationHints | undefined,
    registerRollback: (rollback: MutationRollback) => void,
  ) {
    const payload = prepareOpenCodeSessionMutation(sessionId, hints, registerRollback);
    const pinnedAt = Date.now();
    params.setLocalPinnedSession(payload.projectId, payload.sessionId, pinnedAt);
    if (params.activeBackendKind.value !== 'opencode') return;
    await params.openCodeApi.pinSession({ ...payload, pinnedAt });
  }

  async function pinSession(sessionId: string, hints?: SessionOperationHints) {
    await runSessionMutation({
      sessionId,
      actionLabel: 'app.actions.pinningSession',
      errorKey: 'app.error.sessionPinFailed',
      apply: async ({ registerRollback }) => {
        await pinOpenCodeSession(sessionId, hints, registerRollback);
      },
    });
  }

  async function unpinSession(sessionId: string, hints?: SessionOperationHints) {
    if (!sessionId) return;
    const { projectId, directory } = params.resolveSessionOperationPayload(
      sessionId,
      hints?.projectId,
      hints?.directory,
    );
    if (!params.ensureConnectionReady(params.translate('app.actions.unpinningSession'))) return;
    params.clearSessionError();
    let previousOverride: number | undefined;
    try {
      previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
      params.setLocalUnpinnedSession(projectId, sessionId);
      if (params.activeBackendKind.value !== 'opencode') {
        return;
      }
      await params.openCodeApi.unpinSession({ sessionId, projectId, directory });
    } catch (error) {
      params.restoreLocalPinnedSessionOverride(projectId, sessionId, previousOverride);
      params.setSessionError(
        params.translate('app.error.sessionUnpinFailed', { message: params.toErrorMessage(error) }),
      );
    }
  }

  async function runTopPanelBatchSessionActionTarget(
    action: TopPanelBatchSessionActionPayload['action'],
    target: TopPanelBatchSessionTarget,
  ) {
    switch (action) {
      case 'pin':
        await pinSession(target.sessionId, {
          projectId: target.projectId,
          directory: target.directory,
        });
        return;
      case 'unpin':
        await unpinSession(target.sessionId, {
          projectId: target.projectId,
          directory: target.directory,
        });
        return;
      case 'archive':
        await archiveSession(target.sessionId, {
          projectId: target.projectId,
          directory: target.directory,
        });
        return;
      case 'unarchive':
        await unarchiveSession(target.sessionId, {
          projectId: target.projectId,
          directory: target.directory,
        });
        return;
      case 'delete':
        await deleteSession(target.sessionId, {
          projectId: target.projectId,
          directory: target.directory,
        });
        return;
      default:
        throw new Error(`Unsupported batch session action: ${action}`);
    }
  }

  async function handleTopPanelBatchSessionAction(payload: TopPanelBatchSessionActionPayload) {
    if (!payload || !Array.isArray(payload.sessions) || payload.sessions.length === 0) return;
    if (!params.ensureConnectionReady(params.translate('app.actions.batchSessionOperation')))
      return;
    if (!isBatchSessionAction(payload.action)) {
      params.setSessionError(
        params.translate('app.error.batchOperationPartialFailure', {
          action: 'unknown',
          failures: 1,
          total: payload.sessions.length,
          firstError: `Unsupported batch session action: ${String(payload.action)}`,
        }),
      );
      return;
    }
    const targets = normalizeBatchSessionTargets(payload.sessions) as TopPanelBatchSessionTarget[];
    if (targets.length === 0) return;
    params.clearSessionError();
    const results = await mapWithConcurrency(targets, params.batchConcurrency, async (target) => {
      await runTopPanelBatchSessionActionTarget(payload.action, target);
    });
    const failures = results.flatMap((result, index) =>
      result?.status === 'rejected'
        ? [`${targets[index]?.sessionId}: ${params.toErrorMessage(result.reason)}`]
        : [],
    );
    if (failures.length > 0) {
      params.setSessionError(
        params.translate('app.error.batchOperationPartialFailure', {
          action: payload.action,
          failures: failures.length,
          total: targets.length,
          firstError: failures[0],
        }),
      );
    }
  }

  async function handleForkSession(sessionId: string) {
    await runSessionMutation({
      sessionId,
      actionLabel: 'app.actions.fork',
      errorKey: 'app.error.sessionForkFailed',
      apply: async () => {
        const api = params.kimiWebApi;
        if (params.activeBackendKind.value !== 'kimi-web' || !api?.forkSession) {
          throw new Error('Whole-session fork is unavailable for this backend.');
        }
        const session = mapKimiWebSession(await api.forkSession(sessionId));
        upsertKimiWebSessionIntoProjects(params.serverProjects, session);
        await params.switchSessionSelection(session.workspaceId, session.id);
      },
    });
  }

  async function handleCompactSession(sessionId: string) {
    await runSessionMutation({
      sessionId,
      actionLabel: 'codex.compactThread',
      errorKey: 'app.error.sendFailed',
      apply: async () => {
        const api = params.kimiWebApi;
        if (params.activeBackendKind.value !== 'kimi-web' || !api?.compactSession) {
          throw new Error('Session compaction is unavailable for this backend.');
        }
        await api.compactSession(sessionId);
      },
    });
  }

  const pendingCardMutations = new Set<string>();

  async function handleForkMessage(payload: { sessionId: string; messageId: string }) {
    if (pendingCardMutations.has(payload.sessionId)) return;
    if (!params.ensureConnectionReady(params.translate('app.actions.fork'))) return;
    const requestBackend = params.activeBackendKind.value;
    const requestSelection = params.selectedSessionId.value;
    const ownsRequest = () => requestBackend !== 'kimi-web' ||
      (params.activeBackendKind.value === requestBackend && params.selectedSessionId.value === requestSelection);
    pendingCardMutations.add(payload.sessionId);
    params.clearSessionError();
    try {
      params.setSendStatusKey('app.status.forking');
      if (params.activeBackendKind.value === 'kimi-web') {
        const api = params.kimiWebApi;
        if (!api?.forkSessionAtMessage) throw new Error('Kimi checkpoint forks are unavailable.');
        const raw = await api.forkSessionAtMessage(payload.sessionId, payload.messageId);
        if (!ownsRequest()) return;
        const session = mapKimiWebSession(raw);
        upsertKimiWebSessionIntoProjects(params.serverProjects, session);
        params.seedForkedSessionComposerDraft(payload, { id: session.id });
        await params.switchSessionSelection(session.workspaceId, session.id);
        if (params.activeBackendKind.value !== requestBackend) return;
      } else if (params.activeBackendKind.value === 'codex') {
        const thread = await params.codexApi.forkThread(payload.sessionId);
        if (thread?.id) {
          params.selectedProjectId.value = params.codexProjectId;
          params.selectedSessionId.value = thread.id;
        }
      } else {
        const data = await params.openCodeApi.forkSession({
          sessionId: payload.sessionId,
          messageId: payload.messageId,
          directory: params.activeDirectory.value.trim() || undefined,
          projectId: params.selectedProjectId.value,
        });
        if (data?.id) {
          params.seedForkedSessionComposerDraft(payload, data);
          await params.switchSessionSelection(params.selectedProjectId.value, data.id);
        }
      }
      params.setSendStatusKey('app.status.forked');
    } catch (error) {
      if (!ownsRequest()) return;
      params.setSessionError(
        params.translate('app.error.sessionForkFailed', { message: params.toErrorMessage(error) }),
      );
    } finally {
      pendingCardMutations.delete(payload.sessionId);
    }
  }

  async function handleRevertMessage(payload: { sessionId: string; messageId: string }) {
    if (pendingCardMutations.has(payload.sessionId)) return;
    if (!params.ensureConnectionReady(params.translate('app.actions.revert'))) return;
    const requestBackend = params.activeBackendKind.value;
    const requestSelection = params.selectedSessionId.value;
    const ownsRequest = () => requestBackend !== 'kimi-web' ||
      (params.activeBackendKind.value === requestBackend && params.selectedSessionId.value === requestSelection);
    pendingCardMutations.add(payload.sessionId);
    params.clearSessionError();
    try {
      params.setSendStatusKey('app.status.reverting');
      if (params.activeBackendKind.value === 'kimi-web') {
        const api = params.kimiWebApi;
        if (!api?.undoSessionFromMessage) throw new Error('Kimi checkpoint undo is unavailable.');
        await api.undoSessionFromMessage(payload.sessionId, payload.messageId);
        if (!ownsRequest()) return;
        if (params.selectedSessionId.value === payload.sessionId)
          await params.reloadSelectedSessionState(payload.sessionId, undefined, true);
      } else if (params.activeBackendKind.value === 'codex') {
        const thread = await params.codexApi.rollbackThread(payload.sessionId, payload.messageId);
        if (thread?.id) {
          params.selectedProjectId.value = params.codexProjectId;
          params.selectedSessionId.value = thread.id;
          await params.codexApi.selectThread(thread.id);
          await params.reloadSelectedSessionState(thread.id, undefined, true);
        }
      } else {
        await params.openCodeApi.revertSession({
          sessionId: payload.sessionId,
          messageId: payload.messageId,
          projectId: params.selectedProjectId.value,
          directory: params.activeDirectory.value.trim() || undefined,
        });
        if (params.selectedSessionId.value === payload.sessionId)
          await params.reloadSelectedSessionState(payload.sessionId, undefined, true);
      }
      if (!ownsRequest()) return;
      params.setSendStatusKey('app.status.reverted');
    } catch (error) {
      if (!ownsRequest()) return;
      params.setSessionError(
        params.translate('app.error.sessionRevertFailed', {
          message: params.toErrorMessage(error),
        }),
      );
    } finally {
      pendingCardMutations.delete(payload.sessionId);
    }
  }

  return {
    deleteSession,
    archiveSession,
    unarchiveSession,
    renameSession,
    pinSession,
    unpinSession,
    handleTopPanelBatchSessionAction,
    handleForkMessage,
    handleForkSession,
    handleCompactSession,
    handleRevertMessage,
  };
}
