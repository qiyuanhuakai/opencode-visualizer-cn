import type { MessageInfo } from '../../types/sse';
import { storageGetJSON, storageSetJSON, StorageKeys } from '../../utils/storageKeys';
import type { CodexCanonicalHistoryEntry } from './normalize';

type MessageModel = { readonly providerID: string; readonly modelID: string };
type MessageSnapshot = { readonly model?: MessageModel; readonly agent?: string };

function readAgent(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim() !== 'codex' ? value.trim() : undefined;
}

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
    const models = new Map<string, MessageSnapshot>();
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return models;
    for (const [id, value] of Object.entries(saved)) {
      if (!value || typeof value !== 'object') continue;
      const model = readModel('model' in value ? value.model : value);
      const agent = readAgent('agent' in value ? value.agent : undefined);
      if (model || agent) models.set(id, { model, agent });
    }
    return models;
  }

  function save(threadId: string, user: MessageInfo) {
    if (user.role !== 'user') return;
    const model = readModel(user.model);
    const agent = readAgent(user.agent);
    if (!model && !agent) return;
    const models = load(threadId);
    const saved = models.get(user.id);
    models.set(user.id, { model: model ?? saved?.model, agent: agent ?? saved?.agent });
    storageSetJSON(key(threadId), Object.fromEntries(models));
  }

  function restore(threadId: string, entries: readonly CodexCanonicalHistoryEntry[], known: readonly CodexCanonicalHistoryEntry[] = []) {
    const models = load(threadId);
    for (const { info } of known) {
      if (info.role !== 'user' || info.sessionID !== threadId) continue;
      const saved = models.get(info.id);
      models.set(info.id, { model: saved?.model ?? readModel(info.model), agent: saved?.agent ?? readAgent(info.agent) });
    }
    return entries.map(entry => {
      const wireModel = readModel(entry.info.role === 'user' ? entry.info.model : entry.info);
      const snapshot = models.get(entry.info.role === 'user' ? entry.info.id : entry.info.parentID);
      const model = snapshot?.model
        ?? (wireModel?.providerID === 'openai' ? { ...wireModel, providerID: 'codex' } : undefined);
      const agent = entry.info.role === 'user' || !entry.info.agent || entry.info.agent === 'codex'
        ? snapshot?.agent : undefined;
      if (!model && !agent) return entry;
      const info = entry.info.role === 'user'
        ? { ...entry.info, ...(model ? { model } : {}), ...(agent ? { agent } : {}) }
        : { ...entry.info, ...model, ...(agent ? { agent } : {}) };
      return { ...entry, info };
    });
  }

  return { save, restore };
}
