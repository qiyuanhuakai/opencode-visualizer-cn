import { StorageKeys, storageGetJSON, storageKey, storageRemove, storageSetJSON } from '../../utils/storageKeys';

const DATABASE = 'opencode.codexAuxiliaryHistory';
const STORE = 'snapshots';
const PREFIX = `${storageKey(StorageKeys.state.codexAuxiliaryHistory)}.`;
const snapshots = new Map<string, string | null>();
const generations = new Map<string, number>();
const pending = new Set<Promise<void>>();
let database: IDBDatabase | null = null;
let initialization: Promise<void> | null = null;
let channel: BroadcastChannel | null = null;

function keyFor(threadId: string) {
  return `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent(threadId)}`;
}

function useIndexedDB() {
  return typeof window !== 'undefined'
    && !window.electronAPI?.persistentStorage
    && typeof indexedDB !== 'undefined';
}

function reportFailure(error: unknown) {
  console.error('[Codex] Auxiliary history persistence failed; cached data retained',
    error instanceof Error ? error.message : String(error));
}

function track(operation: Promise<void>) {
  const handled = operation.catch(reportFailure);
  pending.add(handled);
  void handled.then(() => pending.delete(handled));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => console.error('[Codex] Auxiliary history database upgrade blocked by another tab');
    request.onsuccess = () => resolve(request.result);
  });
}

function synchronizeKey(key: string): Promise<void> {
  const connection = database;
  if (!connection) return Promise.resolve();
  const generation = generations.get(key);
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(key);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => {
      const value: unknown = request.result;
      if (connection === database && generation === generations.get(key)
        && (typeof value === 'string' || value === undefined)) {
        snapshots.set(key, value ?? null);
      }
      resolve();
    };
  });
}

function closeConnection() {
  channel?.close();
  channel = null;
  database?.close();
  database = null;
  initialization = null;
}

function listenForChanges() {
  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(DATABASE);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string' && event.data.startsWith(PREFIX)) {
      track(synchronizeKey(event.data));
    }
  };
}

function hydrateAndMigrate(connection: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const loaded = new Map<string, string>();
    const migrated = new Map<string, string>();
    const cursor = store.openCursor();
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => {
      try {
        for (const [key, value] of loaded) {
          if (!snapshots.has(key)) snapshots.set(key, value);
        }
        for (const [key, value] of migrated) {
          if (window.localStorage.getItem(key) === value) window.localStorage.removeItem(key);
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (entry) {
        const value: unknown = entry.value;
        if (typeof entry.key === 'string' && typeof value === 'string') loaded.set(entry.key, value);
        entry.continue();
        return;
      }
      try {
        // Read legacy values while holding the IDB write transaction, not before waiting for another tab.
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (!key?.startsWith(PREFIX)) continue;
          const value = window.localStorage.getItem(key);
          if (value === null) continue;
          store.put(value, key);
          migrated.set(key, value);
          loaded.set(key, value);
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
  });
}

export function initializeCodexAuxiliaryStorage(): Promise<void> {
  if (!useIndexedDB()) return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    const connection = await openDatabase();
    try {
      await hydrateAndMigrate(connection);
      database = connection;
      connection.onversionchange = closeConnection;
      listenForChanges();
    } catch (error) {
      connection.close();
      throw error;
    }
  })().catch((error: unknown) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

function persist(key: string, value: string | null): Promise<void> {
  const connection = database;
  if (!connection) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(STORE, 'readwrite');
    transaction.oncomplete = () => {
      if (database === connection) channel?.postMessage(key);
      resolve();
    };
    transaction.onabort = () => reject(transaction.error);
    const store = transaction.objectStore(STORE);
    if (value === null) store.delete(key);
    else store.put(value, key);
  });
}

function update(key: string, value: string | null) {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  snapshots.set(key, value);
  track(database ? persist(key, value) : initializeCodexAuxiliaryStorage().then(() => persist(key, value)));
}

export function readCodexAuxiliarySnapshot(threadId: string): unknown {
  const key = keyFor(threadId);
  if (!useIndexedDB() || !snapshots.has(storageKey(key))) return storageGetJSON<unknown>(key);
  const raw = snapshots.get(storageKey(key));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value;
  } catch (error) {
    reportFailure(error);
    return null;
  }
}

export function writeCodexAuxiliarySnapshot(threadId: string, snapshot: unknown): void {
  const key = keyFor(threadId);
  if (!useIndexedDB()) {
    if (!storageSetJSON(key, snapshot)) console.error('[Codex] Auxiliary history storage write failed');
    return;
  }
  const serialized = JSON.stringify(snapshot);
  if (serialized !== undefined) update(storageKey(key), serialized);
}

export function removeCodexAuxiliarySnapshot(threadId: string): void {
  const key = keyFor(threadId);
  if (!useIndexedDB()) {
    storageRemove(key);
    return;
  }
  update(storageKey(key), null);
}

export async function flushCodexAuxiliaryStorage(): Promise<void> {
  await initialization;
  while (pending.size > 0) await Promise.all(pending);
}

if (import.meta.hot) import.meta.hot.dispose(closeConnection);
