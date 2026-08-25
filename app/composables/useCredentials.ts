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
import { runCredentialMutationExclusive } from '../utils/credentialCleanup';
import {
  clearStoredCredentials,
  migrateLegacyCredentials,
  parseStoredCredentials,
  saveStoredCredentials,
  type StoredCredentials,
} from './credentialStorage';

type Credentials = StoredCredentials;

type CredentialSnapshot = {
  credentials: Credentials;
  backendKind: BackendKind;
  storedBackendKind: string | null;
  storedServerUrl: string | null;
  storedAcpBridgeUrl: string | null;
  storedAcpBridgeToken: string | null;
  codexBridgeUrl: string;
  acpBridgeUrl: string;
  codexBridgeToken: string;
  acpBridgeToken: string;
  acpAgentId: string;
  credentialRevision: string | null;
};

const url = ref('');
const username = ref('');
const password = ref('');
const backendKind = ref<BackendKind>('opencode');
const codexBridgeUrl = ref(DEFAULT_CODEX_BRIDGE_URL);
const acpBridgeUrl = ref(DEFAULT_ACP_BRIDGE_URL);
const codexBridgeToken = ref('');
const acpBridgeToken = ref('');
const acpAgentId = ref('');
const credentialRevision = ref<string | null>(null);
const AUTH_STORAGE_EVENT_KEYS = new Set(Object.values(StorageKeys.auth).map(storageKey));

function applyCredentials(next: Credentials) {
  url.value = next.url;
  username.value = next.username;
  password.value = next.password;
}

function createCredentialRevision() {
  return globalThis.crypto.randomUUID();
}

function resolveBackendKind(
  storedBackendKind: string | null,
  storedAcpAgentId: string,
): BackendKind {
  if (storedBackendKind === 'codex') return 'codex';
  if (storedBackendKind === 'acp' && storedAcpAgentId) return 'acp';
  return 'opencode';
}

function resolveStoredCredentials(allowLegacyMigration: boolean) {
  const storedCredentials = parseStoredCredentials(storageGet(StorageKeys.auth.credentials));
  if (storedCredentials || !allowLegacyMigration) return storedCredentials;
  return migrateLegacyCredentials();
}

function resolveOpenCodeCredentials(
  storedCredentials: StoredCredentials | null,
  storedServerUrl: string | null,
): Credentials {
  return {
    url: storedServerUrl ?? storedCredentials?.url ?? '',
    username: storedCredentials?.username ?? '',
    password: storedCredentials?.password ?? '',
  };
}

function storedValueOrDefault(value: string | null, fallback: string) {
  return value ?? fallback;
}

function trimmedStoredValue(value: string | null) {
  return value?.trim() ?? '';
}

function readCredentialSnapshot(allowLegacyMigration: boolean): CredentialSnapshot {
  const storedCredentials = resolveStoredCredentials(allowLegacyMigration);
  const storedBackendKind = storageGet(StorageKeys.auth.backendKind);
  const storedServerUrl = storageGet(StorageKeys.auth.serverUrl);
  const storedAcpBridgeUrl = storageGet(StorageKeys.auth.acpBridgeUrl);
  const storedAcpBridgeToken = storageGet(StorageKeys.auth.acpBridgeToken);
  const storedAcpAgentId = trimmedStoredValue(storageGet(StorageKeys.auth.acpAgentId));
  return {
    credentials: resolveOpenCodeCredentials(storedCredentials, storedServerUrl),
    backendKind: resolveBackendKind(storedBackendKind, storedAcpAgentId),
    storedBackendKind,
    storedServerUrl,
    storedAcpBridgeUrl,
    storedAcpBridgeToken,
    codexBridgeUrl: storedValueOrDefault(
      storageGet(StorageKeys.auth.codexBridgeUrl),
      DEFAULT_CODEX_BRIDGE_URL,
    ),
    acpBridgeUrl: getPersistedAcpBridgeUrl(),
    codexBridgeToken: storedValueOrDefault(storageGet(StorageKeys.auth.codexBridgeToken), ''),
    acpBridgeToken: getPersistedAcpBridgeToken(),
    acpAgentId: storedAcpAgentId,
    credentialRevision: storageGet(StorageKeys.auth.credentialRevision),
  };
}

function persistServerUrlDefault(snapshot: CredentialSnapshot) {
  if (!snapshot.storedServerUrl && snapshot.credentials.url) {
    storageSet(StorageKeys.auth.serverUrl, snapshot.credentials.url);
  }
}

