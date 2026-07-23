import { StorageKeys, storageGet, storageSet } from '../../utils/storageKeys';

type ArchiveIndex = Record<string, string[]>;

function readIndex(): ArchiveIndex {
  const raw = storageGet(StorageKeys.state.acpArchivedSessions);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([agentId, value]) =>
        Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? [[agentId, value]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export function createAcpSessionArchive(agentId: string) {
  let archived = new Set(readIndex()[agentId] ?? []);

  function persist() {
    const index = readIndex();
    if (archived.size > 0) index[agentId] = [...archived].sort();
    else delete index[agentId];
    storageSet(StorageKeys.state.acpArchivedSessions, JSON.stringify(index));
  }

  return {
    has: (sessionId: string) => archived.has(sessionId),
    set(sessionId: string, value: boolean) {
      if (value) archived.add(sessionId);
      else archived.delete(sessionId);
      persist();
    },
    reload() {
      archived = new Set(readIndex()[agentId] ?? []);
    },
  };
}
