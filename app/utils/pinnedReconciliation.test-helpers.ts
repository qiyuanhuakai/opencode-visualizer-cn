import type { ProjectState } from '../types/worker-state';
import type { DirectorySessionHydration } from '../types/sse-worker';
import {
  reconcilePinnedSessionStore,
  type HierarchyMetadataAuthority,
  type ReconcileInput,
  type SessionInventoryAuthority,
} from './pinnedReconciliation';
import type { LocalPinnedSessionStore } from './pinnedSessions';

export function createProjects(serverPinnedAt?: number): Record<string, ProjectState> {
  return {
    p1: {
      id: 'p1',
      worktree: '/',
      sandboxes: {
        '/': {
          directory: '/',
          name: 'main',
          rootSessions: ['s1'],
          sessions: {
            s1: {
              id: 's1',
              timeCreated: 1,
              timeUpdated: 1,
              timePinned: serverPinnedAt,
            },
          },
        },
      },
    },
  };
}

export function createRepoAndWorktreeProjects(): Record<string, ProjectState> {
  return {
    p1: {
      id: 'p1',
      worktree: '/workspace',
      sandboxes: {
        '/workspace': {
          directory: '/workspace',
          name: 'main',
          rootSessions: ['s1', 's2'],
          sessions: {
            s1: {
              id: 's1',
              timeCreated: 1,
              timeUpdated: 1,
              timePinned: 555,
              gitInfo: {
                root: '~/repo',
                commonRoot: '~/repo',
                worktreeRoot: '~/repo',
                branch: 'main',
              },
            },
            s2: {
              id: 's2',
              directory: '/workspace',
              timeCreated: 1,
              timeUpdated: 1,
              timePinned: 555,
            },
          },
        },
      },
    },
  };
}

export function createUnresolvedRepoProjects(): Record<string, ProjectState> {
  const directory = '/home/user/repo/worktree';
  return {
    p1: {
      id: 'p1',
      worktree: directory,
      sandboxes: {
        [directory]: {
          directory,
          name: 'worktree',
          rootSessions: ['s1'],
          sessions: {
            s1: { id: 's1', directory, timePinned: 555 },
          },
        },
      },
    },
  };
}

export function createLegacyProjects(): Record<string, ProjectState> {
  return {
    p1: {
      id: 'p1',
      worktree: '/one',
      sandboxes: {
        '/one': {
          directory: '/one',
          name: 'one',
          rootSessions: ['one-a', 'one-b'],
          sessions: {
            'one-a': { id: 'one-a', timePinned: 999 },
            'one-b': { id: 'one-b' },
          },
        },
        '/two': {
          directory: '/two',
          name: 'two',
          rootSessions: ['two-a'],
          sessions: {
            'two-a': { id: 'two-a' },
          },
        },
      },
    },
  };
}

function assumeComplete(): SessionInventoryAuthority {
  return { kind: 'assume-complete' };
}

export function openCodeInventory(
  sessionHydrationByDirectory: Readonly<Record<string, DirectorySessionHydration>>,
): SessionInventoryAuthority {
  return { kind: 'directory-hydration', byDirectory: sessionHydrationByDirectory };
}

export function untrackedHierarchy(): HierarchyMetadataAuthority {
  return { kind: 'untracked' };
}

export function trackedHierarchy(
  gitInfoByDirectory: Record<
    string,
    NonNullable<ProjectState['sandboxes'][string]['sessions'][string]['gitInfo']>
  >,
  homePath = '',
): HierarchyMetadataAuthority {
  return { kind: 'tracked', gitInfoByDirectory, homePath };
}

export function reconcile(
  store: LocalPinnedSessionStore,
  projects: Record<string, ProjectState>,
  limit: number,
  inventory: SessionInventoryAuthority = assumeComplete(),
  hierarchy: HierarchyMetadataAuthority = untrackedHierarchy(),
): LocalPinnedSessionStore {
  const input: ReconcileInput = { store, projects, limit, inventory, hierarchy };
  return reconcilePinnedSessionStore(input);
}