function persistAcpDefaults(snapshot: CredentialSnapshot) {
  if (
    snapshot.storedBackendKind === 'acp' &&
    !snapshot.storedAcpBridgeToken &&
    snapshot.acpBridgeToken
  ) {
    storageSet(StorageKeys.auth.acpBridgeToken, snapshot.acpBridgeToken);
  }
  if (!snapshot.storedAcpBridgeUrl) {
    storageSet(StorageKeys.auth.acpBridgeUrl, snapshot.acpBridgeUrl);
  }
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
    const nextRevision = createCredentialRevision();
    if (
      typeof window !== 'undefined' &&
      !storageUpdate({
        [StorageKeys.auth.backendKind]: kind,
        [StorageKeys.auth.credentialRevision]: nextRevision,
      })
    ) {
      return false;
    }
    credentialRevision.value = nextRevision;
    backendKind.value = kind;
    return true;
  }

  function save(newUrl: string, newUsername: string, newPassword: string) {
    const next: Credentials = {
      url: newUrl,
      username: newUsername,
      password: newPassword,
    };
    const nextRevision = createCredentialRevision();
    if (
      typeof window !== 'undefined' &&
      !saveStoredCredentials(next, {
        [StorageKeys.auth.backendKind]: 'opencode',
        [StorageKeys.auth.credentialRevision]: nextRevision,
      })
    ) {
      return false;
    }
    credentialRevision.value = nextRevision;
    backendKind.value = 'opencode';
    applyCredentials(next);
    return true;
  }

  function saveCodex(newBridgeUrl: string, newBridgeToken: string) {
    const nextRevision = createCredentialRevision();
    if (
      typeof window !== 'undefined' &&
      !storageUpdate({
        [StorageKeys.auth.backendKind]: 'codex',
        [StorageKeys.auth.codexBridgeUrl]: newBridgeUrl,
        [StorageKeys.auth.codexBridgeToken]: newBridgeToken.trim() ? newBridgeToken : null,
        [StorageKeys.auth.credentialRevision]: nextRevision,
      })
    ) {
      return false;
    }
    credentialRevision.value = nextRevision;
    backendKind.value = 'codex';
    codexBridgeUrl.value = newBridgeUrl;
    codexBridgeToken.value = newBridgeToken;
    return true;
  }

  function saveAcp(newBridgeUrl: string, newBridgeToken: string, newAgentId: string) {
    const agentId = newAgentId.trim();
    if (!agentId) throw new Error('ACP agent ID is required.');
    const bridgeUrl = normalizeAcpBridgeUrl(newBridgeUrl);
    const nextRevision = createCredentialRevision();
    if (
      typeof window !== 'undefined' &&
      !storageUpdate({
        [StorageKeys.auth.backendKind]: 'acp',
        [StorageKeys.auth.acpBridgeUrl]: bridgeUrl,
        [StorageKeys.auth.acpAgentId]: agentId,
        [StorageKeys.auth.acpBridgeToken]: newBridgeToken.trim() ? newBridgeToken : '',
        [StorageKeys.auth.credentialRevision]: nextRevision,
      })
    ) {
      return false;
    }
    credentialRevision.value = nextRevision;
    backendKind.value = 'acp';
    acpBridgeUrl.value = bridgeUrl;
    acpBridgeToken.value = newBridgeToken;
    acpAgentId.value = agentId;
    return true;
  }

  function applyCredentialSnapshot(snapshot: CredentialSnapshot) {
    applyCredentials(snapshot.credentials);
    codexBridgeUrl.value = snapshot.codexBridgeUrl;
    acpBridgeUrl.value = snapshot.acpBridgeUrl;
    codexBridgeToken.value = snapshot.codexBridgeToken;
    acpBridgeToken.value = snapshot.acpBridgeToken;
    acpAgentId.value = snapshot.acpAgentId;
    backendKind.value = snapshot.backendKind;
    credentialRevision.value = snapshot.credentialRevision;
  }

  function load() {
    if (typeof window === 'undefined') return Promise.resolve();

    return runCredentialMutationExclusive(() => {
      try {
        const snapshot = readCredentialSnapshot(true);
        persistServerUrlDefault(snapshot);
        applyCredentialSnapshot(snapshot);
        persistAcpDefaults(snapshot);
      } catch {
        return;
      }
    });
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
      const nextRevision = createCredentialRevision();
      const entries: Record<string, string | null> = {
        [StorageKeys.auth.serverUrl]: preservedUrl.trim() ? preservedUrl : null,
        [StorageKeys.auth.credentialRevision]: nextRevision,
      };
      if (preservedBackendKind === 'codex') {
        entries[StorageKeys.auth.codexBridgeUrl] = preservedCodexUrl;
        entries[StorageKeys.auth.codexBridgeToken] = null;
      }
      if (preservedBackendKind === 'acp') {
        entries[StorageKeys.auth.acpBridgeUrl] = preservedAcpUrl;
        entries[StorageKeys.auth.acpBridgeToken] = '';
      }
      if (!clearStoredCredentials(entries)) return false;
      credentialRevision.value = nextRevision;
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

  function getRevision() {
    return storageGet(StorageKeys.auth.credentialRevision);
  }

  function clearIfRevision(
    expectedRevision: string | null,
  ): 'cleared' | 'already-cleared' | 'failed' | 'stale' {
    if (getRevision() !== expectedRevision) {
      const storedBackendKind = storageGet(StorageKeys.auth.backendKind);
      const isOpenCodeTombstone =
        (storedBackendKind === null || storedBackendKind === 'opencode') &&
        storageGet(StorageKeys.auth.credentials) === null;
      return isOpenCodeTombstone ? 'already-cleared' : 'stale';
    }
    return clear() ? 'cleared' : 'failed';
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key && AUTH_STORAGE_EVENT_KEYS.has(event.key)) {
        void runCredentialMutationExclusive(() =>
          applyCredentialSnapshot(readCredentialSnapshot(false)),
        );
      }
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
    credentialRevision,
    authHeader,
    baseUrl,
    isConfigured,
    save,
    saveBackendKind,
    saveCodex,
    saveAcp,
    load,
    clear,
    clearIfRevision,
    getRevision,
  };
}
