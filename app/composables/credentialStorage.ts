import { StorageKeys, storageGet, storageUpdate } from '../utils/storageKeys';

export type StoredCredentials = {
  url: string;
  username: string;
  password: string;
};

const LEGACY_CREDENTIALS_STORAGE_KEY = 'credentials.v1';

export function parseStoredCredentials(raw: string | null): StoredCredentials | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    return {
      url: typeof record.url === 'string' ? record.url : '',
      username: typeof record.username === 'string' ? record.username : '',
      password: typeof record.password === 'string' ? record.password : '',
    };
  } catch {
    return null;
  }
}

export function migrateLegacyCredentials() {
  const legacy = parseStoredCredentials(storageGet(LEGACY_CREDENTIALS_STORAGE_KEY));
  if (!legacy) return null;
  const next = {
    ...legacy,
    url: legacy.url.trim() || storageGet(StorageKeys.auth.serverUrl)?.trim() || '',
  };
  return saveStoredCredentials(next) ? next : null;
}

export function saveStoredCredentials(
  next: StoredCredentials,
  additionalEntries: Readonly<Record<string, string | null>> = {},
) {
  return storageUpdate({
    ...additionalEntries,
    [StorageKeys.auth.serverUrl]: next.url,
    [StorageKeys.auth.credentials]: JSON.stringify(next),
    [LEGACY_CREDENTIALS_STORAGE_KEY]: null,
  });
}

export function clearStoredCredentials(
  additionalEntries: Readonly<Record<string, string | null>> = {},
) {
  return storageUpdate({
    ...additionalEntries,
    [LEGACY_CREDENTIALS_STORAGE_KEY]: null,
    [StorageKeys.auth.credentials]: null,
  });
}
