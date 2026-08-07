import { describe, expect, it } from 'vitest';
import { discoverNewDirectChildren, resolveUnassignedLiveChildren } from './liveChildSessions';

describe('discoverNewDirectChildren', () => {
  const historical = {
    old: { parentID: 'root', label: 'old child' },
    unrelated: { parentID: 'other', label: 'other child' },
  };

  it('treats the first snapshot as a baseline instead of live creation', () => {
    expect(discoverNewDirectChildren(undefined, 'root', historical).newIds).toEqual([]);
  });

  it('surfaces a busy child already present in the first snapshot', () => {
    expect(
      discoverNewDirectChildren(undefined, 'root', {
        child: { parentID: 'root', label: 'Child', status: 'busy' },
      }).newIds,
    ).toEqual(['child']);
  });

  it('surfaces a known child when a later status event marks it busy', () => {
    expect(
      discoverNewDirectChildren(new Set(['child']), 'root', {
        child: { parentID: 'root', label: 'Child', status: 'busy' },
      }).newIds,
    ).toEqual(['child']);
  });

  it('returns only direct children added after the baseline', () => {
    const baseline = discoverNewDirectChildren(undefined, 'root', historical).currentIds;
    const current = {
      ...historical,
      live: { parentID: 'root', label: 'live child' },
      nested: { parentID: 'old', label: 'nested child' },
    };

    expect(discoverNewDirectChildren(baseline, 'root', current).newIds).toEqual(['live']);
  });

  it('removes a live child from the unassigned bucket once exact task metadata arrives', () => {
    const meta = { child: { parentID: 'root', label: 'Child', status: 'busy' as const } };

    expect(resolveUnassignedLiveChildren(['child'], new Set(), meta)).toEqual([
      { sessionId: 'child', label: 'Child' },
    ]);
    expect(resolveUnassignedLiveChildren(['child'], new Set(['child']), meta)).toEqual([]);
  });
});
