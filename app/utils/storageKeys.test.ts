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
    let rejectNativeMutations = false;
    let nativeReadError = false;
    let legacySetError = false;
    let legacyRemoveError = false;
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
          if (legacySetError) throw new DOMException('Legacy storage unavailable');
          legacyStore[key] = value;
        },
        removeItem: (key: string) => {
          if (legacyRemoveError) throw new DOMException('Legacy storage unavailable');
          delete legacyStore[key];
        },
      },
      electronAPI: {
        persistentStorage: {
          getItem: (key: string) => {
            if (nativeReadError) throw new DOMException('Native storage unavailable');
            return electronStore[key] ?? null;
          },
          setItem: vi.fn((key: string, value: string) => {
            if (rejectNativeMutations) return false;
            electronStore[key] = value;
            return true;
          }),
          removeItem: vi.fn((key: string) => {
            if (rejectNativeMutations) return false;
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
      rejectNativeMutations: () => {
        rejectNativeMutations = true;
      },
      failNativeReads: () => {
        nativeReadError = true;
      },
      failLegacySets: () => {
        legacySetError = true;
      },
      failLegacyRemoves: () => {
        legacyRemoveError = true;
      },
      recoverLegacyRemoves: () => {
        legacyRemoveError = false;
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

  it('leaves renderer-owned model visibility keys out of Electron migration', async () => {
    // Given: local storage contains model visibility plus one storage-abstraction-owned setting.
    const legacyStore: Record<string, string> = {
      'opencode.global.dat:model': '{"user":[]}',
      'opencode.settings.disabledModels.v1': '["provider/model"]',
      'opencode.settings.enterToSend.v1': 'true',
    };
    const migrate = vi.fn(() => true);
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
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate,
        },
      },
    });
    vi.resetModules();
    const freshStorage = await import('./storageKeys');

    // When: an unrelated setting first initializes the Electron storage abstraction.
    freshStorage.storageGet(freshStorage.StorageKeys.settings.enterToSend);

    // Then: only owned keys migrate and direct model consumers retain their local values.
    expect(migrate).toHaveBeenCalledWith({ 'opencode.settings.enterToSend.v1': 'true' });
    expect(legacyStore['opencode.global.dat:model']).toBe('{"user":[]}');
    expect(legacyStore['opencode.settings.disabledModels.v1']).toBe('["provider/model"]');
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

  it('rejects native-missing mutations while migration remains pending', async () => {
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

      // When: a user sets and removes native-missing values during the retry window.
      expect(freshStorage.storageGet(StorageKeys.settings.textTransformersEnabled)).toBe('false');
      expect(freshStorage.storageSet(StorageKeys.settings.textTransformersEnabled, 'true')).toBe(
        false,
      );
      expect(freshStorage.storageRemove('state.retryWindow.v1')).toBe(false);
      rejectMigration = false;
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.settings.textTransformersEnabled)).toBe('false');

      // Then: rejected mutations never contaminate fallback and the original snapshot migrates atomically.
      expect(legacyStore['opencode.settings.textTransformersEnabled.v1']).toBeUndefined();
      expect(legacyStore['opencode.state.retryWindow.v1']).toBeUndefined();
      expect(migrationSnapshots[1]).toEqual({
        'opencode.settings.textTransformersEnabled.v1': 'false',
        'opencode.state.retryWindow.v1': 'stale',
      });
      expect(electronStore['opencode.settings.textTransformersEnabled.v1']).toBe('false');
      expect(electronStore['opencode.state.retryWindow.v1']).toBe('stale');
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

      // Then: the native mutation remains authoritative while migrated legacy entries are retired.
      expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBeUndefined();
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

  it('acknowledges a native-owned set when its legacy mirror throws', async () => {
    // Given: native storage owns the key, migration is pending, and the legacy mirror rejects writes.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const fixture = installPendingNativeOwnerFixture();
      fixture.failLegacySets();
      const freshStorage = await import('./storageKeys');

      // When: native storage commits the replacement before the migration retry.
      const result = freshStorage.storageSet(StorageKeys.settings.enterToSend, 'user-new');
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);

      // Then: the canonical acknowledgement and value reflect the native commit despite stale legacy data.
      expect(result).toBe(true);
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('user-new');
      expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBe('user-new');
      expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a native-owned remove when its legacy retirement throws', async () => {
    // Given: native storage owns the key, migration is pending, and legacy retirement will throw.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const fixture = installPendingNativeOwnerFixture();
      fixture.failLegacyRemoves();
      const freshStorage = await import('./storageKeys');
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('native-old');

      // When: native deletion succeeds but the fallback copy cannot be retired.
      const result = freshStorage.storageRemove(StorageKeys.settings.enterToSend);
      fixture.recoverLegacyRemoves();
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);

      // Then: the caller receives failure and retry restores the still-visible prior value.
      expect(result).toBe(false);
      expect(freshStorage.storageGet(StorageKeys.settings.enterToSend)).toBe('legacy-old');
      expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBe('legacy-old');
      expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect stale legacy data after migration and a later native remove', async () => {
    // Given: a native-owned update succeeds while its legacy mirror stays stale, then migration completes.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const fixture = installPendingNativeOwnerFixture();
      fixture.failLegacySets();
      const firstRenderer = await import('./storageKeys');
      expect(firstRenderer.storageSet(StorageKeys.settings.enterToSend, 'user-new')).toBe(true);
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);
      expect(firstRenderer.storageGet(StorageKeys.settings.enterToSend)).toBe('user-new');
      expect(firstRenderer.storageRemove(StorageKeys.settings.enterToSend)).toBe(true);

      // When: a fresh renderer starts and performs migration discovery again.
      vi.resetModules();
      const freshRenderer = await import('./storageKeys');

      // Then: retired legacy data cannot recreate the intentionally removed native key.
      expect(freshRenderer.storageGet(StorageKeys.settings.enterToSend)).toBeNull();
      expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBeUndefined();
      expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps migration pending when a legacy value changes before conditional cleanup', async () => {
    // Given: another renderer changes a captured legacy value after the native batch commits.
    const key = StorageKeys.settings.enterToSend;
    const storedKey = `opencode.${key}`;
    const legacyStore: Record<string, string> = { [storedKey]: 'legacy-snapshot' };
    const electronStore: Record<string, string> = { [storedKey]: 'native-winner' };
    let firstMigration = true;
    vi.stubGlobal('window', {
      localStorage: {
        get length() {
          return Object.keys(legacyStore).length;
        },
        key: (index: number) => Object.keys(legacyStore)[index] ?? null,
        getItem: (storageKey: string) => legacyStore[storageKey] ?? null,
        setItem: (storageKey: string, value: string) => {
          legacyStore[storageKey] = value;
        },
        removeItem: (storageKey: string) => {
          delete legacyStore[storageKey];
        },
      },
      electronAPI: {
        persistentStorage: {
          getItem: (storageKey: string) => electronStore[storageKey] ?? null,
          setItem: (storageKey: string, value: string) => {
            electronStore[storageKey] = value;
            return true;
          },
          removeItem: (storageKey: string) => {
            delete electronStore[storageKey];
            return true;
          },
          migrate: (entries: Record<string, string>) => {
            for (const [storageKey, value] of Object.entries(entries)) {
              if (!Object.hasOwn(electronStore, storageKey)) electronStore[storageKey] = value;
            }
            if (firstMigration) {
              firstMigration = false;
              legacyStore[storedKey] = 'concurrent-new';
            }
            return true;
          },
        },
      },
    });
    vi.resetModules();
    const firstRenderer = await import('./storageKeys');
    expect(firstRenderer.storageGet(key)).toBe('native-winner');

    // When: the key is removed during pending reconciliation and a fresh renderer starts.
    expect(firstRenderer.storageRemove(key)).toBe(true);
    vi.resetModules();
    const freshRenderer = await import('./storageKeys');

    // Then: the concurrent legacy value cannot be resurrected as a completed migration source.
    expect(freshRenderer.storageGet(key)).toBeNull();
    expect(electronStore[storedKey]).toBeUndefined();
    expect(legacyStore[storedKey]).toBeUndefined();
  });

  it('rejects a native-missing pending write that races an older migration snapshot', async () => {
    // Given: renderer B is pending while renderer A can commit an older legacy snapshot.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-25T08:00:00.000Z'));
      const key = StorageKeys.settings.enterToSend;
      const storedKey = `opencode.${key}`;
      const legacyStore: Record<string, string> = { [storedKey]: 'snapshot-old' };
      const electronStore: Record<string, string> = {};
      let rejectMigration = true;
      let concurrentWriteResult: boolean | null = null;
      let concurrentWrite: (() => void) | null = null;
      const migrate = (entries: Record<string, string>) => {
        if (rejectMigration) return false;
        concurrentWrite?.();
        concurrentWrite = null;
        for (const [storageKey, value] of Object.entries(entries)) {
          if (!Object.hasOwn(electronStore, storageKey)) electronStore[storageKey] = value;
        }
        return true;
      };
      vi.stubGlobal('window', {
        localStorage: {
          get length() {
            return Object.keys(legacyStore).length;
          },
          key: (index: number) => Object.keys(legacyStore)[index] ?? null,
          getItem: (storageKey: string) => legacyStore[storageKey] ?? null,
          setItem: (storageKey: string, value: string) => {
            legacyStore[storageKey] = value;
          },
          removeItem: (storageKey: string) => {
            delete legacyStore[storageKey];
          },
        },
        electronAPI: {
          persistentStorage: {
            getItem: (storageKey: string) => electronStore[storageKey] ?? null,
            setItem: (storageKey: string, value: string) => {
              electronStore[storageKey] = value;
              return true;
            },
            removeItem: (storageKey: string) => {
              delete electronStore[storageKey];
              return true;
            },
            migrate,
          },
        },
      });
      vi.resetModules();
      const rendererB = await import('./storageKeys');
      expect(rendererB.storageGet(key)).toBe('snapshot-old');
      rejectMigration = false;
      vi.resetModules();
      const rendererA = await import('./storageKeys');
      concurrentWrite = () => {
        concurrentWriteResult = rendererB.storageSet(key, 'uncommitted-new');
      };

      // When: A commits its old snapshot and later retries reconciliation without another user write.
      rendererA.storageGet(key);
      vi.advanceTimersByTime(1_000);
      const reconciledValue = rendererA.storageGet(key);

      // Then: B receives failure, fallback is untouched, and A's complete snapshot remains authoritative.
      expect(concurrentWriteResult).toBe(false);
      expect(reconciledValue).toBe('snapshot-old');
      expect(electronStore[storedKey]).toBe('snapshot-old');
      expect(legacyStore[storedKey]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mutate legacy fallback when pending native ownership cannot be read', async () => {
    // Given: migration is pending and native ownership cannot be determined.
    const fixture = installPendingNativeOwnerFixture();
    fixture.failNativeReads();
    const freshStorage = await import('./storageKeys');
    const before = { ...fixture.legacyStore };

    // When: renderer mutations are attempted through the unresolved ownership boundary.
    const setResult = freshStorage.storageSet(StorageKeys.settings.enterToSend, 'unconfirmed');
    const removeResult = freshStorage.storageRemove(StorageKeys.settings.textTransformersEnabled);

    // Then: both mutations are rejected without changing the retryable legacy snapshot.
    expect(setResult).toBe(false);
    expect(removeResult).toBe(false);
    expect(fixture.legacyStore).toEqual(before);
  });

  it('does not mutate legacy fallback when a native-owned set is rejected', async () => {
    // Given: native storage owns the key, migration is pending, and native writes are rejected.
    const fixture = installPendingNativeOwnerFixture();
    fixture.rejectNativeMutations();
    const freshStorage = await import('./storageKeys');

    // When: the renderer tries to replace the native-owned value.
    const result = freshStorage.storageSet(StorageKeys.settings.enterToSend, 'unconfirmed');

    // Then: neither owner observes a value that Electron did not acknowledge.
    expect(result).toBe(false);
    expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBe('native-old');
    expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBe('legacy-old');
  });

  it('does not mutate legacy fallback when a native-owned remove is rejected', async () => {
    // Given: native storage owns the key, migration is pending, and native removals are rejected.
    const fixture = installPendingNativeOwnerFixture();
    fixture.rejectNativeMutations();
    const freshStorage = await import('./storageKeys');

    // When: the renderer tries to remove the native-owned value.
    const result = freshStorage.storageRemove(StorageKeys.settings.enterToSend);

    // Then: both owners retain their prior values for the next retry.
    expect(result).toBe(false);
    expect(fixture.electronStore['opencode.settings.enterToSend.v1']).toBe('native-old');
    expect(fixture.legacyStore['opencode.settings.enterToSend.v1']).toBe('legacy-old');
  });

  it('exposes codexActiveThread key for codex session persistence', () => {
    expect(StorageKeys.state.codexActiveThread).toBe('state.codexActiveThread.v1');
    storageSet(StorageKeys.state.codexActiveThread, 'thr_abc123');
    expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_abc123');
    expect(store['opencode.state.codexActiveThread.v1']).toBe('thr_abc123');
  });
});
