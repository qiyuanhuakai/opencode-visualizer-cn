import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useBackendSessionActions } from './useBackendSessionActions';

function createActions(hidden: string[] = []) {
  const archiveThread = vi.fn().mockResolvedValue({});
  const hideThread = vi.fn();
  const unhideThread = vi.fn();
  const selectThread = vi.fn().mockResolvedValue({});
  const setSessionError = vi.fn();
  const backendUpdateSession = vi.fn();
  const actions = useBackendSessionActions({
    activeBackendKind: ref('codex'), codexProjectId: 'codex', selectedProjectId: ref('codex'),
    selectedSessionId: ref('thread-1'), activeDirectory: ref('/repo'), localPinnedSessionStore: ref({}),
    serverProjects: {},
    openCodeApi: { deleteSession: vi.fn(), archiveSession: vi.fn(), unarchiveSession: vi.fn(), renameSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), forkSession: vi.fn(), revertSession: vi.fn() },
    codexApi: {
      hiddenThreadIds: ref(new Set(hidden)), visibleThreads: ref([{ id: 'thread-2' }]), activeThreadId: ref('thread-2'),
      archiveThread, hideThread, unhideThread, setThreadName: vi.fn(), forkThread: vi.fn(),
      rollbackThread: vi.fn(), startThreadCompaction: vi.fn(), selectThread,
    },
    ensureConnectionReady: () => true, setSessionError, clearSessionError: vi.fn(),
    toErrorMessage: (error) => String(error), translate: (key) => key, showPrompt: vi.fn(),
    showConfirm: vi.fn(), findSessionInProjects: () => null, resolveProjectIdForSession: () => 'codex',
    resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
    getSessionPinnedOverride: () => undefined, setLocalPinnedSession: vi.fn(), setLocalUnpinnedSession: vi.fn(),
    clearLocalPinnedSessionOverride: vi.fn(), restoreLocalPinnedSessionOverride: vi.fn(),
    switchSessionSelection: vi.fn(), reloadSelectedSessionState: vi.fn(), seedForkedSessionComposerDraft: vi.fn(),
    setSendStatusKey: vi.fn(), setLocalSessionArchived: vi.fn(), batchConcurrency: 2,
    backendDeleteSession: vi.fn(), backendUpdateSession,
  });
  return { actions, archiveThread, hideThread, unhideThread, selectThread, setSessionError, backendUpdateSession };
}

describe('Codex archive and delete actions', () => {
  it('uses local hide for archive and native thread/archive only for irreversible delete', async () => {
    const { actions, archiveThread, hideThread } = createActions();
    await actions.archiveSession('thread-1');
    expect(hideThread).toHaveBeenCalledWith('thread-1');
    expect(archiveThread).not.toHaveBeenCalled();

    await actions.deleteSession('thread-1');
    expect(archiveThread).toHaveBeenCalledWith('thread-1');
  });

  it('restores only locally hidden threads and never calls native unarchive', async () => {
    const hidden = createActions(['thread-1']);
    await hidden.actions.unarchiveSession('thread-1');
    expect(hidden.unhideThread).toHaveBeenCalledWith('thread-1');
    expect(hidden.selectThread).toHaveBeenCalledWith('thread-1');
    expect(hidden.backendUpdateSession).not.toHaveBeenCalled();

    const deleted = createActions();
    await deleted.actions.unarchiveSession('thread-1');
    expect(deleted.backendUpdateSession).not.toHaveBeenCalled();
    expect(deleted.setSessionError).toHaveBeenCalled();
  });
});
