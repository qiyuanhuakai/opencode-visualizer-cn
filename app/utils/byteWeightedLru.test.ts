import { describe, expect, it } from 'vitest';

import { ByteWeightedLruCache } from './byteWeightedLru';

describe('ByteWeightedLruCache', () => {
  it('returns values and refreshes a hit as the most recently used entry', () => {
    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 6,
      weigh: (_key, value) => value.length,
    });

    cache.set('first', '111');
    cache.set('second', '22');
    expect(cache.get('first')).toBe('111');
    cache.set('third', '333');

    expect(cache.has('first')).toBe(true);
    expect(cache.has('second')).toBe(false);
    expect(cache.get('third')).toBe('333');
    expect(cache.bytes).toBe(6);
    expect(cache.size).toBe(2);
  });

  it('replaces an existing entry without double-counting its weight', () => {
    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 10,
      weigh: (_key, value) => value.length,
    });

    cache.set('key', '123');
    cache.set('key', '123456');

    expect(cache.get('key')).toBe('123456');
    expect(cache.bytes).toBe(6);
    expect(cache.size).toBe(1);
  });

  it('evicts entries until the byte budget is satisfied', () => {
    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 5,
      weigh: (_key, value) => value.length,
    });

    cache.set('a', '11');
    cache.set('b', '22');
    cache.set('c', '333');

    expect([...cache.entries()]).toEqual([
      ['b', '22'],
      ['c', '333'],
    ]);
    expect(cache.bytes).toBe(5);
  });

  it('does not retain an entry larger than the byte budget', () => {
    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 3,
      weigh: (_key, value) => value.length,
    });

    cache.set('small', '12');
    cache.set('large', '1234');

    expect(cache.get('small')).toBe('12');
    expect(cache.get('large')).toBeUndefined();
    expect(cache.bytes).toBe(2);
  });

  it('supports deletion and clearing while maintaining accounting', () => {
    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 5,
      weigh: (_key, value) => value.length,
    });

    cache.set('a', '11');
    cache.set('b', '222');
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('missing')).toBe(false);
    expect(cache.bytes).toBe(3);
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
    expect([...cache.entries()]).toEqual([]);
  });

  it('rejects invalid byte budgets and entry weights', () => {
    expect(
      () =>
        new ByteWeightedLruCache<string, string>({
          maxBytes: 0,
          weigh: (_key, value) => value.length,
        }),
    ).toThrow(RangeError);

    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 5,
      weigh: () => -1,
    });
    expect(() => cache.set('key', 'value')).toThrow(RangeError);
  });

  it('accounts for key and value bytes and enforces optional limits', () => {
    const cache = new ByteWeightedLruCache<string, string>({
      maxBytes: 20,
      maxEntries: 2,
      maxEntryBytes: 10,
      weigh: (key, value) => key.length + value.length,
    });

    cache.set('a', '1234');
    cache.set('bb', '12345');
    cache.set('ccc', '1');

    expect(cache.has('a')).toBe(false);
    expect(cache.has('bb')).toBe(true);
    expect(cache.has('ccc')).toBe(true);
    expect(cache.bytes).toBe(11);

    cache.set('too-large', '123');
    expect(cache.has('too-large')).toBe(false);
    expect(cache.bytes).toBe(11);
  });
});
