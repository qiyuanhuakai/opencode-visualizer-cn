import { codexAssistantMessageId, codexUserMessageId, type CodexCanonicalHistoryEntry } from './normalize';

export function migrateCodexAuxiliaryHistory(
  cached: ReadonlyArray<CodexCanonicalHistoryEntry>,
  canonical: ReadonlyArray<CodexCanonicalHistoryEntry>,
): CodexCanonicalHistoryEntry[] {
  const aliases = new Map<string, Map<string, string>>();
  const canonicalUsers = new Map<string, Set<string>>();
  const ordinals = new Map<string, Map<string, number>>();
  for (const { info } of canonical) {
    if (info.role !== 'user') continue;
    const separator = info.id.lastIndexOf(':user:');
    if (separator < 0) continue;
    const turnId = info.id.slice(0, separator);
    const threadOrdinals = ordinals.get(info.sessionID) ?? new Map<string, number>();
    const ordinal = threadOrdinals.get(turnId) ?? 0;
    threadOrdinals.set(turnId, ordinal + 1);
    ordinals.set(info.sessionID, threadOrdinals);
    const threadAliases = aliases.get(info.sessionID) ?? new Map<string, string>();
    threadAliases.set(codexUserMessageId(turnId, ordinal), info.id);
    aliases.set(info.sessionID, threadAliases);
    const users = canonicalUsers.get(info.sessionID) ?? new Set<string>();
    users.add(info.id);
    canonicalUsers.set(info.sessionID, users);
  }

  return cached.flatMap(entry => {
    const { info } = entry;
    if (info.role !== 'assistant') return [entry];
    const parentID = canonicalUsers.get(info.sessionID)?.has(info.parentID)
      ? info.parentID
      : aliases.get(info.sessionID)?.get(info.parentID) ?? info.parentID;
    if (!info.id.endsWith(':assistant')) {
      return parentID === info.parentID ? [entry] : [{ ...entry, info: { ...info, parentID } }];
    }
    const turnId = info.id.slice(0, -':assistant'.length);
    return entry.parts.map(part => {
      const id = codexAssistantMessageId(turnId, part.id);
      return { info: { ...info, id, parentID }, parts: [{ ...part, messageID: id }] };
    });
  });
}
