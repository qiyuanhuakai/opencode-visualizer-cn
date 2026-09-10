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
    const selected = params.selectedSessionId.value;
    const ownStatus = selected ? params.getSessionStatus(selected) : undefined;
    const turnStatus = params.codexActiveTurnStatus.value;
    const codexTurnActive = params.activeBackendKind.value === 'codex'
      && ownStatus === undefined
      && Boolean(turnStatus && turnStatus !== 'completed' && turnStatus !== 'failed' && turnStatus !== 'interrupted');
    return Boolean(
      ownStatus === 'busy'
      || ownStatus === 'retry'
      || codexTurnActive
      || params.busyDescendantCount.value > 0
      || params.runningToolCount.value > 0,
    );
  });

  return {
    isThinking,
  };
}
