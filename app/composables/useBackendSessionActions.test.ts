import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionActions } from './useBackendSessionActions';

describe('useBackendSessionActions', () => {
  it('pins Codex sessions through codex runtime methods', async () => {
    const pinThread = vi.fn();
    const actions = useBackendSessionActions({
      activeBackendKind: ref('codex'),
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
        renameSession: vi.fn(),
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
        unarchiveThread: vi.fn(),
        setThreadName: vi.fn(),
        pinThread,
        unpinThread: vi.fn(),
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
      batchConcurrency: 2,
    });

    await actions.pinSession('thread-1');

    expect(pinThread).toHaveBeenCalledWith('thread-1');
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
        unarchiveThread: vi.fn(),
        setThreadName: vi.fn(),
        pinThread: vi.fn(),
        unpinThread: vi.fn(),
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
      batchConcurrency: 2,
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
});
