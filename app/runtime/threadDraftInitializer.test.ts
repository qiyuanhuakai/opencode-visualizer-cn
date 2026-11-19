import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createThreadDraftInitializer } from './threadDraftInitializer';
import { createMemoryBudget } from './entityCache';
import { DraftStorageError } from './migration/draftChunks';
import type { DraftHeader, DraftIdentity, DraftPart } from './draftStore';

function fixture() {
  const pointers = new Map<string, unknown>(), headers = new Map<string, DraftHeader>();
  const budget = createMemoryBudget({ maxBytes: 8 * 1024 * 1024, maxEntries: 32 });
  let writes = 0, largest = 0, peak = 0, fail = false;
  const key = (identity: DraftIdentity) => JSON.stringify([identity.context, identity.clientOrigin, identity.revision]);
  const store = {
    readCheckpoint: async (context: string) => structuredClone(pointers.get(context)),
    compareAndSetCheckpoint: async (context: string, expected: unknown, value: unknown) => {
      if (JSON.stringify(pointers.get(context)) !== JSON.stringify(expected)) throw new DraftStorageError('conflict');
      pointers.set(context, structuredClone(value));
    },
    header: async (identity: DraftIdentity) => headers.get(key(identity)),
    commit: async (header: DraftHeader) => { headers.set(key(header), structuredClone(header)); },
    writePart: async (_identity: DraftIdentity, part: { name: string; kind: DraftPart['kind']; input: AsyncIterable<Uint8Array> }): Promise<DraftPart> => {
      writes++;
      if (fail) throw new DOMException('quota', 'QuotaExceededError');
      const digest = createHash('sha256'); let bytes = 0, chunks = 0;
      for await (const chunk of part.input) {
        largest = Math.max(largest, chunk.length); bytes += chunk.length; chunks++;
        digest.update(chunk);
        const usage = budget.usage(); peak = Math.max(peak, usage.residentBytes + usage.reservedBytes);
      }
      return { name: part.name, kind: part.kind, bytes, chunks, sha256: digest.digest('hex') };
    },
  };
  async function* source(_header: DraftHeader, part: DraftPart) {
    for (let offset = 0; offset < part.bytes; offset += 65536) yield new Uint8Array(Math.min(65536, part.bytes - offset)).fill(part.kind === 'body' ? 65 : 66);
  }
  function part(name: string, kind: DraftPart['kind'], bytes: number): DraftPart {
    const hash = createHash('sha256');
    for (let offset = 0; offset < bytes; offset += 65536) hash.update(new Uint8Array(Math.min(65536, bytes - offset)).fill(kind === 'body' ? 65 : 66));
    return { name, kind, bytes, chunks: Math.ceil(bytes / 65536), sha256: hash.digest('hex') };
  }
  return { store, source, budget, pointers, headers, key, part, fail: (value: boolean) => { fail = value; }, stats: () => ({ writes, largest, peak }) };
}

it('copies a 16 MiB body and 64 MiB attachment once into independent immutable identity with bounded chunks', async () => {
  const state = fixture();
  const header: DraftHeader = { context: 'normal-session', clientOrigin: 'tab', revision: 7, parts: [state.part('body', 'body', 16 * 1024 * 1024), state.part('attachment', 'attachment', 64 * 1024 * 1024)] };
  const original = structuredClone(header);
  state.headers.set(state.key(header), header);
  state.pointers.set('composer-active:normal-session', { context: header.context, clientOrigin: header.clientOrigin, revision: header.revision });
  const normalPointer = structuredClone(state.pointers.get('composer-active:normal-session'));
  const initializer = createThreadDraftInitializer(state.store, state.budget, 'tab', state.source);
  const copied = await initializer.initialize('thread-context', header);
  expect(copied.parts).toEqual(header.parts);
  expect(copied.context).not.toBe(header.context);
  expect(state.pointers.get('composer-active:normal-session')).toEqual(normalPointer);
  expect(header).toEqual(original);
  const before = state.stats();
  expect(await initializer.initialize('thread-context', null)).toEqual(copied);
  expect(state.stats()).toEqual(before);
  expect(before.writes).toBe(2);
  expect(before.largest).toBe(65536);
  expect(before.peak).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(state.budget.usage()).toEqual({ residentBytes: 0, reservedBytes: 0, entries: 0 });
});

it('retains a quota-failed initialization and releases its reservation after retry', async () => {
  const state = fixture();
  const initializer = createThreadDraftInitializer(state.store, state.budget, 'tab', state.source);
  state.fail(true);
  await expect(initializer.initialize('thread', null)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  expect(initializer.recoveryPending).toBe(true);
  expect(state.budget.usage().residentBytes).toBe(512 * 1024);
  expect(state.pointers.has('composer-active:thread')).toBe(false);
  await expect(initializer.initialize('different-thread', null)).rejects.toMatchObject({ code: 'paused' });
  state.fail(false);
  const restored = await initializer.retry();
  expect(restored?.parts.map(part => part.name)).toEqual(['raw', 'body']);
  expect(initializer.recoveryPending).toBe(false);
  expect(state.budget.usage().residentBytes).toBe(0);
});

it('loads another tab’s winner without replacing its checkpoint', async () => {
  const state = fixture();
  const winner: DraftHeader = { context: 'winner', clientOrigin: 'other-tab', revision: 2, parts: [] };
  state.headers.set(state.key(winner), winner);
  const originalWrite = state.store.writePart;
  state.store.writePart = async (identity, part) => {
    state.pointers.set('composer-active:thread', { context: winner.context, clientOrigin: winner.clientOrigin, revision: winner.revision, ownerContext: 'thread' });
    return originalWrite(identity, part);
  };
  const initializer = createThreadDraftInitializer(state.store, state.budget, 'tab', state.source);
  expect(await initializer.initialize('thread', null)).toEqual(winner);
  expect(state.pointers.get('composer-active:thread')).toMatchObject({ context: 'winner', revision: 2 });
  expect(state.budget.usage().entries).toBe(0);
});
