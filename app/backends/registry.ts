import { createOpenCodeAdapter } from './openCodeAdapter';
import { createCodexAdapter } from './codex/codexAdapter';
import type { BackendAdapter, BackendKind } from './types';
import { StorageKeys, storageGet, storageRemove, storageSet } from '../utils/storageKeys';

export const DEFAULT_CODEX_BRIDGE_URL = 'ws://localhost:23004/codex';

export function getPersistedCodexBridgeUrl() {
  const value = storageGet(StorageKeys.auth.codexBridgeUrl)?.trim();
  return value || DEFAULT_CODEX_BRIDGE_URL;
}

export function getPersistedCodexBridgeToken() {
  return storageGet(StorageKeys.auth.codexBridgeToken) ?? '';
}

function appendCodexBridgeToken(url: string, token?: string) {
  const trimmedToken = token?.trim();
  if (!trimmedToken) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', trimmedToken);
  return parsed.toString();
}

let adapters: Record<BackendKind, BackendAdapter | undefined> = {
  opencode: createOpenCodeAdapter(),
  codex: createCodexAdapter({
    url: appendCodexBridgeToken(getPersistedCodexBridgeUrl(), getPersistedCodexBridgeToken()),
  }),
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
  storageSet(StorageKeys.auth.codexBridgeUrl, bridgeUrl);
  if (bridgeToken) storageSet(StorageKeys.auth.codexBridgeToken, bridgeToken);
  else storageRemove(StorageKeys.auth.codexBridgeToken);
  adapters = {
    ...adapters,
    codex: createCodexAdapter({ url: appendCodexBridgeToken(bridgeUrl, bridgeToken) }),
  };
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
