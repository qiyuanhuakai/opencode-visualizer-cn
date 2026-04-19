import { ref, computed } from 'vue';
import {
  StorageKeys,
  storageGet,
  storageKey,
  storageRemove,
  storageSet,
} from '../utils/storageKeys';

type Credentials = {
  url: string;
  username: string;
  password: string;
};

const LEGACY_CREDENTIALS_STORAGE_KEY = 'credentials.v1';

const url = ref('');
const username = ref('');
const password = ref('');

function applyCredentials(next: Credentials) {
  url.value = next.url;
  username.value = next.username;
  password.value = next.password;
}

function parseStoredCredentials(raw: string | null): Credentials | null {
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

function migrateLegacyCredentials() {
  const legacy = parseStoredCredentials(storageGet(LEGACY_CREDENTIALS_STORAGE_KEY));
  if (!legacy) return null;

  const normalizedUrl = legacy.url.trim();
  const next: Credentials = {
    url: normalizedUrl,
    username: legacy.username,
    password: legacy.password,
  };

  if (normalizedUrl) {
    storageSet(StorageKeys.auth.serverUrl, normalizedUrl);
  }
  storageSet(StorageKeys.auth.credentials, JSON.stringify(next));
  storageRemove(LEGACY_CREDENTIALS_STORAGE_KEY);
  return next;
}

export function useCredentials() {
  const authHeader = computed(() => {
    const u = username.value.trim();
    const p = password.value.trim();
    if (!u && !p) return undefined;
    const credentials = `${u}:${p}`;
    return `Basic ${btoa(credentials)}`;
  });

  const baseUrl = computed(() => {
    return url.value.replace(/\/+$/, '');
  });

  const isConfigured = computed(() => {
    return url.value.trim().length > 0;
  });

  function save(newUrl: string, newUsername: string, newPassword: string) {
    applyCredentials({
      url: newUrl,
      username: newUsername,
      password: newPassword,
    });

    if (typeof window === 'undefined') return;

    try {
      const data: Credentials = {
        url: newUrl,
        username: newUsername,
        password: newPassword,
      };
      storageSet(StorageKeys.auth.serverUrl, newUrl);
      storageSet(StorageKeys.auth.credentials, JSON.stringify(data));
    } catch {
      return;
    }
  }

  function load() {
    if (typeof window === 'undefined') return;

    try {
      const storedCredentials =
        parseStoredCredentials(storageGet(StorageKeys.auth.credentials)) ?? migrateLegacyCredentials();
      const storedUrl = storageGet(StorageKeys.auth.serverUrl) ?? storedCredentials?.url ?? '';

      if (!storageGet(StorageKeys.auth.serverUrl) && storedUrl) {
        storageSet(StorageKeys.auth.serverUrl, storedUrl);
      }

      applyCredentials({
        url: storedUrl,
        username: storedCredentials?.username ?? '',
        password: storedCredentials?.password ?? '',
      });
    } catch {
      return;
    }
  }

  function clear() {
    const preservedUrl = url.value;
    url.value = preservedUrl;
    username.value = '';
    password.value = '';

    if (typeof window === 'undefined') return;

    try {
      if (preservedUrl.trim()) {
        storageSet(StorageKeys.auth.serverUrl, preservedUrl);
      } else {
        storageRemove(StorageKeys.auth.serverUrl);
      }
      storageRemove(StorageKeys.auth.credentials);
    } catch {
      return;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === storageKey(StorageKeys.auth.serverUrl)) {
        url.value = event.newValue ?? '';
        return;
      }

      if (event.key !== storageKey(StorageKeys.auth.credentials)) return;

      if (!event.newValue) {
        username.value = '';
        password.value = '';
        const storedUrl = storageGet(StorageKeys.auth.serverUrl);
        url.value = storedUrl ?? '';
        return;
      }

      const next = parseStoredCredentials(event.newValue);
      if (!next) return;
      applyCredentials(next);
    });
  }

  return {
    url,
    username,
    password,
    authHeader,
    baseUrl,
    isConfigured,
    save,
    load,
    clear,
  };
}
