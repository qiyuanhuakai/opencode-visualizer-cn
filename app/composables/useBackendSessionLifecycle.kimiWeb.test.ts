import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  sessionProjectIdForBackend,
  useBackendSessionLifecycle,
} from './useBackendSessionLifecycle';

type LifecycleOptions = Parameters<typeof useBackendSessionLifecycle>[0];

function createLifecycleFixture(overrides: Partial<LifecycleOptions> = {}) {
  const params = {
    activeBackendKind: ref('opencode'),
    codexProjectId: 'codex',
    acpProjectId: 'acp',
    selectedProjectId: ref('old-project'),
    selectedSessionId: ref('old-session'),
    activeDirectory: ref('/repo'),
    homePath: ref('/home/test'),
    codexPendingSessionLock: ref(''),
    codexSessionCreationByDirectory: new Map(),
    openCodeApi: { createSession: vi.fn() },
    codexApi: {
      homeDir: ref('/home/test'),
      activeThreadId: ref(''),
      visibleThreads: ref([]),
      startThread: vi.fn(),
      refreshHomeDir: vi.fn(),
      interruptActiveTurn: vi.fn(),
    },
    normalizeProjectDirectoryForActiveBackend: (directory: string) => directory,
    codexThreadDirectoryMatch: () => false,
    ensureConnectionReady: () => true,
    translate: (key: string) => key,
    toErrorMessage: String,
    setSessionError: vi.fn(),
    clearSessionError: vi.fn(),
    setSendStatusKey: vi.fn(),
    isAborting: ref(false),
    busyDescendantSessionIds: ref<string[]>([]),
    backendCreateSession: vi.fn(),
    backendAbortSession: undefined,
    ...overrides,
  } satisfies LifecycleOptions;
  return { lifecycle: useBackendSessionLifecycle(params), params };
}

describe('useBackendSessionLifecycle kimi-web', () => {
  it('Given a kimi-web backend, When createNewSession runs, Then it creates first and writes the model through profile second', async () => {
    const calls: string[] = [];
    const created = { id: 'kimi-1', workspace_id: 'ws-1', title: 'New session' };
    const createSession = vi
      .fn()
      .mockImplementation(async (input: { metadata: { cwd: string } }) => {
        calls.push(`create:${JSON.stringify(input)}`);
        return created;
      });
    const updated = {
      id: 'kimi-1',
      workspace_id: 'ws-1',
      title: 'New session',
      agent_config: { model: 'kimi-code/k3' },
    };
    const updateProfile = vi
      .fn()
      .mockImplementation(async (sessionId: string, input: unknown) => {
        calls.push(`profile:${sessionId}:${JSON.stringify(input)}`);
        return updated;
      });
    const openCodeCreateSession = vi.fn();
    const selectedProjectId = ref('old-project');
    const selectedSessionId = ref('old-session');
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      activeDirectory: ref('/repo'),
      selectedProjectId,
      selectedSessionId,
      openCodeApi: { createSession: openCodeCreateSession },
      kimiWebApi: { createSession, updateProfile },
      kimiWebCreateProfile: () => ({ agent_config: { model: 'kimi-code/k3' } }),
    });

    const session = await lifecycle.createNewSession();

    expect(session?.id).toBe('kimi-1');
    expect(openCodeCreateSession).not.toHaveBeenCalled();
    // Create must NOT carry the model: the live 0.43.0 server silently ignores
    // create-time agent_config (measured pitfall 1).
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]).toEqual({ metadata: { cwd: '/repo' } });
    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty('agent_config');
    // The create response is not expected to carry the model either — the model
    // is established by the second call.
    expect(updateProfile).toHaveBeenCalledWith('kimi-1', {
      agent_config: { model: 'kimi-code/k3' },
    });
    expect(calls).toEqual([
      'create:{"metadata":{"cwd":"/repo"}}',
      'profile:kimi-1:{"agent_config":{"model":"kimi-code/k3"}}',
    ]);
    expect(selectedProjectId.value).toBe('ws-1');
    expect(selectedSessionId.value).toBe('kimi-1');
  });

  it('Given the kimi-web profile write fails, When createNewSession runs, Then the optimistic selection rolls back and the error surfaces', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'kimi-1', workspace_id: 'ws-1' });
    const updateProfile = vi.fn().mockRejectedValue(new Error('profile boom'));
    const selectedProjectId = ref('old-project');
    const selectedSessionId = ref('old-session');
    const setSessionError = vi.fn();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      activeDirectory: ref('/repo'),
      selectedProjectId,
      selectedSessionId,
      setSessionError,
      kimiWebApi: { createSession, updateProfile },
      kimiWebCreateProfile: () => ({ agent_config: { model: 'kimi-code/k3' } }),
    });

    const session = await lifecycle.createNewSession();

    expect(session).toBeUndefined();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(selectedProjectId.value).toBe('old-project');
    expect(selectedSessionId.value).toBe('old-session');
    expect(setSessionError).toHaveBeenCalledWith('app.error.sessionCreateFailed');
  });

  it('Given a kimi-web backend, When abortSession runs, Then it posts the REST :abort through the kimi client', async () => {
    const abortSession = vi.fn().mockResolvedValue(undefined);
    const setSendStatusKey = vi.fn();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      selectedSessionId: ref('kimi-1'),
      setSendStatusKey,
      kimiWebApi: { abortSession },
    });

    await lifecycle.abortSession();

    expect(abortSession).toHaveBeenCalledWith('kimi-1');
    expect(setSendStatusKey).toHaveBeenCalledWith('app.status.stopped');
  });

  it('Given a kimi-web backend, When the project picker selects a directory, Then it creates a session in that directory', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'kimi-2', workspace_id: 'ws-2' });
    const updateProfile = vi.fn().mockResolvedValue({ id: 'kimi-2', workspace_id: 'ws-2' });
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      selectedProjectId,
      selectedSessionId,
      kimiWebApi: { createSession, updateProfile },
      kimiWebCreateProfile: () => ({ agent_config: { model: 'kimi-code/k3' } }),
    });

    await expect(lifecycle.handleProjectDirectorySelect('/repo')).resolves.toBe('kimi-2');
    expect(createSession).toHaveBeenCalledWith({ metadata: { cwd: '/repo' } });
    expect(updateProfile).toHaveBeenCalledWith('kimi-2', {
      agent_config: { model: 'kimi-code/k3' },
    });
  });

  it('Given kimi-web, When sessionProjectIdForBackend is asked for a synthetic id, Then it rejects instead of returning undefined', () => {
    expect(() => sessionProjectIdForBackend('kimi-web', 'codex', 'acp')).toThrow();
  });
});
