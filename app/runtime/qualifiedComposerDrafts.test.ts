import { expect, it } from 'vitest';
import { createQualifiedComposerDrafts } from './qualifiedComposerDrafts';
import { DraftDigest, DraftStorageError } from './migration/draftChunks';
import type { DraftHeader, DraftIdentity, DraftPart } from './draftStore';

function fixture() {
  const pointers = new Map<string, unknown>(), headers = new Map<string, DraftHeader>(), bytes = new Map<string, Uint8Array[]>();
  let pageCalls = 0;
  const key = (identity: DraftIdentity) => JSON.stringify([identity.context, identity.clientOrigin, identity.revision]);
  const store = {
    paused: false, pendingCount: 0,
    readCheckpoint: async (context: string) => structuredClone(pointers.get(context)),
    compareAndSetCheckpoint: async (context: string, expected: unknown, value: unknown) => {
      if (JSON.stringify(pointers.get(context)) !== JSON.stringify(expected)) throw new DraftStorageError('conflict');
      pointers.set(context, structuredClone(value));
    },
    header: async (identity: DraftIdentity) => headers.get(key(identity)),
    page: async () => { pageCalls++; return { headers: [], next: null }; },
    commit: async (header: DraftHeader) => { headers.set(key(header), structuredClone(header)); },
    retry: async () => {}, writeChunk: async () => {},
    readPart: async function* (identity: DraftIdentity, part: DraftPart) {
      const values = bytes.get(`${key(identity)}:${part.name}`);
      if (!values) throw new DraftStorageError('corrupt');
      for (const value of values) yield value.slice();
    },
    writePart: async (identity: DraftIdentity, part: { name: string; kind: DraftPart['kind']; input: AsyncIterable<Uint8Array> }): Promise<DraftPart> => {
      const chunks: Uint8Array[] = [], digest = new DraftDigest(); let size = 0;
      for await (const chunk of part.input) { chunks.push(chunk.slice()); digest.update(chunk); size += chunk.length; }
      bytes.set(`${key(identity)}:${part.name}`, chunks);
      return { name: part.name, kind: part.kind, bytes: size, chunks: chunks.length, sha256: digest.finish() };
    },
  };
  return { store, pointers, bytes, key, pageCalls: () => pageCalls };
}

it('reads another session’s legacy settings without rebasing the unsaved Thread body', async () => {
  const state = fixture();
  const first = createQualifiedComposerDrafts(state.store, 'tab-A');
  const second = createQualifiedComposerDrafts(state.store, 'tab-B');
  await first.read('thread');
  await first.write('thread', 1, { messageInput: 'original shared body' });
  await second.read('normal-B');
  await second.write('normal-B', 1, { messageInput: 'private normal draft', agent: 'native-B', model: 'model-B', variant: 'high' });
  await second.read('thread');
  await first.read('thread');
  const usage = first.usage();
  expect(await first.readPreferences('settings-B', 'normal-B')).toEqual({ agent: 'native-B', model: 'model-B', variant: 'high' });
  expect(first.usage()).toEqual(usage);
  await first.writePreferences('settings-B', { agent: 'native-B', model: 'selected-B', variant: 'low' });
  await second.write('thread', 2, { messageInput: 'other tab winner' });
  const winner = structuredClone(state.pointers.get('composer-active:thread'));
  await expect(first.write('thread', 3, { messageInput: 'unsaved tab-A edit' })).rejects.toMatchObject({ code: 'conflict' });
  expect(state.pointers.get('composer-active:thread')).toEqual(winner);
  expect(await second.read('thread')).toEqual({ messageInput: 'other tab winner' });
  expect(await second.read('normal-B')).toMatchObject({ messageInput: 'private normal draft', model: 'model-B' });
});

it('releases detached-read scratch on corruption and refuses oversized raw fallback without materializing it', async () => {
  const state = fixture();
  const storage = createQualifiedComposerDrafts(state.store, 'tab');
  await storage.read('normal');
  await storage.write('normal', 1, { messageInput: 'body', model: 'native' });
  const usage = storage.usage();
  const pages = state.pageCalls();
  expect(await storage.readPreferences('missing-settings', 'missing-session')).toEqual({ agent: '', model: '', variant: '' });
  expect(state.pageCalls()).toBe(pages);
  state.bytes.set(`${state.key({ context: 'normal', clientOrigin: 'tab', revision: 1 })}:raw`, [new TextEncoder().encode('{broken')]);
  await expect(storage.readPreferences('settings', 'normal')).rejects.toThrow();
  expect(storage.usage()).toEqual(usage);
  await storage.read('large');
  await storage.write('large', 1, { messageInput: 'x'.repeat(300000), model: 'not-read' });
  expect(await storage.readPreferences('large-settings', 'large')).toEqual({ agent: '', model: '', variant: '' });
  expect(storage.usage()).toEqual(usage);
});

it('does not let an older delayed body open replace a newer body’s loaded conflict baseline', async () => {
  const state = fixture();
  const seed = createQualifiedComposerDrafts(state.store, 'seed');
  for (const context of ['A', 'B']) { await seed.read(context); await seed.write(context, 1, { messageInput: `original-${context}` }); }
  const first = createQualifiedComposerDrafts(state.store, 'tab-A'), second = createQualifiedComposerDrafts(state.store, 'tab-B');
  const read = state.store.readCheckpoint;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  state.store.readCheckpoint = async key => {
    const value = await read(key);
    if (key === 'composer-active:A') await held;
    return value;
  };
  const oldOpen = first.open('A');
  await first.open('B');
  await second.open('B');
  await second.write('B', 2, { messageInput: 'other-tab-winner' });
  const winner = structuredClone(state.pointers.get('composer-active:B'));
  release(); await oldOpen;
  await expect(first.write('B', 3, { messageInput: 'unsaved-B' })).rejects.toMatchObject({ code: 'conflict' });
  expect(state.pointers.get('composer-active:B')).toEqual(winner);
});
