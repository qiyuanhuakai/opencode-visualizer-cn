import { DRAFT_CHUNK_BYTES, DraftDigest, DraftStorageError } from './migration/draftChunks';
export type DraftIdentity = Readonly<{ context: string; clientOrigin: string; revision: number }>;
export type DraftPart = Readonly<{ name: string; kind: 'body' | 'attachment' | 'raw'; bytes: number; chunks: number; sha256: string }>;
export type DraftHeader = DraftIdentity & Readonly<{ parts: readonly DraftPart[]; sourceRevision?: string }>;
export type InlineDraft = Readonly<{ identity: DraftIdentity; parts: readonly Readonly<{ name: string; kind: DraftPart['kind']; bytes: Uint8Array }>[]; checkpoint?: Readonly<{ key: string; value: unknown }> }>;
type Put = Readonly<{ store: string; key: IDBValidKey; value: unknown; bytes: number }>;
type PendingPut = Readonly<{ writes: readonly Put[]; resolve: () => void; reject: (error: unknown) => void }>;
function identityKey(identity: DraftIdentity): string {
  if (!identity.context || identity.context.length > 16384 || !identity.clientOrigin || identity.clientOrigin.length > 256 || !Number.isSafeInteger(identity.revision) || identity.revision < 0) throw new DraftStorageError('invalid_chunk');
  return JSON.stringify([identity.context, identity.clientOrigin, identity.revision]);
}
const partKey = (identity: DraftIdentity, name: string, index: number) => [identityKey(identity), name, index];
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new DraftStorageError('unavailable')); transaction.onerror = () => reject(transaction.error ?? new DraftStorageError('unavailable')); });
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new DraftStorageError('unavailable')); });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isPart(value: unknown): value is DraftPart {
  return record(value) && typeof value.name === 'string' && ['body', 'attachment', 'raw'].includes(String(value.kind))
    && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && typeof value.chunks === 'number' && Number.isSafeInteger(value.chunks) && value.chunks >= 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256);
}
function parseHeader(value: unknown): DraftHeader {
  if (!record(value) || typeof value.context !== 'string' || typeof value.clientOrigin !== 'string' || typeof value.revision !== 'number'
    || !Array.isArray(value.parts) || !value.parts.every(isPart) || value.sourceRevision !== undefined && typeof value.sourceRevision !== 'string') throw new DraftStorageError('corrupt');
  const header: DraftHeader = { context: value.context, clientOrigin: value.clientOrigin, revision: value.revision,
    parts: value.parts.map(part => ({ name: part.name, kind: part.kind, bytes: part.bytes, chunks: part.chunks, sha256: part.sha256 })),
    ...(typeof value.sourceRevision === 'string' ? { sourceRevision: value.sourceRevision } : {}) };
  identityKey(header); return header;
}
export class DraftStore {
  private constructor(private readonly database: IDBDatabase) {}
  private failure: unknown = null;
  private readonly pending: PendingPut[] = [];
  private pumping: Promise<void> | undefined;
  get paused(): boolean { return this.failure !== null; }
  get pendingCount(): number { return this.pending.length; }
  static async open(factory: IDBFactory = indexedDB): Promise<DraftStore> {
    const request = factory.open('vis-runtime-client', 1);
    request.onupgradeneeded = () => { for (const name of ['headers', 'bodies', 'attachments', 'raw', 'migration']) request.result.createObjectStore(name); };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new DraftStorageError('unavailable')); };
      request.onerror = () => reject(request.error ?? new DraftStorageError('unavailable'));
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
    database.onversionchange = () => database.close(); return new DraftStore(database);
  }
  close(): void { this.database.close(); }
  private async persist(pending: PendingPut): Promise<void> {
    const transaction = this.database.transaction([...new Set(pending.writes.map(write => write.store))], 'readwrite', { durability: 'strict' }); const done = transactionDone(transaction);
    let conflict = false;
    for (const write of pending.writes) {
      const store = transaction.objectStore(write.store); const request = store.get(write.key);
      request.onsuccess = () => {
        const existing: unknown = request.result;
        if (write.store !== 'migration' && existing !== undefined) {
          let same = false;
          try { same = write.store === 'headers' ? JSON.stringify(parseHeader(existing)) === JSON.stringify(parseHeader(write.value))
            : record(existing) && record(write.value) && 'sha256' in existing && existing.sha256 === write.value.sha256; }
          catch { same = false; }
          if (!same) { conflict = true; transaction.abort(); }
        } else store.put(write.value, write.key);
      };
    }
    try { await done; } catch (error) { if (conflict) throw new DraftStorageError('conflict'); throw error; }
  }
  private async pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      while (this.pending.length) {
        const write = this.pending[0];
        try { await this.persist(write); }
        catch (error) { if (error instanceof DraftStorageError && error.code === 'conflict') { this.pending.shift(); write.reject(error); continue; } throw error; }
        this.pending.shift(); write.resolve();
      }
    })();
    try { await this.pumping; }
    catch (error) { this.failure = error; for (const write of this.pending) write.reject(error); throw error; }
    finally { this.pumping = undefined; }
  }
  private put(write: Put): Promise<void> { return this.putMany([write]); }
  private putMany(writes: readonly Put[]): Promise<void> {
    if (this.paused) return Promise.reject(new DraftStorageError('paused'));
    const bytes = [...this.pending.flatMap(entry => entry.writes), ...writes].reduce((total, entry) => total + entry.bytes, 0);
    if (this.pending.length >= 32 || bytes > 8 * 1024 * 1024) { this.failure = new DraftStorageError('paused'); return Promise.reject(this.failure); }
    const result = new Promise<void>((resolve, reject) => { this.pending.push({ writes, resolve, reject }); });
    void this.pump().catch((error: unknown) => { this.failure = error; }); return result;
  }
  async commitInline(identity: DraftIdentity, input: readonly Readonly<{ name: string; kind: DraftPart['kind']; bytes: Uint8Array }>[]): Promise<DraftHeader> {
    return (await this.commitInlineBatch([{ identity, parts: input }]))[0];
  }
  async commitInlineBatch(entries: readonly InlineDraft[]): Promise<readonly DraftHeader[]> {
    if (!entries.length || entries.length > 32) throw new DraftStorageError('invalid_chunk');
    let admittedBytes = 0;
    for (const entry of entries) for (const part of entry.parts) { admittedBytes += part.bytes.length; if (admittedBytes > 8 * 1024 * 1024) throw new DraftStorageError('invalid_chunk'); }
    const all: Put[] = []; const headers: DraftHeader[] = [];
    for (const { identity, parts: input, checkpoint } of entries) {
    const writes: Put[] = []; const parts: DraftPart[] = [];
    for (const part of input) {
      if (part.bytes.length > 65536 || !part.name || part.name.length > 1024) throw new DraftStorageError('invalid_chunk');
      const bytes = part.bytes.slice(); const digest = new DraftDigest(); digest.update(bytes); const sha256 = digest.finish();
      const store = part.kind === 'attachment' ? 'attachments' : part.kind === 'body' ? 'bodies' : 'raw';
      parts.push({ name: part.name, kind: part.kind, chunks: 1, bytes: bytes.length, sha256 });
      writes.push({ store, key: partKey(identity, part.name, 0), value: { bytes: part.kind === 'attachment' ? new Blob([bytes]) : bytes, sha256 }, bytes: bytes.length });
    }
    const header = parseHeader({ ...identity, parts }); const serialized = JSON.stringify(header);
    if (serialized.length > 65536 || new Set(parts.map(part => part.name)).size !== parts.length) throw new DraftStorageError('invalid_chunk');
    writes.push({ store: 'headers', key: identityKey(header), value: header, bytes: serialized.length * 2 });
    if (checkpoint) {
      const value = JSON.stringify(checkpoint.value);
      if (value === undefined || new TextEncoder().encode(value).length > 65536) throw new DraftStorageError('invalid_chunk');
      writes.push({ store: 'migration', key: checkpoint.key, value: structuredClone(checkpoint.value), bytes: value.length * 2 });
    }
    all.push(...writes); headers.push(header);
    }
    if (all.reduce((sum, write) => sum + write.bytes, 0) > 8 * 1024 * 1024 || new Set(headers.map(identityKey)).size !== headers.length) throw new DraftStorageError('invalid_chunk');
    const tx = this.database.transaction(['headers', 'bodies', 'raw', 'attachments'], 'readonly'); const done = transactionDone(tx);
    const reads = all.filter(write => write.store !== 'migration').map(async write => ({ write, existing: await requestValue<unknown>(tx.objectStore(write.store).get(write.key)) }));
    const [observed] = await Promise.all([Promise.all(reads), done]);
    for (const { write, existing } of observed) {
      if (existing === undefined) continue;
      if (write.store === 'headers') { if (JSON.stringify(parseHeader(existing)) !== JSON.stringify(parseHeader(write.value))) throw new DraftStorageError('conflict'); continue; }
      if (!record(existing) || !(existing.bytes instanceof Blob || existing.bytes instanceof Uint8Array) || !record(write.value)) throw new DraftStorageError('corrupt');
      const bytes = existing.bytes instanceof Blob ? new Uint8Array(await existing.bytes.arrayBuffer()) : existing.bytes;
      if (bytes.length > DRAFT_CHUNK_BYTES) throw new DraftStorageError('corrupt');
      const digest = new DraftDigest(); digest.update(bytes);
      if (digest.finish() !== existing.sha256) throw new DraftStorageError('corrupt');
      if (existing.sha256 !== write.value.sha256) throw new DraftStorageError('conflict');
    }
    await this.putMany(all); return headers;
  }
  async retry(): Promise<void> { this.failure = null; await this.pump(); }
  async checkpoint(key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).length > 65536) throw new DraftStorageError('invalid_chunk');
    await this.put({ store: 'migration', key, value: structuredClone(value), bytes: serialized.length * 2 });
  }
  async readCheckpoint(key: string): Promise<unknown> {
    return (await this.readCheckpoints([key]))[0];
  }
  async readCheckpoints(keys: readonly string[]): Promise<readonly unknown[]> {
    if (!keys.length || keys.length > 200) throw new DraftStorageError('invalid_chunk');
    const tx = this.database.transaction('migration', 'readonly'); const done = transactionDone(tx);
    const [values] = await Promise.all([Promise.all(keys.map(key => requestValue<unknown>(tx.objectStore('migration').get(key)))), done]); return values;
  }
  async writeChunk(identity: DraftIdentity, part: Readonly<{ name: string; kind: DraftPart['kind']; index: number; bytes: Uint8Array }>): Promise<void> {
    if (!Number.isSafeInteger(part.index) || part.index < 0 || part.bytes.length > DRAFT_CHUNK_BYTES || !part.name || part.name.length > 1024) throw new DraftStorageError('invalid_chunk');
    const header = await this.header(identity);
    if (header && !header.parts.some(value => value.name === part.name && value.kind === part.kind && part.index < value.chunks)) throw new DraftStorageError('conflict');
    const bytes = part.bytes.slice(); const digest = new DraftDigest(); digest.update(bytes);
    const store = part.kind === 'attachment' ? 'attachments' : part.kind === 'body' ? 'bodies' : 'raw';
    await this.put({ store, key: partKey(identity, part.name, part.index), value: { bytes: part.kind === 'attachment' ? new Blob([bytes]) : bytes, sha256: digest.finish() }, bytes: bytes.length });
  }
  async writePart(identity: DraftIdentity, part: Readonly<{ name: string; kind: DraftPart['kind']; input: AsyncIterable<Uint8Array> }>): Promise<DraftPart> {
    const digest = new DraftDigest(); let bytes = 0; let chunks = 0;
    for await (const input of part.input) for (let offset = 0; offset < input.length; offset += DRAFT_CHUNK_BYTES) {
      const value = input.subarray(offset, offset + DRAFT_CHUNK_BYTES); digest.update(value);
      await this.writeChunk(identity, { ...part, index: chunks, bytes: value }); bytes += value.length; chunks++;
    }
    return { name: part.name, kind: part.kind, bytes, chunks, sha256: digest.finish() };
  }
  async commit(header: DraftHeader): Promise<void> {
    header = parseHeader(header); const serialized = JSON.stringify(header);
    if (new TextEncoder().encode(serialized).length > 65536 || new Set(header.parts.map(part => part.name)).size !== header.parts.length) throw new DraftStorageError('invalid_chunk');
    for (const part of header.parts) {
      const digest = new DraftDigest(); let bytes = 0;
      for await (const chunk of this.readPart(header, part)) { digest.update(chunk); bytes += chunk.length; }
      if (bytes !== part.bytes || digest.finish() !== part.sha256) throw new DraftStorageError('corrupt');
    }
    await this.put({ store: 'headers', key: identityKey(header), value: structuredClone(header), bytes: serialized.length * 2 });
  }
  async header(identity: DraftIdentity): Promise<DraftHeader | undefined> {
    const tx = this.database.transaction('headers', 'readonly'); const done = transactionDone(tx);
    const header: unknown = await requestValue(tx.objectStore('headers').get(identityKey(identity))); await done; return header === undefined ? undefined : parseHeader(header);
  }
  async page(options: Readonly<{ after?: string; limit?: number }> = {}): Promise<Readonly<{ headers: readonly DraftHeader[]; next: string | null }>> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DraftStorageError('invalid_chunk');
    const tx = this.database.transaction('headers', 'readonly'); const done = transactionDone(tx); const headers: DraftHeader[] = []; let next: string | null = null; let failure: unknown;
    const request = tx.objectStore('headers').openCursor(options.after ? IDBKeyRange.lowerBound(options.after, true) : undefined);
    request.onsuccess = () => { const cursor = request.result; if (!cursor || headers.length === limit) return;
      try { headers.push(parseHeader(cursor.value)); next = typeof cursor.key === 'string' ? cursor.key : null; cursor.continue(); } catch (error) { failure = error; tx.abort(); } };
    try { await done; } catch (error) { throw failure ?? error; } return { headers, next: headers.length === limit ? next : null };
  }
  async *readPart(identity: DraftIdentity, part: DraftPart): AsyncGenerator<Uint8Array> {
    const store = part.kind === 'attachment' ? 'attachments' : part.kind === 'body' ? 'bodies' : 'raw';
    for (let index = 0; index < part.chunks; index++) {
      const tx = this.database.transaction(store, 'readonly'); const done = transactionDone(tx);
      const value: unknown = await requestValue(tx.objectStore(store).get(partKey(identity, part.name, index))); await done;
      if (!record(value) || !(value.bytes instanceof Blob || value.bytes instanceof Uint8Array) || typeof value.sha256 !== 'string') throw new DraftStorageError('corrupt');
      const bytes = value.bytes instanceof Blob ? new Uint8Array(await value.bytes.arrayBuffer()) : value.bytes;
      if (bytes.length > DRAFT_CHUNK_BYTES) throw new DraftStorageError('corrupt');
      const digest = new DraftDigest(); digest.update(bytes); if (digest.finish() !== value.sha256) throw new DraftStorageError('corrupt'); yield bytes;
    }
  }
}
