import { createOpenCodeAdapter } from './openCodeAdapter';
import type { BackendAdapter, BackendKind } from './types';

const adapters: Record<BackendKind, BackendAdapter | undefined> = {
  opencode: createOpenCodeAdapter(),
  codex: undefined,
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
