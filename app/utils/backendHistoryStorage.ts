import type { MessageInfo, MessagePart } from '../types/sse';
import { storageKey, storageRead, storageSet } from './storageKeys';

export type BackendHistoryEntry = {
  readonly info: MessageInfo;
  readonly parts: MessagePart[];
};

const DATABASE = 'opencode.backendHistory';
const STORE = 'histories';
const pending = new Map<string, Promise<unknown>>();
const retained = new Map<string, BackendHistoryEntry[]>();
const dirty = new Set<string>();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInfo(value: unknown, sessionID: string): value is MessageInfo {
  return record(value) && typeof value.id === 'string' && value.sessionID === sessionID
    && (value.role === 'user' || value.role === 'assistant') && record(value.time)
    && typeof value.time.created === 'number';
}

function isPart(value: unknown, sessionID: string, messageID: string): value is MessagePart {
  if (!record(value) || typeof value.id !== 'string' || value.sessionID !== sessionID || value.messageID !== messageID) return false;
  switch (value.type) {
    case 'text': return typeof value.text === 'string';
    case 'reasoning': return typeof value.text === 'string' && record(value.time);
    case 'tool': return typeof value.callID === 'string' && typeof value.tool === 'string' && record(value.state)
      && ['pending', 'running', 'completed', 'error'].includes(String(value.state.status)) && record(value.state.input);
    case 'file': return typeof value.url === 'string' && typeof value.mime === 'string';
    case 'patch': return typeof value.hash === 'string' && Array.isArray(value.files);
    case 'snapshot': return typeof value.snapshot === 'string';
    case 'subtask': return typeof value.prompt === 'string' && typeof value.agent === 'string';
    case 'agent': return typeof value.name === 'string';
    case 'compaction': return typeof value.auto === 'boolean';
    case 'retry': return typeof value.attempt === 'number' && record(value.error) && record(value.time);
    case 'step-start': return true;
    case 'step-finish': return typeof value.reason === 'string' && record(value.tokens);
    default: return false;
  }
}

function parse(value: unknown, sessionID: string): BackendHistoryEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('Invalid OpenCode child history');
  return value.map((entry: unknown) => {
    if (!record(entry) || !isInfo(entry.info, sessionID) || !Array.isArray(entry.parts)) throw new TypeError('Invalid OpenCode child history entry');
    const info = entry.info;
    const parts = entry.parts.map((part: unknown) => {
      if (!isPart(part, sessionID, info.id)) throw new TypeError('Invalid OpenCode child history part');
      return part;
    });
    return { info, parts };
  });
}

function mergePart(old: MessagePart | undefined, part: MessagePart): MessagePart {
  if (!old) return part;
  if (old.type === 'tool' && part.type === 'tool') {
    if (old.state.status === 'completed' || old.state.status === 'error') return old;
  }
  if ((old.type === 'text' || old.type === 'reasoning') && (part.type === 'text' || part.type === 'reasoning')) {
    if (old.time?.end !== undefined || old.text.length > part.text.length) return old;
  }
  return part;
}

function mergeEntries(...sources: readonly (readonly BackendHistoryEntry[])[]): BackendHistoryEntry[] {
  const entries = new Map<string, BackendHistoryEntry>();
  for (const source of sources) for (const entry of source) {
    const old = entries.get(entry.info.id);
    const parts = new Map(old?.parts.map(part => [part.id, part]));
    for (const part of entry.parts) parts.set(part.id, mergePart(parts.get(part.id), part));
    const info = old?.info.role === 'assistant' && old.info.time.completed !== undefined
      ? old.info : entry.info;
    entries.set(entry.info.id, { info, parts: [...parts.values()] });
  }
  return [...entries.values()].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
}

