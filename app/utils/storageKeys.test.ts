import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StorageKeys,
  storageGet,
  storageGetJSON,
  storageKey,
  storageRemove,
  storageSet,
  storageSetJSON,
} from './storageKeys';

describe('storageKeys', () => {
  let store: Record<string, string | null>;

  beforeEach(() => {
    store = {};
    const storage = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    } as unknown as Storage;

    vi.stubGlobal('window', {
      localStorage: storage,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefixes keys with opencode', () => {
    expect(storageKey('foo')).toBe('opencode.foo');
  });

  it('round-trips strings via storageSet and storageGet', () => {
    storageSet(StorageKeys.settings.enterToSend, 'true');
    expect(storageGet(StorageKeys.settings.enterToSend)).toBe('true');
  });

  it('returns null for missing keys', () => {
    expect(storageGet('missing.key')).toBeNull();
  });

  it('removes keys with storageRemove', () => {
    storageSet('x', '1');
    storageRemove('x');
    expect(storageGet('x')).toBeNull();
  });

  it('parses JSON with storageGetJSON', () => {
    storageSetJSON('data', { a: 1 });
    expect(storageGetJSON<{ a: number }>('data')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON in storageGetJSON', () => {
    storageSet('bad', 'not-json');
    expect(storageGetJSON('bad')).toBeNull();
  });

  it('returns null from storageGetJSON when key is missing', () => {
    expect(storageGetJSON('none')).toBeNull();
  });
});
