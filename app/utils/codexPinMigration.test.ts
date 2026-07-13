import { beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { migrateCodexPinsToUnifiedStore, __testing } from './codexPinMigration';

const LEGACY_KEY = __testing.LEGACY_CODEX_PIN_STORAGE_KEY;

describe('migrateCodexPinsToUnifiedStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns zeros and leaves storage untouched when no legacy key exists', () => {
    const store = ref<Record<string, number>>({});
    const result = migrateCodexPinsToUnifiedStore(store);
    expect(result).toEqual({ migrated: 0, removed: false });
    expect(store.value).toEqual({});
  });

  it('migrates legacy codex thread ids into the unified store and removes the legacy key', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['thr_a', 'thr_b', 'thr_c']));
    const store = ref<Record<string, number>>({});

    const result = migrateCodexPinsToUnifiedStore(store);

    expect(result.migrated).toBe(3);
    expect(result.removed).toBe(true);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    const keys = Object.keys(store.value).sort();
    expect(keys).toEqual(['codex:thr_a', 'codex:thr_b', 'codex:thr_c']);
    for (const key of keys) {
      expect(store.value[key]).toBeGreaterThan(0);
    }
  });

  it('skips non-string and empty entries and does not overwrite existing positive pins', () => {
    window.localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify(['thr_keep', '', null, undefined, 42, {}, '  ']),
    );
    const store = ref<Record<string, number>>({ 'codex:thr_keep': 99 });

    const result = migrateCodexPinsToUnifiedStore(store);

    expect(result.migrated).toBe(0);
    expect(result.removed).toBe(true);
    expect(store.value['codex:thr_keep']).toBe(99);
    expect(Object.keys(store.value)).toEqual(['codex:thr_keep']);
  });

  it('removes the legacy key even when the stored payload is not an array', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify({ not: 'array' }));
    const store = ref<Record<string, number>>({});

    const result = migrateCodexPinsToUnifiedStore(store);

    expect(result).toEqual({ migrated: 0, removed: true });
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(store.value).toEqual({});
  });

  it('removes a corrupt legacy payload and returns removed=true', () => {
    window.localStorage.setItem(LEGACY_KEY, '{not valid json');
    const store = ref<Record<string, number>>({});

    const result = migrateCodexPinsToUnifiedStore(store);

    expect(result).toEqual({ migrated: 0, removed: true });
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('is idempotent: a second call is a no-op', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(['thr_once']));
    const store = ref<Record<string, number>>({});

    const first = migrateCodexPinsToUnifiedStore(store);
    const second = migrateCodexPinsToUnifiedStore(store);

    expect(first.migrated).toBe(1);
    expect(first.removed).toBe(true);
    expect(second).toEqual({ migrated: 0, removed: false });
    expect(Object.keys(store.value)).toEqual(['codex:thr_once']);
  });
});
