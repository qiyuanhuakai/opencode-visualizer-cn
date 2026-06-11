import type { Ref } from 'vue';
import type { LocalPinnedSessionStore } from './pinnedSessions';
import { pinnedSessionStoreKey } from './pinnedSessions';
import { CODEX_PROJECT_ID } from '../composables/useCodexWorkspace';

const LEGACY_CODEX_PIN_STORAGE_KEY = 'vis.codex.pins.v1';

export type MigrateCodexPinsResult = {
  migrated: number;
  removed: boolean;
};

/**
 * Reads the legacy Codex pin storage and writes its entries into the unified
 * `localPinnedSessionStore` keyed by `pinnedSessionStoreKey(CODEX_PROJECT_ID, …)`.
 * Removes the legacy key on first call so the migration is one-way and idempotent.
 */
export function migrateCodexPinsToUnifiedStore(
  pinnedStore: Ref<LocalPinnedSessionStore>,
): MigrateCodexPinsResult {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { migrated: 0, removed: false };
  }

  const storage = window.localStorage;
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_CODEX_PIN_STORAGE_KEY);
  } catch {
    return { migrated: 0, removed: false };
  }

  if (raw === null) {
    return { migrated: 0, removed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { migrated: 0, removed: tryRemoveLegacyKey(storage) };
  }

  const removed = tryRemoveLegacyKey(storage);

  if (!Array.isArray(parsed)) {
    return { migrated: 0, removed };
  }

  const baseAt = Date.now();
  const next: LocalPinnedSessionStore = { ...pinnedStore.value };
  let migrated = 0;
  for (const id of parsed) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    const key = pinnedSessionStoreKey(CODEX_PROJECT_ID, trimmed);
    if (!key) continue;
    if (typeof next[key] === 'number' && next[key] > 0) continue;
    next[key] = baseAt + migrated;
    migrated += 1;
  }

  if (migrated > 0) {
    pinnedStore.value = next;
  }

  return { migrated, removed };
}

function tryRemoveLegacyKey(storage: Storage): boolean {
  try {
    storage.removeItem(LEGACY_CODEX_PIN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export const __testing = {
  LEGACY_CODEX_PIN_STORAGE_KEY,
};
