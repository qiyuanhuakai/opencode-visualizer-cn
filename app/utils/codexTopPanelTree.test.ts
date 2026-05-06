import { describe, expect, it } from 'vitest';
import { createCodexProjectState } from '../composables/useCodexWorkspace';
import { buildCodexSessionTreeData, buildCodexTopPanelTreeData, type CodexTopPanelWorktree } from './codexTopPanelTree';

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

  it('pins individual Codex branch rows without pinning sibling branches', () => {
    const project = createCodexProjectState(
      [
        { id: 'main', cwd: '/repo', gitInfo: { root: '/repo', branch: 'main' }, updatedAt: 2 },
        { id: 'dev', cwd: '/repo', gitInfo: { root: '/repo', branch: 'dev' }, updatedAt: 1 },
      ],
      '/home/codex',
    );

    const [worktree]: CodexTopPanelWorktree[] = buildCodexTopPanelTreeData(project, {
      pinnedStore: { 'sandbox:codex:codex-branch:/repo:main': 123 },
      homePath: '/home/codex',
    });
    const main = worktree.sandboxes.find((sandbox) => sandbox.branch === 'main');
    const dev = worktree.sandboxes.find((sandbox) => sandbox.branch === 'dev');

    expect(main).toMatchObject({ isPinned: true, pinDirectory: 'codex-branch:/repo:main' });
    expect(main?.sessions[0]).toMatchObject({ id: 'main', isImplicitlyPinned: true, pinnedAt: 123 });
    expect(dev).toMatchObject({ isPinned: false, isImplicitlyPinned: false });
    expect(dev?.sessions[0]).toMatchObject({ id: 'dev', isImplicitlyPinned: false, pinnedAt: 0 });
  });

  it('groups git worktrees under their common repository root while keeping branch cwd actions', () => {
    const project = createCodexProjectState(
      [
        { id: 'main', cwd: '/apps/vis_app/vis', gitInfo: { root: '/apps/vis_app/vis', commonRoot: '/apps/vis_app/vis', branch: 'main' }, updatedAt: 1 },
        {
          id: 'bridge',
          cwd: '/apps/vis_app/vis.feat-bridge',
          gitInfo: {
            root: '/apps/vis_app/vis.feat-bridge',
            commonRoot: '/apps/vis_app/vis',
            worktreeRoot: '/apps/vis_app/vis.feat-bridge',
            branch: 'feat/bridge',
          },
          updatedAt: 2,
        },
      ],
      '/home/codex',
    );

    const [worktree]: CodexTopPanelWorktree[] = buildCodexTopPanelTreeData(project, { pinnedStore: {}, homePath: '/home/codex' });

    expect(worktree).toMatchObject({ kind: 'sandbox', name: 'vis', directory: '/apps/vis_app/vis' });
    expect(worktree.sandboxes.map((sandbox) => [sandbox.branch, sandbox.directory])).toEqual([
      ['feat/bridge', '/apps/vis_app/vis.feat-bridge'],
      ['main', '/apps/vis_app/vis'],
    ]);
  });

  it('maps Codex grouped branches into the pinned sidebar session tree', () => {
    const project = createCodexProjectState(
      [
        {
          id: 'bridge',
          name: 'Bridge work',
          cwd: '/apps/vis_app/vis.feat-bridge',
          gitInfo: {
            root: '/apps/vis_app/vis.feat-bridge',
            commonRoot: '/apps/vis_app/vis',
            worktreeRoot: '/apps/vis_app/vis.feat-bridge',
            branch: 'feat/bridge',
          },
          updatedAt: 2,
        },
        { id: 'main', name: 'Main work', cwd: '/apps/vis_app/vis', gitInfo: { root: '/apps/vis_app/vis', commonRoot: '/apps/vis_app/vis', branch: 'main' }, updatedAt: 1 },
      ],
      '/home/codex',
    );
    const worktrees = buildCodexTopPanelTreeData(project, {
      pinnedStore: { 'sandbox:codex:codex-branch:/apps/vis_app/vis:feat/bridge': 123 },
      homePath: '/home/codex',
    });

    const sidebarTree = buildCodexSessionTreeData(worktrees);

    expect(sidebarTree).toHaveLength(1);
    expect(sidebarTree[0]).toMatchObject({ name: 'vis', pinDirectory: '/apps/vis_app/vis', kind: 'sandbox' });
    expect(sidebarTree[0].sandboxes).toHaveLength(1);
    expect(sidebarTree[0].sandboxes[0]).toMatchObject({
      name: 'feat/bridge',
      directory: '/apps/vis_app/vis.feat-bridge',
      pinDirectory: 'codex-branch:/apps/vis_app/vis:feat/bridge',
      isPinned: true,
    });
    expect(sidebarTree[0].sandboxes[0].sessions).toEqual([
      expect.objectContaining({ sessionId: 'bridge', title: 'Bridge work', isImplicitlyPinned: true }),
    ]);
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

  it('preserves Global and folder kinds in the sidebar tree so folder pins can stay hidden', () => {
    const project = createCodexProjectState(
      [
        { id: 'scratch', name: 'Scratch', cwd: '/tmp/scratch', updatedAt: 1 },
      ],
      '/home/codex',
      new Set(['scratch']),
    );
    const worktrees = buildCodexTopPanelTreeData(project, { pinnedStore: {}, homePath: '/home/codex' });

    const sidebarTree = buildCodexSessionTreeData(worktrees);

    expect(sidebarTree[0]).toMatchObject({ kind: 'global', name: 'Global', isPinned: false });
    expect(sidebarTree[0].sandboxes[0]).toMatchObject({ kind: 'folder', directory: '/tmp/scratch', isPinned: false });
    expect(sidebarTree[0].sandboxes[0].sessions).toEqual([
      expect.objectContaining({ sessionId: 'scratch', title: 'Scratch', isPinned: true }),
    ]);
  });
});
