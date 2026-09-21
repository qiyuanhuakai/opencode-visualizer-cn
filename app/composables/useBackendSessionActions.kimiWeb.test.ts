import { describe, expect, it, vi } from 'vitest';
import { KimiWebError } from '../utils/kimiWeb';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';

function createKimiFixture(
  overrides: Parameters<typeof createSessionActionsFixture>[0] = {},
) {
  return createSessionActionsFixture({ activeBackendKind: 'kimi-web', ...overrides });
}

describe('useBackendSessionActions kimi-web', () => {
  it('Given a kimi-web session, When deleteSession runs, Then it calls the :delete endpoint and not OpenCode', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const openCodeDelete = vi.fn();
    const { actions } = createKimiFixture({
      kimiWebApi: { deleteSession },
      openCodeApi: { deleteSession: openCodeDelete },
    });

    await actions.deleteSession('session-1');

    expect(deleteSession).toHaveBeenCalledWith('session-1');
    expect(openCodeDelete).not.toHaveBeenCalled();
  });

  it('Given a kimi-web session, When archiveSession runs, Then it calls :archive and not OpenCode', async () => {
    const archiveSession = vi.fn().mockResolvedValue({ id: 'session-1' });
    const openCodeArchive = vi.fn();
    const { actions } = createKimiFixture({
      kimiWebApi: { archiveSession },
      openCodeApi: { archiveSession: openCodeArchive },
    });

    await actions.archiveSession('session-1');

    expect(archiveSession).toHaveBeenCalledWith('session-1');
    expect(openCodeArchive).not.toHaveBeenCalled();
  });

  it('Given a kimi-web session, When unarchiveSession runs, Then it calls :restore and not OpenCode', async () => {
    const restoreSession = vi.fn().mockResolvedValue({ id: 'session-1' });
    const openCodeUnarchive = vi.fn();
    const { actions } = createKimiFixture({
      kimiWebApi: { restoreSession },
      openCodeApi: { unarchiveSession: openCodeUnarchive },
    });

    await actions.unarchiveSession('session-1');

    expect(restoreSession).toHaveBeenCalledWith('session-1');
    expect(openCodeUnarchive).not.toHaveBeenCalled();
  });

  it('Given a kimi-web session, When renameSession runs, Then it writes the title through the profile endpoint', async () => {
    const updateProfile = vi.fn().mockResolvedValue({ id: 'session-1', title: 'New title' });
    const openCodeRename = vi.fn();
    const { actions } = createKimiFixture({
      kimiWebApi: { updateProfile },
      openCodeApi: { renameSession: openCodeRename },
      findSessionInProjects: () => null,
      showPrompt: vi.fn().mockResolvedValue('New title'),
    });

    await actions.renameSession('session-1');

    expect(updateProfile).toHaveBeenCalledWith('session-1', { title: 'New title' });
    expect(openCodeRename).not.toHaveBeenCalled();
  });

  it('Given a kimi 40401 delete failure, When deleteSession runs, Then the failure surfaces instead of faking success', async () => {
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new KimiWebError(40401, 'Session not found.'));
    const { actions, mocks } = createKimiFixture({ kimiWebApi: { deleteSession } });

    await actions.deleteSession('session-1');

    expect(deleteSession).toHaveBeenCalledWith('session-1');
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
    expect(mocks.clearLocalPinnedSessionOverride).not.toHaveBeenCalled();
  });

  it('Given a kimi archive failure, When archiveSession runs, Then the failure surfaces', async () => {
    const archiveSession = vi
      .fn()
      .mockRejectedValue(new KimiWebError(40401, 'Session not found.'));
    const { actions, mocks } = createKimiFixture({ kimiWebApi: { archiveSession } });

    await actions.archiveSession('session-1');

    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionArchiveFailed');
  });

  it('Given the kimi client is not injected, When deleteSession runs, Then it surfaces an unavailable error instead of routing to OpenCode', async () => {
    const openCodeDelete = vi.fn();
    const { actions, mocks } = createKimiFixture({
      openCodeApi: { deleteSession: openCodeDelete },
    });

    await actions.deleteSession('session-1');

    expect(openCodeDelete).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });
});
