import { describe, expect, it, vi } from 'vitest';
import { ref, watch } from 'vue';
import {
  createDynamicBackendAbortSession,
  sessionProjectIdForBackend,
  useBackendSessionLifecycle,
} from './useBackendSessionLifecycle';
import type { DshNormalizeOp } from '../backends/dsh/ops';
import type { ProjectState, SessionState } from '../types/worker-state';

type LifecycleOptions = Parameters<typeof useBackendSessionLifecycle>[0];

function createLifecycleFixture(overrides: Partial<LifecycleOptions> = {}) {
  const params = {
    activeBackendKind: ref('opencode'),
    codexProjectId: 'codex',
    acpProjectId: 'acp',
    selectedProjectId: ref('proj-1'),
    selectedSessionId: ref('session-1'),
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
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('codex'),
      selectedProjectId,
      selectedSessionId,
      homePath,
      codexPendingSessionLock,
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
      isAborting,
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
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('opencode'),
      selectedSessionId: ref('session-root'),
      setSendStatusKey,
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
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('acp'),
      selectedProjectId,
      selectedSessionId,
      activeDirectory: ref(''),
      openCodeApi: { createSession: openCodeCreateSession },
      backendCreateSession: createSession,
      findAcpSessionByDirectory: () => existingSession,
    });

    await expect(lifecycle.handleProjectDirectorySelect('/repo')).resolves.toBe('acp-session');
    expect(createSession).toHaveBeenCalledWith('/repo');
    expect(openCodeCreateSession).not.toHaveBeenCalled();
    expect(selectedProjectId.value).toBe('acp');
    expect(selectedSessionId.value).toBe('acp-session');
    await expect(lifecycle.handleProjectDirectorySelect('/repo')).resolves.toBe('acp-session');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('createNewSession always creates a fresh ACP session even when one exists in the directory', async () => {
    const selectedProjectId = ref('');
    const selectedSessionId = ref('');
    const existingSession = { id: 'old-session', directory: '/repo', title: 'Old' };
    const createdSession = { id: 'new-session', directory: '/repo', title: 'new-session' };
    const createSession = vi.fn().mockResolvedValue(createdSession);
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('acp'),
      selectedProjectId,
      selectedSessionId,
      backendCreateSession: createSession,
      findAcpSessionByDirectory: () => existingSession,
    });

    const session = await lifecycle.createNewSession();
    expect(createSession).toHaveBeenCalledWith('/repo');
    expect(session?.id).toBe('new-session');
    expect(selectedSessionId.value).toBe('new-session');
  });
});

// ---------------------------------------------------------------------------
// dsh (plan Todo 22)
// ---------------------------------------------------------------------------

type DshEventContext = { sessionId?: string; origin?: 'live' | 'snapshot-rebuild' };

