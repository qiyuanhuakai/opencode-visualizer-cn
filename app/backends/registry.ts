import { createOpenCodeAdapter } from './openCodeAdapter';
import { createCodexAdapter } from './codex/codexAdapter';
import { appendCodexBridgeToken } from './codex/bridgeUrl';
import { createAcpAdapter } from './acp/acpAdapter';
import { acpBridgeWebSocketUrl, normalizeAcpBridgeUrl } from './acp/bridgeUrl';
import {
  createKimiWebAdapter,
  KIMI_WEB_CAPABILITIES,
} from './kimiWeb/kimiWebAdapter';
import type { BackendAdapter, BackendKind } from './types';
import { StorageKeys, storageGet } from '../utils/storageKeys';

export const DEFAULT_CODEX_BRIDGE_URL = 'ws://localhost:23004/codex';
export const DEFAULT_ACP_BRIDGE_URL = 'ws://localhost:23004';
export const DEFAULT_KIMI_WEB_BRIDGE_URL = 'ws://localhost:23004/kimi-web/ws';

// Only bits with a measured basis in docs/kimi.md are enabled. Actions that Todo 21
// gates behind runtime probing (fork/compact/undo, tasks, terminal) stay off.
export { KIMI_WEB_CAPABILITIES };

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

export function kimiWebBridgeHttpUrl(bridgeUrl: string) {
  const parsed = new URL(bridgeUrl);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else {
    throw new Error(`Unsupported Kimi Web bridge URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function getPersistedAcpBridgeToken() {
  const value = storageGet(StorageKeys.auth.acpBridgeToken);
  if (value !== null) return value;
  return storageGet(StorageKeys.auth.backendKind) === 'acp' ? getPersistedCodexBridgeToken() : '';
}

let acpAdapter: ReturnType<typeof createAcpAdapter> | undefined;
let acpAdapterKey = '';
let kimiWebAdapter: ReturnType<typeof createKimiWebAdapter> | undefined;
let kimiWebAdapterKey = '';
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
  'kimi-web': undefined,
};

let activeBackendKind: BackendKind = 'opencode';

export function getActiveBackendKind() {
  return activeBackendKind;
}

export function setActiveBackendKind(kind: BackendKind) {
  if (!adapters[kind]) {
    throw new Error(`Backend adapter is not registered: ${kind}`);
  }
  activeBackendKind = kind;
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

export function configureKimiWebBackend(options: { bridgeUrl: string; bridgeToken?: string }) {
  const bridgeUrl = options.bridgeUrl.trim();
  if (!bridgeUrl) throw new Error('Kimi Web bridge URL is required.');
  kimiWebBridgeHttpUrl(bridgeUrl);
  const bridgeToken = options.bridgeToken?.trim() ?? '';
  const nextKey = JSON.stringify([bridgeUrl, bridgeToken]);
  if (kimiWebAdapter && kimiWebAdapterKey === nextKey) return kimiWebAdapter;
  kimiWebAdapter = createKimiWebAdapter({ bridgeUrl, bridgeToken });
  kimiWebAdapterKey = nextKey;
  adapters = { ...adapters, 'kimi-web': kimiWebAdapter };
  return kimiWebAdapter;
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
