import { computed, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { CODEX_PROJECT_ID, createCodexProjectState, useCodexWorkspace } from './useCodexWorkspace';
import type { CodexThread } from '../backends/codex/codexAdapter';

describe('useCodexWorkspace', () => {
  it('normalizes Codex threads into a Vis project and sessions', () => {
    const threads: CodexThread[] = [
      { id: 'thread-1', name: 'Implement bridge', cwd: '/repo', gitInfo: { root: '/repo', branch: 'main' }, createdAt: 10, updatedAt: 20, status: 'running' },
      { id: 'thread-2', preview: 'Older thread', cwd: '/other-repo/subdir', gitInfo: { root: '/other-repo', branch: 'dev' }, createdAt: 1, updatedAt: 2 },
    ];

    const project = createCodexProjectState(threads, '/home/user');

    expect(project.id).toBe(CODEX_PROJECT_ID);
    expect(project.worktree).toBe('/');
    expect(project.sandboxes['/repo'].rootSessions).toEqual(['thread-1']);
    expect(project.sandboxes['/other-repo/subdir'].rootSessions).toEqual(['thread-2']);
    expect(project.sandboxes['/repo'].name).toBe('repo · main');
    expect(project.sandboxes['/other-repo/subdir'].name).toBe('subdir · dev');
    expect(project.sandboxes['/repo'].sessions['thread-1']).toMatchObject({
      id: 'thread-1',
      title: 'Implement bridge',
      directory: '/repo',
      gitInfo: { root: '/repo', branch: 'main' },
      status: 'busy',
      timeUpdated: 20_000,
    });
    expect(project.sandboxes['/other-repo/subdir'].sessions['thread-2']).toMatchObject({
      id: 'thread-2',
      directory: '/other-repo/subdir',
      status: 'idle',
    });
  });

  it('falls back to bridge home directory when threads do not expose cwd', () => {
    const threads = ref<CodexThread[]>([{ id: 'thread-1', name: 'Untitled' }]);
    const activeThreadId = ref('thread-1');
    const workspace = useCodexWorkspace({
      threads,
      visibleThreads: computed(() => threads.value),
      activeThreadId,
      canonicalHistory: ref([]),
      homeDir: ref('/home/codex'),
    });

    expect(workspace.project.value.worktree).toBe('/');
    expect(workspace.activeDirectory.value).toBe('/');
    expect(workspace.activeSessionId.value).toBe('thread-1');
  });

  it('uses thread cwd when gitInfo is absent', () => {
    const project = createCodexProjectState(
      [
        { id: 'thread-cwd', name: 'CWD thread', cwd: '/my/project' },
      ],
      '/home/codex',
    );

    expect(project.sandboxes['/my/project']).toBeDefined();
    expect(project.sandboxes['/my/project'].rootSessions).toContain('thread-cwd');
    expect(project.sandboxes['/my/project'].sessions['thread-cwd'].directory).toBe('/my/project');
  });

  it('prefers thread cwd over gitInfo.root for sandbox directory', () => {
    const project = createCodexProjectState(
      [
        { id: 'thread-git', name: 'Git thread', cwd: '/repo/subdir', gitInfo: { root: '/repo', branch: 'main' } },
      ],
      '/home/codex',
    );

    expect(project.sandboxes['/repo/subdir']).toBeDefined();
    expect(project.sandboxes['/repo/subdir'].rootSessions).toContain('thread-git');
    expect(project.sandboxes['/repo']).toBeUndefined();
  });

  it('converts second-based Codex timestamps to milliseconds for session times', () => {
    const project = createCodexProjectState(
      [
        { id: 'thread-seconds', name: 'Seconds thread', cwd: '/repo', createdAt: 1_746_168_600, updatedAt: 1_746_168_960 },
      ],
      '/home/codex',
    );

    expect(project.sandboxes['/repo'].sessions['thread-seconds'].timeCreated).toBe(1_746_168_600_000);
    expect(project.sandboxes['/repo'].sessions['thread-seconds'].timeUpdated).toBe(1_746_168_960_000);
  });

  it('routes non-git tilde cwd values through expanded home directory', () => {
    const project = createCodexProjectState(
      [
        { id: 'thread-home', name: 'Home', cwd: '~' },
        { id: 'thread-child', name: 'Child', cwd: '~/repo' },
      ],
      '/home/codex',
    );

    expect(project.worktree).toBe('/');
    expect(project.sandboxes['/home/codex'].rootSessions).toContain('thread-home');
    expect(project.sandboxes['/home/codex/repo'].rootSessions).toContain('thread-child');
    expect(project.sandboxes['/home/codex'].sessions['thread-home'].directory).toBe('/home/codex');
    expect(project.sandboxes['/home/codex/repo'].sessions['thread-child'].directory).toBe('/home/codex/repo');
  });

  it('expands tilde git roots with the bridge home directory', () => {
    const project = createCodexProjectState(
      [{ id: 'thread-child', name: 'Child', cwd: '~/repo/subdir', gitInfo: { root: '~/repo', branch: 'main' } }],
      '/home/codex',
    );

    expect(project.sandboxes['/home/codex/repo/subdir'].rootSessions).toContain('thread-child');
    expect(project.sandboxes['/home/codex/repo/subdir'].sessions['thread-child'].directory).toBe('/home/codex/repo/subdir');
  });

  it('marks locally pinned Codex threads as pinned sessions', () => {
    const project = createCodexProjectState(
      [{ id: 'thread-1', name: 'Pinned thread', cwd: '/repo', gitInfo: { root: '/repo' } }],
      '/home/user',
      new Set(['thread-1']),
    );

    expect(project.sandboxes['/repo'].sessions['thread-1'].timePinned).toBe(1);
  });
});
