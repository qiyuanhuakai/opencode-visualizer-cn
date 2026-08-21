import { describe, expect, it } from 'vitest';

import {
  getEffectivePinnedAt,
  limitPinnedSessionStore,
  parsePinnedSessionStore,
  type LocalPinnedSessionStore,
} from './pinnedSessions';
import { createProjects, reconcile } from './pinnedReconciliation.test-helpers';

describe('pinned session store helpers', () => {
  it('applies a local unpin override even when the server still reports pinned', () => {
    expect(getEffectivePinnedAt(123, -456)).toBe(0);
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
});

describe('pinned session optimistic convergence', () => {
  it('keeps optimistic unpin overrides during reconciliation until server state catches up', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': -123 };
    const next = reconcile(store, createProjects(999), 10);

    expect(next).toEqual(store);
  });

  it('drops optimistic pin overrides once the server confirms the same pinned timestamp', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 555 };
    const next = reconcile(store, createProjects(555), 10);

    expect(next).toEqual({});
  });

  it('drops an optimistic pin override once the server authoritatively confirms the session is unpinned', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 555 };
    const next = reconcile(store, createProjects(0), 10);

    expect(next).toEqual({});
  });

  it('converges an optimistic pin override to the server re-pin timestamp', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 555 };
    const next = reconcile(store, createProjects(777), 10);

    expect(next).toEqual({});
  });

  it('retains a positive local override while the server has not reported a pinned timestamp', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': 555 };
    const next = reconcile(store, createProjects(undefined), 10);

    expect(next).toEqual(store);
  });

  it('drops optimistic unpin overrides once the server confirms the session is unpinned', () => {
    const store: LocalPinnedSessionStore = { 'p1:s1': -123 };
    const next = reconcile(store, createProjects(0), 10);

    expect(next).toEqual({});
  });

  it('does not retain a confirmed leaf solely for negative hierarchy overrides', () => {
    const next = reconcile(
      {
        'project:p1': -555,
        'sandbox:p1:/': -555,
        'p1:s1': -123,
      },
      createProjects(0),
      10,
    );

    expect(next['p1:s1']).toBeUndefined();
  });
});
