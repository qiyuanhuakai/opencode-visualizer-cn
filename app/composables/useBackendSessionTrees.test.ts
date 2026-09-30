import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { SessionState } from '../types/worker-state';
import type { ProjectState } from '../types/worker-state';
import { useBackendSessionTrees } from './useBackendSessionTrees';

type TreeOptions = Parameters<typeof useBackendSessionTrees>[0];

function session(id: string, directory: string, extra: Partial<SessionState> = {}): SessionState {
  return { id, title: id, directory, status: 'idle', ...extra };
}

function project(
  id: string,
  directory: string,
  options: { rootSessions?: string[]; sessions?: Record<string, SessionState> } = {},
): ProjectState {
  return {
    id,
    name: id,
    worktree: directory,
    sandboxes: {
      [directory]: {
        directory,
        name: id,
        rootSessions: options.rootSessions ?? [id],
        sessions: options.sessions ?? { [id]: session(id, directory) },
      },
    },
  };
}

function dshTree(
  projects: Record<string, ProjectState>,
  overrides: Partial<Omit<TreeOptions, 'projects' | 'activeBackendKind'>> = {},
) {
  return useBackendSessionTrees({
    activeBackendKind: ref('dsh'),
    projects,
    pinnedStore: ref({}),
    deletedSandboxStore: ref({}),
    homePath: ref('/home/user'),
    replaceHomePrefix: (path) => path,
    resolveProjectColor: () => undefined,
    ...overrides,
  });
}

describe('useBackendSessionTrees dsh routing', () => {
  it('routes dsh through the dsh repo grouping instead of the OpenCode default', () => {
    const main = '/home/user/vis';
    const linked = '/home/user/vis.thirdend';
    const trees = dshTree(
      { main: project('main', main), linked: project('linked', linked) },
      {
        pinnedStore: ref({ 'main:main': 1, 'linked:linked': 1 }),
        gitInfoByDirectory: ref({
          [main]: { root: main, branch: 'main' },
          [linked]: { root: linked, commonRoot: main, worktreeRoot: linked, branch: 'thirdend' },
        }),
      },
    );

    // The OpenCode default would keep one worktree per project; the dsh branch
    // folds both branches of the same repository into ONE sandbox group.
    expect(trees.topPanelTreeData.value).toHaveLength(1);
    expect(trees.topPanelTreeData.value[0]?.key).toBe(`dsh:repo:${main}`);
    expect(trees.topPanelTreeData.value[0]?.sandboxes.map((sandbox) => sandbox.directory)).toEqual([
      main,
      linked,
    ]);
    // sessionTreeData for dsh is projected from that grouped top panel data.
    expect(trees.sessionTreeData.value).toHaveLength(1);
    expect(trees.sessionTreeData.value[0]?.name).toBe('vis');
  });

  it('drops dsh child sessions from both the top panel and the session tree', () => {
    const repo = '/home/user/vis';
    const trees = dshTree(
      {
        main: project('main', repo, {
          rootSessions: ['child-1', 'parent-1'],
          sessions: {
            'parent-1': session('parent-1', repo),
            'child-1': session('child-1', repo, { parentID: 'parent-1' }),
          },
        }),
      },
      {
        pinnedStore: ref({ 'main:parent-1': 1, 'main:child-1': 1 }),
        gitInfoByDirectory: ref({ [repo]: { root: repo, branch: 'main' } }),
      },
    );

    const topLevelIds = trees.topPanelTreeData.value.flatMap((worktree) =>
      worktree.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.id)),
    );
    expect(topLevelIds).toEqual(['parent-1']);

    const sessionTreeIds = trees.sessionTreeData.value.flatMap((tree) =>
      tree.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.sessionId)),
    );
    expect(sessionTreeIds).not.toContain('child-1');
  });
});
