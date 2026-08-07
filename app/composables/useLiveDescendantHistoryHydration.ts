import { ref, watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

export function useLiveDescendantHistoryHydration(params: {
  activeBackendKind: Ref<BackendKind>;
  selectedSessionId: Ref<string>;
  allowedSessionIds: Ref<ReadonlySet<string>>;
  hydrate: (rootSessionId: string, descendantSessionIds: string[]) => Promise<boolean>;
}) {
  const requested = new Set<string>();
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryTick = ref(0);

  function scheduleRetry(rootSessionId: string, descendantSessionIds: string[]) {
    descendantSessionIds.forEach((sessionId) => {
      const key = `${rootSessionId}\u0000${sessionId}`;
      requested.delete(key);
      if (retryTimers.has(key)) return;
      const attempt = (retryAttempts.get(key) ?? 0) + 1;
      retryAttempts.set(key, attempt);
      if (attempt > MAX_RETRY_ATTEMPTS) return;
      const timer = setTimeout(
        () => {
          retryTimers.delete(key);
          retryTick.value += 1;
        },
        RETRY_DELAY_MS * 2 ** (attempt - 1),
      );
      retryTimers.set(key, timer);
    });
  }

  function markLoaded(rootSessionId: string, descendantSessionIds: string[]) {
    descendantSessionIds.forEach((sessionId) => {
      const key = `${rootSessionId}\u0000${sessionId}`;
      retryAttempts.delete(key);
      const timer = retryTimers.get(key);
      if (timer) clearTimeout(timer);
      retryTimers.delete(key);
    });
  }

  watch(
    [params.activeBackendKind, params.selectedSessionId, params.allowedSessionIds, retryTick],
    ([backendKind, rootSessionId, allowedSessionIds]) => {
      if (backendKind !== 'opencode' || !rootSessionId) return;
      const descendantSessionIds = [...allowedSessionIds].filter((sessionId) => {
        if (sessionId === rootSessionId) return false;
        return !requested.has(`${rootSessionId}\u0000${sessionId}`);
      });
      if (descendantSessionIds.length === 0) return;

      descendantSessionIds.forEach((sessionId) => {
        requested.add(`${rootSessionId}\u0000${sessionId}`);
      });
      void params
        .hydrate(rootSessionId, descendantSessionIds)
        .then((loaded) => {
          if (loaded) markLoaded(rootSessionId, descendantSessionIds);
          else scheduleRetry(rootSessionId, descendantSessionIds);
        })
        .catch(() => {
          scheduleRetry(rootSessionId, descendantSessionIds);
        });
    },
    { immediate: true },
  );
}
