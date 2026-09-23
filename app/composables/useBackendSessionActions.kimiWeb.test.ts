import { describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import { KimiWebError } from '../utils/kimiWeb';
import { useBackendSessionTrees } from './useBackendSessionTrees';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';

function createKimiFixture(
  overrides: Parameters<typeof createSessionActionsFixture>[0] = {},
) {
  return createSessionActionsFixture({ activeBackendKind: 'kimi-web', ...overrides });
}

function createKimiProjects(): Record<string, ProjectState> {
  return reactive({
    workspace: {
      id: 'workspace',
      name: 'Workspace',
      worktree: '/repo',
      sandboxes: {
        '/repo': {
          directory: '/repo',
          name: 'repo',
          rootSessions: ['session-1', 'session-2'],
          sessions: {
            'session-1': {
              id: 'session-1',
              title: 'Archived session',
              directory: '/repo',
              timeUpdated: 2,
              timeArchived: 1,
            },
            'session-2': {
              id: 'session-2',
              title: 'Other session',
              directory: '/repo',
              timeUpdated: 1,
            },
          },
        },
      },
    },
  });
}

function createKimiTrees(projects: Record<string, ProjectState>) {
  return useBackendSessionTrees({
    activeBackendKind: ref('kimi-web'),
    projects,
    pinnedStore: ref({}),
    deletedSandboxStore: ref({}),
    homePath: ref('/home/test'),
    replaceHomePrefix: (path) => path,
    resolveProjectColor: () => undefined,
  });
}

describe('useBackendSessionActions kimi-web', () => {
  it('updates the archive projection immediately after the server confirms archiving', async () => {
    // Given
    const projects = createKimiProjects();
    const trees = createKimiTrees(projects);
    const { actions, mocks } = createKimiFixture({
      serverProjects: projects,
      kimiWebApi: { archiveSession: async () => ({ id: 'session-2', archived: true }) },
      setLocalSessionArchived: (id, archived) => {
        projects.workspace.sandboxes['/repo'].sessions[id].timeArchived = archived;
      },
    });
    // When
    await actions.archiveSession('session-2');
    // Then
    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions.find((item) => item.id === 'session-2')?.archivedAt).toBeGreaterThan(0);
    expect(trees.navigableTree.value).toEqual([]);
    expect(mocks.setSendStatusKey).toHaveBeenLastCalledWith('app.status.archived');
  });

  it('returns restored sessions to the navigable tree immediately', async () => {
    // Given
    const projects = createKimiProjects();
    const trees = createKimiTrees(projects);
    const { actions } = createKimiFixture({
      serverProjects: projects,
      kimiWebApi: { restoreSession: async () => ({ id: 'session-1', archived: false }) },
      setLocalSessionArchived: (id, archived) => {
        projects.workspace.sandboxes['/repo'].sessions[id].timeArchived = archived;
      },
    });
    // When
    await actions.unarchiveSession('session-1');
    // Then
    expect(trees.navigableTree.value[0]?.sandboxes[0]?.sessions.map((item) => item.id)).toContain('session-1');
  });

  it('updates session titles in the tree after a successful rename', async () => {
    // Given
    const projects = createKimiProjects();
    const trees = createKimiTrees(projects);
    const { actions } = createKimiFixture({
      serverProjects: projects,
      kimiWebApi: { updateProfile: async () => ({ id: 'session-2', title: 'Renamed' }) },
      showPrompt: async () => 'Renamed',
    });
    // When
    await actions.renameSession('session-2');
    // Then
    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions.find((item) => item.id === 'session-2')?.title).toBe('Renamed');
  });

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

  it('Given a selected archived kimi-web session, When deletion succeeds, Then local trees drop it and selection clears', async () => {
    const projects = createKimiProjects();
    const trees = createKimiTrees(projects);
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const { actions, params } = createKimiFixture({
      serverProjects: projects,
      kimiWebApi: { deleteSession },
    });

    expect(
      trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions.map((session) => session.id),
    ).toContain('session-1');

    await actions.deleteSession('session-1');

    expect(projects.workspace.sandboxes['/repo'].sessions['session-1']).toBeUndefined();
    expect(projects.workspace.sandboxes['/repo'].rootSessions).toEqual(['session-2']);
    expect(params.selectedSessionId.value).toBe('');
    expect(
      trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions.map((session) => session.id),
    ).not.toContain('session-1');
  });

  it('Given another kimi-web session is selected, When deletion succeeds, Then the existing selection remains', async () => {
    const projects = createKimiProjects();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const { actions, params } = createKimiFixture({
      serverProjects: projects,
      selectedSessionId: ref('session-2'),
      kimiWebApi: { deleteSession },
    });

    await actions.deleteSession('session-1');

    expect(params.selectedSessionId.value).toBe('session-2');
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
    const projects = createKimiProjects();
    const { actions, mocks, params } = createKimiFixture({
      serverProjects: projects,
      kimiWebApi: { deleteSession },
    });

    await actions.deleteSession('session-1');

    expect(deleteSession).toHaveBeenCalledWith('session-1');
    expect(mocks.setSessionError).toHaveBeenCalledWith('app.error.sessionDeleteFailed');
    expect(mocks.clearLocalPinnedSessionOverride).not.toHaveBeenCalled();
    expect(projects.workspace.sandboxes['/repo'].sessions['session-1']).toBeDefined();
    expect(projects.workspace.sandboxes['/repo'].rootSessions).toContain('session-1');
    expect(params.selectedSessionId.value).toBe('session-1');
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
