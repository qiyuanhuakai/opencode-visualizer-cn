import { describe, expect, it } from 'vitest';
import { reactive, ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import { useBackendSessionTrees } from './useBackendSessionTrees';

describe('useBackendSessionTrees OpenCode archive projection', () => {
  it('projects an archived OpenCode session into the TopPanel archive state', () => {
    // Given
    const projects = reactive<Record<string, ProjectState>>({
      opencode: {
        id: 'opencode',
        name: 'OpenCode',
        worktree: '/repo',
        sandboxes: {
          '/repo': {
            directory: '/repo',
            name: 'repo',
            rootSessions: ['session-1'],
            sessions: {
              'session-1': {
                id: 'session-1',
                title: 'Archived session',
                directory: '/repo',
                timeUpdated: 1,
                timeArchived: 123,
              },
            },
          },
        },
      },
    });

    // When
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('opencode'),
      projects,
      pinnedStore: ref({}),
      deletedSandboxStore: ref({}),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });

    // Then
    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions[0]?.archivedAt).toBe(123);
  });
});
