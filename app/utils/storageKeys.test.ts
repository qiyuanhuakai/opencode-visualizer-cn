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
    expect(storageKey(StorageKeys.settings.modelVisibility)).toBe('opencode.global.dat:model');
    expect(storageKey(StorageKeys.settings.disabledModels)).toBe(
      'opencode.settings.disabledModels.v1',
    );
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
          migrate: vi.fn(() => true),
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

  it('throttles failed migration retries while keeping legacy storage readable', async () => {
    // Given: Electron rejects the first atomic migration of legacy renderer state.
    vi.resetModules();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const key = 'opencode.settings.textTransformers.v1';
    const migrate = vi.fn(() => false);
    const localStorage = {
      length: 1,
      key: vi.fn(() => key),
      getItem: vi.fn((requestedKey: string) => (requestedKey === key ? 'legacy-snippets' : null)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('window', {
      localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate,
        },
      },
    });
    const freshStorage = await import('./storageKeys');

    // When: callers read repeatedly inside one retry window and once after it advances.
    const first = freshStorage.storageGet(freshStorage.StorageKeys.settings.textTransformers);
    const second = freshStorage.storageGet(freshStorage.StorageKeys.settings.textTransformers);
    now.mockReturnValue(2_000);
    const third = freshStorage.storageGet(freshStorage.StorageKeys.settings.textTransformers);

    // Then: every read uses legacy data but only one migration runs per retry window.
    expect(first).toBe('legacy-snippets');
    expect(second).toBe('legacy-snippets');
    expect(third).toBe('legacy-snippets');
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenLastCalledWith({ [key]: 'legacy-snippets' });
  });

  it('uses Electron storage when the localStorage getter is unavailable', async () => {
    // Given: a sandbox policy makes localStorage access throw while Electron storage remains healthy.
    vi.resetModules();
    const key = 'opencode.settings.enterToSend.v1';
    const electronStore: Record<string, string> = { [key]: 'electron-value' };
    const migrate = vi.fn(() => true);
    const windowStub = {
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn((requestedKey: string) => electronStore[requestedKey] ?? null),
          setItem: vi.fn((requestedKey: string, value: string) => {
            electronStore[requestedKey] = value;
            return true;
          }),
          removeItem: vi.fn((requestedKey: string) => {
            delete electronStore[requestedKey];
            return true;
          }),
          migrate,
        },
      },
    };
    Object.defineProperty(windowStub, 'localStorage', {
      get() {
        throw new DOMException('Access denied', 'SecurityError');
      },
    });
    vi.stubGlobal('window', windowStub);
    const freshStorage = await import('./storageKeys');

    // When: callers read, write, and remove through the generic storage helpers.
    const initial = freshStorage.storageGet(freshStorage.StorageKeys.settings.enterToSend);
    const saved = freshStorage.storageSet(freshStorage.StorageKeys.settings.enterToSend, 'updated');
    const removed = freshStorage.storageRemove(freshStorage.StorageKeys.settings.enterToSend);

    // Then: no helper throws, Electron owns every operation, and migration is not attempted.
    expect(initial).toBe('electron-value');
    expect(saved).toBe(true);
    expect(removed).toBe(true);
    expect(electronStore[key]).toBeUndefined();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('exposes codexActiveThread key for codex session persistence', () => {
    expect(StorageKeys.state.codexActiveThread).toBe('state.codexActiveThread.v1');
    storageSet(StorageKeys.state.codexActiveThread, 'thr_abc123');
    expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_abc123');
    expect(store['opencode.state.codexActiveThread.v1']).toBe('thr_abc123');
  });
});
