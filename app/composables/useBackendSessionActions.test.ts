import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionActions } from './useBackendSessionActions';
import type { CodexApiLike, OpenCodeApiLike } from './useBackendSessionActions';

function createOpenCodeApi(overrides: Partial<OpenCodeApiLike> = {}): OpenCodeApiLike {
  return {
    deleteSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    renameSession: vi.fn(),
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
    forkSession: vi.fn(),
    revertSession: vi.fn(),
    ...overrides,
  };
}

function createCodexApi(overrides: Partial<CodexApiLike> = {}): CodexApiLike {
  return {
    hiddenThreadIds: ref(new Set()),
    visibleThreads: ref([]),
    activeThreadId: ref(''),
    archiveThread: vi.fn(),
    hideThread: vi.fn(),
    unhideThread: vi.fn(),
    setThreadName: vi.fn(),
    forkThread: vi.fn(),
    rollbackThread: vi.fn(),
    startThreadCompaction: vi.fn(),
    selectThread: vi.fn(),
    ...overrides,
  };
}

function createPinMocks() {
  return {
    setLocalPinnedSession: vi.fn(),
    setLocalUnpinnedSession: vi.fn(),
    clearLocalPinnedSessionOverride: vi.fn(),
    restoreLocalPinnedSessionOverride: vi.fn(),
  };
}

function createActions(
  overrides: {
    activeBackendKind?: 'opencode' | 'codex' | 'acp';
    openCodeApi?: Partial<OpenCodeApiLike>;
    codexApi?: Partial<CodexApiLike>;
    ensureConnectionReady?: () => boolean;
    getSessionPinnedOverride?: () => number | undefined;
    backendDeleteSession?: () => Promise<unknown>;
  } = {},
) {
  const openCodeApi = createOpenCodeApi(overrides.openCodeApi);
  const codexApi = createCodexApi(overrides.codexApi);
  const pinMocks = createPinMocks();
  const setSessionError = vi.fn();
  const actions = useBackendSessionActions({
    activeBackendKind: ref(overrides.activeBackendKind ?? 'opencode'),
    codexProjectId: 'codex',
    selectedProjectId: ref('proj-1'),
    selectedSessionId: ref('session-1'),
    activeDirectory: ref('/repo'),
    localPinnedSessionStore: ref({}),
    serverProjects: {},
    openCodeApi,
    codexApi,
    ensureConnectionReady: overrides.ensureConnectionReady ?? (() => true),
    setSessionError,
    clearSessionError: vi.fn(),
    toErrorMessage: (error) => String(error),
    translate: (key) => key,
    showPrompt: vi.fn(),
    showConfirm: vi.fn(),
    findSessionInProjects: () => null,
    resolveProjectIdForSession: () => 'proj-1',
    resolveSessionOperationPayload: () => ({ projectId: 'proj-1', directory: '/repo' }),
    getSessionPinnedOverride: overrides.getSessionPinnedOverride ?? (() => 123),
    ...pinMocks,
    switchSessionSelection: vi.fn(),
    reloadSelectedSessionState: vi.fn(),
    seedForkedSessionComposerDraft: vi.fn(),
    setSendStatusKey: vi.fn(),
    setLocalSessionArchived: vi.fn(),
    batchConcurrency: 2,
    backendDeleteSession: overrides.backendDeleteSession ?? vi.fn(),
    backendUpdateSession: vi.fn(),
  });
  return {
    actions,
    mocks: {
      openCodeApi: openCodeApi as unknown as Record<
        keyof OpenCodeApiLike,
        ReturnType<typeof vi.fn>
      >,
      codexApi,
      ...pinMocks,
      setSessionError,
    },
  };
}

