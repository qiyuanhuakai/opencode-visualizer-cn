import { describe, expect, it, vi } from 'vitest';
import { ref, watch } from 'vue';
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
  it('opens the project picker at the Kimi host home directory', async () => {
    const homePath = ref('/home/other-backend');
    const pickerOpen = ref(false);
    const getFsHome = vi.fn(async () => ({ home: '/home/kimi', recent_roots: [] }));
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'), homePath,
      kimiWebApi: { getFsHome },
    });
    await lifecycle.openProjectPicker(pickerOpen);
    expect(getFsHome).toHaveBeenCalledOnce();
    expect(homePath.value).toBe('/home/kimi');
    expect(pickerOpen.value).toBe(true);
  });

  it('still opens the project picker if the home endpoint is unavailable', async () => {
    const homePath = ref('/home/other-backend');
    const pickerOpen = ref(false);
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'), homePath,
      kimiWebApi: { getFsHome: vi.fn().mockRejectedValue(new Error('unsupported')) },
    });
    await lifecycle.openProjectPicker(pickerOpen);
    expect(pickerOpen.value).toBe(true);
    expect(homePath.value).toBe('');
  });

  it('switches to a new Kimi session after registering it', async () => {
    const registered = new Set<string>();
    const selectedProjectId = ref('old-project');
    const selectedSessionId = ref('old-session');
    const selectKimiWebSession = vi.fn(async (projectId: string, sessionId: string) => {
      expect(registered.has(sessionId)).toBe(true);
      selectedProjectId.value = projectId;
      selectedSessionId.value = sessionId;
    });
    const created = { id: 'new-session', workspace_id: 'new-workspace', metadata: { cwd: '/repo' } };
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'), selectedProjectId, selectedSessionId,
      kimiWebApi: { createSession: async () => created, updateProfile: async () => created },
      onKimiWebSessionCreated: (session) => { registered.add(session.id); },
      selectKimiWebSession,
    });
    await lifecycle.createNewSession();
    expect(selectKimiWebSession).toHaveBeenCalledWith('new-workspace', 'new-session');
    expect(selectedSessionId.value).toBe('new-session');
  });

  it('keeps the created workspace when the profile response omits it', async () => {
    const registered: string[] = [];
    const selectedProjectId = ref('old-project');
    const selectedSessionId = ref('old-session');
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'), selectedProjectId, selectedSessionId,
      kimiWebApi: {
        createSession: async () => ({ id: 'new-session', workspace_id: 'new-workspace', metadata: { cwd: '/repo' } }),
        updateProfile: async () => ({ id: 'new-session', agent_config: { model: 'kimi-code/k3' } }),
      },
      onKimiWebSessionCreated: (session) => { registered.push(session.projectID ?? ''); },
    });
    await lifecycle.createNewSession();
    expect(registered).toEqual(['new-workspace']);
    expect(selectedProjectId.value).toBe('new-workspace');
    expect(selectedSessionId.value).toBe('new-session');
  });
  it('registers the session before publishing its selection', async () => {
    // Given
    const registered = new Set<string>();
    const selectedSessionId = ref('old-session');
    const invalidSelections: string[] = [];
    const stop = watch(
      selectedSessionId,
      (id) => {
        if (!registered.has(id)) invalidSelections.push(id);
      },
      { flush: 'sync' },
    );
    const created = {
      id: 'new-session',
      workspace_id: 'workspace',
      metadata: { cwd: '/canonical' },
    };
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      selectedSessionId,
      kimiWebApi: { createSession: async () => created, updateProfile: async () => created },
      onKimiWebSessionCreated: (session) => registered.add(session.id),
    });
    // When
    const createdSession = await lifecycle.createNewSession();
    stop();
    // Then
    expect(invalidSelections).toEqual([]);
    expect(createdSession?.directory).toBe('/canonical');
  });

  it('preserves a newer user selection when a pending profile fails', async () => {
    // Given
    const profile = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const { lifecycle, params } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      kimiWebApi: {
        createSession: async () => ({ id: 'created', workspace_id: 'workspace' }),
        updateProfile: () => {
          started.resolve();
          return profile.promise;
        },
      },
    });
    const pending = lifecycle.createNewSession();
    await started.promise;
    // When
    params.selectedProjectId.value = 'new-choice';
    params.selectedSessionId.value = 'new-choice';
    profile.reject(new Error('profile failed'));
    await pending;
    // Then
    expect(params.selectedSessionId.value).toBe('new-choice');
    expect(params.selectedProjectId.value).toBe('new-choice');
  });

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
    const updateProfile = vi.fn().mockImplementation(async (sessionId: string, input: unknown) => {
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

  it('Given a kimi-web create succeeds, When createNewSession runs, Then the host is handed the created session for store registration', async () => {
    const onKimiWebSessionCreated = vi.fn();
    const created = {
      id: 'kimi-1',
      workspace_id: 'ws-1',
      title: 'New session',
      created_at: '2026-09-21T02:00:00.000Z',
      updated_at: '2026-09-21T03:00:00.000Z',
    };
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      activeDirectory: ref('/repo'),
      kimiWebApi: {
        createSession: vi.fn().mockResolvedValue(created),
        updateProfile: vi.fn().mockResolvedValue(created),
      },
      kimiWebCreateProfile: () => ({ agent_config: { model: 'kimi-code/k3' } }),
      onKimiWebSessionCreated,
    });

    await lifecycle.createNewSession();

    expect(onKimiWebSessionCreated).toHaveBeenCalledTimes(1);
    expect(onKimiWebSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'kimi-1',
        projectID: 'ws-1',
        directory: '/repo',
        status: 'unknown',
        time: {
          created: Date.parse('2026-09-21T02:00:00.000Z'),
          updated: Date.parse('2026-09-21T03:00:00.000Z'),
        },
      }),
    );
  });

  it('Given the kimi-web profile write fails, When createNewSession runs, Then the host is not handed a session for registration', async () => {
    const onKimiWebSessionCreated = vi.fn();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('kimi-web'),
      activeDirectory: ref('/repo'),
      kimiWebApi: {
        createSession: vi.fn().mockResolvedValue({ id: 'kimi-1', workspace_id: 'ws-1' }),
        updateProfile: vi.fn().mockRejectedValue(new Error('profile boom')),
      },
      onKimiWebSessionCreated,
    });

    await lifecycle.createNewSession();

    expect(onKimiWebSessionCreated).not.toHaveBeenCalled();
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
