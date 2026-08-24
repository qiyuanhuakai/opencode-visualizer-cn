import { StorageKeys, storageGet, storageRemove, storageSet } from './storageKeys';

export type ModelVisibilityEntry = {
  providerID: string;
  modelID: string;
  visibility: 'show' | 'hide';
};

type ModelVisibilityStore = {
  user: ModelVisibilityEntry[];
  recent: string[];
  variant: Record<string, string>;
};

function createEmptyStore(): ModelVisibilityStore {
  return { user: [], recent: [], variant: {} };
}

function isModelVisibilityEntry(value: unknown): value is ModelVisibilityEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.providerID === 'string' &&
    entry.providerID.length > 0 &&
    typeof entry.modelID === 'string' &&
    entry.modelID.length > 0 &&
    (entry.visibility === 'show' || entry.visibility === 'hide')
  );
}

function parseUserEntries(value: unknown) {
  return Array.isArray(value) ? value.filter(isModelVisibilityEntry) : [];
}

function parseRecentEntries(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function parseVariants(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function parseStore(raw: string | null): ModelVisibilityStore | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const parsed = value as Partial<ModelVisibilityStore>;
    return {
      user: parseUserEntries(parsed.user),
      recent: parseRecentEntries(parsed.recent),
      variant: parseVariants(parsed.variant),
    };
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
  const store = parseStore(storageGet(StorageKeys.settings.modelVisibility)) ?? createEmptyStore();
  const hiddenSet = new Set(nextHiddenModels);
  const preservedUser = store.user.filter(
    (entry) => !hiddenSet.has(modelVisibilityKey(entry.providerID, entry.modelID)),
  );
  const hiddenEntries = [...hiddenSet]
    .sort()
    .map(parseModelKey)
    .filter((entry): entry is { providerID: string; modelID: string } => Boolean(entry))
    .map((entry) => ({ ...entry, visibility: 'hide' as const }));
  const saved = storageSet(
    StorageKeys.settings.modelVisibility,
    JSON.stringify({ ...store, user: [...preservedUser, ...hiddenEntries] }),
  );
  if (saved) storageRemove(StorageKeys.settings.disabledModels);
  return saved;
}
