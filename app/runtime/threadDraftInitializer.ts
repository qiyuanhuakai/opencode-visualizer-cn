import type { DraftHeader, DraftIdentity, DraftPart, DraftStore } from './draftStore';
import type { MemoryBudget, MemoryLease } from './entityCache';
import { DraftStorageError } from './migration/draftChunks';

type Store = Pick<DraftStore, 'readCheckpoint' | 'compareAndSetCheckpoint' | 'header' | 'writePart' | 'commit'>;
type Source = (header: DraftHeader, part: DraftPart) => AsyncIterable<Uint8Array>;

export function createThreadDraftInitializer(store: Store, budget: MemoryBudget, clientOrigin: string, source: Source) {
  let pending: { context: string; expected: unknown; identity: DraftIdentity; source: DraftHeader | null; lease: MemoryLease } | null = null;
  let working: Promise<DraftHeader> | null = null;
  let admitting = false;
  async function resolve(context: string): Promise<DraftHeader | null> {
    const value = await store.readCheckpoint(`composer-active:${context}`);
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || !('context' in value) || typeof value.context !== 'string' ||
        !('clientOrigin' in value) || typeof value.clientOrigin !== 'string' ||
        !('revision' in value) || typeof value.revision !== 'number' ||
        value.context !== context && (!('ownerContext' in value) || value.ownerContext !== context)) throw new DraftStorageError('corrupt');
    const header = await store.header({ context: value.context, clientOrigin: value.clientOrigin, revision: value.revision });
    if (!header) throw new DraftStorageError('corrupt');
    return header;
  }
  async function run(): Promise<DraftHeader> {
    const captured = pending;
    if (!captured) throw new DraftStorageError('conflict');
    const winner = await resolve(captured.context);
    if (winner) { captured.lease.release(); pending = null; return winner; }
    const parts: DraftPart[] = [];
    if (captured.source) {
      for (const part of captured.source.parts) {
        const copied = await store.writePart(captured.identity, { name: part.name, kind: part.kind, input: source(captured.source, part) });
        if (copied.bytes !== part.bytes || copied.sha256 !== part.sha256 || copied.chunks !== part.chunks) throw new DraftStorageError('corrupt');
        parts.push(copied);
      }
    } else {
      const raw = new TextEncoder().encode(JSON.stringify({ messageInput: '', attachments: [] }));
      parts.push(await store.writePart(captured.identity, { name: 'raw', kind: 'raw', input: (async function* () { yield raw; })() }));
      parts.push(await store.writePart(captured.identity, { name: 'body', kind: 'body', input: (async function* () {})() }));
    }
    const header: DraftHeader = { ...captured.identity, parts };
    await store.commit(header);
    try {
      await store.compareAndSetCheckpoint(`composer-active:${captured.context}`, captured.expected, { ...captured.identity, ownerContext: captured.context });
    } catch (error) {
      if (error instanceof DraftStorageError && error.code === 'conflict') {
        const winner = await resolve(captured.context);
        if (winner) { captured.lease.release(); pending = null; return winner; }
      }
      throw error;
    }
    captured.lease.release(); pending = null;
    return header;
  }
  function execute() {
    if (working) return working;
    working = run().finally(() => { working = null; });
    return working;
  }
  return {
    async initialize(context: string, header: DraftHeader | null): Promise<DraftHeader> {
      if (!context || context.length > 16384 || header && JSON.stringify(header).length > 16384) throw new DraftStorageError('invalid_chunk');
      if (pending) {
        if (pending.context !== context) throw new DraftStorageError('paused');
        return execute();
      }
      if (admitting) throw new DraftStorageError('paused');
      admitting = true;
      try {
        const winner = await resolve(context);
        if (winner) return winner;
        const lease = budget.reserve({ bytes: 512 * 1024, entries: 1 });
        if (!lease) throw new DraftStorageError('paused');
        let expected: unknown;
        try { expected = await store.readCheckpoint(`composer-active:${context}`); }
        catch (error) { lease.release(); throw error; }
        if (expected !== undefined && expected !== null) {
          lease.release();
          const winner = await resolve(context);
          if (winner) return winner;
          throw new DraftStorageError('conflict');
        }
        pending = { context, expected, source: header ? { ...header, parts: header.parts.map(part => ({ ...part })) } : null, identity: { context: `composer-copy:${crypto.randomUUID()}`, clientOrigin, revision: 1 }, lease };
        lease.commit();
        return execute();
      } finally { admitting = false; }
    },
    retry: () => pending ? execute() : Promise.resolve(null),
    get recoveryPending() { return pending !== null; },
  };
}
