import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { BackendSessionInfo } from '../types/backend-domain';
import type { TopPanelBatchSessionActionPayload, TopPanelBatchSessionTarget } from '../types/top-panel';
import type { SandboxState, ProjectState } from '../types/worker-state';
import type { LocalPinnedSessionStore } from '../utils/pinnedSessions';
import { pinnedSessionStoreKey, projectPinKey, sandboxPinKey } from '../utils/pinnedSessions';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';
import { isBatchSessionAction, normalizeBatchSessionTargets } from '../utils/batchSessionTargets';

type OpenCodeApiLike = {
  deleteSession: (payload: { sessionId: string; projectId: string; directory?: string }) => Promise<void>;
  archiveSession: (payload: { sessionId: string; projectId: string; directory?: string }) => Promise<unknown>;
  unarchiveSession: (payload: { sessionId: string; projectId: string; directory?: string }) => Promise<unknown>;
  renameSession: (payload: { sessionId: string; projectId: string; directory?: string; title: string }) => Promise<unknown>;
  pinSession: (payload: { sessionId: string; projectId: string; directory?: string; pinnedAt?: number }) => Promise<unknown>;
  unpinSession: (payload: { sessionId: string; projectId: string; directory?: string }) => Promise<unknown>;
  forkSession: (payload: { sessionId: string; messageId: string; directory?: string; projectId: string }) => Promise<BackendSessionInfo>;
  revertSession: (payload: { sessionId: string; messageId: string; projectId: string; directory?: string }) => Promise<void>;
};

