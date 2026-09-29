import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';

function createActions() {
  const archiveThread = vi.fn().mockResolvedValue({});
  const unarchiveThread = vi.fn().mockResolvedValue({ id: 'thread-1' });
  const deleteThread = vi.fn().mockResolvedValue({});
  const selectThread = vi.fn().mockResolvedValue({});
  const setSessionError = vi.fn();
  const backendUpdateSession = vi.fn();
  const { actions } = createSessionActionsFixture({
    activeBackendKind: 'codex',
    selectedProjectId: ref('codex'),
    selectedSessionId: ref('thread-1'),
    codexApi: {
      visibleThreads: ref([{ id: 'thread-2' }]),
      activeThreadId: ref('thread-2'),
      archiveThread,
      unarchiveThread,
      deleteThread,
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
    unarchiveThread,
    deleteThread,
    selectThread,
    setSessionError,
    backendUpdateSession,
  };
}

describe('Codex archive and delete actions', () => {
  it('routes archive and permanent delete to separate Codex operations', async () => {
    const { actions, archiveThread, deleteThread } = createActions();
    await actions.archiveSession('thread-1');
    expect(archiveThread).toHaveBeenCalledWith('thread-1');

    await actions.deleteSession('thread-1');
    expect(deleteThread).toHaveBeenCalledWith('thread-1');
    expect(archiveThread).toHaveBeenCalledTimes(1);
  });

  it('restores a server archived Codex thread and selects it only after success', async () => {
    const fixture = createActions();
    await fixture.actions.unarchiveSession('thread-1');
    expect(fixture.unarchiveThread).toHaveBeenCalledWith('thread-1');
    expect(fixture.selectThread).toHaveBeenCalledWith('thread-1');
    expect(fixture.setSessionError).not.toHaveBeenCalled();
  });
});
