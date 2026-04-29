import { ref, computed } from 'vue';
import {
  StorageKeys,
  storageGet,
  storageKey,
  storageRemove,
  storageSet,
} from '../utils/storageKeys';
import type { BackendKind } from '../backends/types';
import { DEFAULT_CODEX_BRIDGE_URL } from '../backends/registry';

type Credentials = {
  url: string;
  username: string;
  password: string;
};

const LEGACY_CREDENTIALS_STORAGE_KEY = 'credentials.v1';

const url = ref('');
const username = ref('');
const password = ref('');
const backendKind = ref<BackendKind>('opencode');
const codexBridgeUrl = ref(DEFAULT_CODEX_BRIDGE_URL);
const codexBridgeToken = ref('');

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
    if (backendKind.value === 'codex') return codexBridgeUrl.value.trim().length > 0;
    return url.value.trim().length > 0;
  });

  function saveBackendKind(kind: BackendKind) {
    backendKind.value = kind;
    storageSet(StorageKeys.auth.backendKind, kind);
  }

  function save(newUrl: string, newUsername: string, newPassword: string) {
    saveBackendKind('opencode');
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

  function saveCodex(newBridgeUrl: string, newBridgeToken: string) {
    saveBackendKind('codex');
    codexBridgeUrl.value = newBridgeUrl;
    codexBridgeToken.value = newBridgeToken;

    storageSet(StorageKeys.auth.codexBridgeUrl, newBridgeUrl);
    if (newBridgeToken.trim()) {
      storageSet(StorageKeys.auth.codexBridgeToken, newBridgeToken);
    } else {
      storageRemove(StorageKeys.auth.codexBridgeToken);
    }
  }

  function load() {
    if (typeof window === 'undefined') return;

    try {
      const storedCredentials =
        parseStoredCredentials(storageGet(StorageKeys.auth.credentials)) ?? migrateLegacyCredentials();
      const storedUrl = storageGet(StorageKeys.auth.serverUrl) ?? storedCredentials?.url ?? '';
      const storedBackendKind = storageGet(StorageKeys.auth.backendKind);

      if (!storageGet(StorageKeys.auth.serverUrl) && storedUrl) {
        storageSet(StorageKeys.auth.serverUrl, storedUrl);
      }

      applyCredentials({
        url: storedUrl,
        username: storedCredentials?.username ?? '',
        password: storedCredentials?.password ?? '',
      });
      backendKind.value = storedBackendKind === 'codex' ? 'codex' : 'opencode';
      codexBridgeUrl.value = storageGet(StorageKeys.auth.codexBridgeUrl) ?? DEFAULT_CODEX_BRIDGE_URL;
      codexBridgeToken.value = storageGet(StorageKeys.auth.codexBridgeToken) ?? '';
    } catch {
      return;
    }
  }

  function clear() {
    const preservedUrl = url.value;
    const preservedBackendKind = backendKind.value;
    const preservedCodexUrl = codexBridgeUrl.value;
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
      if (preservedBackendKind === 'codex') {
        storageSet(StorageKeys.auth.codexBridgeUrl, preservedCodexUrl);
        storageRemove(StorageKeys.auth.codexBridgeToken);
      }
    } catch {
      return;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === storageKey(StorageKeys.auth.backendKind)) {
        backendKind.value = event.newValue === 'codex' ? 'codex' : 'opencode';
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.codexBridgeUrl)) {
        codexBridgeUrl.value = event.newValue ?? DEFAULT_CODEX_BRIDGE_URL;
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.codexBridgeToken)) {
        codexBridgeToken.value = event.newValue ?? '';
        return;
      }

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
    backendKind,
    codexBridgeUrl,
    codexBridgeToken,
    authHeader,
    baseUrl,
    isConfigured,
    save,
    saveBackendKind,
    saveCodex,
    load,
    clear,
  };
}
