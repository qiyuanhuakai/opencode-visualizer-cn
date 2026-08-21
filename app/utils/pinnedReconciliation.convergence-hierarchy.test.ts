import { describe, expect, it } from 'vitest';

import type { LocalPinnedSessionStore } from './pinnedSessions';
import {
  createProjects,
  createRepoAndWorktreeProjects,
  createUnresolvedRepoProjects,
  openCodeInventory,
  reconcile,
  trackedHierarchy,
  untrackedHierarchy,
} from './pinnedReconciliation.test-helpers';

describe('pinned session hierarchy retention', () => {
  it('retains confirmed leaf state that belongs to a persisted pin hierarchy', () => {
    const store: LocalPinnedSessionStore = {
      'project:p1': 555,
      'sandbox:p1:/': 555,
      'p1:s1': 555,
    };

    const confirmed = reconcile(store, createProjects(555), 10, undefined, untrackedHierarchy());
    const lazyReload = reconcile(
      confirmed,
      { p1: { id: 'p1', worktree: '/', sandboxes: {} } },
      10,
      openCodeInventory({ '/': { status: 'loading' } }),
      untrackedHierarchy(),
    );

    expect(confirmed).toMatchObject(store);
    expect(lazyReload).toMatchObject(store);
  });
});

describe('pinned session hierarchy retention', () => {
  it('retains confirmed leaf state under repo and worktree hierarchy keys', () => {
    const store: LocalPinnedSessionStore = {
      'repo:p1:/home/user/repo': 555,
      'sandbox:p1:/home/user/repo': 555,
      'p1:s1': 555,
      'p1:s2': 555,
    };
    const projects = createRepoAndWorktreeProjects();

    const pendingMetadata = reconcile(
      store,
      projects,
      10,
      undefined,
      trackedHierarchy({}, '/home/user'),
    );
    const confirmed = reconcile(
      pendingMetadata,
      projects,
      10,
      undefined,
      trackedHierarchy(
        {
          '/workspace': {
            root: '~/repo',
            commonRoot: '~/repo',
            worktreeRoot: '~/repo',
            branch: 'main',
          },
        },
        '/home/user',
      ),
    );

    expect(pendingMetadata).toMatchObject(store);
    expect(confirmed).toMatchObject(store);
  });
});

describe('pinned session hierarchy retention', () => {
  it('retains unresolved repo membership, then converges when metadata resolves elsewhere', () => {
    const store: LocalPinnedSessionStore = {
      'repo:p1:/home/user/repo': 555,
      'p1:s1': 555,
    };
    const projects = createUnresolvedRepoProjects();

    const pending = reconcile(store, projects, 10, undefined, trackedHierarchy({}, '/home/user'));
    const resolved = reconcile(
      pending,
      projects,
      10,
      undefined,
      trackedHierarchy(
        {
          '/home/user/repo/worktree': {
            root: '/other/repo',
            commonRoot: '/other/repo',
            worktreeRoot: '/home/user/repo/worktree',
            branch: 'main',
          },
        },
        '/home/user',
      ),
    );

    expect(pending).toMatchObject(store);
    expect(resolved['p1:s1']).toBeUndefined();
  });
});

describe('pinned session archived and child lifecycle', () => {
  it('deletes an archived session override even when a local override exists', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 555 };
    const projects = {
      p1: {
        id: 'p1',
        worktree: '/',
        sandboxes: {
          '/': {
            directory: '/',
            name: 'main',
            rootSessions: ['s1'],
            sessions: {
              s1: { id: 's1', timePinned: 555, timeArchived: 100 },
            },
          },
        },
      },
    };

    const next = reconcile(store, projects, 10);

    expect(next['p1:s1']).toBeUndefined();
  });

  it('deletes a child session override even when a local override exists', () => {
    const store: LocalPinnedSessionStore = { 'p1:child': 555 };
    const projects = {
      p1: {
        id: 'p1',
        worktree: '/',
        sandboxes: {
          '/': {
            directory: '/',
            name: 'main',
            rootSessions: ['child'],
            sessions: {
              child: { id: 'child', timePinned: 555, parentID: 'root' },
            },
          },
        },
      },
    };

    const next = reconcile(store, projects, 10);

    expect(next['p1:child']).toBeUndefined();
  });
});

describe('pinned session archived and child lifecycle', () => {
  it('deletes an archived override even under incomplete hydration', () => {
    const store: LocalPinnedSessionStore = { 'project:p1': 555, 'p1:s1': 555 };
    const projects = {
      p1: {
        id: 'p1',
        worktree: '/pending',
        sandboxes: {
          '/pending': {
            directory: '/pending',
            name: 'main',
            rootSessions: ['s1'],
            sessions: {
              s1: { id: 's1', timePinned: 555, timeArchived: 100 },
            },
          },
        },
      },
    };

    const next = reconcile(
      store,
      projects,
      10,
      openCodeInventory({ '/pending': { status: 'loading' } }),
    );

    expect(next['project:p1']).toBe(555);
    expect(next['p1:s1']).toBeUndefined();
  });

  it('deletes a child unpin override even under incomplete hydration', () => {
    const store: LocalPinnedSessionStore = { 'p1:child': -555 };
    const projects = {
      p1: {
        id: 'p1',
        worktree: '/pending',
        sandboxes: {
          '/pending': {
            directory: '/pending',
            name: 'main',
            rootSessions: ['child'],
            sessions: {
              child: { id: 'child', timePinned: 555, parentID: 'root' },
            },
          },
        },
      },
    };

    const next = reconcile(
      store,
      projects,
      10,
      openCodeInventory({ '/pending': { status: 'loading' } }),
    );

    expect(next['p1:child']).toBeUndefined();
  });
});
