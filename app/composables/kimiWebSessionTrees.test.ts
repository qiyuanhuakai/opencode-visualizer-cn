import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../types/worker-state';
import { buildCodexSessionTreeData } from '../utils/codexTopPanelTree';
import { buildKimiWebTopPanelTreeData } from './kimiWebSessionTrees';

function project(id: string, directory: string): ProjectState {
  return {
    id, name: id, worktree: directory,
    sandboxes: {
      [directory]: {
        directory, name: id, rootSessions: [id],
        sessions: { [id]: { id, title: id, directory, status: 'idle' } },
      },
    },
  };
}

describe('Kimi Web top panel groups', () => {
  it('places main and linked worktree branches under one repository sandbox', () => {
    const main = '/home/user/vis';
    const linked = '/home/user/vis.thirdend';
    const groups = buildKimiWebTopPanelTreeData({
      projects: { main: project('main', main), linked: project('linked', linked) },
      pinnedStore: {}, deletedSandboxStore: {}, homePath: '/home/user',
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
      gitInfoByDirectory: {
        [main]: { root: main, branch: 'main' },
        [linked]: { root: linked, commonRoot: main, worktreeRoot: linked, branch: 'thirdend' },
      },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.directory).toBe(main);
    expect(groups[0]?.sandboxes.map((branch) => [branch.directory, branch.branch])).toEqual([
      [main, 'main'], [linked, 'thirdend'],
    ]);
  });

  it('puts every non-Git project in one Global and gives Git roots their own sandbox', () => {
    const groups = buildKimiWebTopPanelTreeData({
      projects: {
        a: project('a', '/tmp/a'),
        b: project('b', '/tmp/b'),
        c: project('c', '/repo/branch'),
      },
      pinnedStore: { 'a:a': 10, 'b:b': 20 }, deletedSandboxStore: {}, homePath: '/home/user',
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
      gitInfoByDirectory: { '/repo/branch': { root: '/repo', branch: 'main' } },
    });
    expect(groups.map((group) => [group.kind, group.label])).toEqual([
      ['global', 'Global'], ['sandbox', 'repo'],
    ]);
    expect(groups[0]?.sandboxes.flatMap((sandbox) => sandbox.sessions.map((session) => session.projectId))).toEqual(['a', 'b']);
    expect(groups[1]?.sandboxes[0]?.sessions[0]?.projectId).toBe('c');
    expect(buildCodexSessionTreeData(groups).find((group) => group.name === 'Global')
      ?.sandboxes.flatMap((sandbox) => sandbox.sessions.map((session) => session.projectId))).toEqual(['a', 'b']);
  });
});