function createDshEventSource() {
  const listeners = new Set<(op: DshNormalizeOp, context: DshEventContext) => void>();
  return {
    onSessionEvent(listener: (op: DshNormalizeOp, context: DshEventContext) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(op: DshNormalizeOp, context: DshEventContext = {}) {
      for (const listener of [...listeners]) listener(op, context);
    },
    listenerCount: () => listeners.size,
  };
}

function dshProjects(): Record<string, ProjectState> {
  const session = (id: string, overrides: Partial<SessionState> = {}): SessionState => ({
    id,
    title: id,
    status: 'unknown',
    ...overrides,
  });
  return {
    'ws-1': {
      id: 'ws-1',
      name: 'repo',
      worktree: '/repo',
      sandboxes: {
        '/repo': {
          directory: '/repo',
          name: 'repo',
          rootSessions: ['s1', 's2', 'archived-1', 'child-1'],
          sessions: {
            s1: session('s1', { timeCreated: 30, timeUpdated: 30 }),
            s2: session('s2', { timeCreated: 20, timeUpdated: 20 }),
            'archived-1': session('archived-1', { timeArchived: 9 }),
            'child-1': session('child-1', { parentID: 's1', timeCreated: 10 }),
          },
        },
      },
    },
  };
}

function dshEntry(projects: Record<string, ProjectState>, sessionId: string): SessionState {
  const entry = Object.values(projects)
    .flatMap((project) => Object.values(project.sandboxes))
    .map((sandbox) => sandbox.sessions[sessionId])
    .find(Boolean);
  if (!entry) throw new Error(`fixture has no session ${sessionId}`);
  return entry;
}

describe('useBackendSessionLifecycle dsh', () => {
  it('rejects a synthetic project id for dsh (sessions use their workspace id)', () => {
    expect(() => sessionProjectIdForBackend('dsh', 'codex', 'acp')).toThrow();
  });

  it('creates a dsh session through the dsh api and selects it after registration', async () => {
    const created = {
      id: 'dsh-1',
      projectID: 'ws-1',
      workspaceId: 'ws-1',
      directory: '/repo',
      title: 'dsh-1',
      status: 'unknown' as const,
    };
    const createSession = vi.fn().mockResolvedValue(created);
    const registered = new Set<string>();
    const selectedProjectId = ref('old-project');
    const selectedSessionId = ref('old-session');
    const selectDshSession = vi.fn(async (projectId: string, sessionId: string) => {
      expect(registered.has(sessionId)).toBe(true);
      selectedProjectId.value = projectId;
      selectedSessionId.value = sessionId;
    });
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      selectedProjectId,
      selectedSessionId,
      dshApi: { createSession },
      onDshSessionCreated: (session) => {
        registered.add(session.id);
      },
      selectDshSession,
    });

    const session = await lifecycle.createNewSession();

    expect(createSession).toHaveBeenCalledWith('/repo');
    expect(session?.id).toBe('dsh-1');
    expect(selectDshSession).toHaveBeenCalledWith('ws-1', 'dsh-1');
    expect(selectedSessionId.value).toBe('dsh-1');
  });

  it('registers the dsh session before publishing its selection', async () => {
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
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      selectedSessionId,
      dshApi: {
        createSession: vi.fn().mockResolvedValue({ id: 'dsh-2', projectID: 'ws-1', directory: '/repo' }),
      },
      onDshSessionCreated: (session) => {
        registered.add(session.id);
      },
    });

    await lifecycle.createNewSession();
    stop();

    expect(invalidSelections).toEqual([]);
    expect(selectedSessionId.value).toBe('dsh-2');
  });

  it('preserves a newer user selection when a pending dsh creation lands late', async () => {
    const pendingCreate = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const { lifecycle, params } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      dshApi: {
        createSession: () => {
          started.resolve();
          return pendingCreate.promise;
        },
      },
    });
    const pending = lifecycle.createNewSession();
    await started.promise;
    params.selectedProjectId.value = 'new-choice';
    params.selectedSessionId.value = 'new-choice';
    pendingCreate.resolve({ id: 'dsh-3', projectID: 'ws-1', directory: '/repo' });
    await pending;
    expect(params.selectedSessionId.value).toBe('new-choice');
    expect(params.selectedProjectId.value).toBe('new-choice');
  });

  it('fails closed when the dsh api has no createSession', async () => {
    const setSessionError = vi.fn();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      setSessionError,
      dshApi: {},
    });
    const session = await lifecycle.createNewSession();
    expect(session).toBeUndefined();
    expect(setSessionError).toHaveBeenCalledWith('app.error.sessionCreateFailed');
  });

  it('creates a dsh session when the project picker selects a directory', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'dsh-4', projectID: 'ws-1' });
    const selectedSessionId = ref('');
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      selectedProjectId: ref(''),
      selectedSessionId,
      dshApi: { createSession },
    });

    await expect(lifecycle.handleProjectDirectorySelect('/repo')).resolves.toBe('dsh-4');
    expect(createSession).toHaveBeenCalledWith('/repo');
    expect(selectedSessionId.value).toBe('dsh-4');
  });

  it('routes the dsh abort through the dsh cancel endpoint', async () => {
    const abortSession = vi.fn().mockResolvedValue(undefined);
    const setSendStatusKey = vi.fn();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      selectedSessionId: ref('dsh-1'),
      setSendStatusKey,
      dshApi: { abortSession },
    });

    await lifecycle.abortSession();

    expect(abortSession).toHaveBeenCalledWith('dsh-1');
    expect(setSendStatusKey).toHaveBeenCalledWith('app.status.stopped');
  });

  it('applies normalized session events onto the shared projects state', async () => {
    const projects = dshProjects();
    const source = createDshEventSource();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      dshApi: { createSession: vi.fn() },
    });

    lifecycle.subscribeSessionEvents({ source, projects: () => projects });

    source.emit({ kind: 'turn', phase: 'started', sessionId: 's1', turn: 1, time: 100 });
    source.emit({ kind: 'turn', phase: 'started', sessionId: 's2', turn: 1, time: 101 });
    source.emit({
      kind: 'user-message', sessionId: 's2', messageId: 'm2', sourceKind: 'user', role: 'user', time: 102,
    });
    source.emit({ kind: 'turn', phase: 'ended', sessionId: 's1', turn: 1, time: 103, reason: { kind: 'completed' } });

    // Cross-session isolation: session one's inbox/turn events never overwrite
    // session two's state.
    expect(dshEntry(projects, 's1').status).toBe('idle');
    expect(dshEntry(projects, 's1').timeUpdated).toBe(103);
    expect(dshEntry(projects, 's2').status).toBe('busy');
    expect(dshEntry(projects, 's2').timeUpdated).toBe(102);
  });

  it('ignores session events while another backend is active', async () => {
    const projects = dshProjects();
    const source = createDshEventSource();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('opencode'),
      dshApi: { createSession: vi.fn() },
    });

    lifecycle.subscribeSessionEvents({ source, projects: () => projects });
    source.emit({ kind: 'turn', phase: 'started', sessionId: 's1', turn: 1, time: 100 });

    expect(dshEntry(projects, 's1').status).toBe('unknown');
  });

  it('cancels the superseded stream subscription when the same session id re-subscribes (fork)', async () => {
    const projects = dshProjects();
    const stale = createDshEventSource();
    const fresh = createDshEventSource();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      dshApi: { createSession: vi.fn() },
    });

    lifecycle.subscribeSessionEvents({ source: stale, projects: () => projects });
    // A fork/reconnect re-subscribes the same session id on a fresh stream:
    // the old stream's late frames must no longer reach the shared state.
    const detachFresh = lifecycle.subscribeSessionEvents({ source: fresh, projects: () => projects });

    stale.emit({ kind: 'turn', phase: 'started', sessionId: 's1', turn: 1, time: 100 });
    expect(dshEntry(projects, 's1').status).toBe('unknown');

    fresh.emit({ kind: 'turn', phase: 'started', sessionId: 's1', turn: 1, time: 200 });
    expect(dshEntry(projects, 's1').status).toBe('busy');

    detachFresh();
    fresh.emit({ kind: 'turn', phase: 'ended', sessionId: 's1', turn: 1, time: 300, reason: { kind: 'completed' } });
    expect(dshEntry(projects, 's1').status).toBe('busy');
  });

  it('loads the archive state from the bootstrap archivedSessionIds baseline', async () => {
    const projects = dshProjects();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      dshApi: { createSession: vi.fn() },
    });

    const applied = lifecycle.loadSessionArchives({ projects, archivedSessionIds: ['s2'] });

    expect(applied).toBe(1);
    expect(dshEntry(projects, 's2').timeArchived).toBeGreaterThan(0);
    expect(dshEntry(projects, 's1').timeArchived).toBeUndefined();
    // Idempotent: the baseline is authoritative, never re-stamped.
    expect(lifecycle.loadSessionArchives({ projects, archivedSessionIds: ['s2'] })).toBe(0);
  });

  it('builds the dsh more-sessions sidebar contract on shared SessionCard entries', async () => {
    const projects = dshProjects();
    const { lifecycle } = createLifecycleFixture({
      activeBackendKind: ref('dsh'),
      dshApi: { createSession: vi.fn() },
    });

    const menu = lifecycle.showMoreSessionsMenu({
      projects,
      projectId: 'ws-1',
      selectedSessionId: 's2',
    });

    expect(menu.contract).toBe('shared-session-cards');
    // Archived and child (subagent) sessions never enter the sidebar list;
    // the most recently active root session comes first.
    expect(menu.cards.map((card) => card.sessionId)).toEqual(['s1', 's2']);
    expect(menu.selectedSessionId).toBe('s2');
    for (const card of menu.cards) {
      expect(card.pid).toBe('');
      expect(() => card.pid.startsWith('pid:')).not.toThrow();
    }
  });
});
