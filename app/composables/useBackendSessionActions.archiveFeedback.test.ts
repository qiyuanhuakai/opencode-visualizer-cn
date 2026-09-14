import { describe, expect, it, vi } from 'vitest';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';

function createAcpActions() {
  const backendUpdateSession = vi.fn().mockResolvedValue({});
  const setSendStatusKey = vi.fn();
  const setLocalSessionArchived = vi.fn();
  const { actions } = createSessionActionsFixture({
    activeBackendKind: 'acp',
    resolveProjectIdForSession: () => 'acp',
    resolveSessionOperationPayload: () => ({ projectId: 'acp', directory: '/repo' }),
    getSessionPinnedOverride: () => undefined,
    setSendStatusKey,
    setLocalSessionArchived,
    backendUpdateSession,
  });
  return { actions, backendUpdateSession, setSendStatusKey, setLocalSessionArchived };
}

describe('ACP archive feedback', () => {
  it('shows a localized success status after archiving', async () => {
    const { actions, backendUpdateSession, setSendStatusKey, setLocalSessionArchived } =
      createAcpActions();

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
    const { actions, backendUpdateSession, setSendStatusKey, setLocalSessionArchived } =
      createAcpActions();

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
