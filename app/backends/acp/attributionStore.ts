import { StorageKeys, storageGetJSON, storageSetJSON } from '../../utils/storageKeys';

export type AcpEntryAttribution = {
  agent?: string;
  modelID?: string;
  created?: number;
  completed?: number;
};

export type AcpAttributionStore = {
  get(sessionId: string): Record<string, AcpEntryAttribution>;
  set(sessionId: string, entryId: string, attribution: AcpEntryAttribution): void;
};

export type AcpAttributionData = {
  sessions: Record<string, { entries: Record<string, AcpEntryAttribution>; updatedAt: number }>;
};

export const ACP_ATTRIBUTION_STORAGE_KEY = StorageKeys.state.acpMessageAttribution;
const MAX_SESSIONS = 30;
const MAX_ENTRIES_PER_SESSION = 500;

export function createAcpAttributionStore(options?: {
  read?: () => AcpAttributionData | null;
  write?: (data: AcpAttributionData) => void;
  now?: () => number;
}): AcpAttributionStore {
  const read =
    options?.read ??
    (() => storageGetJSON<AcpAttributionData>(ACP_ATTRIBUTION_STORAGE_KEY));
  const write =
    options?.write ??
    ((data: AcpAttributionData) => storageSetJSON(ACP_ATTRIBUTION_STORAGE_KEY, data));
  const now = options?.now ?? Date.now;

  function readData(): AcpAttributionData {
    const data = read();
    if (!data || typeof data !== 'object' || typeof data.sessions !== 'object' || !data.sessions) {
      return { sessions: {} };
    }
    return data;
  }

  return {
    get(sessionId) {
      return readData().sessions[sessionId]?.entries ?? {};
    },
    set(sessionId, entryId, attribution) {
      const data = readData();
      const session = data.sessions[sessionId] ?? { entries: {}, updatedAt: 0 };
      session.entries[entryId] = { ...session.entries[entryId], ...attribution };
      session.updatedAt = now();
      const entryIds = Object.keys(session.entries);
      if (entryIds.length > MAX_ENTRIES_PER_SESSION) {
        for (const id of entryIds.slice(0, entryIds.length - MAX_ENTRIES_PER_SESSION)) {
          delete session.entries[id];
        }
      }
      data.sessions[sessionId] = session;
      const sessionIds = Object.entries(data.sessions)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .map(([id]) => id);
      for (const id of sessionIds.slice(MAX_SESSIONS)) {
        delete data.sessions[id];
      }
      write(data);
    },
  };
}
