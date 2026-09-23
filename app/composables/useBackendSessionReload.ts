import { nextTick, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import { loadKimiWebHistoryEntries } from '../backends/kimiWeb/history';
import type { KimiWebClient } from '../utils/kimiWeb';
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
  /** Kimi Web session-history REST pager; absent until the adapter is wired. */
  kimiWebApi?: Pick<KimiWebClient, 'getMessages'> & Partial<Pick<KimiWebClient, 'getSessionStatus' | 'listModels'>>;
  kimiWebBridge?: {
    subscribe(sessionIds: string[]): Promise<unknown>;
    applyHistory(entries: unknown[]): void;
  };
  kimiWebHistoryMaxPages?: number;
  kimiWebHistoryPageSize?: number;
  /** Fires when the page cap bounded a history load (never silent). */
  onKimiWebHistoryTruncated?: (info: { sessionId: string; pages: number }) => void;
  fetchRootSessionHistory: (
    rootSessionId: string,
  ) => Promise<{ requestId: number; loaded: boolean }>;
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
  anchorOutputToBottom: (waitForRenders?: boolean) => Promise<void>;
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

  async function reloadSelectedSessionState(newId?: string, oldId?: string, forceReset = false) {
    const reloadRequestId = ++params.sessionReloadRequestId.value;
    params.isLoadingHistory.value = Boolean(newId) && params.activeBackendKind.value === 'codex';
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
    if (!newId) params.msg.reset();

    if (newId) {
      const sessionId = newId;
      if (params.activeBackendKind.value === 'codex') {
        params.isLoadingHistory.value = true;
        try {
          const isSessionSwitch = Boolean(oldId) && oldId !== sessionId;
          let nextHistory = params.codexHistory.value;
          if (params.codexApi.activeThreadId.value !== sessionId || nextHistory.length === 0) {
            await params.codexApi.selectThread(sessionId);
            if (reloadRequestId !== params.sessionReloadRequestId.value) return;
            nextHistory = params.codexHistory.value;
          }
          if (isSessionSwitch || forceReset) {
            params.msg.reset();
          }
          params.resetFollow();
          params.reasoningReset();
          params.subagentWindowsReset();
          params.clearRetryStatus();
          await nextTick();
          if (reloadRequestId !== params.sessionReloadRequestId.value) return;
          params.msg.loadHistory(nextHistory);
          params.codexReapplyBackfill();
          try {
            await params.anchorOutputToBottom(false);
          } catch (error) {
            console.error('[codex] Output anchoring failed:', error);
          }
        } finally {
          if (reloadRequestId === params.sessionReloadRequestId.value) {
            params.isLoadingHistory.value = false;
          }
        }
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
      if (reloadRequestId !== params.sessionReloadRequestId.value) return;

      if (params.activeBackendKind.value === 'kimi-web') {
        if (params.kimiWebApi) {
          params.isLoadingHistory.value = true;
          try {
            const [status, catalog] = params.kimiWebApi.getSessionStatus && params.kimiWebApi.listModels
              ? await Promise.all([
                  params.kimiWebApi.getSessionStatus(sessionId).catch(() => undefined),
                  params.kimiWebApi.listModels().catch(() => undefined),
                ])
              : [undefined, undefined];
            const result = await loadKimiWebHistoryEntries({
              sessionId,
              getMessages: params.kimiWebApi.getMessages,
              maxPages: params.kimiWebHistoryMaxPages,
              pageSize: params.kimiWebHistoryPageSize,
              isCurrent: () => reloadRequestId === params.sessionReloadRequestId.value,
              profile: {
                model: status?.model,
                provider: catalog?.items.find((item) => item.model === status?.model)?.provider,
                effort: status?.thinking_level,
                permission: status?.permission,
              },
            });
            if (reloadRequestId !== params.sessionReloadRequestId.value) return;
            if (result.truncated) {
              params.onKimiWebHistoryTruncated?.({ sessionId, pages: result.pages });
            }
            if (params.kimiWebBridge) {
              params.kimiWebBridge.applyHistory(result.entries);
              await params.kimiWebBridge.subscribe([sessionId]);
            } else {
              params.msg.loadHistory(result.entries);
            }
            await params.anchorOutputToBottom();
          } finally {
            if (reloadRequestId === params.sessionReloadRequestId.value) {
              params.isLoadingHistory.value = false;
            }
          }
        }
        if (reloadRequestId !== params.sessionReloadRequestId.value) return;
        params.focusInput();
        return;
      }

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
        try {
          const rootHistory = await params.fetchRootSessionHistory(sessionId);
          if (reloadRequestId !== params.sessionReloadRequestId.value) return;
          params.isLoadingHistory.value = false;
          if (rootHistory.loaded && reloadRequestId === params.sessionReloadRequestId.value) {
            if (loadedMessageCacheContext === nextCacheContext && nextCacheContext) {
              nextCacheContext.cacheable = true;
            }
            await new Promise((resolve) => requestAnimationFrame(resolve));
            await params.waitForPendingRenders();
            await hydrateAndScheduleDescendantHistory(
              sessionId,
              rootHistory.requestId,
              reloadRequestId,
            );
          }
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

  function invalidateMessageCacheContext() {
    loadedMessageCacheContext = null;
    params.isLoadingHistory.value = false;
  }

  return {
    reloadSelectedSessionState,
    invalidateMessageCacheContext,
  };
}
