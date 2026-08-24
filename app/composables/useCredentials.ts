import { ref, computed } from 'vue';
import {
  StorageKeys,
  storageGet,
  storageKey,
  storageSet,
  storageUpdate,
} from '../utils/storageKeys';
import type { BackendKind } from '../backends/types';
import {
  DEFAULT_ACP_BRIDGE_URL,
  DEFAULT_CODEX_BRIDGE_URL,
  getPersistedAcpBridgeToken,
  getPersistedAcpBridgeUrl,
} from '../backends/registry';
import { normalizeAcpBridgeUrl } from '../backends/acp/bridgeUrl';
import {
  clearStoredCredentials,
  migrateLegacyCredentials,
  parseStoredCredentials,
  type StoredCredentials,
} from './credentialStorage';

type Credentials = StoredCredentials;

const url = ref('');
const username = ref('');
const password = ref('');
const backendKind = ref<BackendKind>('opencode');
const codexBridgeUrl = ref(DEFAULT_CODEX_BRIDGE_URL);
const acpBridgeUrl = ref(DEFAULT_ACP_BRIDGE_URL);
const codexBridgeToken = ref('');
const acpBridgeToken = ref('');
const acpAgentId = ref('');

function applyCredentials(next: Credentials) {
  url.value = next.url;
  username.value = next.username;
  password.value = next.password;
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
    if (backendKind.value === 'acp') {
      return acpBridgeUrl.value.trim().length > 0 && acpAgentId.value.trim().length > 0;
    }
    return url.value.trim().length > 0;
  });

  function saveBackendKind(kind: BackendKind) {
    if (typeof window !== 'undefined' && !storageSet(StorageKeys.auth.backendKind, kind)) {
      return false;
    }
    backendKind.value = kind;
    return true;
  }

  function save(newUrl: string, newUsername: string, newPassword: string) {
    const next: Credentials = {
      url: newUrl,
      username: newUsername,
      password: newPassword,
    };
    if (
      typeof window !== 'undefined' &&
      !storageUpdate({
        [StorageKeys.auth.backendKind]: 'opencode',
        [StorageKeys.auth.serverUrl]: newUrl,
        [StorageKeys.auth.credentials]: JSON.stringify(next),
      })
    ) {
      return false;
    }
    backendKind.value = 'opencode';
    applyCredentials(next);
    return true;
  }

  function saveCodex(newBridgeUrl: string, newBridgeToken: string) {
    if (
      typeof window !== 'undefined' &&
      !storageUpdate({
        [StorageKeys.auth.backendKind]: 'codex',
        [StorageKeys.auth.codexBridgeUrl]: newBridgeUrl,
        [StorageKeys.auth.codexBridgeToken]: newBridgeToken.trim() ? newBridgeToken : null,
      })
    ) {
      return false;
    }
    backendKind.value = 'codex';
    codexBridgeUrl.value = newBridgeUrl;
    codexBridgeToken.value = newBridgeToken;
    return true;
  }

  function saveAcp(newBridgeUrl: string, newBridgeToken: string, newAgentId: string) {
    const agentId = newAgentId.trim();
    if (!agentId) throw new Error('ACP agent ID is required.');
    const bridgeUrl = normalizeAcpBridgeUrl(newBridgeUrl);
    if (
      typeof window !== 'undefined' &&
      !storageUpdate({
        [StorageKeys.auth.backendKind]: 'acp',
        [StorageKeys.auth.acpBridgeUrl]: bridgeUrl,
        [StorageKeys.auth.acpAgentId]: agentId,
        [StorageKeys.auth.acpBridgeToken]: newBridgeToken.trim() ? newBridgeToken : null,
      })
    ) {
      return false;
    }
    backendKind.value = 'acp';
    acpBridgeUrl.value = bridgeUrl;
    acpBridgeToken.value = newBridgeToken;
    acpAgentId.value = agentId;
    return true;
  }

  function load() {
    if (typeof window === 'undefined') return;

    try {
      const storedCredentials =
        parseStoredCredentials(storageGet(StorageKeys.auth.credentials)) ??
        migrateLegacyCredentials();
      const storedUrl = storageGet(StorageKeys.auth.serverUrl) ?? storedCredentials?.url ?? '';
      const storedBackendKind = storageGet(StorageKeys.auth.backendKind);
      const storedAcpAgentId = storageGet(StorageKeys.auth.acpAgentId)?.trim() ?? '';

      if (!storageGet(StorageKeys.auth.serverUrl) && storedUrl) {
        storageSet(StorageKeys.auth.serverUrl, storedUrl);
      }

      applyCredentials({
        url: storedUrl,
        username: storedCredentials?.username ?? '',
        password: storedCredentials?.password ?? '',
      });
      backendKind.value =
        storedBackendKind === 'codex' || (storedBackendKind === 'acp' && storedAcpAgentId)
          ? storedBackendKind
          : 'opencode';
      codexBridgeUrl.value =
        storageGet(StorageKeys.auth.codexBridgeUrl) ?? DEFAULT_CODEX_BRIDGE_URL;
      acpBridgeUrl.value = getPersistedAcpBridgeUrl();
      acpBridgeToken.value = getPersistedAcpBridgeToken();
      if (!storageGet(StorageKeys.auth.acpBridgeUrl)) {
        storageSet(StorageKeys.auth.acpBridgeUrl, acpBridgeUrl.value);
      }
      if (
        storedBackendKind === 'acp' &&
        !storageGet(StorageKeys.auth.acpBridgeToken) &&
        acpBridgeToken.value
      ) {
        storageSet(StorageKeys.auth.acpBridgeToken, acpBridgeToken.value);
      }
      codexBridgeToken.value = storageGet(StorageKeys.auth.codexBridgeToken) ?? '';
      acpAgentId.value = storedAcpAgentId;
    } catch {
      return;
    }
  }

  function clear() {
    const preservedUrl = url.value;
    const preservedBackendKind = backendKind.value;
    const preservedCodexUrl = codexBridgeUrl.value;
    const preservedAcpUrl = acpBridgeUrl.value;
    if (typeof window === 'undefined') {
      username.value = '';
      password.value = '';
      return true;
    }

    try {
      const entries: Record<string, string | null> = {
        [StorageKeys.auth.serverUrl]: preservedUrl.trim() ? preservedUrl : null,
      };
      if (preservedBackendKind === 'codex') {
        entries[StorageKeys.auth.codexBridgeUrl] = preservedCodexUrl;
        entries[StorageKeys.auth.codexBridgeToken] = null;
      }
      if (preservedBackendKind === 'acp') {
        entries[StorageKeys.auth.acpBridgeUrl] = preservedAcpUrl;
        entries[StorageKeys.auth.acpBridgeToken] = null;
      }
      if (!clearStoredCredentials(entries)) return false;
    } catch {
      return false;
    }
    url.value = preservedUrl;
    username.value = '';
    password.value = '';
    if (preservedBackendKind === 'codex') codexBridgeToken.value = '';
    if (preservedBackendKind === 'acp') acpBridgeToken.value = '';
    return true;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === storageKey(StorageKeys.auth.backendKind)) {
        backendKind.value =
          event.newValue === 'codex' || event.newValue === 'acp' ? event.newValue : 'opencode';
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.codexBridgeUrl)) {
        codexBridgeUrl.value = event.newValue ?? DEFAULT_CODEX_BRIDGE_URL;
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.acpBridgeUrl)) {
        acpBridgeUrl.value = event.newValue
          ? normalizeAcpBridgeUrl(event.newValue)
          : DEFAULT_ACP_BRIDGE_URL;
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.codexBridgeToken)) {
        codexBridgeToken.value = event.newValue ?? '';
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.acpBridgeToken)) {
        acpBridgeToken.value = event.newValue ?? '';
        return;
      }

      if (event.key === storageKey(StorageKeys.auth.acpAgentId)) {
        acpAgentId.value = event.newValue ?? '';
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
    acpBridgeUrl,
    codexBridgeToken,
    acpBridgeToken,
    acpAgentId,
    authHeader,
    baseUrl,
    isConfigured,
    save,
    saveBackendKind,
    saveCodex,
    saveAcp,
    load,
    clear,
  };
}
