import { describe, expect, it } from 'vitest';

import type { ProjectState } from '../types/worker-state';
import { buildOpenCodeSessionTreeData } from './openCodeSessionTrees';

const PROJECT_ID = 'project-1';
const DIRECTORY = '/repo';
const SESSION_ID = 'session-1';

function buildProjects(options: {
  directory?: string;
  sandboxName?: string;
  timePinned?: number;
  rootStatus?: 'busy' | 'idle' | 'retry';
  childStatus?: 'busy' | 'idle' | 'retry';
} = {}): Record<string, ProjectState> {
  const directory = options.directory ?? DIRECTORY;
  return {
    [PROJECT_ID]: {
      id: PROJECT_ID,
      name: 'Repo',
      worktree: directory,
      sandboxes: {
        [directory]: {
          directory,
          name: options.sandboxName ?? 'main',
          rootSessions: [SESSION_ID],
          sessions: {
            [SESSION_ID]: {
              id: SESSION_ID,
              title: 'Pinned session',
              directory,
              timePinned: options.timePinned ?? 0,
              status: options.rootStatus,
            },
            ...(options.childStatus
              ? {
                  'child-1': {
                    id: 'child-1',
                    title: 'Child session',
                    directory,
                    parentID: SESSION_ID,
                    status: options.childStatus,
                  },
                }
              : {}),
          },
        },
      },
    },
  };
}

describe('buildOpenCodeSessionTreeData', () => {
  it('keeps a directly pinned branch visible when its project is explicitly unpinned', () => {
    // Given
    const pinnedStore = {
      [`project:${PROJECT_ID}`]: -100,
      [`sandbox:${PROJECT_ID}:${DIRECTORY}`]: 200,
    };

    // When
    const tree = buildOpenCodeSessionTreeData({
      projects: buildProjects(),
      pinnedStore,
      resolveProjectColor: () => undefined,
    });

    // Then
    expect(tree).toMatchObject([
      {
        projectId: PROJECT_ID,
        isPinned: false,
        sandboxes: [{ directory: DIRECTORY, isPinned: true, sessions: [] }],
      },
    ]);
  });

  it('keeps a server-pinned session visible when its project and branch are explicitly unpinned', () => {
    // Given
    const pinnedStore = {
      [`project:${PROJECT_ID}`]: -100,
      [`sandbox:${PROJECT_ID}:${DIRECTORY}`]: -200,
    };

    // When
    const tree = buildOpenCodeSessionTreeData({
      projects: buildProjects({ timePinned: 300 }),
      pinnedStore,
      resolveProjectColor: () => undefined,
    });

    // Then
    expect(tree).toMatchObject([
      {
        projectId: PROJECT_ID,
        isPinned: false,
        sandboxes: [
          {
            directory: DIRECTORY,
            isPinned: false,
            sessions: [{ sessionId: SESSION_ID, isPinned: true, pinnedAt: 300 }],
          },
        ],
      },
    ]);
  });

  it('uses the worktree directory name while the VCS branch name is still unavailable', () => {
    // Given
    const directory = '/repo/vis.thirdend';

    // When
    const tree = buildOpenCodeSessionTreeData({
      projects: buildProjects({ directory, sandboxName: '', timePinned: 300 }),
      pinnedStore: {},
      resolveProjectColor: () => undefined,
    });

    // Then
    expect(tree[0]?.sandboxes[0]?.name).toBe('vis.thirdend');
  });

  it('reports an idle pinned root as busy while a descendant session is busy', () => {
    const tree = buildOpenCodeSessionTreeData({
      projects: buildProjects({ timePinned: 300, rootStatus: 'idle', childStatus: 'busy' }),
      pinnedStore: {},
      resolveProjectColor: () => undefined,
    });

    expect(tree[0]?.sandboxes[0]?.sessions[0]?.status).toBe('busy');
  });
});
