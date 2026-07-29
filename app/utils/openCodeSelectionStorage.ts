import { StorageKeys, storageGetJSON, storageRemove, storageSetJSON } from './storageKeys';

export interface OpenCodeLastSelection {
  projectId: string;
  sessionId: string;
  directory: string;
}

type OpenCodeLastSelectionStore = Record<string, OpenCodeLastSelection>;

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

function stripQueryAndHash(value: string): string {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  let end = value.length;
  if (queryIndex !== -1 && queryIndex < end) end = queryIndex;
  if (hashIndex !== -1 && hashIndex < end) end = hashIndex;
  return value.slice(0, end);
}

function stripUserInfo(value: string): string {
  const schemeSepIndex = value.indexOf('//');
  if (schemeSepIndex === -1) return value;
  const prefix = value.slice(0, schemeSepIndex + 2);
  const remainder = value.slice(schemeSepIndex + 2);
  const slashIndex = remainder.indexOf('/');
  const authority = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
  const path = slashIndex === -1 ? '' : remainder.slice(slashIndex);
  const atIndex = authority.lastIndexOf('@');
  const host = atIndex === -1 ? authority : authority.slice(atIndex + 1);
  return `${prefix}${host}${path}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    } catch {
      // Fall through to the lenient path for malformed http(s) URLs.
    }
  }
  return stripUserInfo(stripQueryAndHash(trimmed)).replace(/\/+$/, '');
}

function normalizeField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSelection(value: unknown): OpenCodeLastSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const projectId = normalizeField(record.projectId);
  const sessionId = normalizeField(record.sessionId);
  const directory = normalizeField(record.directory);
  if (!projectId || !sessionId || !directory) {
    return null;
  }
  return { projectId, sessionId, directory };
}

function readStore(): OpenCodeLastSelectionStore {
  const raw = storageGetJSON<Record<string, unknown>>(StorageKeys.state.openCodeLastSelection);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const store: OpenCodeLastSelectionStore = Object.create(null);
  Object.entries(raw).forEach(([baseUrl, value]) => {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    if (!normalizedBaseUrl || isDangerousKey(normalizedBaseUrl)) return;
    const selection = normalizeSelection(value);
    if (!selection) return;
    store[normalizedBaseUrl] = selection;
  });
  return store;
}

function writeStore(store: OpenCodeLastSelectionStore) {
  if (Object.keys(store).length === 0) {
    storageRemove(StorageKeys.state.openCodeLastSelection);
    return;
  }
  storageSetJSON(StorageKeys.state.openCodeLastSelection, store);
}

export function readOpenCodeLastSelection(baseUrl: string): OpenCodeLastSelection | null {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl || isDangerousKey(normalizedBaseUrl)) return null;
  const store = readStore();
  if (!Object.hasOwn(store, normalizedBaseUrl)) return null;
  return store[normalizedBaseUrl];
}

export function writeOpenCodeLastSelection(baseUrl: string, selection: OpenCodeLastSelection) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl || isDangerousKey(normalizedBaseUrl)) return;
  const normalizedSelection = normalizeSelection(selection);
  if (!normalizedSelection) return;
  writeStore({ ...readStore(), [normalizedBaseUrl]: normalizedSelection });
}

export function clearOpenCodeLastSelection(baseUrl: string) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl || isDangerousKey(normalizedBaseUrl)) return;
  const store = readStore();
  if (!(normalizedBaseUrl in store)) return;
  const { [normalizedBaseUrl]: _removed, ...rest } = store;
  writeStore(rest);
}
