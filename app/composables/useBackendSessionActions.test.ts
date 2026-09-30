import { describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import type { OpenCodeApiLike } from './useBackendSessionActions';
import type { DshSessionActionApi } from './dshSessionActions';
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

  it.each(['acp', 'kimi-web'] as const)(
    'Given a %s backend, pinning and unpinning persist locally without an OpenCode request',
    async (activeBackendKind) => {
      const { actions, mocks } = createSessionActionsFixture({ activeBackendKind });

      await actions.pinSession('session-1');

      expect(mocks.setLocalPinnedSession).toHaveBeenCalledWith(
        'proj-1',
        'session-1',
        expect.any(Number),
      );
      expect(mocks.openCodeApi.pinSession).not.toHaveBeenCalled();
      expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
      expect(mocks.setSessionError).not.toHaveBeenCalled();
      await actions.unpinSession('session-1');
      expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
      expect(mocks.openCodeApi.unpinSession).not.toHaveBeenCalled();
    },
  );

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

  it('Given a codex deleteThread rejection, When deleteSession runs, Then the delete error is surfaced without a pinned rollback', async () => {
    const { actions, mocks } = createSessionActionsFixture({
      activeBackendKind: 'codex',
      codexApi: { deleteThread: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    await actions.deleteSession('session-1');

    expect(mocks.restoreLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });
});

describe('useBackendSessionActions', () => {
  it('reloads the selected OpenCode session after reverting a message', async () => {
    const fixture = createSessionActionsFixture();

    await fixture.actions.handleRevertMessage({ sessionId: 'session-1', messageId: 'message-2' });

    expect(fixture.mocks.openCodeApi.revertSession).toHaveBeenCalledWith({
      sessionId: 'session-1', messageId: 'message-2', projectId: 'proj-1', directory: '/repo',
    });
    expect(fixture.params.reloadSelectedSessionState).toHaveBeenCalledWith('session-1', undefined, true);
  });
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

function createDshProjects(): Record<string, ProjectState> {
  return reactive({
    workspace: {
      id: 'workspace',
      name: 'Workspace',
      worktree: '/repo',
      sandboxes: {
        '/repo': {
          directory: '/repo',
          name: 'repo',
          rootSessions: ['session-1'],
          sessions: {
            'session-1': { id: 'session-1', title: 'Original', directory: '/repo', timeUpdated: 1 },
          },
        },
      },
    },
  });
}

function createDshApi(overrides: Partial<DshSessionActionApi> = {}) {
  const order: string[] = [];
  const api: DshSessionActionApi = {
    renameSession: vi.fn(async (sessionId: string, title: string) => {
      order.push(`rename:${sessionId}:${title}`);
      return {};
    }),
    forkSession: vi.fn(async (sessionId: string, atSeq?: number) => {
      order.push(`fork:${sessionId}:${atSeq ?? ''}`);
      return { sessionId: 'fork-1' };
    }),
    archiveSession: vi.fn(async (sessionId: string) => {
      order.push(`archive:${sessionId}`);
      return {};
    }),
    unarchiveSession: vi.fn(async (sessionId: string) => {
      order.push(`unarchive:${sessionId}`);
      return {};
    }),
    pinSession: vi.fn(async (sessionId: string) => {
      order.push(`pin:${sessionId}`);
      return {};
    }),
    unpinSession: vi.fn(async (sessionId: string) => {
      order.push(`unpin:${sessionId}`);
      return {};
    }),
    followSession: vi.fn(async (sessionId: string) => {
      order.push(`follow:${sessionId}`);
      return { archived: false };
    }),
    disposeSessionFollow: vi.fn((sessionId: string) => {
      order.push(`dispose:${sessionId}`);
    }),
    ...overrides,
  };
  return { api, order };
}

describe('useBackendSessionActions dsh', () => {
  it('Given a dsh session, When renameSession runs, Then it writes the title through the dsh seam and not OpenCode', async () => {
    const projects = createDshProjects();
    const { api } = createDshApi();
    const openCodeRename = vi.fn();
    const { actions } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      serverProjects: projects,
      dshSessionApi: api,
      openCodeApi: { renameSession: openCodeRename },
      showPrompt: vi.fn().mockResolvedValue('Renamed'),
    });

    await actions.renameSession('session-1');

    expect(api.renameSession).toHaveBeenCalledWith('session-1', 'Renamed');
    expect(openCodeRename).not.toHaveBeenCalled();
    expect(projects.workspace.sandboxes['/repo'].sessions['session-1'].title).toBe('Renamed');
  });

  it('Given a dsh session, When archiveSession runs, Then it calls the dsh archive seam and not OpenCode', async () => {
    const projects = createDshProjects();
    const { api } = createDshApi();
    const openCodeArchive = vi.fn();
    const { actions, mocks } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      serverProjects: projects,
      dshSessionApi: api,
      openCodeApi: { archiveSession: openCodeArchive },
    });

    await actions.archiveSession('session-1');

    expect(api.archiveSession).toHaveBeenCalledWith('session-1');
    expect(openCodeArchive).not.toHaveBeenCalled();
    expect(projects.workspace.sandboxes['/repo'].sessions['session-1'].timeArchived).toBeGreaterThan(0);
    expect(mocks.setSendStatusKey).toHaveBeenLastCalledWith('app.status.archived');
  });

  it('Given a dsh session, When unarchiveSession runs, Then it calls the dsh unarchive seam and not OpenCode', async () => {
    const projects = createDshProjects();
    projects.workspace.sandboxes['/repo'].sessions['session-1'].timeArchived = 5;
    const { api } = createDshApi();
    const openCodeUnarchive = vi.fn();
    const { actions } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      serverProjects: projects,
      dshSessionApi: api,
      openCodeApi: { unarchiveSession: openCodeUnarchive },
    });

    await actions.unarchiveSession('session-1');

    expect(api.unarchiveSession).toHaveBeenCalledWith('session-1');
    expect(openCodeUnarchive).not.toHaveBeenCalled();
    expect(projects.workspace.sandboxes['/repo'].sessions['session-1'].timeArchived).toBeUndefined();
  });

  it('Given a dsh session, When pin/unpin run, Then they call the dsh pin seams and not OpenCode', async () => {
    const { api } = createDshApi();
    const openCodePin = vi.fn();
    const openCodeUnpin = vi.fn();
    const { actions, mocks } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      dshSessionApi: api,
      openCodeApi: { pinSession: openCodePin, unpinSession: openCodeUnpin },
    });

    await actions.pinSession('session-1');
    await actions.unpinSession('session-1');

    expect(api.pinSession).toHaveBeenCalledWith('session-1');
    expect(api.unpinSession).toHaveBeenCalledWith('session-1');
    expect(openCodePin).not.toHaveBeenCalled();
    expect(openCodeUnpin).not.toHaveBeenCalled();
    expect(mocks.setLocalPinnedSession).toHaveBeenCalledWith('proj-1', 'session-1', expect.any(Number));
    expect(mocks.setLocalUnpinnedSession).toHaveBeenCalledWith('proj-1', 'session-1');
  });

  it('Given a dsh session, When deleteSession runs, Then it hides locally and refuses the server delete with a documented reason', async () => {
    const projects = createDshProjects();
    const { api } = createDshApi();
    const backendDeleteSession = vi.fn();
    const openCodeDelete = vi.fn();
    const { actions, mocks, params } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      serverProjects: projects,
      dshSessionApi: api,
      backendDeleteSession,
      openCodeApi: { deleteSession: openCodeDelete },
    });

    await actions.deleteSession('session-1');

    expect(projects.workspace.sandboxes['/repo'].sessions['session-1']).toBeUndefined();
    expect(projects.workspace.sandboxes['/repo'].rootSessions).toEqual([]);
    expect(params.selectedSessionId.value).toBe('');
    expect(backendDeleteSession).not.toHaveBeenCalled();
    expect(openCodeDelete).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
  });

  it('Given a dsh session, When handleForkSession runs, Then it forks, restores the archive state, and re-subscribes the follow stream', async () => {
    const { api, order } = createDshApi({
      followSession: vi.fn(async (sessionId: string) => {
        order.push(`follow:${sessionId}`);
        return { archived: true };
      }),
    });
    const openCodeFork = vi.fn();
    const { actions, params } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      dshSessionApi: api,
      openCodeApi: { forkSession: openCodeFork },
    });

    await actions.handleForkSession('session-1');

    expect(openCodeFork).not.toHaveBeenCalled();
    // fork ack -> dispose stale stream -> fresh follow -> archive restoration.
    expect(order).toEqual([
      'fork:session-1:',
      'dispose:session-1',
      'follow:fork-1',
      'unarchive:fork-1',
    ]);
    expect(params.switchSessionSelection).toHaveBeenCalledWith('proj-1', 'fork-1');
  });

  it('Given the dsh seam is not injected, When archiveSession runs, Then it fails closed instead of routing to OpenCode', async () => {
    const openCodeArchive = vi.fn();
    const { actions, mocks } = createSessionActionsFixture({
      activeBackendKind: 'dsh',
      openCodeApi: { archiveSession: openCodeArchive },
    });

    await actions.archiveSession('session-1');

    expect(openCodeArchive).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionArchiveFailed');
  });
});

describe('useBackendSessionActions legacy rename guard', () => {
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
