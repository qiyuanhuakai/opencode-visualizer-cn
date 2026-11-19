import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeLiveSetting, liveSettingKey } from '../../shared/runtime/liveSettings.js';

import {
  StorageKeys,
  storageGet,
  storageGetJSON,
  storageKey,
  storageRemove,
  storageSet,
  storageSetJSON,
} from './storageKeys';

describe('live settings', () => {
  let values: Map<string, string>;
  let browser: Storage;
  beforeEach(() => {
    vi.resetModules();
    values = new Map();
    browser = {
      get length() { return values.size; },
      key: index => [...values.keys()][index] ?? null,
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); },
      clear: () => { values.clear(); },
    };
    vi.stubGlobal('window', { localStorage: browser });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it.each(['legacy', 'draining', 'frozen', 'paused', 'cutover'] as const)(
    'persists settings independently when the writer is %s', async phase => {
      // Given: the legacy writer is in each supported lifecycle phase.
      const gate = await import('../runtime/migration/writerFreeze');
      const storage = await import('./storageKeys');
      const retained: unknown[] = [];
      const persist = async (write: unknown) => { retained.push(write); };
      let releaseDrain = () => {};
      let draining: Promise<void> | undefined;
      if (phase === 'draining') {
        const blocked = new Promise<void>(resolve => { releaseDrain = resolve; });
        gate.registerLegacyWriter(() => blocked);
        draining = gate.freezeLegacyWriters({ clientOrigin: 'test', persist });
      } else if (phase === 'paused') {
        const unregister = gate.registerLegacyWriter(() => { throw new Error('fixture drain'); });
        await expect(gate.freezeLegacyWriters({ clientOrigin: 'test', persist })).rejects.toThrow('fixture drain');
        unregister();
      } else if (phase === 'frozen') {
        await gate.freezeLegacyWriters({ clientOrigin: 'test', persist });
      } else if (phase === 'cutover') {
        gate.restoreLegacyCutover({ clientOrigin: 'test', persist });
      }
      expect(gate.legacyWriterPhase()).toBe(phase);
      const key = 'vis.runtime.bridgeUrl';
      values.set(storageKey(key), 'legacy-address');
      // When: the live value is saved while legacy ownership is unchanged.
      const saved = storage.storageSet(key, 'ws://127.0.0.1:35807/runtime');
      // Then: the effective value is durable and no pending legacy write is created.
      expect(saved).toBe(true);
      expect(storage.storageGet(key)).toBe('ws://127.0.0.1:35807/runtime');
      expect(values.get(storageKey(key))).toBe('legacy-address');
      expect(retained).toEqual([]);
      expect(gate.writerPendingState().count).toBe(0);
      releaseDrain();
      await draining;
    },
  );

  it('reads the cutover URL and theme on fresh startup before restoring writer state', async () => {
    // Given: a cutover profile retains old source values.
    const gate = await import('../runtime/migration/writerFreeze');
    gate.restoreLegacyCutover({ clientOrigin: 'test', persist: async () => {} });
    const first = await import('./storageKeys');
    const theme = StorageKeys.settings.regionTheme;
    values.set(storageKey(theme), 'old-theme');
    expect(first.storageSet('vis.runtime.bridgeUrl', 'ws://127.0.0.1:35807/runtime')).toBe(true);
    expect(first.storageSet(theme, 'imported-theme')).toBe(true);
    // When: a fresh module initializes before asynchronous cutover restoration.
    vi.resetModules();
    const fresh = await import('./storageKeys');
    const freshGate = await import('../runtime/migration/writerFreeze');
    // Then: startup sees both saved values and the source remains untouched.
    expect(freshGate.legacyWriterPhase()).toBe('legacy');
    expect(fresh.storageGet('vis.runtime.bridgeUrl')).toBe('ws://127.0.0.1:35807/runtime');
    expect(fresh.storageGet(theme)).toBe('imported-theme');
    expect(values.get(storageKey(theme))).toBe('old-theme');
  });

  it.each([StorageKeys.auth.credentials, 'credentials.v1', StorageKeys.settings.regionTheme])(
    'live removal of %s survives reload without resurrecting legacy values', async key => {
      // Given: an old setting exists without an overlay.
      values.set(storageKey(key), 'synthetic-old');
      const first = await import('./storageKeys');
      // When: it is removed and the renderer reloads.
      expect(first.storageRemove(key)).toBe(true);
      vi.resetModules();
      const fresh = await import('./storageKeys');
      // Then: the tombstone wins while the old source stays intact.
      expect(fresh.storageRead(key)).toEqual({ kind: 'missing' });
      expect(values.get(storageKey(key))).toBe('synthetic-old');
      expect(values.get(liveSettingKey(key))).toBe(encodeLiveSetting(null));
    },
  );

  it('live failure preserves the old overlay on quota rejection', async () => {
    // Given: storage has a committed overlay and rejects subsequent writes.
    const key = StorageKeys.settings.regionTheme;
    values.set(liveSettingKey(key), encodeLiveSetting('committed'));
    browser.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    const storage = await import('./storageKeys');
    // When: replacement and removal both fail.
    const results = [storage.storageSet(key, 'lost'), storage.storageRemove(key)];
    // Then: failure is acknowledged without changing the effective value.
    expect(results).toEqual([false, false]);
    expect(storage.storageGet(key)).toBe('committed');
  });

  it('live failure guards localStorage getter access', async () => {
    // Given: the browser denies storage access.
    vi.stubGlobal('window', { get localStorage() { throw new DOMException('denied', 'SecurityError'); } });
    const storage = await import('./storageKeys');
    // When: callers attempt each synchronous operation.
    const read = storage.storageRead(StorageKeys.settings.regionTheme);
    const set = storage.storageSet(StorageKeys.settings.regionTheme, 'new');
    const remove = storage.storageRemove(StorageKeys.settings.regionTheme);
    // Then: the public failure contract is returned without an uncaught exception.
    expect(read).toEqual({ kind: 'error' });
    expect([set, remove]).toEqual([false, false]);
  });

  it.each(['{broken', '{"version":2,"value":"wrong"}'])(
    'live failure does not fall back from corrupt overlay %s', async raw => {
      // Given: a corrupt overlay exists over a valid old value.
      const key = StorageKeys.settings.regionTheme;
      values.set(storageKey(key), 'stale');
      values.set(liveSettingKey(key), raw);
      const storage = await import('./storageKeys');
      // When: the setting is read.
      const result = storage.storageRead(key);
      // Then: corruption is visible instead of stale fallback.
      expect(result).toEqual({ kind: 'error' });
    },
  );

  it('reads native then browser legacy fallback without migration or source mutation', async () => {
    // Given: native and browser sources disagree, and another setting exists only in the browser.
    const key = StorageKeys.settings.regionTheme;
    const other = StorageKeys.settings.enterToSend;
    values.set(storageKey(key), 'browser-old');
    values.set(storageKey(other), 'true');
    const native = new Map([[storageKey(key), 'native-old']]);
    const migrate = vi.fn(() => true);
    vi.stubGlobal('window', { localStorage: browser, electronAPI: { persistentStorage: {
      getItem: (key: string) => native.get(key) ?? null, setItem: vi.fn(), removeItem: vi.fn(), migrate,
    } } });
    const storage = await import('./storageKeys');
    // When: both settings are read.
    const reads = [storage.storageGet(key), storage.storageGet(other)];
    // Then: native precedence and read-only fallback preserve both sources.
    expect(reads).toEqual(['native-old', 'true']);
    expect([...values]).toEqual([[storageKey(key), 'browser-old'], [storageKey(other), 'true']]);
    expect([...native]).toEqual([[storageKey(key), 'native-old']]);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('live failure never falls back after native read errors or rejected writes', async () => {
    // Given: native persistence fails despite an available browser fallback.
    const key = StorageKeys.settings.regionTheme;
    values.set(storageKey(key), 'browser-old');
    const before = [...values];
    vi.stubGlobal('window', { localStorage: browser, electronAPI: { persistentStorage: {
      getItem: () => { throw new Error('native unavailable'); },
      setItem: () => false, removeItem: () => false, migrate: vi.fn(),
    } } });
    const storage = await import('./storageKeys');
    // When: read, replacement, and removal are attempted.
    const read = storage.storageRead(key);
    const results = [storage.storageSet(key, 'new'), storage.storageRemove(key)];
    // Then: no browser mutation or successful acknowledgement masks the native failure.
    expect(read).toEqual({ kind: 'error' });
    expect(results).toEqual([false, false]);
    expect([...values]).toEqual(before);
  });

  it('preserves native approved-application authority during cutover', async () => {
    // Given: native IPC exclusively owns application approval.
    const gate = await import('../runtime/migration/writerFreeze');
    const pending = vi.fn(async () => {});
    gate.restoreLegacyCutover({ clientOrigin: 'test', persist: pending });
    const key = StorageKeys.settings.localApplicationPath;
    const getItem = vi.fn((key: string) => key === storageKey(StorageKeys.settings.localApplicationPath) ? 'approved-app' : null);
    const setItem = vi.fn(() => true);
    const removeItem = vi.fn(() => true);
    const migrate = vi.fn();
    vi.stubGlobal('window', { localStorage: browser, electronAPI: { persistentStorage: { getItem, setItem, removeItem, migrate } } });
    const storage = await import('./storageKeys');
    // When: renderer attempts to change or remove that main-owned preference.
    expect(storage.storageSet(key, 'unapproved')).toBe(true);
    expect(storage.storageRemove(key)).toBe(true);
    // Then: only protected IPC is used, with its no-op acknowledgement semantics.
    expect(storage.storageGet(key)).toBe('approved-app');
    expect(setItem).toHaveBeenCalledWith(storageKey(key), 'unapproved');
    expect(removeItem).toHaveBeenCalledWith(storageKey(key));
    expect(migrate).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it('live failure keeps a committed native envelope after rejected replacement and removal', async () => {
    // Given: native storage can commit an envelope before later persistence fails.
    const key = StorageKeys.settings.regionTheme;
    const native = new Map([[storageKey(key), 'native-source']]);
    values.set(storageKey(key), 'browser-source');
    let writable = true;
    const migrate = vi.fn();
    vi.stubGlobal('window', { localStorage: browser, electronAPI: { persistentStorage: {
      getItem: (key: string) => native.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (!writable) return false;
        native.set(key, value); return true;
      },
      removeItem: vi.fn(() => false), migrate,
    } } });
    const storage = await import('./storageKeys');
    expect(storage.storageSet(key, 'native-committed')).toBe(true);
    writable = false;
    // When: subsequent replacement and removal are rejected, then the module reloads.
    const results = [storage.storageSet(key, 'uncommitted'), storage.storageRemove(key)];
    vi.resetModules();
    const fresh = await import('./storageKeys');
    // Then: the committed envelope remains authoritative and both legacy sources are unchanged.
    expect(results).toEqual([false, false]);
    expect(fresh.storageGet(key)).toBe('native-committed');
    expect(native.get(storageKey(key))).toBe('native-source');
    expect(values.get(storageKey(key))).toBe('browser-source');
    expect(values.has(liveSettingKey(key))).toBe(false);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('keeps an empty live string distinct from a removal tombstone', async () => {
    // Given: the source has a nonempty fallback.
    const key = StorageKeys.settings.regionTheme;
    values.set(storageKey(key), 'old');
    const storage = await import('./storageKeys');
    // When: an empty string is saved.
    expect(storage.storageSet(key, '')).toBe(true);
    // Then: the read contract retains the explicit empty value.
    expect(storage.storageRead(key)).toEqual({ kind: 'value', value: '' });
  });

  it('persists the application path normally when Electron is absent', async () => {
    // Given: this is a browser with no native application approval authority.
    const key = StorageKeys.settings.localApplicationPath;
    const storage = await import('./storageKeys');
    // When: the browser setting is updated.
    expect(storage.storageSet(key, 'browser-app')).toBe(true);
    // Then: it uses the same independent envelope as other browser settings.
    expect(values.get(liveSettingKey(key))).toBe(encodeLiveSetting('browser-app'));
    expect(values.has(storageKey(key))).toBe(false);
  });

  it('retains frozen entity and unknown writes in their existing pending sink', async () => {
    // Given: entity writers are frozen while live settings are available.
    const gate = await import('../runtime/migration/writerFreeze');
    const retained: unknown[] = [];
    await gate.freezeLegacyWriters({ clientOrigin: 'test', persist: async write => { retained.push(write); } });
    const storage = await import('./storageKeys');
    const keys = [StorageKeys.drafts.composer, StorageKeys.state.pinnedSessions, 'unknown.v1'];
    // When: entity and unknown keys are updated.
    for (const key of keys) expect(storage.storageSet(key, 'pending')).toBe(true);
    await gate.flushFrozenLegacyWrites();
    // Then: existing pending ownership is retained without live records.
    expect(retained).toEqual(keys.map((key, index) => ({
      channel: 'storage', key: storageKey(key), value: 'pending', clientOrigin: 'test', revision: index + 1,
    })));
    expect(values.size).toBe(0);
  });
});

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
      'opencode.state.lastAuthError.v1': 'legacy-old',
      'opencode.state.deletedSandboxes.v1': 'legacy-missing',
    };
    const electronStore: Record<string, string> = {
      'opencode.state.lastAuthError.v1': 'native-old',
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
    storageSet(StorageKeys.state.lastAuthError, 'true');
    expect(storageGet(StorageKeys.state.lastAuthError)).toBe('true');
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

    storageSet(StorageKeys.state.lastAuthError, 'true');
    expect(storageGet(StorageKeys.state.lastAuthError)).toBe('true');
    expect(electronStore['opencode.state.lastAuthError.v1']).toBe('true');
  });

  it('leaves renderer-owned model visibility keys out of Electron migration', async () => {
    // Given: local storage contains model visibility plus one storage-abstraction-owned entity.
    const legacyStore: Record<string, string> = {
      'opencode.global.dat:model': '{"user":[]}',
      'opencode.settings.disabledModels.v1': '["provider/model"]',
      'opencode.state.lastAuthError.v1': 'true',
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

    // When: an unrelated entity first initializes the Electron storage abstraction.
    freshStorage.storageGet(freshStorage.StorageKeys.state.lastAuthError);

    // Then: only owned keys migrate and direct model consumers retain their local values.
    expect(migrate).toHaveBeenCalledWith({ 'opencode.state.lastAuthError.v1': 'true' });
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
        'opencode.state.lastAuthError.v1': 'legacy-value',
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
      const pendingValue = freshStorage.storageGet(StorageKeys.state.lastAuthError);
      rejectMigration = false;
      vi.advanceTimersByTime(1_000);
      const migratedValue = freshStorage.storageGet(StorageKeys.state.lastAuthError);

      // Then: the source remains readable until one acknowledged batch becomes authoritative.
      expect(pendingValue).toBe('legacy-value');
      expect(migratedValue).toBe('legacy-value');
      expect(electronStore['opencode.state.lastAuthError.v1']).toBe('legacy-value');
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
        'opencode.state.deletedSandboxes.v1': 'false',
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
      expect(freshStorage.storageGet(StorageKeys.state.deletedSandboxes)).toBe('false');
      expect(freshStorage.storageSet(StorageKeys.state.deletedSandboxes, 'true')).toBe(
        false,
      );
      expect(freshStorage.storageRemove('state.retryWindow.v1')).toBe(false);
      rejectMigration = false;
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.state.deletedSandboxes)).toBe('false');

      // Then: rejected mutations never contaminate fallback and the original snapshot migrates atomically.
      expect(legacyStore['opencode.state.deletedSandboxes.v1']).toBeUndefined();
      expect(legacyStore['opencode.state.retryWindow.v1']).toBeUndefined();
      expect(migrationSnapshots[1]).toEqual({
        'opencode.state.deletedSandboxes.v1': 'false',
        'opencode.state.retryWindow.v1': 'stale',
      });
      expect(electronStore['opencode.state.deletedSandboxes.v1']).toBe('false');
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
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('native-old');
      expect(freshStorage.storageSet(StorageKeys.state.lastAuthError, 'user-new')).toBe(true);
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('user-new');
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('user-new');

      // Then: the native mutation remains authoritative while migrated legacy entries are retired.
      expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBeUndefined();
      expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBe('user-new');
      expect(fixture.electronStore['opencode.state.deletedSandboxes.v1']).toBe(
        'legacy-missing',
      );
      expect(fixture.migrationSnapshots[1]).toEqual({
        'opencode.state.lastAuthError.v1': 'user-new',
        'opencode.state.deletedSandboxes.v1': 'legacy-missing',
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
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('native-old');
      expect(freshStorage.storageRemove(StorageKeys.state.lastAuthError)).toBe(true);
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBeNull();
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBeNull();

      // Then: both owners stay removed and retry does not resurrect the native key.
      expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBeUndefined();
      expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBeUndefined();
      expect(fixture.electronStore['opencode.state.deletedSandboxes.v1']).toBe(
        'legacy-missing',
      );
      expect(fixture.migrationSnapshots[1]).toEqual({
        'opencode.state.deletedSandboxes.v1': 'legacy-missing',
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
      const result = freshStorage.storageSet(StorageKeys.state.lastAuthError, 'user-new');
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);

      // Then: the canonical acknowledgement and value reflect the native commit despite stale legacy data.
      expect(result).toBe(true);
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('user-new');
      expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBe('user-new');
      expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBeUndefined();
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
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('native-old');

      // When: native deletion succeeds but the fallback copy cannot be retired.
      const result = freshStorage.storageRemove(StorageKeys.state.lastAuthError);
      fixture.recoverLegacyRemoves();
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);

      // Then: the caller receives failure and retry restores the still-visible prior value.
      expect(result).toBe(false);
      expect(freshStorage.storageGet(StorageKeys.state.lastAuthError)).toBe('legacy-old');
      expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBe('legacy-old');
      expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBeUndefined();
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
      expect(firstRenderer.storageSet(StorageKeys.state.lastAuthError, 'user-new')).toBe(true);
      fixture.makeMigrationSucceed();
      vi.advanceTimersByTime(1_000);
      expect(firstRenderer.storageGet(StorageKeys.state.lastAuthError)).toBe('user-new');
      expect(firstRenderer.storageRemove(StorageKeys.state.lastAuthError)).toBe(true);

      // When: a fresh renderer starts and performs migration discovery again.
      vi.resetModules();
      const freshRenderer = await import('./storageKeys');

      // Then: retired legacy data cannot recreate the intentionally removed native key.
      expect(freshRenderer.storageGet(StorageKeys.state.lastAuthError)).toBeNull();
      expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBeUndefined();
      expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps migration pending when a legacy value changes before conditional cleanup', async () => {
    // Given: another renderer changes a captured legacy value after the native batch commits.
    const key = StorageKeys.state.lastAuthError;
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
      const key = StorageKeys.state.lastAuthError;
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
    const setResult = freshStorage.storageSet(StorageKeys.state.lastAuthError, 'unconfirmed');
    const removeResult = freshStorage.storageRemove(StorageKeys.state.deletedSandboxes);

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
    const result = freshStorage.storageSet(StorageKeys.state.lastAuthError, 'unconfirmed');

    // Then: neither owner observes a value that Electron did not acknowledge.
    expect(result).toBe(false);
    expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBe('native-old');
    expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBe('legacy-old');
  });

  it('does not mutate legacy fallback when a native-owned remove is rejected', async () => {
    // Given: native storage owns the key, migration is pending, and native removals are rejected.
    const fixture = installPendingNativeOwnerFixture();
    fixture.rejectNativeMutations();
    const freshStorage = await import('./storageKeys');

    // When: the renderer tries to remove the native-owned value.
    const result = freshStorage.storageRemove(StorageKeys.state.lastAuthError);

    // Then: both owners retain their prior values for the next retry.
    expect(result).toBe(false);
    expect(fixture.electronStore['opencode.state.lastAuthError.v1']).toBe('native-old');
    expect(fixture.legacyStore['opencode.state.lastAuthError.v1']).toBe('legacy-old');
  });

  it('exposes codexActiveThread key for codex session persistence', () => {
    expect(StorageKeys.state.codexActiveThread).toBe('state.codexActiveThread.v1');
    storageSet(StorageKeys.state.codexActiveThread, 'thr_abc123');
    expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_abc123');
    expect(store['opencode.state.codexActiveThread.v1']).toBe('thr_abc123');
  });
});
