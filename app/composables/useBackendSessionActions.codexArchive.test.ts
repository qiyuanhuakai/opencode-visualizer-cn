import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';

function createActions(hidden: string[] = []) {
  const archiveThread = vi.fn().mockResolvedValue({});
  const hideThread = vi.fn();
  const unhideThread = vi.fn();
  const selectThread = vi.fn().mockResolvedValue({});
  const setSessionError = vi.fn();
  const backendUpdateSession = vi.fn();
  const { actions } = createSessionActionsFixture({
    activeBackendKind: 'codex',
    selectedProjectId: ref('codex'),
    selectedSessionId: ref('thread-1'),
    codexApi: {
      hiddenThreadIds: ref(new Set(hidden)),
      visibleThreads: ref([{ id: 'thread-2' }]),
      activeThreadId: ref('thread-2'),
      archiveThread,
      hideThread,
      unhideThread,
      setThreadName: vi.fn(),
      forkThread: vi.fn(),
      rollbackThread: vi.fn(),
      startThreadCompaction: vi.fn(),
      selectThread,
    },
    setSessionError,
    resolveProjectIdForSession: () => 'codex',
    resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
    getSessionPinnedOverride: () => undefined,
    backendUpdateSession,
  });
  return {
    actions,
    archiveThread,
    hideThread,
    unhideThread,
    selectThread,
    setSessionError,
    backendUpdateSession,
  };
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
