import { isLegacyKey } from './legacyInventory';
import { LegacyExportError, stringChunks } from '../../../shared/runtime/migration/streamingJson.js';
import { legacyDigest } from '../../../shared/runtime/migration/legacyExport.js';
import type { LegacySource, LegacyPiece } from '../../../shared/runtime/migration/legacyExport.js';

const databases = [['opencode.codexAuxiliaryHistory', 'snapshots'], ['opencode.backendHistory', 'histories']] as const;
function namespaceFor(key: string): string {
  const match = /^opencode\.state\.backendHistory\.v1\.([a-f0-9]{32})\./u.exec(key);
  if (key.startsWith('opencode.state.backendHistory.v1.') && !match) throw new LegacyExportError('unknown_namespace');
  return match ? `backend-history-v1:${match[1]}` : 'unattached-legacy-local';
}
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(new LegacyExportError('source_changed')); };
    request.onerror = () => reject(new LegacyExportError('source_unavailable'));
    request.onblocked = () => reject(new LegacyExportError('source_unavailable'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function readRecord(db: IDBDatabase, store: string, after: IDBValidKey | undefined): Promise<Readonly<{ key: IDBValidKey; value: unknown }> | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readonly');
    const request = transaction.objectStore(store).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
    let result: Readonly<{ key: IDBValidKey; value: unknown }> | null = null;
    request.onsuccess = () => { const cursor = request.result; if (cursor) result = { key: cursor.key, value: cursor.value }; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(new LegacyExportError('source_unavailable'));
    transaction.onerror = () => reject(new LegacyExportError('source_unavailable'));
  });
}
export function createBrowserLegacySource(context: Readonly<{ storage: Storage; indexedDB: IDBFactory; origin: string }>): LegacySource {
  if (context.origin !== globalThis.location.origin) throw new LegacyExportError('origin_mismatch');
  return async function* (): AsyncGenerator<LegacyPiece> {
    const sourceScope = `browser:${await legacyDigest(context.origin)}`;
    const keys = Array.from({ length: context.storage.length }, (_, index) => context.storage.key(index)).filter((key): key is string => key !== null && isLegacyKey(key)).sort();
    for (const key of keys) {
      const value = context.storage.getItem(key);
      if (value === null) throw new LegacyExportError('source_changed');
      for (const chunk of stringChunks(value)) yield { ...chunk, key, source: `${sourceScope}/localStorage`, namespace: namespaceFor(key) };
    }
    const present = await context.indexedDB.databases();
    for (const [name, store] of databases) {
      if (!present.some(database => database.name === name)) continue;
      const db = await openExisting(context.indexedDB, name);
      try {
        if (!db.objectStoreNames.contains(store)) throw new LegacyExportError('corrupt_source');
        let after: IDBValidKey | undefined;
        for (;;) {
          const row = await readRecord(db, store, after);
          if (!row) break;
          after = row.key;
          const key = typeof row.key === 'string' ? row.key : JSON.stringify(row.key);
          const scopeKey = Array.isArray(row.key) && typeof row.key[0] === 'string' ? row.key[0] : key;
          const value = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
          if (value === undefined) throw new LegacyExportError('corrupt_source');
          for (const chunk of stringChunks(value)) yield { ...chunk, key, source: `${sourceScope}/${name}/${store}`, namespace: namespaceFor(scopeKey), authority: 'indexeddb' };
        }
      } finally { db.close(); }
    }
  };
}
