import { StorageKeys, storageGetJSON, storageRemove, storageSetJSON } from './storageKeys';
import { normalizeDirectory } from './path';

export type DeletedSandboxStore = Record<string, string[]>;

function normalizeProjectId(projectId?: string) {
  return projectId?.trim() ?? '';
}

function normalizeSandboxList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const normalized = normalizeDirectory(entry);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

export function readDeletedSandboxStore(): DeletedSandboxStore {
  const raw = storageGetJSON<Record<string, unknown>>(StorageKeys.state.deletedSandboxes);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const result: DeletedSandboxStore = {};
  Object.entries(raw).forEach(([projectId, directories]) => {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) return;
    const normalizedDirectories = normalizeSandboxList(directories);
    if (normalizedDirectories.length === 0) return;
    result[normalizedProjectId] = normalizedDirectories;
  });
  return result;
}

export function writeDeletedSandboxStore(store: DeletedSandboxStore) {
  const normalized: DeletedSandboxStore = {};
  Object.entries(store).forEach(([projectId, directories]) => {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) return;
    const normalizedDirectories = normalizeSandboxList(directories);
    if (normalizedDirectories.length === 0) return;
    normalized[normalizedProjectId] = normalizedDirectories;
  });

  if (Object.keys(normalized).length === 0) {
    storageRemove(StorageKeys.state.deletedSandboxes);
    return;
  }

  storageSetJSON(StorageKeys.state.deletedSandboxes, normalized);
}

export function markSandboxDeleted(
  store: DeletedSandboxStore,
  projectId: string,
  directory: string,
): DeletedSandboxStore {
  const normalizedProjectId = normalizeProjectId(projectId);
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedProjectId || !normalizedDirectory) return store;

  const existing = normalizeSandboxList(store[normalizedProjectId]);
  if (existing.includes(normalizedDirectory)) return store;
  return {
    ...store,
    [normalizedProjectId]: [...existing, normalizedDirectory],
  };
}

export function unmarkSandboxDeleted(
  store: DeletedSandboxStore,
  projectId: string,
  directory: string,
): DeletedSandboxStore {
  const normalizedProjectId = normalizeProjectId(projectId);
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedProjectId || !normalizedDirectory) return store;

  const existing = normalizeSandboxList(store[normalizedProjectId]);
  if (existing.length === 0) return store;
  const nextDirectories = existing.filter((entry) => entry !== normalizedDirectory);
  if (nextDirectories.length === existing.length) return store;
  if (nextDirectories.length === 0) {
    const { [normalizedProjectId]: _removed, ...rest } = store;
    return rest;
  }
  return {
    ...store,
    [normalizedProjectId]: nextDirectories,
  };
}

export function isSandboxMarkedDeleted(
  store: DeletedSandboxStore,
  projectId: string,
  directory: string,
) {
  const normalizedProjectId = normalizeProjectId(projectId);
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedProjectId || !normalizedDirectory) return false;
  return normalizeSandboxList(store[normalizedProjectId]).includes(normalizedDirectory);
}

export function pruneDeletedSandboxStore(
  store: DeletedSandboxStore,
  liveSandboxesByProject: Record<string, string[]>,
): DeletedSandboxStore {
  const next: DeletedSandboxStore = {};
  Object.entries(store).forEach(([projectId, directories]) => {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) return;
    const live = new Set(normalizeSandboxList(liveSandboxesByProject[normalizedProjectId]));
    const filtered = normalizeSandboxList(directories).filter((directory) => live.has(directory));
    if (filtered.length === 0) return;
    next[normalizedProjectId] = filtered;
  });
  return next;
}
