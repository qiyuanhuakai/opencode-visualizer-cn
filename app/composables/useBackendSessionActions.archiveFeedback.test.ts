import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendSessionActions } from './useBackendSessionActions';

function createAcpActions() {
  const backendUpdateSession = vi.fn().mockResolvedValue({});
  const setSendStatusKey = vi.fn();
  const setLocalSessionArchived = vi.fn();
  const actions = useBackendSessionActions({
    activeBackendKind: ref('acp'),
    codexProjectId: 'codex',
    selectedProjectId: ref('acp'),
    selectedSessionId: ref('session-1'),
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
    setSendStatusKey,
    setLocalSessionArchived,
    batchConcurrency: 2,
    backendDeleteSession: vi.fn(),
    backendUpdateSession,
  });
  return { actions, backendUpdateSession, setSendStatusKey, setLocalSessionArchived };
}

describe('ACP archive feedback', () => {
  it('shows a localized success status after archiving', async () => {
    const { actions, backendUpdateSession, setSendStatusKey, setLocalSessionArchived } = createAcpActions();

    await actions.archiveSession('session-1');

    expect(backendUpdateSession).toHaveBeenCalledWith(
      'session-1',
      { time: { archived: expect.any(Number) } },
      '/repo',
    );
    expect(setSendStatusKey).toHaveBeenCalledWith('app.status.archived');
    expect(setLocalSessionArchived).toHaveBeenCalledWith('session-1', expect.any(Number));
  });

  it('shows a localized success status after restoring an archive', async () => {
    const { actions, backendUpdateSession, setSendStatusKey, setLocalSessionArchived } = createAcpActions();

    await actions.unarchiveSession('session-1');

    expect(backendUpdateSession).toHaveBeenCalledWith(
      'session-1',
      { time: { archived: 0 } },
      '/repo',
    );
    expect(setSendStatusKey).toHaveBeenCalledWith('app.status.unarchived');
    expect(setLocalSessionArchived).toHaveBeenCalledWith('session-1', undefined);
  });
});
