import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn((key: string) => values.get(key) ?? null),
    set: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return true;
    }),
    remove: vi.fn((key: string) => {
      values.delete(key);
      return true;
    }),
  };
});

vi.mock('./storageKeys', () => ({
  StorageKeys: {
    settings: {
      modelVisibility: 'global.dat:model',
      disabledModels: 'settings.disabledModels.v1',
    },
  },
  storageGet: storage.get,
  storageSet: storage.set,
  storageRemove: storage.remove,
}));

import { readHiddenModelsFromStorage, writeHiddenModelsToStorage } from './modelVisibilityStorage';

describe('model visibility storage', () => {
  beforeEach(() => {
    storage.values.clear();
    vi.clearAllMocks();
  });

  it('treats a valid empty canonical store as authoritative over legacy models', () => {
    // Given: canonical storage intentionally contains no hidden models while legacy cleanup failed.
    storage.values.set('global.dat:model', JSON.stringify({ user: [], recent: [], variant: {} }));
    storage.values.set('settings.disabledModels.v1', JSON.stringify(['provider/legacy-model']));

    // When: the application restores hidden model state.
    const hiddenModels = readHiddenModelsFromStorage();

    // Then: obsolete legacy state cannot resurrect after a successful canonical write.
    expect(hiddenModels).toEqual([]);
  });

  it.each(['[]', '"text"', '42', 'true'])('falls back from invalid canonical JSON %s', (value) => {
    // Given: canonical JSON has the wrong schema while legacy state remains valid.
    storage.values.set('global.dat:model', value);
    storage.values.set('settings.disabledModels.v1', JSON.stringify(['provider/legacy-model']));

    // When: the application restores hidden model state.
    const hiddenModels = readHiddenModelsFromStorage();

    // Then: malformed canonical data cannot suppress the valid recovery source.
    expect(hiddenModels).toEqual(['provider/legacy-model']);
  });

  it('retains legacy state when the canonical write is rejected', () => {
    // Given: only legacy model state exists and canonical persistence rejects the update.
    storage.values.set('settings.disabledModels.v1', JSON.stringify(['provider/legacy-model']));
    storage.set.mockReturnValueOnce(false);

    // When: the user clears hidden models but the canonical write fails.
    const saved = writeHiddenModelsToStorage([]);

    // Then: cleanup is not attempted and the legacy state remains readable.
    expect(saved).toBe(false);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(readHiddenModelsFromStorage()).toEqual(['provider/legacy-model']);
  });

  it('keeps canonical state authoritative when legacy cleanup is rejected', () => {
    // Given: canonical persistence succeeds while removal of the old key is rejected.
    storage.values.set('settings.disabledModels.v1', JSON.stringify(['provider/legacy-model']));
    storage.remove.mockReturnValueOnce(false);

    // When: the user clears all hidden models.
    const saved = writeHiddenModelsToStorage([]);

    // Then: the valid canonical empty value wins despite the retained legacy source.
    expect(saved).toBe(true);
    expect(storage.values.has('settings.disabledModels.v1')).toBe(true);
    expect(readHiddenModelsFromStorage()).toEqual([]);
  });
});