// An opaque, stable namespace also works on LAN HTTP origins without SubtleCrypto.
function scopeHash(scope: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map(seed => {
    let hash = seed;
    for (let index = 0; index < scope.length; index++) hash = Math.imul(hash ^ scope.charCodeAt(index), 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');
}

function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (pending.get(key) ?? Promise.resolve()).then(operation, operation);
  pending.set(key, result);
  void result.then(() => { if (pending.get(key) === result) pending.delete(key); }, () => { if (pending.get(key) === result) pending.delete(key); });
  return result;
}

async function indexedHistory(key: string, sessionID: string, incoming?: readonly BackendHistoryEntry[]): Promise<BackendHistoryEntry[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE).createIndex('session', 'session');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('OpenCode child history database is blocked'));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, incoming ? 'readwrite' : 'readonly');
      const store = transaction.objectStore(STORE);
      const request = store.index('session').getAll(key);
      let entries: BackendHistoryEntry[] = [];
      transaction.onabort = () => reject(transaction.error ?? new Error('OpenCode child history transaction aborted'));
      transaction.oncomplete = () => resolve(entries);
      request.onsuccess = () => {
        try {
          const raw: unknown = request.result;
          if (!Array.isArray(raw)) throw new TypeError('Invalid backend history rows');
          const stored = parse(raw.map((row: unknown) => {
            if (!record(row)) throw new TypeError('Invalid backend history row');
            return row.entry;
          }), sessionID);
          entries = mergeEntries(stored, incoming ?? []);
          if (incoming) {
            retained.set(key, entries);
            const previous = new Map(stored.map(entry => [entry.info.id, JSON.stringify(entry)]));
            for (const entry of entries) if (previous.get(entry.info.id) !== JSON.stringify(entry)) {
              store.put({ session: key, entry }, [key, entry.info.id]);
            }
          }
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

async function persist(key: string, sessionID: string, incoming?: readonly BackendHistoryEntry[]) {
  const native = typeof window === 'undefined' ? undefined : window.electronAPI?.sessionDatabase;
  if (native) {
    const namespace = `backend-history-v1:${key.split('.')[3]}`;
    const stored: BackendHistoryEntry[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await native.readHistory({ threadId: sessionID, namespace, cursor, limit: 200 });
      stored.push(...parse(page.entries, sessionID));
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated backend history cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const entries = mergeEntries(stored, incoming ?? []);
    if (incoming) {
      retained.set(key, entries);
      const previous = new Map(stored.map(entry => [entry.info.id, JSON.stringify(entry)]));
      const changed = entries.filter(entry => previous.get(entry.info.id) !== JSON.stringify(entry));
      if (changed.length) await native.upsertHistory({ threadId: sessionID, namespace, entries: changed });
    }
    return entries;
  }
  if (typeof indexedDB !== 'undefined' && !window.electronAPI?.persistentStorage) return indexedHistory(key, sessionID, incoming);
  const stored = storageRead(key);
  if (stored.kind === 'error') throw new Error('OpenCode child history read failed');
  const raw: unknown = stored.kind === 'value' ? JSON.parse(stored.value) : null;
  const entries = mergeEntries(parse(raw, sessionID), incoming ?? []);
  if (incoming) {
    retained.set(key, entries);
    const value = JSON.stringify(entries);
    const asyncWrite = window.electronAPI?.persistentStorage?.setItemAsync;
    const saved = asyncWrite ? await asyncWrite(storageKey(key), value) : storageSet(key, value);
    if (!saved) throw new Error('OpenCode child history write failed; retained for retry');
  }
  return entries;
}

export function createBackendHistoryStorage({ backend, scope }: { readonly backend: string; readonly scope: string }) {
  const prefix = `state.backendHistory.v1.${scopeHash(JSON.stringify([backend, scope]))}.`;
  const sessions = new Map<string, string>();
  function keyFor(sessionID: string) {
    const key = `${prefix}${encodeURIComponent(sessionID)}`;
    sessions.set(key, sessionID);
    return key;
  }
  async function update(sessionID: string, entries?: readonly BackendHistoryEntry[]) {
    const key = keyFor(sessionID);
    // Serialize before yielding: live Vue objects can mutate while awaiting storage.
    const incoming = entries ? parse(JSON.parse(JSON.stringify(entries)), sessionID) : undefined;
    return serial(key, async () => {
      const current = mergeEntries(retained.get(key) ?? [], incoming ?? []);
      if (incoming) { retained.set(key, current); dirty.add(key); }
      try {
        const result = await persist(key, sessionID, dirty.has(key) ? current : undefined);
        const merged = mergeEntries(result, current);
        retained.set(key, merged);
        dirty.delete(key);
        return parse(JSON.parse(JSON.stringify(merged)), sessionID);
      } catch (error) {
        console.error('[OpenCode] Child history persistence failed; cached history retained', error instanceof Error ? error.message : String(error));
        return parse(JSON.parse(JSON.stringify(mergeEntries(retained.get(key) ?? [], current))), sessionID);
      }
    });
  }
  return {
    read: (sessionID: string) => update(sessionID),
    merge: (sessionID: string, entries: readonly BackendHistoryEntry[]) => update(sessionID, entries),
    async flush(): Promise<void> {
      await Promise.all([...sessions.keys()].flatMap(key => pending.has(key) ? [pending.get(key)] : []));
      for (const [key, sessionID] of sessions) await serial(key, async () => {
        if (!dirty.has(key)) return;
        const result = await persist(key, sessionID, retained.get(key) ?? []);
        retained.set(key, result);
        dirty.delete(key);
      });
      await window.electronAPI?.sessionDatabase?.flush();
    },
  };
}
