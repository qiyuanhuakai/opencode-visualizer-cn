import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionStatus } from './useBackendSessionStatus';

describe('useBackendSessionStatus', () => {
  it('uses Codex active turn status for thinking state', () => {
    const runtime = useBackendSessionStatus({
      activeBackendKind: ref('codex'),
      selectedSessionId: ref('session-1'),
      busyDescendantCount: ref(0),
      runningToolCount: ref(0),
      codexActiveTurnStatus: ref('in_progress'),
      getSessionStatus: () => 'idle',
    });

    expect(runtime.isThinking.value).toBe(true);
  });

  it('uses generic session activity for non-Codex backends', () => {
    const runtime = useBackendSessionStatus({
      activeBackendKind: ref('opencode'),
      selectedSessionId: ref('session-1'),
      busyDescendantCount: ref(1),
      runningToolCount: ref(0),
      codexActiveTurnStatus: ref(undefined),
      getSessionStatus: () => 'idle',
    });

    expect(runtime.isThinking.value).toBe(true);
  });
});
