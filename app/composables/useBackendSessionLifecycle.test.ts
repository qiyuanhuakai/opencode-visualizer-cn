import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionLifecycle } from './useBackendSessionLifecycle';

describe('useBackendSessionLifecycle', () => {
  it('creates and selects a Codex session through the lifecycle runtime', async () => {
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const homePath = ref('/home/test');
    const codexPendingSessionLock = ref('');
    const isAborting = ref(false);
    const lifecycle = useBackendSessionLifecycle({
      activeBackendKind: ref('codex'),
      codexProjectId: 'codex',
      selectedProjectId,
      selectedSessionId,
      activeDirectory: ref('/repo'),
      homePath,
      codexPendingSessionLock,
      codexSessionCreationByDirectory: new Map(),
      openCodeApi: {
        createSession: vi.fn(),
      },
      codexApi: {
        homeDir: ref('/home/test'),
        activeThreadId: ref(''),
        visibleThreads: ref([]),
        startThread: vi.fn().mockResolvedValue({ id: 'thread-1', cwd: '/repo', name: 'Thread One' }),
        refreshHomeDir: vi.fn().mockResolvedValue('/home/test'),
        interruptActiveTurn: vi.fn(),
      },
      normalizeProjectDirectoryForActiveBackend: (directory) => directory,
      codexThreadDirectoryMatch: () => false,
      ensureConnectionReady: () => true,
      translate: (key) => key,
      toErrorMessage: (error) => String(error),
      setSessionError: vi.fn(),
      clearSessionError: vi.fn(),
      setSendStatusKey: vi.fn(),
      isAborting,
      busyDescendantSessionIds: ref([]),
      backendAbortSession: undefined,
    });

    const session = await lifecycle.createSessionInDirectory('/repo');

    expect(session?.id).toBe('thread-1');
    expect(selectedProjectId.value).toBe('codex');
    expect(selectedSessionId.value).toBe('thread-1');
    expect(codexPendingSessionLock.value).toBe('thread-1');
  });

  it('aborts opencode session and busy descendants through backend abort', async () => {
    const abortSession = vi.fn().mockResolvedValue(undefined);
    const setSendStatusKey = vi.fn();
    const lifecycle = useBackendSessionLifecycle({
      activeBackendKind: ref('opencode'),
      codexProjectId: 'codex',
      selectedProjectId: ref('proj-1'),
      selectedSessionId: ref('session-root'),
      activeDirectory: ref('/repo'),
      homePath: ref('/home/test'),
      codexPendingSessionLock: ref(''),
      codexSessionCreationByDirectory: new Map(),
      openCodeApi: {
        createSession: vi.fn(),
      },
      codexApi: {
        homeDir: ref('/home/test'),
        activeThreadId: ref(''),
        visibleThreads: ref([]),
        startThread: vi.fn(),
        refreshHomeDir: vi.fn(),
        interruptActiveTurn: vi.fn(),
      },
      normalizeProjectDirectoryForActiveBackend: (directory) => directory,
      codexThreadDirectoryMatch: () => false,
      ensureConnectionReady: () => true,
      translate: (key) => key,
      toErrorMessage: (error) => String(error),
      setSessionError: vi.fn(),
      clearSessionError: vi.fn(),
      setSendStatusKey,
      isAborting: ref(false),
      busyDescendantSessionIds: ref(['child-1', 'child-2']),
      backendAbortSession: abortSession,
    });

    await lifecycle.abortSession();

    expect(abortSession).toHaveBeenCalledTimes(3);
    expect(abortSession).toHaveBeenNthCalledWith(1, 'session-root', '/repo');
    expect(abortSession).toHaveBeenNthCalledWith(2, 'child-1', '/repo');
    expect(abortSession).toHaveBeenNthCalledWith(3, 'child-2', '/repo');
    expect(setSendStatusKey).toHaveBeenLastCalledWith('app.status.stopped');
  });
});
