import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  createDynamicBackendAbortSession,
  sessionProjectIdForBackend,
  useBackendSessionLifecycle,
} from './useBackendSessionLifecycle';

describe('useBackendSessionLifecycle', () => {
  it('maps ACP session creation to the ACP synthetic project', () => {
    expect(sessionProjectIdForBackend('acp', 'codex', 'acp')).toBe('acp');
  });

  it('routes aborts through the backend active at call time', async () => {
    const openCodeAbort = vi.fn().mockResolvedValue(undefined);
    const acpAbort = vi.fn().mockResolvedValue(undefined);
    let active = { abortSession: openCodeAbort };
    const abortSession = createDynamicBackendAbortSession(() => active);

    active = { abortSession: acpAbort };
    await abortSession('acp-session', '/workspace');

    expect(openCodeAbort).not.toHaveBeenCalled();
    expect(acpAbort).toHaveBeenCalledWith('acp-session', '/workspace');
  });

  it('creates and selects a Codex session through the lifecycle runtime', async () => {
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const homePath = ref('/home/test');
    const codexPendingSessionLock = ref('');
    const isAborting = ref(false);
    const lifecycle = useBackendSessionLifecycle({
      activeBackendKind: ref('codex'),
      codexProjectId: 'codex',
      acpProjectId: 'acp',
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
        startThread: vi
          .fn()
          .mockResolvedValue({ id: 'thread-1', cwd: '/repo', name: 'Thread One' }),
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
      backendCreateSession: vi.fn(),
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
      acpProjectId: 'acp',
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
      backendCreateSession: vi.fn(),
      backendAbortSession: abortSession,
    });

    await lifecycle.abortSession();

    expect(abortSession).toHaveBeenCalledTimes(3);
    expect(abortSession).toHaveBeenNthCalledWith(1, 'session-root', '/repo');
    expect(abortSession).toHaveBeenNthCalledWith(2, 'child-1', '/repo');
    expect(abortSession).toHaveBeenNthCalledWith(3, 'child-2', '/repo');
    expect(setSendStatusKey).toHaveBeenLastCalledWith('app.status.stopped');
  });

  it('creates an ACP session when the project picker selects a directory', async () => {
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const createdSession = {
      id: 'acp-session',
      directory: '/repo',
      title: 'ACP session',
    };
    let existingSession: typeof createdSession | undefined;
    const createSession = vi.fn().mockImplementation(async () => {
      existingSession = createdSession;
      return createdSession;
    });
    const openCodeCreateSession = vi.fn();
    const lifecycle = useBackendSessionLifecycle({
      activeBackendKind: ref('acp'),
      codexProjectId: 'codex',
      acpProjectId: 'acp',
      selectedProjectId,
      selectedSessionId,
      activeDirectory: ref(''),
      homePath: ref('/home/test'),
      codexPendingSessionLock: ref(''),
      codexSessionCreationByDirectory: new Map(),
      openCodeApi: { createSession: openCodeCreateSession },
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
      setSendStatusKey: vi.fn(),
      isAborting: ref(false),
      busyDescendantSessionIds: ref([]),
      backendCreateSession: createSession,
      findAcpSessionByDirectory: () => existingSession,
      backendAbortSession: undefined,
    });

    await expect(lifecycle.handleProjectDirectorySelect('/repo')).resolves.toBe('acp-session');
    expect(createSession).toHaveBeenCalledWith('/repo');
    expect(openCodeCreateSession).not.toHaveBeenCalled();
    expect(selectedProjectId.value).toBe('acp');
    expect(selectedSessionId.value).toBe('acp-session');
    await expect(lifecycle.handleProjectDirectorySelect('/repo')).resolves.toBe('acp-session');
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
