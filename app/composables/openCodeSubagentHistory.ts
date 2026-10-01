import type { MessageInfo, MessagePart } from '../types/sse';
import { createBackendHistoryStorage, type BackendHistoryEntry } from '../utils/backendHistoryStorage';

type HistoryStore = ReturnType<typeof createBackendHistoryStorage>;

export function createOpenCodeSubagentHistory(options: {
  getScope: () => string;
  isActive: () => boolean;
  getRootSessionId: () => string;
  getMemoryEntries: (sessionId: string) => BackendHistoryEntry[];
  createStore?: (scope: string) => HistoryStore;
}) {
  const stores = new Map<string, HistoryStore>();
  const pending = new Map<HistoryStore, Map<string, Map<string, BackendHistoryEntry>>>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function storeFor(scope: string) {
    let store = stores.get(scope);
    if (!store) {
      store = options.createStore?.(scope) ?? createBackendHistoryStorage({ backend: 'opencode', scope });
      stores.set(scope, store);
    }
    return store;
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    const batches = [...pending];
    pending.clear();
    await Promise.all(batches.flatMap(([store, sessions]) => [...sessions].map(([id, entries]) =>
      store.merge(id, [...entries.values()]))));
    await Promise.all([...stores.values()].map((store) => store.flush()));
  }

  function record(entry: BackendHistoryEntry) {
    if (!options.isActive() || entry.info.sessionID === options.getRootSessionId()) return;
    const store = storeFor(options.getScope());
    const sessions = pending.get(store) ?? new Map<string, Map<string, BackendHistoryEntry>>();
    const messages = sessions.get(entry.info.sessionID) ?? new Map<string, BackendHistoryEntry>();
    messages.set(entry.info.id, entry);
    sessions.set(entry.info.sessionID, messages);
    pending.set(store, sessions);
    if (!timer) timer = setTimeout(() => {
      void flush().catch((error: unknown) => console.error('[OpenCode] Child history persistence failed', error));
    }, 50);
  }

  function loader(scope: string, fetchHistory: (sessionId: string) => Promise<unknown>) {
    const store = storeFor(scope);
    return async (sessionId: string): Promise<BackendHistoryEntry[]> => {
      const memory = options.isActive() && options.getScope() === scope ? options.getMemoryEntries(sessionId) : [];
      if (memory.length) return store.merge(sessionId, memory);
      const retained = await store.read(sessionId);
      if (retained.length) return retained;
      const response = await fetchHistory(sessionId);
      const entries = parseHistory(response, sessionId);
      const observed = options.isActive() && options.getScope() === scope ? options.getMemoryEntries(sessionId) : [];
      return store.merge(sessionId, [...entries, ...observed]);
    };
  }

  return { record, loader, flush };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseHistory(value: unknown, sessionId: string): BackendHistoryEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid OpenCode session history response.');
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.info) || !Array.isArray(entry.parts) ||
      entry.info.sessionID !== sessionId || typeof entry.info.id !== 'string' ||
      !['user', 'assistant'].includes(String(entry.info.role))) {
      throw new Error('Invalid OpenCode session history entry.');
    }
    const info = entry.info as unknown as MessageInfo;
    const parts = entry.parts.map((part: unknown) => {
      if (!isRecord(part) || part.sessionID !== sessionId || part.messageID !== info.id ||
        typeof part.id !== 'string' || typeof part.type !== 'string') {
        throw new Error('Invalid OpenCode session history part.');
      }
      return part as unknown as MessagePart;
    });
    return { info, parts };
  });
}
