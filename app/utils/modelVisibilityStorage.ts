import { StorageKeys, storageGet, storageRemove, storageSet } from './storageKeys';

export type ModelVisibilityEntry = {
  providerID: string;
  modelID: string;
  visibility: 'show' | 'hide';
};

type ModelKey = {
  providerID: string;
  modelID: string;
};

type ModelVisibilityStore = {
  user: ModelVisibilityEntry[];
  recent: ModelKey[];
  variant: Record<string, string>;
};

function createEmptyStore(): ModelVisibilityStore {
  return { user: [], recent: [], variant: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isModelKey(value: unknown): value is ModelKey {
  return (
    isRecord(value) &&
    typeof value.providerID === 'string' &&
    value.providerID.length > 0 &&
    typeof value.modelID === 'string' &&
    value.modelID.length > 0
  );
}

function isModelVisibilityEntry(value: unknown): value is ModelVisibilityEntry {
  if (!isModelKey(value) || !('visibility' in value)) return false;
  return value.visibility === 'show' || value.visibility === 'hide';
}

function parseUserEntries(value: unknown) {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(isModelVisibilityEntry) ? value : null;
}

function parseRecentEntries(value: unknown) {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(isModelKey) ? value : null;
}

function parseVariants(value: unknown) {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    return null;
  }
  return Object.fromEntries(entries);
}

function parseStore(raw: string | null): ModelVisibilityStore | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const user = parseUserEntries(value.user);
    const recent = parseRecentEntries(value.recent);
    const variant = parseVariants(value.variant);
    return user && recent && variant ? { user, recent, variant } : null;
  } catch {
    return null;
  }
}

export function modelVisibilityKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`;
}

function parseModelKey(value: string) {
  const normalized = value.trim();
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return null;
  const providerID = normalized.slice(0, slashIndex).trim();
  const modelID = normalized.slice(slashIndex + 1).trim();
  return providerID && modelID ? { providerID, modelID } : null;
}

function parseLegacyHiddenModels(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string'))].sort()
      : [];
  } catch {
    return [];
  }
}

export function readHiddenModelsFromStorage() {
  const currentStore = parseStore(storageGet(StorageKeys.settings.modelVisibility));
  if (currentStore) {
    return [
      ...new Set(
        currentStore.user
          .filter((entry) => entry.visibility === 'hide')
          .map((entry) => modelVisibilityKey(entry.providerID, entry.modelID)),
      ),
    ].sort();
  }
  return parseLegacyHiddenModels(storageGet(StorageKeys.settings.disabledModels));
}

export function writeHiddenModelsToStorage(nextHiddenModels: string[]) {
  const stored = storageGet(StorageKeys.settings.modelVisibility);
  const store = stored === null ? createEmptyStore() : parseStore(stored);
  if (!store) return false;
  const hiddenSet = new Set(nextHiddenModels);
  const existingEntries = new Map(
    store.user.map((entry) => [modelVisibilityKey(entry.providerID, entry.modelID), entry]),
  );
  const preservedUser = store.user.filter(
    (entry) =>
      entry.visibility !== 'hide' &&
      !hiddenSet.has(modelVisibilityKey(entry.providerID, entry.modelID)),
  );
  const hiddenEntries = [...hiddenSet]
    .sort()
    .map((key) => {
      const existing = existingEntries.get(key);
      if (existing) return { ...existing, visibility: 'hide' as const };
      const entry = parseModelKey(key);
      return entry ? { ...entry, visibility: 'hide' as const } : null;
    })
    .filter((entry) => entry !== null);
  const saved = storageSet(
    StorageKeys.settings.modelVisibility,
    JSON.stringify({ ...store, user: [...preservedUser, ...hiddenEntries] }),
  );
  if (saved) storageRemove(StorageKeys.settings.disabledModels);
  return saved;
}
