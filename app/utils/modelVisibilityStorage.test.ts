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

  it.each([
    JSON.stringify({ user: 'corrupt', recent: [], variant: {} }),
    JSON.stringify({ user: [], recent: {}, variant: {} }),
    JSON.stringify({ user: [], recent: [], variant: [] }),
  ])('falls back from invalid canonical fields in %s', (value) => {
    // Given: canonical JSON is object-shaped but one required field has the wrong type.
    storage.values.set('global.dat:model', value);
    storage.values.set('settings.disabledModels.v1', JSON.stringify(['provider/legacy-model']));

    // When: the application restores hidden model state.
    const hiddenModels = readHiddenModelsFromStorage();

    // Then: malformed canonical fields cannot suppress the valid recovery source.
    expect(hiddenModels).toEqual(['provider/legacy-model']);
  });

  it.each([
    JSON.stringify({
      user: [{ providerID: 'provider', modelID: 7, visibility: 'hide' }],
      recent: [],
      variant: {},
    }),
    JSON.stringify({
      user: [],
      recent: [{ providerID: 'provider', modelID: 7 }],
      variant: {},
    }),
    JSON.stringify({ user: [], recent: [], variant: { 'provider/model': 7 } }),
  ])('falls back when canonical collections contain malformed members in %s', (value) => {
    // Given: a canonical collection contains a malformed member while legacy state is valid.
    storage.values.set('global.dat:model', value);
    storage.values.set('settings.disabledModels.v1', JSON.stringify(['provider/legacy-model']));

    // When: the application restores hidden model state.
    const hiddenModels = readHiddenModelsFromStorage();

    // Then: partial parsing cannot turn corrupt canonical data into an authoritative empty store.
    expect(hiddenModels).toEqual(['provider/legacy-model']);
  });

  it('removes obsolete hide entries when a model is made visible', () => {
    // Given: canonical storage contains two hidden models and unrelated explicit visibility metadata.
    storage.values.set(
      'global.dat:model',
      JSON.stringify({
        user: [
          { providerID: 'provider', modelID: 'first', visibility: 'hide' },
          { providerID: 'provider', modelID: 'second', visibility: 'hide' },
          { providerID: 'provider', modelID: 'shown', visibility: 'show' },
        ],
        recent: [{ providerID: 'provider', modelID: 'recent' }],
        variant: { 'provider/second': 'fast' },
      }),
    );

    // When: the user makes the first model visible while leaving the second hidden.
    expect(writeHiddenModelsToStorage(['provider/second'])).toBe(true);

    // Then: reload restores only the requested hidden model and preserves unrelated metadata.
    expect(readHiddenModelsFromStorage()).toEqual(['provider/second']);
    expect(JSON.parse(storage.values.get('global.dat:model')!)).toEqual({
      user: [
        { providerID: 'provider', modelID: 'shown', visibility: 'show' },
        { providerID: 'provider', modelID: 'second', visibility: 'hide' },
      ],
      recent: [{ providerID: 'provider', modelID: 'recent' }],
      variant: { 'provider/second': 'fast' },
    });
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

  it('refuses to overwrite malformed canonical model state', () => {
    // Given: canonical state has valid preferences beside one malformed history member.
    const malformed = JSON.stringify({
      recent: [{ providerID: 'openai', modelID: 7 }],
      user: [{ providerID: 'openai', modelID: 'gpt-5', visibility: 'show' }],
      variant: { 'openai/gpt-5': 'high' },
    });
    storage.values.set('global.dat:model', malformed);

    // When: a visibility update tries to commit through the canonical writer.
    const saved = writeHiddenModelsToStorage(['anthropic/claude-sonnet']);

    // Then: the invalid payload remains recoverable instead of being replaced.
    expect(saved).toBe(false);
    expect(storage.values.get('global.dat:model')).toBe(malformed);
  });
});
