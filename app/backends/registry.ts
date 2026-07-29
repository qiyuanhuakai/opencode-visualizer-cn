import { createOpenCodeAdapter } from './openCodeAdapter';
import { createCodexAdapter } from './codex/codexAdapter';
import { appendCodexBridgeToken } from './codex/bridgeUrl';
import { createAcpAdapter } from './acp/acpAdapter';
import { acpBridgeWebSocketUrl, normalizeAcpBridgeUrl } from './acp/bridgeUrl';
import type { BackendAdapter, BackendKind } from './types';
import { StorageKeys, storageGet } from '../utils/storageKeys';

export const DEFAULT_CODEX_BRIDGE_URL = 'ws://localhost:23004/codex';
export const DEFAULT_ACP_BRIDGE_URL = 'ws://localhost:23004';

export function getPersistedCodexBridgeUrl() {
  const value = storageGet(StorageKeys.auth.codexBridgeUrl)?.trim();
  return value || DEFAULT_CODEX_BRIDGE_URL;
}

export function getPersistedAcpBridgeUrl() {
  const value = storageGet(StorageKeys.auth.acpBridgeUrl)?.trim();
  if (value) return normalizeAcpBridgeUrl(value);
  if (storageGet(StorageKeys.auth.backendKind) !== 'acp') return DEFAULT_ACP_BRIDGE_URL;
  const legacyValue = storageGet(StorageKeys.auth.codexBridgeUrl)?.trim();
  return legacyValue ? normalizeAcpBridgeUrl(legacyValue) : DEFAULT_ACP_BRIDGE_URL;
}

export function getPersistedCodexBridgeToken() {
  return storageGet(StorageKeys.auth.codexBridgeToken) ?? '';
}

export function getPersistedAcpBridgeToken() {
  const value = storageGet(StorageKeys.auth.acpBridgeToken);
  if (value !== null) return value;
  return storageGet(StorageKeys.auth.backendKind) === 'acp' ? getPersistedCodexBridgeToken() : '';
}

export function getPersistedAcpAgentId() {
  return storageGet(StorageKeys.auth.acpAgentId)?.trim() ?? '';
}

let acpAdapter: ReturnType<typeof createAcpAdapter> | undefined;
let acpAdapterKey = '';
const initialCodexBridgeUrl = getPersistedCodexBridgeUrl();
const initialCodexBridgeToken = getPersistedCodexBridgeToken();
let codexAdapterKey = JSON.stringify([initialCodexBridgeUrl, initialCodexBridgeToken]);
let codexAdapter = createCodexAdapter({
  url: appendCodexBridgeToken(initialCodexBridgeUrl, initialCodexBridgeToken),
  experimentalApi: true,
});

let adapters: Record<BackendKind, BackendAdapter | undefined> = {
  opencode: createOpenCodeAdapter(),
  codex: codexAdapter,
  acp: acpAdapter,
};

let activeBackendKind: BackendKind = 'opencode';
const listeners = new Set<(kind: BackendKind) => void>();

export function getActiveBackendKind() {
  return activeBackendKind;
}

export function setActiveBackendKind(kind: BackendKind) {
  if (!adapters[kind]) {
    throw new Error(`Backend adapter is not registered: ${kind}`);
  }
  activeBackendKind = kind;
  listeners.forEach((listener) => listener(kind));
}

export function onActiveBackendKindChange(listener: (kind: BackendKind) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function configureOpenCodeBackend(options: { baseUrl?: string; authorization?: string }) {
  getBackendAdapter('opencode').configure?.(options);
}

export function configureCodexBackend(options: { bridgeUrl: string; bridgeToken?: string }) {
  const bridgeUrl = options.bridgeUrl.trim();
  if (!bridgeUrl) {
    throw new Error('Codex bridge URL is required.');
  }
  const bridgeToken = options.bridgeToken?.trim() ?? '';
  const nextKey = JSON.stringify([bridgeUrl, bridgeToken]);
  if (codexAdapterKey === nextKey) return codexAdapter;
  codexAdapter.disconnect();
  codexAdapter = createCodexAdapter({
    url: appendCodexBridgeToken(bridgeUrl, bridgeToken),
    experimentalApi: true,
  });
  codexAdapterKey = nextKey;
  adapters = {
    ...adapters,
    codex: codexAdapter,
  };
  return codexAdapter;
}

export function configureAcpBackend(options: {
  bridgeUrl: string;
  bridgeToken?: string;
  agentId: string;
}) {
  const bridgeUrl = options.bridgeUrl.trim();
  if (!bridgeUrl) throw new Error('ACP bridge URL is required.');
  const agentId = options.agentId.trim();
  if (!agentId) throw new Error('ACP agent ID is required.');
  const bridgeToken = options.bridgeToken?.trim() ?? '';
  const nextKey = JSON.stringify([bridgeUrl, bridgeToken, agentId]);
  if (acpAdapter && acpAdapterKey === nextKey) return acpAdapter;
  acpAdapter?.disconnect();
  acpAdapter = createAcpAdapter({
    url: acpBridgeWebSocketUrl(bridgeUrl, agentId, bridgeToken),
    bridgeUrl,
    bridgeToken,
    agentId,
  });
  acpAdapterKey = nextKey;
  adapters = {
    ...adapters,
    acp: acpAdapter,
  };
  return acpAdapter;
}

export function disconnectAcpBackend() {
  acpAdapter?.disconnect();
}

export function disconnectCodexBackend() {
  codexAdapter.disconnect();
}

export function getBackendAdapter(kind: BackendKind) {
  const adapter = adapters[kind];
  if (!adapter) {
    throw new Error(`Backend adapter is not registered: ${kind}`);
  }
  return adapter;
}

export function getActiveBackendAdapter() {
  return getBackendAdapter(activeBackendKind);
}
