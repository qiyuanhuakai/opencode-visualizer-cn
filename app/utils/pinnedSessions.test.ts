import { describe, expect, it } from 'vitest';

import {
  getEffectivePinnedAt,
  limitPinnedSessionStore,
  parsePinnedSessionStore,
  reconcilePinnedSessionStore,
  type LocalPinnedSessionStore,
} from './pinnedSessions';

function createProjects(serverPinnedAt?: number) {
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

function createLegacyProjects() {
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

describe('pinned session optimistic overrides', () => {
  it('applies a local unpin override even when the server still reports pinned', () => {
    expect(getEffectivePinnedAt(123, -456)).toBe(0);
  });

  it('keeps optimistic unpin overrides during reconciliation until server state catches up', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': -123 };
    const next = reconcilePinnedSessionStore(store, createProjects(999), 10);

    expect(next).toEqual(store);
  });

  it('drops optimistic pin overrides once the server confirms the same pinned timestamp', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 555 };
    const next = reconcilePinnedSessionStore(store, createProjects(555), 10);

    expect(next).toEqual({});
  });

  it('drops optimistic unpin overrides once the server confirms the session is unpinned', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': -123 };
    const next = reconcilePinnedSessionStore(store, createProjects(0), 10);

    expect(next).toEqual({});
  });

  it('limits positive pins but preserves negative unpin overrides', () => {
    const limited = limitPinnedSessionStore(
      {
        'p1:s1': 300,
        'p1:s2': 200,
        'p1:s3': -100,
      },
      1,
    );

    expect(limited).toEqual({
      'p1:s1': 300,
      'p1:s3': -100,
    });
  });

  it('parses persisted negative unpin overrides from storage', () => {
    const parsed = parsePinnedSessionStore('{"p1:s1":-100,"p1:s2":200,"p1:s3":0}', 5);

    expect(parsed).toEqual({
      'p1:s2': 200,
      'p1:s1': -100,
    });
  });

  it('expands legacy project-only pins into explicit sandbox and session entries', () => {
    const next = reconcilePinnedSessionStore({ 'project:p1': 123 }, createProjects(), 10);

    expect(next).toMatchObject({
      'project:p1': 123,
      'sandbox:p1:/': 123,
      'p1:s1': 123,
    });
  });

  it('expands legacy sandbox-only pins into explicit session entries', () => {
    const next = reconcilePinnedSessionStore({ 'sandbox:p1:/': 123 }, createProjects(), 10);

    expect(next).toMatchObject({
      'sandbox:p1:/': 123,
      'p1:s1': 123,
    });
  });

  it('expands missing project descendants while preserving sandbox overrides', () => {
    const next = reconcilePinnedSessionStore(
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

  it('expands missing sandbox sessions while preserving session overrides', () => {
    const next = reconcilePinnedSessionStore(
      { 'sandbox:p1:/one': 123, 'p1:one-a': -50 },
      createLegacyProjects(),
      20,
    );

    expect(next).toMatchObject({
      'sandbox:p1:/one': 123,
      'p1:one-a': -50,
      'p1:one-b': 123,
    });
  });
});
