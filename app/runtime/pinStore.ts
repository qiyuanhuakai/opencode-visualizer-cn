import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId } from '../../shared/runtime/identity.js';
import { createMemoryBudget } from './entityCache';
import type { QualifiedSession } from './selectionScope';

export type PinIdentity = Readonly<{ selection: QualifiedSession; clientOrigin: string }>;
export type PinRecord = PinIdentity & Readonly<{ revision: number; pinned: boolean }>;
export class PinStorageError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'budget' | 'unavailable') { super(code); this.name = 'PinStorageError'; }
}
const PAGE_BYTES = 512 * 1024;
const ROW_BYTES = 144 * 1024;
function key(identity: PinIdentity): string[] {
  const profile = parseConnectionProfileId(identity.selection.profileId);
  const ref = parseSessionRef(identity.selection.session);
  if (ref.nativeSessionId.length > 16384 || !identity.clientOrigin || identity.clientOrigin.length > 256) throw new PinStorageError('invalid');
  return [profile, ref.environmentId, ref.harnessInstanceId, ref.nativeSessionId, identity.clientOrigin];
}
function value(input: unknown): Readonly<{ revision: number; pinned: boolean }> {
  if (typeof input !== 'object' || input === null || !('revision' in input) || !('pinned' in input)
    || typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.pinned !== 'boolean') throw new PinStorageError('invalid');
  return { revision: input.revision, pinned: input.pinned };
}
function identity(input: IDBValidKey): PinIdentity {
  if (!Array.isArray(input) || input.length !== 5 || !input.every(item => typeof item === 'string')) throw new PinStorageError('invalid');
  const [profileId, environmentId, harnessInstanceId, nativeSessionId, clientOrigin] = input;
  if (typeof clientOrigin !== 'string') throw new PinStorageError('invalid');
  const result = { selection: { profileId: parseConnectionProfileId(profileId), session: parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId }) }, clientOrigin };
  key(result); return result;
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new PinStorageError('unavailable'));
    tx.onerror = () => reject(tx.error ?? new PinStorageError('unavailable'));
  });
}
export class PinStore {
  private readonly budget = createMemoryBudget({ maxBytes: PAGE_BYTES, maxEntries: 200 });
  private constructor(private readonly database: IDBDatabase) {}
  static async open(factory: IDBFactory = indexedDB): Promise<PinStore> {
    const request = factory.open('vis-runtime-pins', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identities');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      request.onerror = () => reject(request.error ?? new PinStorageError('unavailable'));
      request.onblocked = () => { blocked = true; reject(new PinStorageError('unavailable')); };
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
    database.onversionchange = () => database.close(); return new PinStore(database);
  }
  async set(input: PinRecord): Promise<void> {
    const address = key(input); const record = value(input);
    const lease = this.budget.reserve({ bytes: ROW_BYTES, entries: 1 });
    if (!lease) throw new PinStorageError('budget');
    try {
      const tx = this.database.transaction('identities', 'readwrite', { durability: 'strict' }); const completion = done(tx);
      const store = tx.objectStore('identities'); const request = store.get(address); let failure: unknown;
      request.onsuccess = () => {
        try {
          const existing = request.result === undefined ? undefined : value(request.result);
          if (existing && (existing.revision > record.revision || existing.revision === record.revision && existing.pinned !== record.pinned)) throw new PinStorageError('conflict');
          if (!existing || existing.revision < record.revision) store.put(record, address);
        } catch (error) { failure = error; tx.abort(); }
      };
      try { await completion; } catch (error) { throw failure ?? error; }
    } finally { lease.release(); }
  }
  async get(input: PinIdentity): Promise<Readonly<{ record: PinRecord; release(): void }> | undefined> {
    const address = key(input); const lease = this.budget.reserve({ bytes: ROW_BYTES, entries: 1 });
    if (!lease) throw new PinStorageError('budget');
    try {
      const tx = this.database.transaction('identities', 'readonly'); const completion = done(tx); const request = tx.objectStore('identities').get(address);
      const raw: unknown = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await completion;
      if (raw === undefined) { lease.release(); return undefined; }
      const record = { ...identity(address), ...value(raw) }; lease.commit(); return { record, release: lease.release };
    } catch (error) { lease.release(); throw error; }
  }
  async page(options: Readonly<{ profileId: ConnectionProfileId; after?: readonly string[]; limit?: number }>): Promise<Readonly<{ records: readonly PinRecord[]; next: readonly string[] | null; release(): void }>> {
    const profile = parseConnectionProfileId(options.profileId); const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new PinStorageError('invalid');
    const after = options.after ? key(identity([...options.after])) : undefined;
    if (after && after[0] !== profile) throw new PinStorageError('invalid');
    const lease = this.budget.reserve({ bytes: PAGE_BYTES, entries: limit });
    if (!lease) throw new PinStorageError('budget');
    try {
      const range = IDBKeyRange.bound(after ?? [profile], [profile, []], !!after, true);
      const tx = this.database.transaction('identities', 'readonly'); const completion = done(tx); const request = tx.objectStore('identities').openCursor(range);
      const records: PinRecord[] = []; let bytes = 4096; let next: readonly string[] | null = null; let failure: unknown;
      request.onsuccess = () => {
        const cursor = request.result; if (!cursor) { next = null; return; }
        if (records.length >= limit || bytes + ROW_BYTES > PAGE_BYTES) return;
        try {
          const record = { ...identity(cursor.key), ...value(cursor.value) };
          bytes += 2048 + key(record).reduce((total, text) => total + text.length * 8, 0);
          records.push(record); next = key(record); cursor.continue();
        } catch (error) { failure = error; tx.abort(); }
      };
      try { await completion; } catch (error) { throw failure ?? error; }
      lease.commit(); return { records, next, release: lease.release };
    } catch (error) { lease.release(); throw error; }
  }
  usage() { return this.budget.usage(); }
  close(): void { this.database.close(); }
}
