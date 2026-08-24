export const STORAGE_PREFIX = 'opencode.';

export type StorageBackend = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => boolean | void;
  removeItem: (key: string) => boolean | void;
  update?: (entries: Record<string, string | null>) => boolean | void;
};

export type ElectronStorageBackend = StorageBackend & {
  migrate: (entries: Record<string, string>) => boolean;
  update: (entries: Record<string, string | null>) => boolean;
};

const MIGRATION_RETRY_MS = 1_000;
const SENSITIVE_STORAGE_KEYS = new Set([
  'opencode.credentials.v1',
  'opencode.auth.credentials.v1',
  'opencode.auth.codexBridgeToken.v1',
  'opencode.auth.acpBridgeToken.v1',
]);
let hasMigrated = false;
let nextAttemptAt = 0;

function readEntries(localStorage: Storage) {
  const entries: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  return entries;
}

function scheduleRetry(now: number) {
  nextAttemptAt = now + MIGRATION_RETRY_MS;
  return false;
}

export function migrateLocalStorageToElectronStorage(
  electronStorage: ElectronStorageBackend,
  localStorage: Storage,
) {
  if (hasMigrated) return true;
  const now = Date.now();
  if (now < nextAttemptAt) return false;
  try {
    const entries = readEntries(localStorage);
    if (!electronStorage.migrate(entries)) return scheduleRetry(now);

    for (const key of Object.keys(entries)) localStorage.removeItem(key);

    hasMigrated = true;
    nextAttemptAt = 0;
    return true;
  } catch {
    return scheduleRetry(now);
  }
}

export function pendingElectronMigrationBackend(
  electronStorage: ElectronStorageBackend,
  localStorage: Storage,
): StorageBackend {
  return {
    getItem: (key) => {
      const nativeValue = electronStorage.getItem(key);
      if (nativeValue !== null || SENSITIVE_STORAGE_KEYS.has(key)) return nativeValue;
      return localStorage.getItem(key);
    },
    setItem: () => false,
    removeItem: () => false,
    update: () => false,
  };
}
