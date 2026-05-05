import { describe, expect, it } from 'vitest';
import { createCodexProjectState } from '../composables/useCodexWorkspace';
import { buildCodexTopPanelTreeData, type CodexTopPanelWorktree } from './codexTopPanelTree';

describe('buildCodexTopPanelTreeData', () => {
  it('groups Codex sessions into sandbox, branch or folder, and session layers', () => {
    const project = createCodexProjectState(
      [
        { id: 'non-git', name: 'Scratch', cwd: '/tmp/scratch', updatedAt: 1 },
        { id: 'main-a', name: 'Main A', cwd: '/repo/packages/a', gitInfo: { root: '/repo', branch: 'main' }, updatedAt: 3 },
        { id: 'main-b', name: 'Main B', cwd: '/repo/packages/b', gitInfo: { root: '/repo', branch: 'main' }, updatedAt: 4 },
        { id: 'dev', name: 'Dev', cwd: '/repo', gitInfo: { root: '/repo', branch: 'dev' }, updatedAt: 2 },
      ],
      '/home/codex',
    );

    const worktrees: CodexTopPanelWorktree[] = buildCodexTopPanelTreeData(project, { pinnedStore: {}, homePath: '/home/codex' });

    expect(worktrees.map((worktree) => [worktree.kind, worktree.name, worktree.directory])).toEqual([
      ['global', 'Global', '/'],
      ['sandbox', 'repo', '/repo'],
    ]);
    expect(worktrees[0].sandboxes.map((sandbox) => [sandbox.kind, sandbox.branch, sandbox.directory])).toEqual([
      ['folder', 'scratch', '/tmp/scratch'],
    ]);
    expect(worktrees[1].sandboxes.map((sandbox) => [sandbox.kind, sandbox.branch])).toEqual([
      ['branch', 'dev'],
      ['branch', 'main'],
    ]);
    expect(worktrees[0].sandboxes[0].sessions.map((session) => session.id)).toEqual(['non-git']);
    expect(worktrees[1].sandboxes[0]).toMatchObject({ directory: '/repo', sessions: [expect.objectContaining({ id: 'dev' })] });
    expect(worktrees[1].sandboxes[1]).toMatchObject({ directory: '/repo' });
    expect(worktrees[1].sandboxes[1].sessions.map((session) => session.id)).toEqual(['main-b', 'main-a']);
  });

  it('uses the normalized git root as branch row directory even when sessions use subdirectories', () => {
    const project = createCodexProjectState(
      [
        { id: 'subdir-a', cwd: '~/repo/a', gitInfo: { root: '~/repo', branch: 'main' }, updatedAt: 1 },
        { id: 'subdir-b', cwd: '~/repo/b', gitInfo: { root: '~/repo', branch: 'main' }, updatedAt: 2 },
      ],
      '/home/codex',
    );

    const [worktree]: CodexTopPanelWorktree[] = buildCodexTopPanelTreeData(project, { pinnedStore: {}, homePath: '/home/codex' });
    const branch = worktree.sandboxes.find((sandbox) => sandbox.kind === 'branch' && sandbox.branch === 'main');

    expect(branch?.directory).toBe('/home/codex/repo');
    expect(branch?.sessions.map((session) => session.id)).toEqual(['subdir-b', 'subdir-a']);
  });

  it('keeps multiple non-git folders visible below the Global sandbox', () => {
    const project = createCodexProjectState(
      [
        { id: 'scripts-a', cwd: '/tmp/scripts', updatedAt: 1 },
        { id: 'notes', cwd: '/home/codex/notes', updatedAt: 2 },
        { id: 'scripts-b', cwd: '/tmp/scripts', updatedAt: 3 },
      ],
      '/home/codex',
    );

    const [global]: CodexTopPanelWorktree[] = buildCodexTopPanelTreeData(project, { pinnedStore: {}, homePath: '/home/codex' });

    expect(global).toMatchObject({ kind: 'global', name: 'Global', directory: '/' });
    expect(global.sandboxes.map((sandbox) => [sandbox.kind, sandbox.branch, sandbox.directory])).toEqual([
      ['folder', 'notes', '/home/codex/notes'],
      ['folder', 'scripts', '/tmp/scripts'],
    ]);
    expect(global.sandboxes[1].sessions.map((session) => session.id)).toEqual(['scripts-b', 'scripts-a']);
  });
});
