import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionActions } from './useBackendSessionActions';

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
      showPrompt: vi.fn(
        () => new Promise<string | null>((resolve) => (resolvePrompt = resolve)),
      ),
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
        deleteSession: vi.fn(), archiveSession: vi.fn(), unarchiveSession: vi.fn(), renameSession,
        pinSession: vi.fn(), unpinSession: vi.fn(), forkSession: vi.fn(), revertSession: vi.fn(),
      },
      codexApi: {
        hiddenThreadIds: ref(new Set()), visibleThreads: ref([]), activeThreadId: ref('thread-1'),
        archiveThread: vi.fn(), hideThread: vi.fn(), unhideThread: vi.fn(), setThreadName,
        forkThread: vi.fn(), rollbackThread: vi.fn(), startThreadCompaction: vi.fn(), selectThread: vi.fn(),
      },
      ensureConnectionReady: () => true,
      setSessionError: vi.fn(), clearSessionError: vi.fn(), toErrorMessage: String,
      translate: (key) => key,
      showPrompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      showConfirm: vi.fn(), findSessionInProjects: () => null,
      resolveProjectIdForSession: () => 'codex',
      resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession: vi.fn(), setLocalUnpinnedSession: vi.fn(),
      clearLocalPinnedSessionOverride: vi.fn(), restoreLocalPinnedSessionOverride: vi.fn(),
      switchSessionSelection: vi.fn(), reloadSelectedSessionState: vi.fn(),
      seedForkedSessionComposerDraft: vi.fn(), setSendStatusKey: vi.fn(),
      setLocalSessionArchived: vi.fn(), batchConcurrency: 2,
      backendDeleteSession: vi.fn(), backendUpdateSession: vi.fn(),
    });

    const pending = actions.renameSession('thread-1');
    activeBackendKind.value = 'opencode';
    resolvePrompt?.('renamed');
    await pending;

    expect(setThreadName).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });
});
