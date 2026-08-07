import { watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';

export function useLiveDescendantHistoryHydration(params: {
  activeBackendKind: Ref<BackendKind>;
  selectedSessionId: Ref<string>;
  allowedSessionIds: Ref<ReadonlySet<string>>;
  hydrate: (rootSessionId: string, descendantSessionIds: string[]) => Promise<void>;
}) {
  const requested = new Set<string>();

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
      void params.hydrate(rootSessionId, descendantSessionIds).catch(() => {
        descendantSessionIds.forEach((sessionId) => {
          requested.delete(`${rootSessionId}\u0000${sessionId}`);
        });
      });
    },
    { immediate: true },
  );
}
