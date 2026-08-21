import { describe, expect, it } from 'vitest';

import type { LocalPinnedSessionStore } from './pinnedSessions';
import {
  createLegacyProjects,
  createProjects,
  openCodeInventory,
  reconcile,
} from './pinnedReconciliation.test-helpers';

describe('pinned session hydration authority', () => {
  it.each(['unloaded', 'loading', 'error'] as const)(
    'preserves session pins while a project directory is %s',
    (status) => {
      const store: LocalPinnedSessionStore = { 'p1:s1': 123 };
      const projects = { p1: { id: 'p1', worktree: '/pending', sandboxes: {} } };

      const next = reconcile(store, projects, 10, openCodeInventory({ '/pending': { status } }));

      expect(next).toEqual(store);
    },
  );

  it('removes stale session pins after the project directory is authoritatively loaded', () => {
    const store: LocalPinnedSessionStore = { 'p1:stale': 123 };
    const projects = { p1: { id: 'p1', worktree: '/loaded', sandboxes: {} } };

    const next = reconcile(
      store,
      projects,
      10,
      openCodeInventory({ '/loaded': { status: 'loaded' } }),
    );

    expect(next).toEqual({});
  });
});

describe('pinned session hydration authority', () => {
  it('preserves pins when a project has mixed loaded and loading directories', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 123 };
    const projects = {
      p1: {
        id: 'p1',
        worktree: '/loaded',
        sandboxes: {
          '/loaded': { directory: '/loaded', name: 'a', rootSessions: [], sessions: {} },
          '/pending': { directory: '/pending', name: 'b', rootSessions: [], sessions: {} },
        },
      },
    };

    const next = reconcile(
      store,
      projects,
      10,
      openCodeInventory({
        '/loaded': { status: 'loaded' },
        '/pending': { status: 'loading' },
      }),
    );

    expect(next).toEqual(store);
  });
});

describe('pinned session hydration authority', () => {
  it('assumes a project is complete when the inventory authority is assume-complete', () => {
    const store: LocalPinnedSessionStore = { 'p1:stale': 123 };
    const projects = { p1: { id: 'p1', worktree: '/loaded', sandboxes: {} } };

    const next = reconcile(store, projects, 10);

    expect(next).toEqual({});
  });

  it('distinguishes assume-complete from an empty directory hydration map', () => {
    const store: LocalPinnedSessionStore = { 'p1:stale': 123 };
    const projects = { p1: { id: 'p1', worktree: '/loaded', sandboxes: {} } };

    const complete = reconcile(store, projects, 10);
    const pending = reconcile(store, projects, 10, openCodeInventory({}));

    expect(complete).toEqual({});
    expect(pending).toEqual(store);
  });
});

describe('pinned session hydration authority', () => {
  it('preserves ambiguous session keys when any matching project is incomplete', () => {
    const store: LocalPinnedSessionStore = { 'p1:child:s1': 123 };
    const projects = {
      p1: { id: 'p1', worktree: '/pending', sandboxes: {} },
      nested: { id: 'p1:child', worktree: '/loaded', sandboxes: {} },
    };

    const next = reconcile(
      store,
      projects,
      10,
      openCodeInventory({
        '/pending': { status: 'unloaded' },
        '/loaded': { status: 'loaded' },
      }),
    );

    expect(next).toEqual(store);
  });
});

describe('pinned session legacy hierarchy migration', () => {
  it('defers legacy hierarchy expansion until the project is authoritatively loaded', () => {
    const store: LocalPinnedSessionStore = { 'project:p1': 123 };
    const pendingProjects = { p1: { id: 'p1', worktree: '/', sandboxes: {} } };

    const pending = reconcile(
      store,
      pendingProjects,
      10,
      openCodeInventory({ '/': { status: 'unloaded' } }),
    );
    const loaded = reconcile(
      pending,
      createProjects(),
      10,
      openCodeInventory({ '/': { status: 'loaded' } }),
    );

    expect(pending).toEqual(store);
    expect(loaded).toMatchObject({
      'project:p1': 123,
      'sandbox:p1:/': 123,
      'p1:s1': 123,
    });
  });

  it('expands legacy project-only pins into explicit sandbox and session entries', () => {
    const next = reconcile({ 'project:p1': 123 }, createProjects(), 10);

    expect(next).toMatchObject({
      'project:p1': 123,
      'sandbox:p1:/': 123,
      'p1:s1': 123,
    });
  });
});

describe('pinned session legacy hierarchy migration', () => {
  it('expands legacy sandbox-only pins into explicit session entries', () => {
    const next = reconcile({ 'sandbox:p1:/': 123 }, createProjects(), 10);

    expect(next).toMatchObject({
      'sandbox:p1:/': 123,
      'p1:s1': 123,
    });
  });
});

describe('pinned session legacy hierarchy migration', () => {
  it('expands missing project descendants while preserving sandbox overrides', () => {
    const next = reconcile(
      { 'project:p1': 123, 'sandbox:p1:/two': -50 },
      createLegacyProjects(),
      20,
    );

    expect(next).toMatchObject({
      'project:p1': 123,
      'sandbox:p1:/one': 123,
      'p1:one-a': 123,
      'p1:one-b': 123,
      'sandbox:p1:/two': -50,
    });
    expect(next['p1:two-a']).toBeUndefined();
  });
});

describe('pinned session legacy hierarchy migration', () => {
  it('expands missing sandbox sessions while preserving session overrides', () => {
    const next = reconcile({ 'sandbox:p1:/one': 123, 'p1:one-a': -50 }, createLegacyProjects(), 20);

    expect(next).toMatchObject({
      'sandbox:p1:/one': 123,
      'p1:one-a': -50,
      'p1:one-b': 123,
    });
  });
});

describe('pinned session legacy hierarchy migration', () => {
  it('expands a matching-timestamp migration once and marks it one-shot', () => {
    const store: LocalPinnedSessionStore = { 'project:p1': 555 };
    const projects = createProjects(555);

    const first = reconcile(store, projects, 10);
    const second = reconcile(first, projects, 10);

    expect(first).toMatchObject({
      'project:p1': 555,
      'sandbox:p1:/': 555,
      'p1:s1': 555,
    });
    expect(second).toMatchObject(first);
  });
});

describe('pinned session legacy hierarchy migration', () => {
  it('does not inherit a legacy pin into descendants discovered after migration', () => {
    const migrated = reconcile({ 'project:p1': 555 }, createProjects(555), 10);
    const projectsWithLaterDescendant = createProjects(555);
    const sandbox = projectsWithLaterDescendant.p1?.sandboxes['/'];
    if (!sandbox) throw new Error('expected root sandbox');
    sandbox.sessions.s2 = { id: 's2', timePinned: 0 };
    sandbox.rootSessions.push('s2');

    const next = reconcile(migrated, projectsWithLaterDescendant, 10);

    expect(next['p1:s2']).toBeUndefined();
  });
});
