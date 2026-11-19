// Legacy global backend routing — RETIRED from production (v0.9 task 48).
//
// Production code resolves an adapter through the explicit-kind accessor
// `getBackendAdapter(kind)`, with the kind carried by the active connection
// scope (the injected `activeBackendKind` ref every runtime consumer already
// receives). The module-global "active backend" indirection below is kept ONLY
// as the legacy export: it preserves the retired routing behavior verbatim so
// the registry lineage tests (app/backends/registry.*.test.ts) keep exercising
// exactly what was unwired, and so a reader can see the shape of the path that
// used to route every production action.
//
// INVARIANT (task 48 acceptance): nothing in production imports this module.
// The task-48 rg audit greps the whole repo for these symbols and accepts hits
// only in fixtures and in this legacy export.
import { getBackendAdapter } from './registry';
import type { BackendKind } from './types';

let activeBackendKind: BackendKind = 'opencode';

export function getActiveBackendKind() {
  return activeBackendKind;
}

export function setActiveBackendKind(kind: BackendKind) {
  // Preserves the retired fail-closed contract: an unregistered kind is
  // refused before the legacy global moves, with the registry's own error.
  getBackendAdapter(kind);
  activeBackendKind = kind;
}

export function getActiveBackendAdapter() {
  return getBackendAdapter(activeBackendKind);
}
