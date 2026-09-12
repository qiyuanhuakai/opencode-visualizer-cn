import type { MessageInfo } from '../../types/sse';
import { storageGetJSON, storageSetJSON, StorageKeys } from '../../utils/storageKeys';
import type { CodexCanonicalHistoryEntry } from './normalize';

type MessageModel = { readonly providerID: string; readonly modelID: string };

function readModel(value: unknown): MessageModel | undefined {
  if (!value || typeof value !== 'object' || !('providerID' in value) || !('modelID' in value)) return;
  if (typeof value.providerID !== 'string' || typeof value.modelID !== 'string') return;
  const providerID = value.providerID.trim();
  const modelID = value.modelID.trim();
  if (!providerID || !modelID || modelID === 'codex' || modelID === 'unknown') return;
  return { providerID, modelID };
}

export function createCodexMessageModels(connectionUrl: () => string) {
  function key(threadId: string) {
    const endpoint = new URL(connectionUrl());
    const scope = `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`;
    return `${StorageKeys.state.codexMessageModels}.${encodeURIComponent(scope)}.${encodeURIComponent(threadId)}`;
  }

  function load(threadId: string) {
    const saved = storageGetJSON<unknown>(key(threadId));
    const models = new Map<string, MessageModel>();
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return models;
    for (const [id, value] of Object.entries(saved)) {
      const model = readModel(value);
      if (model) models.set(id, model);
    }
    return models;
  }

  function save(threadId: string, user: MessageInfo) {
    if (user.role !== 'user') return;
    const model = readModel(user.model);
    if (!model) return;
    const models = load(threadId);
    models.set(user.id, model);
    storageSetJSON(key(threadId), Object.fromEntries(models));
  }

  function restore(threadId: string, entries: readonly CodexCanonicalHistoryEntry[], known: readonly CodexCanonicalHistoryEntry[] = []) {
    const models = load(threadId);
    for (const { info } of known) {
      if (info.role !== 'user' || info.sessionID !== threadId || models.has(info.id)) continue;
      const model = readModel(info.model);
      if (model) models.set(info.id, model);
    }
    return entries.map(entry => {
      const wireModel = readModel(entry.info.role === 'user' ? entry.info.model : entry.info);
      const model = models.get(entry.info.role === 'user' ? entry.info.id : entry.info.parentID)
        ?? (wireModel?.providerID === 'openai' ? { ...wireModel, providerID: 'codex' } : undefined);
      if (!model) return entry;
      const info = entry.info.role === 'user' ? { ...entry.info, model } : { ...entry.info, ...model };
      return { ...entry, info };
    });
  }

  return { save, restore };
}
