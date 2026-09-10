import type { CodexCanonicalHistoryEntry } from './normalize';
import { codexUserMessageId } from './normalize';
import { StorageKeys, storageGetJSON, storageSetJSON } from '../../utils/storageKeys';

function snapshotKey(threadId: string) {
  return `${StorageKeys.state.codexTurnEfforts}.${encodeURIComponent(threadId)}`;
}

function loadEfforts(threadId: string): Map<string, string> {
  const value = storageGetJSON<unknown>(snapshotKey(threadId));
  const efforts = new Map<string, string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return efforts;
  for (const [id, effort] of Object.entries(value)) {
    if (typeof effort === 'string' && effort.trim()) efforts.set(id, effort);
  }
  return efforts;
}

export function saveCodexTurnEffort(threadId: string, turnId: string, effort: string | undefined, userMessageId?: string) {
  if (!effort) return;
  const efforts = loadEfforts(threadId);
  efforts.set(userMessageId ?? codexUserMessageId(turnId, 0), effort);
  storageSetJSON(snapshotKey(threadId), Object.fromEntries(efforts));
}

export function restoreCodexMessageEfforts(threadId: string, entries: CodexCanonicalHistoryEntry[]) {
  const efforts = loadEfforts(threadId);
  const ordinals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.info.role !== 'user') continue;
    const separator = entry.info.id.lastIndexOf(':user:');
    if (separator < 0) continue;
    const turnId = entry.info.id.slice(0, separator);
    const ordinal = ordinals.get(turnId) ?? 0;
    ordinals.set(turnId, ordinal + 1);
    const legacyEffort = efforts.get(codexUserMessageId(turnId, ordinal));
    if (!efforts.has(entry.info.id) && legacyEffort) efforts.set(entry.info.id, legacyEffort);
  }
  return entries.map(entry => {
    const userId = entry.info.role === 'user' ? entry.info.id : entry.info.parentID;
    const variant = entry.info.variant ?? efforts.get(userId);
    return variant ? { ...entry, info: { ...entry.info, variant } } : entry;
  });
}
