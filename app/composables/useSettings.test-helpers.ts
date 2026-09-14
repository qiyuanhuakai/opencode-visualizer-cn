import { afterEach, beforeEach, vi } from 'vitest';

import type { useSettings } from './useSettings';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

type Settings = ReturnType<typeof useSettings>;
type StorageListener = (event: StorageEvent) => void;

export function useSettingsTestHarness() {
  let storage = new MemoryStorage();
  let storageListeners: StorageListener[] = [];

  beforeEach(() => {
    vi.resetModules();
    storage = new MemoryStorage();
    storageListeners = [];

    const addEventListener = vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
      if (type !== 'storage') return;
      storageListeners.push((event) => {
        if (typeof handler === 'function') {
          handler(event);
        } else {
          handler.handleEvent(event);
        }
      });
    });

    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  return {
    get storage(): Storage {
      return storage;
    },
    get storageListeners(): readonly StorageListener[] {
      return storageListeners;
    },
    storageEvent(key: string, newValue: string | null): StorageEvent {
      return new StorageEvent('storage', { key, newValue, storageArea: storage });
    },
    async importFresh(): Promise<Settings> {
      const mod = await import('./useSettings');
      return mod.useSettings();
    },
  };
}
