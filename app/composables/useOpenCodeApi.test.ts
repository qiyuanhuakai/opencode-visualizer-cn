import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenCodeApi } from './useOpenCodeApi';

const { updateSessionMock, waitForStateMock, deleteWorktreeMock } = vi.hoisted(() => ({
  updateSessionMock: vi.fn(),
  waitForStateMock: vi.fn(),
  deleteWorktreeMock: vi.fn(),
}));

vi.mock('../utils/opencode', () => ({
  updateSession: updateSessionMock,
  deleteWorktree: deleteWorktreeMock,
}));

vi.mock('../utils/waitForState', () => ({
  waitForState: waitForStateMock,
}));

function createProjects() {
  return {
    p1: {
      id: 'p1',
      worktree: '/',
      sandboxes: {
        '/': {
          directory: '/',
          name: 'main',
          rootSessions: ['s1'],
          sessions: {
            s1: {
              id: 's1',
              timeCreated: 1,
              timeUpdated: 1,
            },
          },
        },
      },
    },
  };
}

describe('useOpenCodeApi pin regression', () => {
  beforeEach(() => {
    updateSessionMock.mockReset();
    waitForStateMock.mockReset();
    deleteWorktreeMock.mockReset();
  });

  it('pinSession resolves after the PATCH request without waiting for SSE reconciliation', async () => {
    updateSessionMock.mockResolvedValueOnce({ id: 's1', projectID: 'p1' });
    waitForStateMock.mockImplementation(() => new Promise(() => {}));

    const api = useOpenCodeApi(createProjects());

    expect(api.pending.value).toBe(false);

    const result = await api.pinSession({ sessionId: 's1', projectId: 'p1', directory: '/' });

    expect(result).toEqual({ id: 's1', projectID: 'p1' });
    expect(api.pending.value).toBe(false);
    expect(updateSessionMock).toHaveBeenCalledWith('s1', { time: { pinned: expect.any(Number) } }, '/');
    expect(waitForStateMock).not.toHaveBeenCalled();
  });

  it('pinSession forwards an explicit optimistic pinnedAt timestamp to the PATCH payload', async () => {
    updateSessionMock.mockResolvedValueOnce({ id: 's1', projectID: 'p1' });

    const api = useOpenCodeApi(createProjects());

    await api.pinSession({ sessionId: 's1', projectId: 'p1', directory: '/', pinnedAt: 4242 });

    expect(updateSessionMock).toHaveBeenCalledWith('s1', { time: { pinned: 4242 } }, '/');
  });

  it('unpinSession resolves after the PATCH request without waiting for SSE reconciliation', async () => {
    updateSessionMock.mockResolvedValueOnce({ id: 's1', projectID: 'p1' });
    waitForStateMock.mockImplementation(() => new Promise(() => {}));

    const api = useOpenCodeApi(createProjects());

    const result = await api.unpinSession({ sessionId: 's1', projectId: 'p1', directory: '/' });

    expect(result).toEqual({ id: 's1', projectID: 'p1' });
    expect(api.pending.value).toBe(false);
    expect(updateSessionMock).toHaveBeenCalledWith('s1', { time: { pinned: 0 } }, '/');
    expect(waitForStateMock).not.toHaveBeenCalled();
  });

  it('deleteWorktree removes the sandbox optimistically after the DELETE request', async () => {
    deleteWorktreeMock.mockResolvedValueOnce(undefined);
    waitForStateMock.mockRejectedValueOnce(new Error('timeout'));

    const projects = {
      p1: {
        id: 'p1',
        worktree: '/repo',
        sandboxes: {
          '/repo': {
            directory: '/repo',
            name: 'main',
            rootSessions: ['s1'],
            sessions: {
              s1: {
                id: 's1',
                timeCreated: 1,
                timeUpdated: 1,
              },
            },
          },
          '/repo/feature': {
            directory: '/repo/feature',
            name: 'feature',
            rootSessions: ['s2'],
            sessions: {
              s2: {
                id: 's2',
                timeCreated: 2,
                timeUpdated: 2,
              },
            },
          },
        },
      },
    };

    const api = useOpenCodeApi(projects as any);

    await api.deleteWorktree({
      directory: '/repo',
      targetDirectory: '/repo/feature',
      projectId: 'p1',
    });

    expect(deleteWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/feature');
    expect(projects.p1.sandboxes['/repo/feature']).toBeUndefined();
  });
});
