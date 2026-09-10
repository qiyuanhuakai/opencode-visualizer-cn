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
      getSessionStatus: () => undefined,
    });

    expect(runtime.isThinking.value).toBe(true);
  });

  it.each(['busy', 'retry'])('restores Codex thinking from %s session status without a live turn', (status) => {
    const runtime = useBackendSessionStatus({
      activeBackendKind: ref('codex'), selectedSessionId: ref('session-1'),
      busyDescendantCount: ref(0), runningToolCount: ref(0),
      codexActiveTurnStatus: ref(undefined), getSessionStatus: () => status,
    });
    expect(runtime.isThinking.value).toBe(true);
  });

  it('stops thinking when authoritative session status becomes idle despite stale turn metadata', () => {
    const status = ref('busy');
    const runtime = useBackendSessionStatus({
      activeBackendKind: ref('codex'), selectedSessionId: ref('session-1'),
      busyDescendantCount: ref(0), runningToolCount: ref(0),
      codexActiveTurnStatus: ref('inProgress'), getSessionStatus: () => status.value,
    });
    expect(runtime.isThinking.value).toBe(true);
    status.value = 'idle';
    expect(runtime.isThinking.value).toBe(false);
  });

  it('keeps Codex thinking while a descendant is busy', () => {
    const runtime = useBackendSessionStatus({
      activeBackendKind: ref('codex'), selectedSessionId: ref('session-1'),
      busyDescendantCount: ref(1), runningToolCount: ref(0),
      codexActiveTurnStatus: ref('completed'), getSessionStatus: () => 'idle',
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
