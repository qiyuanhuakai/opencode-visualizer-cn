import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

type HydrationState = {
  status: 'ready' | 'pending' | 'loaded' | 'waiting' | 'exhausted';
  retries: number;
};

export function useLiveDescendantHistoryHydration(params: {
  activeBackendKind: Ref<BackendKind>;
  selectedSessionId: Ref<string>;
  allowedSessionIds: Ref<ReadonlySet<string>>;
  hydrate: (rootSessionId: string, descendantSessionIds: string[]) => Promise<boolean>;
}) {
  const states = new Map<string, HydrationState>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryTick = ref(0);
  let activeScope = '';
  let generation = 0;

  function clearScope() {
    retryTimers.forEach((timer) => clearTimeout(timer));
    retryTimers.clear();
    states.clear();
    generation += 1;
  }

  function recordFailure(key: string, requestGeneration: number) {
    if (requestGeneration !== generation) return;
    const retries = (states.get(key)?.retries ?? 0) + 1;
    if (retries > MAX_RETRY_ATTEMPTS) {
      states.set(key, { status: 'exhausted', retries });
      return;
    }
    states.set(key, { status: 'waiting', retries });
    const timer = setTimeout(
      () => {
        retryTimers.delete(key);
        if (requestGeneration !== generation) return;
        states.set(key, { status: 'ready', retries });
        retryTick.value += 1;
      },
      RETRY_DELAY_MS * 2 ** (retries - 1),
    );
    retryTimers.set(key, timer);
  }

  watch(
    [params.activeBackendKind, params.selectedSessionId, params.allowedSessionIds, retryTick],
    ([backendKind, rootSessionId, allowedSessionIds]) => {
      const nextScope = backendKind === 'opencode' && rootSessionId ? rootSessionId : '';
      if (nextScope !== activeScope) {
        clearScope();
        activeScope = nextScope;
      }
      if (!nextScope) return;

      const descendantSessionIds = [...allowedSessionIds].filter((sessionId) => {
        if (sessionId === rootSessionId) return false;
        const state = states.get(`${rootSessionId}\u0000${sessionId}`);
        return !state || state.status === 'ready';
      });
      if (descendantSessionIds.length === 0) return;

      const requestGeneration = generation;
      descendantSessionIds.forEach((sessionId) => {
        const key = `${rootSessionId}\u0000${sessionId}`;
        states.set(key, { status: 'pending', retries: states.get(key)?.retries ?? 0 });
      });
      void params
        .hydrate(rootSessionId, descendantSessionIds)
        .then((loaded) => {
          if (requestGeneration !== generation) return;
          descendantSessionIds.forEach((sessionId) => {
            const key = `${rootSessionId}\u0000${sessionId}`;
            if (loaded) states.set(key, { status: 'loaded', retries: 0 });
            else recordFailure(key, requestGeneration);
          });
        })
        .catch(() => {
          descendantSessionIds.forEach((sessionId) => {
            recordFailure(`${rootSessionId}\u0000${sessionId}`, requestGeneration);
          });
        });
    },
    { immediate: true },
  );

  if (getCurrentScope()) onScopeDispose(clearScope);
}
