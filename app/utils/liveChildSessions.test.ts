import { describe, expect, it } from 'vitest';
import { discoverNewDirectChildren } from './liveChildSessions';

describe('discoverNewDirectChildren', () => {
  const historical = {
    old: { parentID: 'root', label: 'old child' },
    unrelated: { parentID: 'other', label: 'other child' },
  };

  it('treats the first snapshot as a baseline instead of live creation', () => {
    expect(discoverNewDirectChildren(undefined, 'root', historical).newIds).toEqual([]);
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
});
