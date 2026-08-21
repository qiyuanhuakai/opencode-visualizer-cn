import { nextTick, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { MessageCacheIdentity } from './useMessages';

type MessageStoreLike = {
  saveSessionState: (identity: MessageCacheIdentity) => void;
  reset: () => void;
  loadHistory: (history: unknown[]) => void;
  tryLoadFromCache: (identity: MessageCacheIdentity) => boolean;
};

type CodexApiLike = {
  activeThreadId: Ref<string>;
  selectThread: (sessionId: string) => Promise<unknown>;
};

type LoadedMessageCacheContext = {
  backend: BackendKind;
  namespace: string;
  cacheable: boolean;
};

export function useBackendSessionReload(params: {
  activeBackendKind: Ref<BackendKind>;
  activeDirectory: Ref<string>;
  getMessageCacheNamespace: () => string;
  uiInitState: Ref<'loading' | 'ready' | 'error' | 'login'>;
  isBootstrapping: Ref<boolean>;
  isLoadingHistory: Ref<boolean>;
  deferredSessionReloadId: Ref<string | null>;
  sessionReloadRequestId: Ref<number>;
  hydratedDescendantSessionIds: Set<string>;
  msg: MessageStoreLike;
  fwCloseAll: () => void;
  resetFollow: () => void;
  reasoningReset: () => void;
  subagentWindowsReset: () => void;
  clearRetryStatus: () => void;
  codexApi: CodexApiLike;
  codexHistory: Ref<unknown[]>;
  codexReapplyBackfill: () => void;
  fetchRootSessionHistory: (rootSessionId: string) => Promise<number>;
  waitForPendingRenders: () => Promise<void>;
  reserveRootHistoryRequestId: () => number;
  scheduleDescendantSessionHistoryHydration: (
    sessionId: string,
    rootHistoryRequestId: number,
    reloadRequestId: number,
    referencedSessionIds?: string[],
  ) => void;
  hydrateReferencedSubagents?: (
    sessionId: string,
    reloadRequestId: number,
  ) => Promise<string[] | undefined>;
  anchorOutputToBottom: () => Promise<void>;
  restoreShellSessions: () => Promise<void>;
  reloadTodosForAllowedSessions: () => Promise<void> | void;
  fetchPendingPermissions: (directory?: string) => Promise<void> | void;
  fetchPendingQuestions: (directory?: string) => Promise<void> | void;
  focusInput: () => void;
}) {
  let loadedMessageCacheContext: LoadedMessageCacheContext | null = null;

  async function hydrateAndScheduleDescendantHistory(
    sessionId: string,
    rootHistoryRequestId: number,
    reloadRequestId: number,
  ) {
    const referencedSessionIds = params.hydrateReferencedSubagents
      ? await params.hydrateReferencedSubagents(sessionId, reloadRequestId)
      : undefined;
    if (reloadRequestId !== params.sessionReloadRequestId.value) return;
    if (referencedSessionIds) {
      params.scheduleDescendantSessionHistoryHydration(
        sessionId,
        rootHistoryRequestId,
        reloadRequestId,
        referencedSessionIds,
      );
      return;
    }
    params.scheduleDescendantSessionHistoryHydration(
      sessionId,
      rootHistoryRequestId,
      reloadRequestId,
    );
  }

  async function reloadSelectedSessionState(newId?: string, oldId?: string) {
    const reloadRequestId = ++params.sessionReloadRequestId.value;
    const previousCacheContext = loadedMessageCacheContext;
    const nextCacheContext: LoadedMessageCacheContext | null = newId
      ? {
          backend: params.activeBackendKind.value,
          namespace: params.getMessageCacheNamespace(),
          cacheable: false,
        }
      : null;
    if (newId && params.isBootstrapping.value && !params.activeDirectory.value) {
      params.deferredSessionReloadId.value = newId;
      return;
    }
    if (newId) params.deferredSessionReloadId.value = null;

    params.fwCloseAll();
    await nextTick();
    if (reloadRequestId !== params.sessionReloadRequestId.value) return;
    if (oldId && previousCacheContext?.cacheable && previousCacheContext.backend !== 'codex') {
      params.msg.saveSessionState({
        namespace: previousCacheContext.namespace,
        sessionId: oldId,
      });
    }
    loadedMessageCacheContext = nextCacheContext;

    if (newId) {
      const sessionId = newId;
      if (params.activeBackendKind.value === 'codex') {
        params.isLoadingHistory.value = true;
        try {
          const isSessionSwitch = Boolean(oldId) && oldId !== sessionId;
          let nextHistory = params.codexHistory.value;
          if (params.codexApi.activeThreadId.value !== sessionId || nextHistory.length === 0) {
            await params.codexApi.selectThread(sessionId);
            nextHistory = params.codexHistory.value;
          }
          if (isSessionSwitch) {
            params.msg.reset();
          }
          params.resetFollow();
          params.reasoningReset();
          params.subagentWindowsReset();
          params.clearRetryStatus();
          await nextTick();
          params.msg.loadHistory(nextHistory);
          params.codexReapplyBackfill();
        } finally {
          if (reloadRequestId === params.sessionReloadRequestId.value) {
            params.isLoadingHistory.value = false;
          }
        }
        if (reloadRequestId !== params.sessionReloadRequestId.value) return;
        await params.anchorOutputToBottom();
        if (reloadRequestId !== params.sessionReloadRequestId.value) return;
        params.focusInput();
        return;
      }

      params.msg.reset();
      params.resetFollow();
      params.reasoningReset();
      params.subagentWindowsReset();
      params.clearRetryStatus();
      await nextTick();

      const cacheHit = params.msg.tryLoadFromCache({
        namespace: nextCacheContext?.namespace ?? params.getMessageCacheNamespace(),
        sessionId,
      });
      if (cacheHit && loadedMessageCacheContext === nextCacheContext && nextCacheContext) {
        nextCacheContext.cacheable = true;
      }
      const descendantsHydrated = params.hydratedDescendantSessionIds.has(sessionId);
      if (!cacheHit) {
        params.hydratedDescendantSessionIds.delete(sessionId);
        params.isLoadingHistory.value = true;
        let rootHistoryRequestId = 0;
        try {
          rootHistoryRequestId = await params.fetchRootSessionHistory(sessionId);
          if (reloadRequestId !== params.sessionReloadRequestId.value) return;
          if (loadedMessageCacheContext === nextCacheContext && nextCacheContext) {
            nextCacheContext.cacheable = true;
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await params.waitForPendingRenders();
          await hydrateAndScheduleDescendantHistory(
            sessionId,
            rootHistoryRequestId,
            reloadRequestId,
          );
        } catch {
          // Keep partial history if hydration/rendering fails.
        } finally {
          if (reloadRequestId === params.sessionReloadRequestId.value) {
            params.isLoadingHistory.value = false;
          }
        }
      } else if (!descendantsHydrated) {
        const rootHistoryRequestId = params.reserveRootHistoryRequestId();
        await hydrateAndScheduleDescendantHistory(
          sessionId,
          rootHistoryRequestId,
          reloadRequestId,
        );
      }

      if (reloadRequestId !== params.sessionReloadRequestId.value) return;
      await params.anchorOutputToBottom();
      if (reloadRequestId !== params.sessionReloadRequestId.value) return;
      if (params.uiInitState.value === 'ready') {
        await params.restoreShellSessions();
      }
      void params.reloadTodosForAllowedSessions();
      const directory = params.activeDirectory.value || undefined;
      void params.fetchPendingPermissions(directory);
      void params.fetchPendingQuestions(directory);
    }

    if (reloadRequestId !== params.sessionReloadRequestId.value) return;
    params.focusInput();
  }

  return {
    reloadSelectedSessionState,
  };
}
