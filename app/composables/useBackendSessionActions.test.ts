import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { OpenCodeApiLike } from './useBackendSessionActions';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';

type SessionActionsFixture = ReturnType<typeof createSessionActionsFixture>;

const sessionPayload = {
  sessionId: 'session-1',
  projectId: 'proj-1',
  directory: '/repo',
} as const;

const rollbackScenarios = [
  {
    name: 'Given an opencode deleteSession rejection, When deleteSession runs, Then it reverts the pinned override and surfaces the delete error',
    arrange: () => {
      const mutation = vi
        .fn<OpenCodeApiLike['deleteSession']>()
        .mockRejectedValue(new Error('boom'));
      return {
        fixture: createSessionActionsFixture({ openCodeApi: { deleteSession: mutation } }),
        mutation,
      };
    },
    run: (fixture: SessionActionsFixture) => fixture.actions.deleteSession('session-1'),
    expectedPayload: sessionPayload,
    assertOptimistic: (fixture: SessionActionsFixture) =>
      expect(fixture.mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith(
        'proj-1',
        'session-1',
      ),
    errorKey: 'app.error.sessionDeleteFailed',
  },
  {
    name: 'Given an opencode archiveSession rejection, When archiveSession runs, Then it reverts the pinned override and surfaces the archive error',
    arrange: () => {
      const mutation = vi
        .fn<OpenCodeApiLike['archiveSession']>()
        .mockRejectedValue(new Error('boom'));
      return {
        fixture: createSessionActionsFixture({ openCodeApi: { archiveSession: mutation } }),
        mutation,
      };
    },
    run: (fixture: SessionActionsFixture) => fixture.actions.archiveSession('session-1'),
    expectedPayload: sessionPayload,
    assertOptimistic: (fixture: SessionActionsFixture) =>
      expect(fixture.mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith(
        'proj-1',
        'session-1',
      ),
    errorKey: 'app.error.sessionArchiveFailed',
  },
  {
    name: 'Given an opencode unarchiveSession rejection, When unarchiveSession runs, Then it reverts the pinned override and surfaces the unarchive error',
    arrange: () => {
      const mutation = vi
        .fn<OpenCodeApiLike['unarchiveSession']>()
        .mockRejectedValue(new Error('boom'));
      return {
        fixture: createSessionActionsFixture({ openCodeApi: { unarchiveSession: mutation } }),
        mutation,
      };
    },
    run: (fixture: SessionActionsFixture) => fixture.actions.unarchiveSession('session-1'),
    expectedPayload: sessionPayload,
    assertOptimistic: (fixture: SessionActionsFixture) =>
      expect(fixture.mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith(
        'proj-1',
        'session-1',
      ),
    errorKey: 'app.error.sessionUnarchiveFailed',
  },
  {
    name: 'Given an opencode pinSession rejection, When pinSession runs, Then it reverts the pinned override and surfaces the pin error',
    arrange: () => {
      const mutation = vi.fn<OpenCodeApiLike['pinSession']>().mockRejectedValue(new Error('boom'));
      return {
        fixture: createSessionActionsFixture({ openCodeApi: { pinSession: mutation } }),
        mutation,
      };
    },
    run: (fixture: SessionActionsFixture) => fixture.actions.pinSession('session-1'),
    expectedPayload: { ...sessionPayload, pinnedAt: expect.any(Number) },
    assertOptimistic: (fixture: SessionActionsFixture) =>
      expect(fixture.mocks.setLocalPinnedSession).toHaveBeenCalledWith(
        'proj-1',
        'session-1',
        expect.any(Number),
      ),
    errorKey: 'app.error.sessionPinFailed',
  },
  {
    name: 'Given an opencode unpinSession rejection, When unpinSession runs, Then it reverts the pinned override and surfaces the unpin error',
    arrange: () => {
      const mutation = vi
        .fn<OpenCodeApiLike['unpinSession']>()
        .mockRejectedValue(new Error('boom'));
      return {
        fixture: createSessionActionsFixture({ openCodeApi: { unpinSession: mutation } }),
        mutation,
      };
    },
    run: (fixture: SessionActionsFixture) => fixture.actions.unpinSession('session-1'),
    expectedPayload: sessionPayload,
    assertOptimistic: (fixture: SessionActionsFixture) =>
      expect(fixture.mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1'),
    errorKey: 'app.error.sessionUnpinFailed',
  },
] as const;

describe('useBackendSessionActions mutation skeleton', () => {
  it('passes the selected Codex message to rollback instead of always reverting one turn', async () => {
    const rollbackThread = vi.fn().mockResolvedValue({});
    const { actions } = createSessionActionsFixture({
      activeBackendKind: 'codex',
      codexApi: { rollbackThread },
    });
    await actions.handleRevertMessage({
      sessionId: 'session-1',
      messageId: 'old-turn:user:client-id',
    });
    expect(rollbackThread).toHaveBeenCalledWith('session-1', 'old-turn:user:client-id');
  });
  it.each(rollbackScenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const { fixture, mutation } = scenario.arrange();

      await scenario.run(fixture);

      expect(mutation).toHaveBeenCalledWith(scenario.expectedPayload);
      scenario.assertOptimistic(fixture);
      expect(fixture.mocks.restoreLocalPinnedSessionOverride).toHaveBeenCalledWith(
        'proj-1',
        'session-1',
        123,
      );
      expect(fixture.mocks.setSessionError).toHaveBeenCalledWith(scenario.errorKey);
    },
  );

  it('Given an empty session id, When deleteSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createSessionActionsFixture();

    await actions.deleteSession('');

    expect(mocks.clearLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.deleteSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given the connection is not ready, When archiveSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createSessionActionsFixture({ ensureConnectionReady: () => false });

    await actions.archiveSession('session-1');

    expect(mocks.clearLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.archiveSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an empty session id, When unpinSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createSessionActionsFixture();

    await actions.unpinSession('');

    expect(mocks.setLocalUnpinnedSession).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.unpinSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given the connection is not ready, When pinSession runs, Then no optimistic or server mutation happens', async () => {
    const { actions, mocks } = createSessionActionsFixture({ ensureConnectionReady: () => false });

    await actions.pinSession('session-1');

    expect(mocks.setLocalPinnedSession).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.pinSession).not.toHaveBeenCalled();
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an acp backend, When pinSession runs, Then the optimistic pin is applied without a server call', async () => {
    const { actions, mocks } = createSessionActionsFixture({ activeBackendKind: 'acp' });

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
    const { actions, mocks } = createSessionActionsFixture({
      openCodeApi: { deleteSession: vi.fn().mockResolvedValue(undefined) },
    });

    await actions.deleteSession('session-1');

    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an opencode deleteSession, When deleteSession runs, Then the optimistic mutation happens before the server call', async () => {
    const { actions, mocks } = createSessionActionsFixture();

    await actions.deleteSession('session-1');

    expect(mocks.clearLocalPinnedSessionOverride).toHaveBeenCalledBefore(
      mocks.openCodeApi.deleteSession,
    );
  });

  it('Given a successful opencode unpinSession, When unpinSession runs, Then the optimistic pin override stays without a rollback', async () => {
    const { actions, mocks } = createSessionActionsFixture({
      openCodeApi: { unpinSession: vi.fn().mockResolvedValue(undefined) },
    });

    await actions.unpinSession('session-1');

    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an opencode unpinSession, When unpinSession runs, Then the optimistic mutation happens before the server call', async () => {
    const { actions, mocks } = createSessionActionsFixture();

    await actions.unpinSession('session-1');

    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledBefore(mocks.openCodeApi.unpinSession);
  });

  it('Given an acp backend, When unpinSession runs, Then the optimistic unpin is applied without a server call', async () => {
    const { actions, mocks } = createSessionActionsFixture({ activeBackendKind: 'acp' });

    await actions.unpinSession('session-1');

    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
    expect(mocks.openCodeApi.unpinSession).not.toHaveBeenCalled();
    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });

  it('Given an acp backendDeleteSession rejection, When deleteSession runs, Then the delete error is surfaced without a pinned rollback', async () => {
    const { actions, mocks } = createSessionActionsFixture({
      activeBackendKind: 'acp',
      backendDeleteSession: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await actions.deleteSession('session-1');

    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });

  it('Given a codex archiveThread rejection, When deleteSession runs, Then the delete error is surfaced without a pinned rollback', async () => {
    const { actions, mocks } = createSessionActionsFixture({
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
    const { actions } = createSessionActionsFixture({
      activeBackendKindRef: activeBackendKind,
      selectedProjectId: ref('codex'),
      selectedSessionId: ref('thread-1'),
      openCodeApi: { renameSession: openCodeRenameSession },
      codexApi: { activeThreadId: ref('thread-1'), setThreadName },
      showPrompt: vi.fn(() => new Promise<string | null>((resolve) => (resolvePrompt = resolve))),
      resolveProjectIdForSession: () => 'codex',
      resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession,
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
    const { actions } = createSessionActionsFixture({
      openCodeApi: { pinSession },
      getSessionPinnedOverride: () => undefined,
      setLocalPinnedSession,
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
    const { actions } = createSessionActionsFixture({
      activeBackendKind: 'acp',
      selectedProjectId: ref('acp'),
      openCodeApi: { deleteSession: openCodeDelete },
      resolveProjectIdForSession: () => 'acp',
      resolveSessionOperationPayload: () => ({ projectId: 'acp', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
      backendDeleteSession,
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
    const { actions } = createSessionActionsFixture({
      activeBackendKindRef: activeBackendKind,
      selectedProjectId: ref('codex'),
      selectedSessionId: ref('thread-1'),
      openCodeApi: { renameSession },
      codexApi: { activeThreadId: ref('thread-1'), setThreadName },
      showPrompt: () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
      resolveProjectIdForSession: () => 'codex',
      resolveSessionOperationPayload: () => ({ projectId: 'codex', directory: '/repo' }),
      getSessionPinnedOverride: () => undefined,
    });

    const pending = actions.renameSession('thread-1');
    activeBackendKind.value = 'opencode';
    resolvePrompt?.('renamed');
    await pending;

    expect(setThreadName).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });
});
