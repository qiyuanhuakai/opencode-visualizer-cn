import { describe, expect, it } from 'vitest';
import { createEntityCache, createMemoryBudget } from './entityCache';
import type { EntityFence } from './entityCache';
import { parseConnectionProfileId, parseEnvironmentId } from '../../shared/runtime/identity.js';

describe('shared runtime memory admission', () => {
  it('counts pending and resident bytes once when a lease commits', () => {
    // Given: one shared budget for resident and pending allocations.
    const budget = createMemoryBudget({ maxBytes: 100, maxEntries: 2 });
    const pending = budget.reserve({ bytes: 60, entries: 1 });
    if (!pending) throw new TypeError('fixture admission failed');
    // When: an admitted allocation becomes resident after its acknowledgement.
    pending.commit(); pending.commit();
    // Then: commit does not create a second allowance or duplicate entry.
    expect(budget.usage()).toEqual({ residentBytes: 60, reservedBytes: 0, entries: 1 });
    expect(budget.reserve({ bytes: 41, entries: 1 })).toBeNull();
    const other = budget.reserve({ bytes: 40, entries: 1 });
    expect(other).not.toBeNull();
    expect(budget.usage()).toEqual({ residentBytes: 60, reservedBytes: 40, entries: 2 });
    expect(budget.reserve({ bytes: 0, entries: 1 })).toBeNull();
    pending.release(); other?.release();
    expect(budget.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });

  it('leaves accounting unchanged when a pending or resident resize is refused', () => {
    // Given: pending and resident reservations share a full budget.
    const budget = createMemoryBudget({ maxBytes: 100, maxEntries: 2 });
    const resident = budget.reserve({ bytes: 60, entries: 1 });
    const pending = budget.reserve({ bytes: 40, entries: 1 });
    if (!resident || !pending) throw new TypeError('fixture admission failed');
    resident.commit();
    // When: either allocation asks for more than the remaining capacity.
    expect(resident.resize(61)).toBe(false);
    expect(pending.resize(41)).toBe(false);
    // Then: refusal is atomic and shrinking releases capacity immediately.
    expect(budget.usage()).toEqual({ residentBytes: 60, reservedBytes: 40, entries: 2 });
    expect(resident.resize(50)).toBe(true);
    expect(pending.resize(50)).toBe(true);
    expect(budget.usage()).toEqual({ residentBytes: 50, reservedBytes: 50, entries: 2 });
    resident.release(); pending.release();
  });

  it('cannot revive or subtract a lease after release', () => {
    // Given: a released lease has surrendered its bytes and entry.
    const budget = createMemoryBudget({ maxBytes: 100, maxEntries: 1 });
    const lease = budget.reserve({ bytes: 100, entries: 1 });
    if (!lease) throw new TypeError('fixture admission failed');
    lease.release();
    // When: late callbacks commit, resize or release it again.
    lease.commit(); lease.release();
    expect(lease.resize(10)).toBe(false);
    // Then: all counters remain zero, with the original capacity available.
    expect(budget.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
    budget.reserve({ bytes: 100, entries: 1 })?.release();
  });

  it('rejects invalid accounting rather than admitting negative or fractional bytes', () => {
    // Given: a valid empty budget.
    const budget = createMemoryBudget({ maxBytes: 100, maxEntries: 1 });
    // When: invalid values cross the public accounting boundary.
    for (const bytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => budget.reserve({ bytes, entries: 1 })).toThrow();
    }
    expect(() => budget.reserve({ bytes: 1, entries: -1 })).toThrow();
    // Then: no invalid reservation changes the counters.
    expect(budget.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });
});

const profileId = parseConnectionProfileId('11111111-1111-4111-8111-111111111111');
const target = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const address = (key: string) => ({ profileId, target, collection: 'session_summaries' as const, key });
const fence = (applicationGeneration = 1): EntityFence => ({ binding: { target, epoch: 'epoch', generation: 1 }, localGeneration: 1, snapshotRevision: 100000, snapshotWatermark: 100000, applicationGeneration });

describe('bounded runtime entity retention', () => {
  it('streams 100k entities without retaining all keys or exceeding the LRU cap', () => {
    const budget = createMemoryBudget({ maxBytes: 16 * 1024 * 1024, maxEntries: 2000 });
    const cache = createEntityCache({ budget }); const current = fence(); cache.begin(current);
    for (let index = 1; index <= 100000; index++) {
      expect(cache.admit({ address: address(String(index)), revision: index, value: { title: `row-${index}` }, fence: current })).toBe('applied');
    }
    expect(cache.usage().entries).toBe(2000);
    expect(cache.usage().residentBytes + cache.usage().reservedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(cache.get(address('1'))).toBeNull();
    const latest = cache.get(address('100000'));
    expect(latest?.entity.value).toEqual({ title: 'row-100000' });
    latest?.release(); cache.clear();
    expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });

  it('retains deletion fences under eviction pressure until a new snapshot supersedes them', () => {
    const budget = createMemoryBudget({ maxBytes: 10000, maxEntries: 2 });
    const cache = createEntityCache({ budget }); const current = fence(); cache.begin(current);
    cache.admit({ address: address('deleted'), revision: 10, value: 'old', fence: current });
    cache.remove({ address: address('deleted'), revision: 100002, fence: current });
    for (let revision = 11; revision < 100; revision++) cache.admit({ address: address(String(revision)), revision, value: 'other', fence: current });
    expect(cache.admit({ address: address('deleted'), revision: 100001, value: 'resurrected', fence: current })).toBe('stale');
    const tombstone = cache.get(address('deleted'));
    expect(tombstone?.entity.value).toBeNull(); tombstone?.release();
    const replacement = fence(2); cache.begin(replacement);
    expect(cache.admit({ address: address('deleted'), revision: 100003, value: 'late-old-scope', fence: current })).toBe('stale');
    cache.clear();
  });

  it('accounts for an output lease even after its cache record is replaced', () => {
    const budget = createMemoryBudget({ maxBytes: 20000, maxEntries: 2 });
    const cache = createEntityCache({ budget }); const current = fence(); cache.begin(current);
    cache.admit({ address: address('view'), revision: 1, value: 'first', fence: current });
    const held = cache.get(address('view')); if (!held) throw new TypeError('fixture lease failed');
    cache.admit({ address: address('view'), revision: 2, value: 'second', fence: current });
    expect(cache.usage().entries).toBe(2);
    expect(held.entity.value).toBe('first');
    cache.clear();
    expect(cache.usage().entries).toBe(1);
    held.release(); held.release();
    expect(cache.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
  });

  it('refuses oversized rows without evicting an externally held record', () => {
    const budget = createMemoryBudget({ maxBytes: 6000, maxEntries: 2 });
    const cache = createEntityCache({ budget }); const current = fence(); cache.begin(current);
    cache.admit({ address: address('held'), revision: 1, value: 'valid', fence: current });
    const held = cache.get(address('held'));
    expect(cache.admit({ address: address('huge'), revision: 2, value: 'x'.repeat(10000), fence: current })).toBe('budget');
    expect(held?.entity.value).toBe('valid');
    held?.release(); cache.clear();
  });

  it('keeps identical entity keys in different profiles separate', () => {
    const budget = createMemoryBudget({ maxBytes: 20000, maxEntries: 3 });
    const cache = createEntityCache({ budget }); const current = fence(); cache.begin(current);
    const other = { ...address('same'), profileId: parseConnectionProfileId('33333333-3333-4333-8333-333333333333') };
    cache.admit({ address: address('same'), revision: 1, value: 'first profile', fence: current });
    cache.admit({ address: other, revision: 2, value: 'second profile', fence: current });
    const first = cache.get(address('same')); const second = cache.get(other);
    expect(first?.entity.value).toBe('first profile'); expect(second?.entity.value).toBe('second profile');
    first?.release(); second?.release(); cache.clear();
  });
});
