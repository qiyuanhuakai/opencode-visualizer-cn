import { describe, expect, it } from 'vitest';
import type { ProjectState, SessionState } from '../types/worker-state';
import { buildCodexSessionTreeData } from '../utils/codexTopPanelTree';
import { buildDshTopPanelTreeData } from './dshSessionTrees';

type SandboxSessions = Record<string, SessionState>;

function session(id: string, directory: string, extra: Partial<SessionState> = {}): SessionState {
  return { id, title: id, directory, status: 'idle', ...extra };
}

function project(
  id: string,
  directory: string,
  options: { rootSessions?: string[]; sessions?: SandboxSessions; name?: string } = {},
): ProjectState {
  return {
    id,
    name: options.name ?? id,
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

function baseParams(projects: Record<string, ProjectState>) {
  return {
    projects,
    pinnedStore: {},
    deletedSandboxStore: {},
    homePath: '/home/user',
    replaceHomePrefix: (path: string) => path,
    resolveProjectColor: () => undefined,
    gitInfoByDirectory: {},
  };
}

describe('dsh top panel groups', () => {
  it('places main and linked worktree branches under one repository sandbox', () => {
    const main = '/home/user/vis';
    const linked = '/home/user/vis.thirdend';
    const groups = buildDshTopPanelTreeData({
      ...baseParams({
        main: project('main', main),
        linked: project('linked', linked),
      }),
      gitInfoByDirectory: {
        [main]: { root: main, branch: 'main' },
        [linked]: { root: linked, commonRoot: main, worktreeRoot: linked, branch: 'thirdend' },
      },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe(`dsh:repo:${main}`);
    expect(groups[0]?.directory).toBe(main);
    expect(groups[0]?.sandboxes.map((branch) => [branch.directory, branch.branch])).toEqual([
      [main, 'main'],
      [linked, 'thirdend'],
    ]);
  });

  it('puts every non-Git project in one Global and gives Git roots their own sandbox', () => {
    const groups = buildDshTopPanelTreeData({
      ...baseParams({
        a: project('a', '/tmp/a'),
        b: project('b', '/tmp/b'),
        c: project('c', '/repo/branch'),
      }),
      pinnedStore: { 'a:a': 10, 'b:b': 20 },
      gitInfoByDirectory: { '/repo/branch': { root: '/repo', branch: 'main' } },
    });
    expect(groups.map((group) => [group.kind, group.label])).toEqual([
      ['global', 'Global'],
      ['sandbox', 'repo'],
    ]);
    expect(groups[0]?.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.projectId))).toEqual([
      'a',
      'b',
    ]);
    expect(groups[1]?.sandboxes[0]?.sessions[0]?.projectId).toBe('c');
    expect(
      buildCodexSessionTreeData(groups)
        .find((group) => group.name === 'Global')
        ?.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.projectId)),
    ).toEqual(['a', 'b']);
  });

  it('groups an empty workspace into no groups', () => {
    expect(buildDshTopPanelTreeData(baseParams({}))).toEqual([]);
  });

  it('keeps the same group and sandbox when a repository branch is renamed', () => {
    const repo = '/home/user/vis';
    const projects = { main: project('main', repo) };
    const before = buildDshTopPanelTreeData({
      ...baseParams(projects),
      gitInfoByDirectory: { [repo]: { root: repo, branch: 'main' } },
    });
    const after = buildDshTopPanelTreeData({
      ...baseParams(projects),
      gitInfoByDirectory: { [repo]: { root: repo, branch: 'renamed-main' } },
    });

    // A rename must not create a new group, duplicate sandboxes, or drop sessions.
    expect(after).toHaveLength(before.length);
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.sandboxes.map((sandbox) => sandbox.directory)).toEqual(
      before[0]?.sandboxes.map((sandbox) => sandbox.directory),
    );
    expect(after[0]?.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.id))).toEqual(['main']);
    // Only the displayed branch label changes.
    expect(before[0]?.sandboxes[0]?.branch).toBe('main');
    expect(after[0]?.sandboxes[0]?.branch).toBe('renamed-main');
  });

  it('never surfaces a dsh child session as a top-level session', () => {
    const repo = '/home/user/vis';
    const groups = buildDshTopPanelTreeData({
      ...baseParams({
        main: project('main', repo, {
          // Deliberately list the child first and inside rootSessions: without the
          // input-boundary filter it would leak into the top-level tree.
          rootSessions: ['child-1', 'parent-1'],
          sessions: {
            'parent-1': session('parent-1', repo),
            'child-1': session('child-1', repo, { parentID: 'parent-1' }),
          },
        }),
      }),
      gitInfoByDirectory: { [repo]: { root: repo, branch: 'main' } },
    });

    const topLevelIds = groups.flatMap((group) =>
      group.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.id)),
    );
    expect(topLevelIds).toEqual(['parent-1']);
    expect(topLevelIds).not.toContain('child-1');

    const sessionTreeIds = buildCodexSessionTreeData(groups).flatMap((group) =>
      group.sandboxes.flatMap((sandbox) => sandbox.sessions.map((entry) => entry.sessionId)),
    );
    expect(sessionTreeIds).not.toContain('child-1');
  });
});
