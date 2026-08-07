import { watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';

export function useLiveDescendantHistoryHydration(params: {
  activeBackendKind: Ref<BackendKind>;
  selectedSessionId: Ref<string>;
  allowedSessionIds: Ref<ReadonlySet<string>>;
  hydrate: (rootSessionId: string, descendantSessionIds: string[]) => Promise<boolean>;
}) {
  const requested = new Set<string>();

  function release(rootSessionId: string, descendantSessionIds: string[]) {
    descendantSessionIds.forEach((sessionId) => {
      requested.delete(`${rootSessionId}\u0000${sessionId}`);
    });
  }

  watch(
    [params.activeBackendKind, params.selectedSessionId, params.allowedSessionIds],
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
          if (!loaded) release(rootSessionId, descendantSessionIds);
        })
        .catch(() => {
          release(rootSessionId, descendantSessionIds);
        });
    },
    { immediate: true },
  );
}
