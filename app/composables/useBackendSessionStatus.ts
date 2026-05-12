import { computed, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';

export function useBackendSessionStatus(params: {
  activeBackendKind: Ref<BackendKind>;
  selectedSessionId: Ref<string>;
  busyDescendantCount: Ref<number>;
  runningToolCount: Ref<number>;
  codexActiveTurnStatus: Ref<string | undefined>;
  getSessionStatus: (sessionId: string) => string | undefined;
}) {
  const isThinking = computed(() => {
    if (params.activeBackendKind.value === 'codex') {
      const status = params.codexActiveTurnStatus.value;
      return Boolean(status && status !== 'completed' && status !== 'failed' && status !== 'interrupted');
    }
    const selected = params.selectedSessionId.value;
    const ownStatus = selected ? params.getSessionStatus(selected) : undefined;
    return Boolean(
      ownStatus === 'busy'
      || ownStatus === 'retry'
      || params.busyDescendantCount.value > 0
      || params.runningToolCount.value > 0,
    );
  });

  return {
    isThinking,
  };
}
