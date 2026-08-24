import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LocalStore = Record<string, string>;

function createLocalStorage(store: LocalStore) {
  return {
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
  };
}

describe('Electron renderer storage migration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cleans submitted entries after acknowledgement without overwriting Electron winners', async () => {
    // Given: Electron owns a credential while renderer storage also has a missing model key.
    const credentialKey = 'opencode.auth.credentials.v1';
    const modelKey = 'opencode.global.dat:model';
    const localStore: LocalStore = {
      [credentialKey]: 'legacy-loser',
      [modelKey]: 'legacy-models',
      unrelated: 'keep-me',
    };
    const electronStore: LocalStore = { [credentialKey]: 'electron-winner' };
    const localStorage = createLocalStorage(localStore);
    const migrate = vi.fn((entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (!(key in electronStore)) electronStore[key] = value;
      }
      return true;
    });
    vi.stubGlobal('window', {
      localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn((key: string) => electronStore[key] ?? null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate,
        },
      },
    });
    const storage = await import('./storageKeys');

    // When: the first shared-storage access completes the atomic Electron migration.
    expect(storage.storageGet(storage.StorageKeys.auth.credentials)).toBe('electron-winner');

    // Then: both submitted sources are removed and the existing Electron winner remains canonical.
    expect(migrate).toHaveBeenCalledWith({
      [credentialKey]: 'legacy-loser',
      [modelKey]: 'legacy-models',
    });
    expect(localStore).toEqual({ unrelated: 'keep-me' });
    expect(electronStore).toEqual({
      [credentialKey]: 'electron-winner',
      [modelKey]: 'legacy-models',
    });
  });

  it('retries source cleanup after localStorage removal throws', async () => {
    // Given: Electron commits a credential but the first renderer cleanup attempt throws.
    const credentialKey = 'opencode.auth.credentials.v1';
    const localStore: LocalStore = { [credentialKey]: 'legacy-secret' };
    const electronStore: LocalStore = {};
    const localStorage = createLocalStorage(localStore);
    localStorage.removeItem.mockImplementationOnce(() => {
      throw new Error('cleanup failed');
    });
    vi.stubGlobal('window', {
      localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn((key: string) => electronStore[key] ?? null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate: vi.fn((entries: Record<string, string>) => {
            Object.assign(electronStore, entries);
            return true;
          }),
        },
      },
    });
    const firstStorage = await import('./storageKeys');

    // When: cleanup fails after the acknowledged migration, then the module reloads.
    expect(firstStorage.storageGet(firstStorage.StorageKeys.auth.credentials)).toBe(
      'legacy-secret',
    );
    expect(localStore[credentialKey]).toBe('legacy-secret');
    vi.resetModules();
    const reloadedStorage = await import('./storageKeys');

    // Then: retry keeps the Electron value and eventually removes the stale renderer source.
    expect(reloadedStorage.storageGet(reloadedStorage.StorageKeys.auth.credentials)).toBe(
      'legacy-secret',
    );
    expect(localStore[credentialKey]).toBeUndefined();
    expect(electronStore[credentialKey]).toBe('legacy-secret');
  });

  it('retains sensitive migration sources for retry without exposing them', async () => {
    // Given: Electron rejects an atomic migration containing stale credentials.
    const credentialKey = 'opencode.auth.credentials.v1';
    const localStore: LocalStore = { [credentialKey]: 'legacy-secret' };
    const localStorage = createLocalStorage(localStore);
    vi.stubGlobal('window', {
      localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate: vi.fn(() => false),
        },
      },
    });
    const storage = await import('./storageKeys');

    // When: a caller reads while migration is unavailable.
    expect(storage.storageGet(storage.StorageKeys.auth.credentials)).toBeNull();

    // Then: the sensitive source remains available only for a later migration retry.
    expect(localStore).toEqual({ [credentialKey]: 'legacy-secret' });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it('keeps non-sensitive fallback readable while migration is pending', async () => {
    // Given: Electron rejects an atomic migration containing non-sensitive model state.
    const modelKey = 'opencode.global.dat:model';
    const localStore: LocalStore = { [modelKey]: 'legacy-model-state' };
    const localStorage = createLocalStorage(localStore);
    vi.stubGlobal('window', {
      localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate: vi.fn(() => false),
        },
      },
    });
    const storage = await import('./storageKeys');

    // When: a caller reads the non-sensitive value before migration recovers.
    const modelState = storage.storageGet(storage.StorageKeys.settings.modelVisibility);

    // Then: existing settings remain readable and their source is retained for retry.
    expect(modelState).toBe('legacy-model-state');
    expect(localStore).toEqual({ [modelKey]: 'legacy-model-state' });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it('preserves every legacy source entry when Electron migration throws', async () => {
    // Given: synchronous IPC throws before acknowledging a credential migration.
    const credentialKey = 'opencode.auth.credentials.v1';
    const localStore: LocalStore = { [credentialKey]: 'legacy-secret' };
    const localStorage = createLocalStorage(localStore);
    vi.stubGlobal('window', {
      localStorage,
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => true),
          removeItem: vi.fn(() => true),
          migrate: vi.fn(() => {
            throw new Error('ipc failed');
          }),
        },
      },
    });
    const storage = await import('./storageKeys');

    // When: a caller reads through the retry-safe fallback path.
    expect(storage.storageGet(storage.StorageKeys.auth.credentials)).toBeNull();

    // Then: the exception hides sensitive residue while leaving the source intact for retry.
    expect(localStore).toEqual({ [credentialKey]: 'legacy-secret' });
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });
});
