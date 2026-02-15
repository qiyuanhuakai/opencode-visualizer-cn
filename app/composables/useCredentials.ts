import { ref, computed } from 'vue';
import { StorageKeys, storageGet, storageKey, storageRemove, storageSet } from '../utils/storageKeys';

type Credentials = {
  url: string;
  username: string;
  password: string;
};

const url = ref('');
const username = ref('');
const password = ref('');

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
    url.value = newUrl;
    username.value = newUsername;
    password.value = newPassword;

    if (typeof window === 'undefined') return;
    
    try {
      const data: Credentials = {
        url: newUrl,
        username: newUsername,
        password: newPassword,
      };
      storageSet(StorageKeys.auth.credentials, JSON.stringify(data));
    } catch {
      return;
    }
  }

  function load() {
    if (typeof window === 'undefined') return;

    try {
      const raw = storageGet(StorageKeys.auth.credentials);
      if (!raw) return;

      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== 'object') return;

      const record = data as Record<string, unknown>;
      const loadedUrl = typeof record.url === 'string' ? record.url : '';
      const loadedUsername = typeof record.username === 'string' ? record.username : '';
      const loadedPassword = typeof record.password === 'string' ? record.password : '';

      url.value = loadedUrl;
      username.value = loadedUsername;
      password.value = loadedPassword;
    } catch {
      return;
    }
  }

  function clear() {
    url.value = '';
    username.value = '';
    password.value = '';

    if (typeof window === 'undefined') return;

    try {
      storageRemove(StorageKeys.auth.credentials);
    } catch {
      return;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== storageKey(StorageKeys.auth.credentials)) return;
      
      if (!event.newValue) {
        url.value = '';
        username.value = '';
        password.value = '';
        return;
      }

      try {
        const data = JSON.parse(event.newValue) as unknown;
        if (!data || typeof data !== 'object') return;

        const record = data as Record<string, unknown>;
        const loadedUrl = typeof record.url === 'string' ? record.url : '';
        const loadedUsername = typeof record.username === 'string' ? record.username : '';
        const loadedPassword = typeof record.password === 'string' ? record.password : '';

        url.value = loadedUrl;
        username.value = loadedUsername;
        password.value = loadedPassword;
      } catch {
        return;
      }
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