type CodexApiLike = {
  hiddenThreadIds: Ref<Set<string>>;
  visibleThreads: Ref<Array<{ id: string }>>;
  activeThreadId: Ref<string>;
  archiveThread: (sessionId: string) => Promise<unknown>;
  hideThread: (sessionId: string) => void;
  unhideThread: (sessionId: string) => void;
  unarchiveThread: (sessionId: string) => Promise<unknown>;
  setThreadName: (sessionId: string, name: string) => Promise<unknown>;
  pinThread: (sessionId: string) => void;
  unpinThread: (sessionId: string) => void;
  forkThread: (sessionId: string) => Promise<{ id?: string }>;
  rollbackThread: (sessionId: string, numTurns?: number) => Promise<{ id?: string }>;
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
  findSessionInProjects: (sessionId: string) => { projectId: string; sandbox: SandboxState; session: BackendSessionInfo } | null;
  resolveProjectIdForSession: (sessionId: string) => string;
  resolveSessionOperationPayload: (sessionId: string, projectIdHint?: string, directoryHint?: string) => { projectId: string; directory?: string };
  getSessionPinnedOverride: (projectId: string, sessionId: string) => number | undefined;
  setLocalPinnedSession: (projectId: string, sessionId: string, pinnedAt: number) => void;
  setLocalUnpinnedSession: (projectId: string, sessionId: string) => void;
  clearLocalPinnedSessionOverride: (projectId: string, sessionId: string) => void;
  restoreLocalPinnedSessionOverride: (projectId: string, sessionId: string, previousOverride?: number) => void;
  switchSessionSelection: (projectId: string, sessionId: string) => Promise<void>;
  reloadSelectedSessionState: (sessionId?: string) => Promise<void>;
  seedForkedSessionComposerDraft: (payload: { sessionId: string; messageId: string }, session: BackendSessionInfo) => void;
  setSendStatusKey: (key: string) => void;
  batchConcurrency: number;
}) {
  async function deleteSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.deletingSession'))) return;
    params.clearSessionError();
    if (!sessionId) return;
    let optimisticProjectId = '';
    let previousOverride: number | undefined;
    try {
      if (params.activeBackendKind.value === 'codex') {
        await params.codexApi.archiveThread(sessionId);
        if (params.selectedSessionId.value === sessionId) {
          params.selectedSessionId.value = params.codexApi.activeThreadId.value || params.codexApi.visibleThreads.value[0]?.id || '';
        }
        return;
      }
      const { projectId, directory } = params.resolveSessionOperationPayload(sessionId, hints?.projectId, hints?.directory);
      optimisticProjectId = projectId;
      previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
      params.clearLocalPinnedSessionOverride(projectId, sessionId);
      await params.openCodeApi.deleteSession({ sessionId, projectId, directory });
    } catch (error) {
      if (optimisticProjectId) params.restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
      params.setSessionError(params.translate('app.error.sessionDeleteFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function archiveSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.archivingSession'))) return;
    params.clearSessionError();
    if (!sessionId) return;
    let optimisticProjectId = '';
    let previousOverride: number | undefined;
    try {
      if (params.activeBackendKind.value === 'codex') {
        params.codexApi.hideThread(sessionId);
        if (params.selectedSessionId.value === sessionId) {
          params.selectedSessionId.value = params.codexApi.activeThreadId.value || params.codexApi.visibleThreads.value[0]?.id || '';
        }
        return;
      }
      const { projectId, directory } = params.resolveSessionOperationPayload(sessionId, hints?.projectId, hints?.directory);
      optimisticProjectId = projectId;
      previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
      params.clearLocalPinnedSessionOverride(projectId, sessionId);
      await params.openCodeApi.archiveSession({ sessionId, projectId, directory });
    } catch (error) {
      if (optimisticProjectId) params.restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
      params.setSessionError(params.translate('app.error.sessionArchiveFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function unarchiveSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.unarchivingSession'))) return;
    params.clearSessionError();
    if (!sessionId) return;
    let optimisticProjectId = '';
    let previousOverride: number | undefined;
    try {
      if (params.activeBackendKind.value === 'codex') {
        if (params.codexApi.hiddenThreadIds.value.has(sessionId)) {
          params.codexApi.unhideThread(sessionId);
          params.selectedProjectId.value = params.codexProjectId;
          params.selectedSessionId.value = sessionId;
          await params.codexApi.selectThread(sessionId);
        } else {
          await params.codexApi.unarchiveThread(sessionId);
          params.selectedSessionId.value = params.codexApi.activeThreadId.value || sessionId;
        }
        return;
      }
      const { projectId, directory } = params.resolveSessionOperationPayload(sessionId, hints?.projectId, hints?.directory);
      optimisticProjectId = projectId;
      previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
      params.clearLocalPinnedSessionOverride(projectId, sessionId);
      await params.openCodeApi.unarchiveSession({ sessionId, projectId, directory });
    } catch (error) {
      if (optimisticProjectId) params.restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
      params.setSessionError(params.translate('app.error.sessionUnarchiveFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function renameSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.renamingSession'))) return;
    params.clearSessionError();
    if (!sessionId) return;
    try {
      const resolved = params.findSessionInProjects(sessionId);
      const currentTitle = resolved?.session.title?.trim() || resolved?.session.slug?.trim() || sessionId;
      const nextTitle = await params.showPrompt(params.translate('topPanel.sessionActions.rename'), currentTitle);
      if (nextTitle === null) return;
      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle || trimmedTitle === currentTitle) return;
      if (params.activeBackendKind.value === 'codex') {
        await params.codexApi.setThreadName(sessionId, trimmedTitle);
        return;
      }
      const { projectId, directory } = params.resolveSessionOperationPayload(sessionId, hints?.projectId, hints?.directory);
      await params.openCodeApi.renameSession({ sessionId, projectId, directory, title: trimmedTitle });
    } catch (error) {
      params.setSessionError(params.translate('app.error.sessionRenameFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function pinSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.pinningSession'))) return;
    params.clearSessionError();
    if (!sessionId) return;
    let optimisticProjectId = '';
    let previousOverride: number | undefined;
    try {
      if (params.activeBackendKind.value === 'codex') {
        params.codexApi.pinThread(sessionId);
        return;
      }
      const { projectId, directory } = params.resolveSessionOperationPayload(sessionId, hints?.projectId, hints?.directory);
      optimisticProjectId = projectId;
      previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
      const pinnedAt = Date.now();
      params.setLocalPinnedSession(projectId, sessionId, pinnedAt);
      await params.openCodeApi.pinSession({ sessionId, projectId, directory, pinnedAt });
    } catch (error) {
      if (optimisticProjectId) params.restoreLocalPinnedSessionOverride(optimisticProjectId, sessionId, previousOverride);
      params.setSessionError(params.translate('app.error.sessionPinFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function unpinSession(sessionId: string, hints?: { projectId?: string; directory?: string }) {
    if (!sessionId) return;
    if (params.activeBackendKind.value === 'codex') {
      params.codexApi.unpinThread(sessionId);
      return;
    }

    const { projectId, directory } = params.resolveSessionOperationPayload(sessionId, hints?.projectId, hints?.directory);
    const sessionKey = pinnedSessionStoreKey(projectId, sessionId);
    const isDirectlyPinned = Boolean(sessionKey && params.localPinnedSessionStore.value[sessionKey] > 0);
    if (!isDirectlyPinned) {
      const next = { ...params.localPinnedSessionStore.value };
      if (sessionKey) next[sessionKey] = -Date.now();
      if (directory) {
        const sandboxKey = sandboxPinKey(projectId, directory);
        const isSandboxDirectlyPinned = Boolean(sandboxKey && next[sandboxKey] > 0);
        if (!isSandboxDirectlyPinned) {
          const project = params.serverProjects[projectId];
          const sandbox = project?.sandboxes?.[directory];
          if (sandbox) {
            let hasVisibleSession = false;
            for (const s of Object.values(sandbox.sessions)) {
              if (s.parentID || s.timeArchived) continue;
              if (s.id === sessionId) continue;
              const sKey = pinnedSessionStoreKey(projectId, s.id);
              if (sKey && next[sKey] < 0) continue;
              hasVisibleSession = true;
              break;
            }
            if (!hasVisibleSession) {
              if (sandboxKey) next[sandboxKey] = -Date.now();
              const projectKey = projectPinKey(projectId);
              if (projectKey && next[projectKey] > 0 && project) {
                let hasVisibleSandbox = false;
                for (const sb of Object.values(project.sandboxes) as SandboxState[]) {
                  const sbKey = sandboxPinKey(projectId, sb.directory);
                  if (sbKey && next[sbKey] < 0) continue;
                  if ((sbKey && next[sbKey] > 0) || next[projectKey] > 0) {
                    hasVisibleSandbox = true;
                    break;
                  }
                }
                if (!hasVisibleSandbox) delete next[projectKey];
              }
            }
          }
        }
      }
      params.localPinnedSessionStore.value = next;
      return;
    }

    if (!params.ensureConnectionReady(params.translate('app.actions.unpinningSession'))) return;
    params.clearSessionError();
    let previousOverride: number | undefined;
    try {
      previousOverride = params.getSessionPinnedOverride(projectId, sessionId);
      params.setLocalUnpinnedSession(projectId, sessionId);
      await params.openCodeApi.unpinSession({ sessionId, projectId, directory });
    } catch (error) {
      params.restoreLocalPinnedSessionOverride(projectId, sessionId, previousOverride);
      params.setSessionError(params.translate('app.error.sessionUnpinFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function runTopPanelBatchSessionActionTarget(action: TopPanelBatchSessionActionPayload['action'], target: TopPanelBatchSessionTarget) {
    switch (action) {
      case 'pin':
        await pinSession(target.sessionId, { projectId: target.projectId, directory: target.directory });
        return;
      case 'unpin':
        await unpinSession(target.sessionId, { projectId: target.projectId, directory: target.directory });
        return;
      case 'archive':
        await archiveSession(target.sessionId, { projectId: target.projectId, directory: target.directory });
        return;
      case 'unarchive':
        await unarchiveSession(target.sessionId, { projectId: target.projectId, directory: target.directory });
        return;
      case 'delete':
        await deleteSession(target.sessionId, { projectId: target.projectId, directory: target.directory });
        return;
      default:
        throw new Error(`Unsupported batch session action: ${action}`);
    }
  }

  async function handleTopPanelBatchSessionAction(payload: TopPanelBatchSessionActionPayload) {
    if (!payload || !Array.isArray(payload.sessions) || payload.sessions.length === 0) return;
    if (!params.ensureConnectionReady(params.translate('app.actions.batchSessionOperation'))) return;
    if (!isBatchSessionAction(payload.action)) {
      params.setSessionError(params.translate('app.error.batchOperationPartialFailure', {
        action: 'unknown',
        failures: 1,
        total: payload.sessions.length,
        firstError: `Unsupported batch session action: ${String(payload.action)}`,
      }));
      return;
    }
    const targets = normalizeBatchSessionTargets(payload.sessions) as TopPanelBatchSessionTarget[];
    if (targets.length === 0) return;
    params.clearSessionError();
    const results = await mapWithConcurrency(targets, params.batchConcurrency, async (target) => {
      await runTopPanelBatchSessionActionTarget(payload.action, target);
    });
    const failures = results.flatMap((result, index) => result?.status === 'rejected'
      ? [`${targets[index]?.sessionId}: ${params.toErrorMessage(result.reason)}`]
      : []);
    if (failures.length > 0) {
      params.setSessionError(params.translate('app.error.batchOperationPartialFailure', {
        action: payload.action,
        failures: failures.length,
        total: targets.length,
        firstError: failures[0],
      }));
    }
  }

  async function handleForkMessage(payload: { sessionId: string; messageId: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.fork'))) return;
    params.clearSessionError();
    try {
      params.setSendStatusKey('app.status.forking');
      if (params.activeBackendKind.value === 'codex') {
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
      params.setSessionError(params.translate('app.error.sessionForkFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function handleRevertMessage(payload: { sessionId: string; messageId: string }) {
    if (!params.ensureConnectionReady(params.translate('app.actions.revert'))) return;
    params.clearSessionError();
    try {
      params.setSendStatusKey('app.status.reverting');
      if (params.activeBackendKind.value === 'codex') {
        const thread = await params.codexApi.rollbackThread(payload.sessionId, 1);
        if (thread?.id) {
          params.selectedProjectId.value = params.codexProjectId;
          params.selectedSessionId.value = thread.id;
          await params.codexApi.selectThread(thread.id);
          await params.reloadSelectedSessionState(thread.id);
        }
      } else {
        await params.openCodeApi.revertSession({
          sessionId: payload.sessionId,
          messageId: payload.messageId,
          projectId: params.selectedProjectId.value,
          directory: params.activeDirectory.value.trim() || undefined,
        });
        if (params.selectedSessionId.value === payload.sessionId) await params.reloadSelectedSessionState();
      }
      params.setSendStatusKey('app.status.reverted');
    } catch (error) {
      params.setSessionError(params.translate('app.error.sessionRevertFailed', { message: params.toErrorMessage(error) }));
    }
  }

  async function compactSession(sessionId: string) {
    if (params.activeBackendKind.value !== 'codex' || !sessionId) return;
    const confirmed = await params.showConfirm(params.translate('codexPanel.compactThreadConfirm'));
    if (!confirmed) return;
    params.clearSessionError();
    try {
      await params.codexApi.startThreadCompaction(sessionId);
    } catch (error) {
      params.setSessionError(params.toErrorMessage(error));
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
    handleRevertMessage,
    compactSession,
  };
}
