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

export function saveCodexTurnEffort(threadId: string, turnId: string, effort: string | undefined) {
  if (!effort) return;
  const efforts = loadEfforts(threadId);
  efforts.set(codexUserMessageId(turnId, 0), effort);
  storageSetJSON(snapshotKey(threadId), Object.fromEntries(efforts));
}

export function restoreCodexMessageEfforts(threadId: string, entries: CodexCanonicalHistoryEntry[]) {
  const efforts = loadEfforts(threadId);
  return entries.map(entry => {
    const userId = entry.info.role === 'user' ? entry.info.id : entry.info.parentID;
    const variant = entry.info.variant ?? efforts.get(userId);
    return variant ? { ...entry, info: { ...entry.info, variant } } : entry;
  });
}
