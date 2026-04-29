import { computed, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { CODEX_PROJECT_ID, createCodexProjectState, useCodexWorkspace } from './useCodexWorkspace';
import type { CodexThread } from '../backends/codex/codexAdapter';

describe('useCodexWorkspace', () => {
  it('normalizes Codex threads into a Vis project and sessions', () => {
    const threads: CodexThread[] = [
      { id: 'thread-1', name: 'Implement bridge', cwd: '/repo', createdAt: 10, updatedAt: 20, status: 'running' },
      { id: 'thread-2', preview: 'Older thread', cwd: '/other-repo', createdAt: 1, updatedAt: 2 },
    ];

    const project = createCodexProjectState(threads, '/home/user');

    expect(project.id).toBe(CODEX_PROJECT_ID);
    expect(project.worktree).toBe('/repo');
    expect(project.sandboxes['/repo'].rootSessions).toEqual(['thread-1']);
    expect(project.sandboxes['/other-repo'].rootSessions).toEqual(['thread-2']);
    expect(project.sandboxes['/repo'].sessions['thread-1']).toMatchObject({
      id: 'thread-1',
      title: 'Implement bridge',
      directory: '/repo',
      status: 'busy',
      timeUpdated: 20,
    });
    expect(project.sandboxes['/other-repo'].sessions['thread-2']).toMatchObject({
      id: 'thread-2',
      directory: '/other-repo',
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

    expect(workspace.project.value.worktree).toBe('/home/codex');
    expect(workspace.activeDirectory.value).toBe('/home/codex');
    expect(workspace.activeSessionId.value).toBe('thread-1');
  });

  it('marks locally pinned Codex threads as pinned sessions', () => {
    const project = createCodexProjectState(
      [{ id: 'thread-1', name: 'Pinned thread', cwd: '/repo' }],
      '/home/user',
      new Set(['thread-1']),
    );

    expect(project.sandboxes['/repo'].sessions['thread-1'].timePinned).toBe(1);
  });
});
