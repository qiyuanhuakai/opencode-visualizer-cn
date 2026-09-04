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

  function installPendingNativeOwnerFixture() {
    const legacyStore: Record<string, string> = {
      'opencode.settings.enterToSend.v1': 'legacy-old',
      'opencode.settings.textTransformersEnabled.v1': 'legacy-missing',
    };
    const electronStore: Record<string, string> = {
      'opencode.settings.enterToSend.v1': 'native-old',
    };
    let rejectMigration = true;
    const migrationSnapshots: Array<Record<string, string>> = [];
    const migrate = vi.fn((entries: Record<string, string>) => {
      migrationSnapshots.push({ ...entries });
      if (rejectMigration) return false;
      for (const [key, value] of Object.entries(entries)) {
        if (!Object.hasOwn(electronStore, key)) electronStore[key] = value;
      }
      return true;
    });
    vi.stubGlobal('window', {
      localStorage: {
        get length() {
          return Object.keys(legacyStore).length;
        },
        key: (index: number) => Object.keys(legacyStore)[index] ?? null,
        getItem: (key: string) => legacyStore[key] ?? null,
        setItem: (key: string, value: string) => {
          legacyStore[key] = value;
        },
        removeItem: (key: string) => {
          delete legacyStore[key];
        },
      },
      electronAPI: {
        persistentStorage: {
          getItem: (key: string) => electronStore[key] ?? null,
          setItem: vi.fn((key: string, value: string) => {
            electronStore[key] = value;
            return true;
          }),
          removeItem: vi.fn((key: string) => {
            delete electronStore[key];
            return true;
          }),
          migrate,
        },
      },
    });
    vi.resetModules();
    return {
      electronStore,
      legacyStore,
      migrationSnapshots,
      makeMigrationSucceed: () => {
        rejectMigration = false;
      },
    };
  }

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

  it('prefers Electron persistent storage when available', () => {
    const electronStore: Record<string, string | null> = {};

    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => 'local-value'),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn((key: string) => electronStore[key] ?? null),
          setItem: vi.fn((key: string, value: string) => {
            electronStore[key] = value;
          }),
          removeItem: vi.fn((key: string) => {
            delete electronStore[key];
          }),
          migrate: vi.fn((entries: Record<string, string>) => {
            for (const [key, value] of Object.entries(entries)) {
              if (!Object.hasOwn(electronStore, key)) electronStore[key] = value;
            }
            return true;
          }),
        },
      },
    });

    storageSet(StorageKeys.settings.enterToSend, 'true');
    expect(storageGet(StorageKeys.settings.enterToSend)).toBe('true');
    expect(electronStore['opencode.settings.enterToSend.v1']).toBe('true');
  });

  it('propagates rejected Electron storage mutation acknowledgements', () => {
    // Given: the Electron persistence owner rejects both mutation channels.
    vi.stubGlobal('window', {
      localStorage: window.localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => false),
          removeItem: vi.fn(() => false),
          migrate: vi.fn(() => true),
        },
      },
    });

    // When: renderer storage helpers attempt to mutate persistent state.
    const setResult = storageSet('rejected', 'value');
    const removeResult = storageRemove('rejected');

    // Then: both false acknowledgements remain observable to rollback callers.
    expect(setResult).toBe(false);
    expect(removeResult).toBe(false);
  });

  it('keeps legacy storage authoritative until Electron acknowledges the complete migration', async () => {
    // Given: one legacy value exists and Electron rejects the first atomic migration attempt.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const legacyStore: Record<string, string> = {
        'opencode.settings.enterToSend.v1': 'legacy-value',
      };
      const electronStore: Record<string, string> = {};
      let rejectMigration = true;
      const migrate = vi.fn((entries: Record<string, string>) => {
        if (rejectMigration) return false;
        for (const [key, value] of Object.entries(entries)) {
          if (!Object.hasOwn(electronStore, key)) electronStore[key] = value;
        }
        return true;
      });
      vi.stubGlobal('window', {
        localStorage: {
          get length() {
            return Object.keys(legacyStore).length;
          },
          key: (index: number) => Object.keys(legacyStore)[index] ?? null,
          getItem: (key: string) => legacyStore[key] ?? null,
          setItem: (key: string, value: string) => {
            legacyStore[key] = value;
          },
          removeItem: (key: string) => {
            delete legacyStore[key];
          },
        },
        electronAPI: {
          persistentStorage: {
            getItem: (key: string) => electronStore[key] ?? null,
            setItem: vi.fn(() => false),
            removeItem: vi.fn(() => false),
            migrate,
          },
        },
      });
      vi.resetModules();
      const freshStorage = await import('./storageKeys');

      // When: the rejected attempt is read, then the retry window elapses and Electron recovers.
      const pendingValue = freshStorage.storageGet(StorageKeys.settings.enterToSend);
      rejectMigration = false;
      vi.advanceTimersByTime(1_000);
      const migratedValue = freshStorage.storageGet(StorageKeys.settings.enterToSend);

      // Then: the source remains readable until one acknowledged batch becomes authoritative.
      expect(pendingValue).toBe('legacy-value');
      expect(migratedValue).toBe('legacy-value');
      expect(electronStore['opencode.settings.enterToSend.v1']).toBe('legacy-value');
      expect(migrate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists pending mutations before retrying the complete migration snapshot', async () => {
    // Given: legacy storage is canonical while the first Electron migration is rejected.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const legacyStore: Record<string, string> = {
        'opencode.settings.textTransformersEnabled.v1': 'false',
        'opencode.state.retryWindow.v1': 'stale',
      };
      const electronStore: Record<string, string> = {};
      let rejectMigration = true;
      const migrationSnapshots: Array<Record<string, string>> = [];
      const migrate = vi.fn((entries: Record<string, string>) => {
        migrationSnapshots.push({ ...entries });
        if (rejectMigration) return false;
        for (const [key, value] of Object.entries(entries)) {
          if (!Object.hasOwn(electronStore, key)) electronStore[key] = value;
        }
        return true;
      });
      vi.stubGlobal('window', {
        localStorage: {
          get length() {
            return Object.keys(legacyStore).length;
          },
          key: (index: number) => Object.keys(legacyStore)[index] ?? null,
          getItem: (key: string) => legacyStore[key] ?? null,
          setItem: (key: string, value: string) => {
            legacyStore[key] = value;
          },
          removeItem: (key: string) => {
            delete legacyStore[key];
          },
        },
        electronAPI: {
          persistentStorage: {
            getItem: (key: string) => electronStore[key] ?? null,
            setItem: vi.fn(() => false),
            removeItem: vi.fn(() => false),
            migrate,
          },
        },
      });
      vi.resetModules();
      const freshStorage = await import('./storageKeys');

      // When: a user sets and removes values during the migration retry window, then migration retries.
      expect(freshStorage.storageGet(StorageKeys.settings.textTransformersEnabled)).toBe('false');
      expect(freshStorage.storageSet(StorageKeys.settings.textTransformersEnabled, 'true')).toBe(
        true,
      );
      expect(freshStorage.storageRemove('state.retryWindow.v1')).toBe(true);
      rejectMigration = false;
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.settings.textTransformersEnabled)).toBe('true');

      // Then: the acknowledged batch contains the newest legacy snapshot and durable values win.
      expect(legacyStore['opencode.settings.textTransformersEnabled.v1']).toBe('true');
      expect(legacyStore['opencode.state.retryWindow.v1']).toBeUndefined();
      expect(migrationSnapshots[1]).toEqual({
        'opencode.settings.textTransformersEnabled.v1': 'true',
      });
      expect(electronStore['opencode.settings.textTransformersEnabled.v1']).toBe('true');
      expect(electronStore['opencode.state.retryWindow.v1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes a pending set observable when native storage already owns the key', async () => {
    // Given: native storage owns one key and rejects the first complete migration attempt.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const fixture = installPendingNativeOwnerFixture();
      const freshStorage = await import('./storageKeys');

      // When: the user sets the natively-owned key during the retry window, then migration retries.
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('native-old');
      expect(freshStorage.storageSet(StorageKeys.settings.enterToSend, 'user-new')).toBe(true);
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('user-new');
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('user-new');

      // Then: the acknowledged native mutation remains authoritative and the retry fills untouched keys.
      expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBe('user-new');
      expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBe('user-new');
      expect(fixture.electronStore['opencode.settings.textTransformersEnabled.v1']).toBe(
        'legacy-missing',
      );
      expect(fixture.migrationSnapshots[1]).toEqual({
        'opencode.settings.enterToSend.v1': 'user-new',
        'opencode.settings.textTransformersEnabled.v1': 'legacy-missing',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents a pending remove from resurrecting a natively-owned key', async () => {
    // Given: native storage owns one key and rejects the first complete migration attempt.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const fixture = installPendingNativeOwnerFixture();
      const freshStorage = await import('./storageKeys');

      // When: the user removes the natively-owned key during retry, then migration retries.
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('native-old');
      expect(freshStorage.storageRemove(StorageKeys.settings.enterToSend)).toBe(true);
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBeNull();
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBeNull();

      // Then: both owners stay removed and retry does not resurrect the native key.
      expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBeUndefined();
      expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBeUndefined();
      expect(fixture.electronStore['opencode.settings.textTransformersEnabled.v1']).toBe(
        'legacy-missing',
      );
      expect(fixture.migrationSnapshots[1]).toEqual({
        'opencode.settings.textTransformersEnabled.v1': 'legacy-missing',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes codexActiveThread key for codex session persistence', () => {
    expect(StorageKeys.state.codexActiveThread).toBe('state.codexActiveThread.v1');
    storageSet(StorageKeys.state.codexActiveThread, 'thr_abc123');
    expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_abc123');
    expect(store['opencode.state.codexActiveThread.v1']).toBe('thr_abc123');
  });
});