describe('useBackendSessionActions mutation skeleton', () => {
  it('Given an opencode deleteSession rejection, When deleteSession runs, Then it reverts the pinned override and surfaces the delete error', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { deleteSession: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.deleteSession('session-1');

    expect(mocks.openCodeApi.deleteSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'proj-1',
      directory: '/repo',
    });
    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      123,
    );
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });

  it('Given an opencode archiveSession rejection, When archiveSession runs, Then it reverts the pinned override and surfaces the archive error', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { archiveSession: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.archiveSession('session-1');

    expect(mocks.openCodeApi.archiveSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'proj-1',
      directory: '/repo',
    });
    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      123,
    );
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionArchiveFailed');
  });

  it('Given an opencode unarchiveSession rejection, When unarchiveSession runs, Then it reverts the pinned override and surfaces the unarchive error', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { unarchiveSession: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.unarchiveSession('session-1');

    expect(mocks.openCodeApi.unarchiveSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'proj-1',
      directory: '/repo',
    });
    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      123,
    );
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionUnarchiveFailed');
  });

  it('Given an opencode pinSession rejection, When pinSession runs, Then it reverts the pinned override and surfaces the pin error', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { pinSession: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.pinSession('session-1');

    expect(mocks.openCodeApi.pinSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'proj-1',
      directory: '/repo',
      pinnedAt: expect.any(Number),
    });
    expect(mocks.setLocalPinnedSession).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      expect.any(Number),
    );
    expect(mocks.restoreLocalPinnedSessionOverride).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      123,
    );
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionPinFailed');
  });

  it('Given an opencode unpinSession rejection, When unpinSession runs, Then it reverts the pinned override and surfaces the unpin error', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { unpinSession: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.unpinSession('session-1');

    expect(mocks.openCodeApi.unpinSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'proj-1',
      directory: '/repo',
    });
    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      123,
    );
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionUnpinFailed');
  });

  it('Given an empty session id, When deleteSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createActions();

    await actions.deleteSession('');

    expect(mocks.clearLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.deleteSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given the connection is not ready, When archiveSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createActions({ ensureConnectionReady: () => false });

    await actions.archiveSession('session-1');

    expect(mocks.clearLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.archiveSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an empty session id, When unpinSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createActions();

    await actions.unpinSession('');

    expect(mocks.setLocalUnpinnedSession).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.unpinSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given the connection is not ready, When pinSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createActions({ ensureConnectionReady: () => false });

    await actions.pinSession('session-1');

    expect(mocks.setLocalPinnedSession).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.pinSession).not.toHaveBeenCalled();
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an acp backend, When pinSession runs, Then the optimistic pin is applied without a server call', async () => {
    const { actions, mocks } = createActions({ activeBackendKind: 'acp' });

    await actions.pinSession('session-1');

    expect(mocks.setLocalPinnedSession).toHaveBeenCalledWith(
      'proj-1',
      'session-1',
      expect.any(Number),
    );
    expect(mocks.openCodeApi.pinSession).not.toHaveBeenCalled();
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given a successful opencode deleteSession, When deleteSession runs, Then the optimistic pin override is cleared without a rollback', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { deleteSession: vi.fn().mockResolvedValue(undefined) },
    });

    await actions.deleteSession('session-1');

    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an opencode deleteSession, When deleteSession runs, Then the optimistic mutation happens before the server call', async () => {
    const { actions, mocks } = createActions();

    await actions.deleteSession('session-1');

    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledBefore(
      mocks.openCodeApi.deleteSession,
    );
  });

  it('Given a successful opencode unpinSession, When unpinSession runs, Then the optimistic pin override stays without a rollback', async () => {
    const { actions, mocks } = createActions({
      openCodeApi: { unpinSession: vi.fn().mockResolvedValue(undefined) },
    });

    await actions.unpinSession('session-1');

    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an opencode unpinSession, When unpinSession runs, Then the optimistic mutation happens before the server call', async () => {
    const { actions, mocks } = createActions();

    await actions.unpinSession('session-1');

    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledBefore(mocks.openCodeApi.unpinSession);
  });

  it('Given an acp backend, When unpinSession runs, Then the optimistic unpin is applied without a server call', async () => {
    const { actions, mocks } = createActions({ activeBackendKind: 'acp' });

    await actions.unpinSession('session-1');

    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.openCodeApi.unpinSession).not.toHaveBeenCalled();
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an acp backendDeleteSession rejection, When deleteSession runs, Then the delete error is surfaced without a pinned rollback', async () => {
    const { actions, mocks } = createActions({
      activeBackendKind: 'acp',
      backendDeleteSession: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await actions.deleteSession('session-1');

    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });

  it('Given a codex archiveThread rejection, When deleteSession runs, Then the delete error is surfaced without a pinned rollback', async () => {
    const { actions, mocks } = createActions({
      activeBackendKind: 'codex',
      codexApi: { archiveThread: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.deleteSession('session-1');

    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });
});

describe('useBackendSessionActions', () => {
  it('pins Codex sessions and cancels a rename when the backend changes', async () => {
    const setLocalPinnedSession = vi.fn();
    const activeBackendKind = ref<'codex' | 'opencode'>('codex');
    const setThreadName = vi.fn();
    const openCodeRenameSession = vi.fn();
    let resolvePrompt: ((value: string | null) => void) | undefined;
    const actions = useBackendSessionActions({
      activeBackendKind,
      codexProjectId: 'codex',
      selectedProjectId: ref('codex'),
      selectedSessionId: ref('thread-1'),
      activeDirectory: ref('/repo'),
      localPinnedSessionStore: ref({}),
      serverProjects: {},
      openCodeApi: {
        deleteSession: vi.fn(),
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        renameSession: openCodeRenameSession,
        pinSession: vi.fn(),
        unpinSession: vi.fn(),
        forkSession: vi.fn(),
        revertSession: vi.fn(),
      },
      codexApi: {
        hiddenThreadIds: ref(new Set()),
        visibleThreads: ref([]),
        activeThreadId: ref('thread-1'),
        archiveThread: vi.fn(),
        hideThread: vi.fn(),
        unhideThread: vi.fn(),
        setThreadName,
        forkThread: vi.fn(),
        rollbackThread: vi.fn(),
        startThreadCompaction: vi.fn(),
        selectThread: vi.fn(),
      },
      ensureConnectionReady: () => true,
      setSessionError: vi.fn(),
      clearSessionError: vi.fn(),
      toErrorMessage: (error) => String(error),
      translate: (key) => key,
      showPrompt: vi.fn(() => new Promise<string | null>((resolve) => (resolvePrompt = resolve))),
      showConfirm: vi.fn(),
      findSessionInProjects: () => null,
      resolveProjectIdForSession: () => 'codex',
      resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession,
      setLocalUnpinnedSession: vi.fn(),
      clearLocalPinnedSessionOverride: vi.fn(),
      restoreLocalPinnedSessionOverride: vi.fn(),
      switchSessionSelection: vi.fn(),
      reloadSelectedSessionState: vi.fn(),
      seedForkedSessionComposerDraft: vi.fn(),
      setSendStatusKey: vi.fn(),
      setLocalSessionArchived: vi.fn(),
      batchConcurrency: 2,
      backendDeleteSession: vi.fn(),
      backendUpdateSession: vi.fn(),
    });

    await actions.pinSession('thread-1');

    expect(setLocalPinnedSession).toHaveBeenCalledWith('codex', 'thread-1', expect.any(Number));

    const renamePromise = actions.renameSession('thread-1');
    activeBackendKind.value = 'opencode';
    resolvePrompt?.('renamed');
    await renamePromise;

    expect(setThreadName).not.toHaveBeenCalled();
    expect(openCodeRenameSession).not.toHaveBeenCalled();
  });

  it('pins opencode sessions with optimistic local state and server call', async () => {
    const setLocalPinnedSession = vi.fn();
    const pinSession = vi.fn().mockResolvedValue(undefined);
    const actions = useBackendSessionActions({
      activeBackendKind: ref('opencode'),
      codexProjectId: 'codex',
      selectedProjectId: ref('proj-1'),
      selectedSessionId: ref('session-1'),
      activeDirectory: ref('/repo'),
      localPinnedSessionStore: ref({}),
      serverProjects: {},
      openCodeApi: {
        deleteSession: vi.fn(),
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        renameSession: vi.fn(),
        pinSession,
        unpinSession: vi.fn(),
        forkSession: vi.fn(),
        revertSession: vi.fn(),
      },
      codexApi: {
        hiddenThreadIds: ref(new Set()),
        visibleThreads: ref([]),
        activeThreadId: ref(''),
        archiveThread: vi.fn(),
        hideThread: vi.fn(),
        unhideThread: vi.fn(),
        setThreadName: vi.fn(),
        forkThread: vi.fn(),
        rollbackThread: vi.fn(),
        startThreadCompaction: vi.fn(),
        selectThread: vi.fn(),
      },
      ensureConnectionReady: () => true,
      setSessionError: vi.fn(),
      clearSessionError: vi.fn(),
      toErrorMessage: (error) => String(error),
      translate: (key) => key,
      showPrompt: vi.fn(),
      showConfirm: vi.fn(),
      findSessionInProjects: () => null,
      resolveProjectIdForSession: () => 'proj-1',
      resolveSessionOperationPayload: () => ({ projectId: 'proj-1', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession,
      setLocalUnpinnedSession: vi.fn(),
      clearLocalPinnedSessionOverride: vi.fn(),
      restoreLocalPinnedSessionOverride: vi.fn(),
      switchSessionSelection: vi.fn(),
      reloadSelectedSessionState: vi.fn(),
      seedForkedSessionComposerDraft: vi.fn(),
      setSendStatusKey: vi.fn(),
      setLocalSessionArchived: vi.fn(),
      batchConcurrency: 2,
      backendDeleteSession: vi.fn(),
      backendUpdateSession: vi.fn(),
    });

    await actions.pinSession('session-1');

    expect(setLocalPinnedSession).toHaveBeenCalledTimes(1);
    expect(pinSession).toHaveBeenCalledTimes(1);
    expect(pinSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
      projectId: 'proj-1',
      directory: '/repo',
    });
    expect(typeof pinSession.mock.calls[0]?.[0]?.pinnedAt).toBe('number');
  });

  it('routes ACP deletion through the active backend instead of OpenCode', async () => {
    const backendDeleteSession = vi.fn().mockResolvedValue(undefined);
    const openCodeDelete = vi.fn();
    const actions = useBackendSessionActions({
      activeBackendKind: ref('acp'),
      codexProjectId: 'codex',
      selectedProjectId: ref('acp'),
      selectedSessionId: ref('session-1'),
      activeDirectory: ref('/repo'),
      localPinnedSessionStore: ref({}),
      serverProjects: {},
      openCodeApi: {
        deleteSession: openCodeDelete,
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        renameSession: vi.fn(),
        pinSession: vi.fn(),
        unpinSession: vi.fn(),
        forkSession: vi.fn(),
        revertSession: vi.fn(),
      },
      codexApi: {
        hiddenThreadIds: ref(new Set()),
        visibleThreads: ref([]),
        activeThreadId: ref(''),
        archiveThread: vi.fn(),
        hideThread: vi.fn(),
        unhideThread: vi.fn(),
        setThreadName: vi.fn(),
        forkThread: vi.fn(),
        rollbackThread: vi.fn(),
        startThreadCompaction: vi.fn(),
        selectThread: vi.fn(),
      },
      ensureConnectionReady: () => true,
      setSessionError: vi.fn(),
      clearSessionError: vi.fn(),
      toErrorMessage: (error) => String(error),
      translate: (key) => key,
      showPrompt: vi.fn(),
      showConfirm: vi.fn(),
      findSessionInProjects: () => null,
      resolveProjectIdForSession: () => 'acp',
      resolveSessionOperationPayload: () => ({ projectId: 'acp', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession: vi.fn(),
      setLocalUnpinnedSession: vi.fn(),
      clearLocalPinnedSessionOverride: vi.fn(),
      restoreLocalPinnedSessionOverride: vi.fn(),
      switchSessionSelection: vi.fn(),
      reloadSelectedSessionState: vi.fn(),
      seedForkedSessionComposerDraft: vi.fn(),
      setSendStatusKey: vi.fn(),
      setLocalSessionArchived: vi.fn(),
      batchConcurrency: 2,
      backendDeleteSession,
      backendUpdateSession: vi.fn(),
    });

    await actions.deleteSession('session-1');

    expect(backendDeleteSession).toHaveBeenCalledWith('session-1', '/repo');
    expect(openCodeDelete).not.toHaveBeenCalled();
  });

  it('does not route a pending rename through a different backend', async () => {
    const activeBackendKind = ref<'opencode' | 'codex' | 'acp'>('codex');
    let resolvePrompt: ((value: string | null) => void) | undefined;
    const setThreadName = vi.fn();
    const renameSession = vi.fn();
    const actions = useBackendSessionActions({
      activeBackendKind,
      codexProjectId: 'codex',
      selectedProjectId: ref('codex'),
      selectedSessionId: ref('thread-1'),
      activeDirectory: ref('/repo'),
      localPinnedSessionStore: ref({}),
      serverProjects: {},
      openCodeApi: {
        deleteSession: vi.fn(),
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        renameSession,
        pinSession: vi.fn(),
        unpinSession: vi.fn(),
        forkSession: vi.fn(),
        revertSession: vi.fn(),
      },
      codexApi: {
        hiddenThreadIds: ref(new Set()),
        visibleThreads: ref([]),
        activeThreadId: ref('thread-1'),
        archiveThread: vi.fn(),
        hideThread: vi.fn(),
        unhideThread: vi.fn(),
        setThreadName,
        forkThread: vi.fn(),
        rollbackThread: vi.fn(),
        startThreadCompaction: vi.fn(),
        selectThread: vi.fn(),
      },
      ensureConnectionReady: () => true,
      setSessionError: vi.fn(),
      clearSessionError: vi.fn(),
      toErrorMessage: String,
      translate: (key) => key,
      showPrompt: () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
      showConfirm: vi.fn(),
      findSessionInProjects: () => null,
      resolveProjectIdForSession: () => 'codex',
      resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession: vi.fn(),
      setLocalUnpinnedSession: vi.fn(),
      clearLocalPinnedSessionOverride: vi.fn(),
      restoreLocalPinnedSessionOverride: vi.fn(),
      switchSessionSelection: vi.fn(),
      reloadSelectedSessionState: vi.fn(),
      seedForkedSessionComposerDraft: vi.fn(),
      setSendStatusKey: vi.fn(),
      setLocalSessionArchived: vi.fn(),
      batchConcurrency: 2,
      backendDeleteSession: vi.fn(),
      backendUpdateSession: vi.fn(),
    });

    const pending = actions.renameSession('thread-1');
    activeBackendKind.value = 'opencode';
    resolvePrompt?.('renamed');
    await pending;

    expect(setThreadName).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });
});
