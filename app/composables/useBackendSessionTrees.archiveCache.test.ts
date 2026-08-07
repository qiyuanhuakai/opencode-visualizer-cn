import { describe, expect, it } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import { useBackendSessionTrees } from './useBackendSessionTrees';

describe('useBackendSessionTrees archive cache invalidation', () => {
  it('rebuilds TopPanel data immediately when a session archive value changes', async () => {
    const projects = reactive<Record<string, ProjectState>>({
      acp: {
        id: 'acp',
        name: 'ACP',
        worktree: '/repo',
        sandboxes: {
          '/repo': {
            directory: '/repo',
            name: 'repo',
            rootSessions: ['session-1'],
            sessions: {
              'session-1': {
                id: 'session-1',
                title: 'Session',
                directory: '/repo',
                timeUpdated: 1,
              },
            },
          },
        },
      },
    });
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('acp'),
      projects,
      pinnedStore: ref({}),
      deletedSandboxStore: ref({}),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });

    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions[0]?.archivedAt).toBeUndefined();
    projects.acp.sandboxes['/repo'].sessions['session-1'].timeArchived = 123;
    await nextTick();

    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions[0]?.archivedAt).toBe(123);
  });

  it('rebuilds TopPanel data immediately when a session returns to idle', async () => {
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
                title: 'Session',
                directory: '/repo',
                status: 'busy',
                timeUpdated: 1,
              },
            },
          },
        },
      },
    });
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('opencode'),
      projects,
      pinnedStore: ref({}),
      deletedSandboxStore: ref({}),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });

    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions[0]?.status).toBe('busy');
    projects.opencode.sandboxes['/repo'].sessions['session-1'].status = 'idle';
    await nextTick();

    expect(trees.topPanelTreeData.value[0]?.sandboxes[0]?.sessions[0]?.status).toBe('idle');
  });

  it('rebuilds TopPanel data when project presentation changes', async () => {
    const projects = reactive<Record<string, ProjectState>>({
      acp: {
        id: 'acp',
        name: 'ACP',
        icon: { color: '#111111' },
        worktree: '/repo',
        sandboxes: {
          '/repo': {
            directory: '/repo',
            name: 'repo',
            rootSessions: ['session-1'],
            sessions: {
              'session-1': {
                id: 'session-1',
                title: 'Session',
                directory: '/repo',
              },
            },
          },
        },
      },
    });
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('acp'),
      projects,
      pinnedStore: ref({}),
      deletedSandboxStore: ref({}),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: (color) => color,
    });

    expect(trees.topPanelTreeData.value[0]?.projectColor).toBe('#111111');
    projects.acp.icon = { color: '#222222' };
    await nextTick();

    expect(trees.topPanelTreeData.value[0]?.projectColor).toBe('#222222');
  });

  it('groups Git repositories by project and non-Git folders under Global', () => {
    const projects = reactive<Record<string, ProjectState>>({
      mixed: {
        id: 'mixed',
        name: 'Mixed',
        worktree: '/workspace/repo',
        sandboxes: {
          '/workspace/repo': {
            directory: '/workspace/repo',
            name: 'main',
            rootSessions: ['git-session'],
            sessions: {
              'git-session': {
                id: 'git-session',
                title: 'Git session',
                directory: '/workspace/repo',
                timeUpdated: 2,
                gitInfo: {
                  root: '/workspace/repo',
                  worktreeRoot: '/workspace/repo',
                  branch: 'main',
                },
              },
            },
          },
          '/workspace/notes': {
            directory: '/workspace/notes',
            name: 'notes',
            rootSessions: ['folder-session'],
            sessions: {
              'folder-session': {
                id: 'folder-session',
                title: 'Folder session',
                directory: '/workspace/notes',
                timeUpdated: 1,
              },
            },
          },
        },
      },
    });
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('acp'),
      projects,
      pinnedStore: ref({}),
      deletedSandboxStore: ref({}),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });

    expect(trees.topPanelTreeData.value).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'global',
        directory: '/',
        sandboxes: [expect.objectContaining({ directory: '/workspace/notes', kind: 'folder' })],
      }),
      expect.objectContaining({
        directory: '/workspace/repo',
        kind: 'sandbox',
        sandboxes: [expect.objectContaining({
          directory: '/workspace/repo',
          branch: 'main',
          kind: 'branch',
        })],
      }),
    ]));
  });

  it('classifies ACP sessions from the VCS cache when the ACP wire omits gitInfo', () => {
    const projects = reactive<Record<string, ProjectState>>({
      acp: {
        id: 'acp',
        name: 'ACP',
        worktree: '/workspace/repository',
        sandboxes: {
          '/workspace/repository': {
            directory: '/workspace/repository',
            name: 'repository',
            rootSessions: ['session-1'],
            sessions: {
              'session-1': {
                id: 'session-1',
                title: 'ACP session without git metadata',
                directory: '/workspace/repository',
                timeUpdated: 1,
              },
            },
          },
        },
      },
    });
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('acp'),
      projects,
      pinnedStore: ref({}),
      deletedSandboxStore: ref({}),
      gitInfoByDirectory: ref({
        '/workspace/repository': {
          root: '/workspace/repository',
          commonRoot: '/workspace/repository',
          worktreeRoot: '/workspace/repository',
          branch: 'main',
        },
      }),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });

    expect(trees.topPanelTreeData.value).toEqual([
      expect.objectContaining({
        kind: 'sandbox',
        directory: '/workspace/repository',
        sandboxes: [expect.objectContaining({ kind: 'branch', branch: 'main' })],
      }),
    ]);
  });

  it('projects one repo-scoped ACP pin identically into the top and sidebar trees', () => {
    const projects = reactive<Record<string, ProjectState>>({
      acp: {
        id: 'acp',
        name: 'ACP',
        worktree: '/repo-a',
        sandboxes: {
          '/repo-a': {
            directory: '/repo-a',
            name: 'main',
            rootSessions: ['repo-a'],
            sessions: {
              'repo-a': {
                id: 'repo-a',
                title: 'Repo A',
                directory: '/repo-a',
                timeUpdated: 2,
                gitInfo: { root: '/repo-a', worktreeRoot: '/repo-a', branch: 'main' },
              },
            },
          },
          '/repo-b': {
            directory: '/repo-b',
            name: 'main',
            rootSessions: ['repo-b'],
            sessions: {
              'repo-b': {
                id: 'repo-b',
                title: 'Repo B',
                directory: '/repo-b',
                timeUpdated: 1,
                gitInfo: { root: '/repo-b', worktreeRoot: '/repo-b', branch: 'main' },
              },
            },
          },
        },
      },
    });
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('acp'),
      projects,
      pinnedStore: ref({
        'repo:acp:/repo-a': 123,
        'sandbox:acp:/repo-a': 123,
        'acp:repo-a': 123,
      }),
      deletedSandboxStore: ref({}),
      homePath: ref('/home/test'),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });

    expect(trees.topPanelTreeData.value.find((entry) => entry.directory === '/repo-a')).toMatchObject({
      isPinned: true,
      pinScope: { level: 'repo', root: '/repo-a' },
    });
    expect(trees.sessionTreeData.value).toEqual([
      expect.objectContaining({
        name: 'repo-a',
        isPinned: true,
        pinScope: { level: 'repo', root: '/repo-a' },
        sandboxes: [
          expect.objectContaining({
            isPinned: true,
            pinScope: { level: 'branch', directory: '/repo-a', repoRoot: '/repo-a' },
            sessions: [expect.objectContaining({ sessionId: 'repo-a', isPinned: true })],
          }),
        ],
      }),
    ]);
  });
});
