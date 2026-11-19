import { DraftStore, type DraftHeader } from './draftStore';
import { createDraftCache } from './draftCache';
import { createMemoryBudget } from './entityCache';
import { DraftStorageError } from './migration/draftChunks';
import { createComposerPreferences } from './composerPreferences';
import { createThreadDraftInitializer } from './threadDraftInitializer';

type QualifiedDraftStore = Pick<DraftStore, 'readCheckpoint' | 'compareAndSetCheckpoint' | 'header' | 'page' | 'readPart' | 'writePart' | 'writeChunk' | 'commit' | 'retry' | 'paused' | 'pendingCount'>;
export function createQualifiedComposerDrafts(store: QualifiedDraftStore, clientOrigin: string) {
  const budget = createMemoryBudget({ maxBytes: 8 * 1024 * 1024, maxEntries: 32 });
  const pointers = budget.reserve({ bytes: 512 * 1024, entries: 1 });
  if (!pointers) throw new DraftStorageError('paused');
  pointers.commit();
  const cache = createDraftCache({ store, budget });
  const threadDrafts = createThreadDraftInitializer(store, budget, clientOrigin, async function* (header, part) {
    for await (const segment of cache.exportPart({ identity: header, part: part.name })) {
      try { yield segment.bytes; } finally { segment.release(); }
    }
  });
  let loadedPointer: { context: string; value: unknown } | null = null;
  let pointerGeneration = 0;
  let pendingSave: { context: string; identity: DraftHeader; expected: unknown } | null = null;
  let pendingWrite: { context: string; identity: { context: string; clientOrigin: string; revision: number } } | null = null;
  async function basePointer(context: string) {
    if (loadedPointer?.context === context) return loadedPointer.value;
    const generation = ++pointerGeneration;
    const value = await store.readCheckpoint(`composer-active:${context}`);
    if (generation === pointerGeneration) loadedPointer = { context, value };
    return value;
  }
  async function publish(context: string, expected: unknown, value: unknown) {
    await store.compareAndSetCheckpoint(`composer-active:${context}`, expected, value);
    if (loadedPointer?.context === context) loadedPointer = { context, value };
  }
  async function readRaw(header: DraftHeader): Promise<unknown> {
    const part = header.parts.find(part => part.name === 'raw');
    if (!part) throw new Error('The saved composer draft is incomplete.');
    if (part.bytes > 256 * 1024) throw new Error('Open this draft in the segmented editor.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    for await (const bytes of store.readPart(header, part)) text += decoder.decode(bytes, { stream: true });
    return JSON.parse(text + decoder.decode());
  }
  async function open(context: string, track = true): Promise<DraftHeader | null> {
    const generation = track ? ++pointerGeneration : pointerGeneration;
    const pointer = await store.readCheckpoint(`composer-active:${context}`);
    if (track && generation === pointerGeneration) loadedPointer = { context, value: pointer };
    if (pointer && typeof pointer === 'object' && 'context' in pointer && typeof pointer.context === 'string' && (pointer.context === context || 'ownerContext' in pointer && pointer.ownerContext === context)
      && 'clientOrigin' in pointer && typeof pointer.clientOrigin === 'string' && 'revision' in pointer && typeof pointer.revision === 'number') {
      const header = await store.header({ context: pointer.context, clientOrigin: pointer.clientOrigin, revision: pointer.revision });
      if (!header) throw new Error('The saved composer draft is incomplete.');
      return header;
    }
    if (!track) return null;
    let after: string | undefined;
    do {
      const page = await store.page({ after, limit: 32 });
      for (const header of page.headers) {
        if (!header.context.startsWith('unattached:')) continue;
        const metadata = await store.readCheckpoint(header.context);
        if (metadata && typeof metadata === 'object' && 'legacyContext' in metadata && metadata.legacyContext === context
          && 'kind' in metadata && metadata.kind === 'composer') return header;
      }
      after = page.next ?? undefined;
    } while (after);
    return null;
  }
  async function read(context: string): Promise<unknown | null> {
    const header = await open(context);
    return header ? readRaw(header) : null;
  }
  const preferences = createComposerPreferences(store, async context => {
    const header = await open(context, false);
    const raw = header?.parts.find(part => part.name === 'raw');
    if (!header || !raw || raw.bytes > 256 * 1024) return null;
    const scratch = budget.reserve({ bytes: raw.bytes * 4 + 256 * 1024, entries: 1 });
    if (!scratch) throw new DraftStorageError('paused');
    try { return await readRaw(header); }
    finally { scratch.release(); }
  });
  async function write(context: string, revision: number, draft: unknown): Promise<void> {
    const expected = await basePointer(context);
    const identity = { context, clientOrigin, revision };
    pendingWrite = { context, identity };
    const content = JSON.stringify(draft);
    async function* chunks() {
      for (let offset = 0; offset < content.length;) {
        let end = Math.min(offset + 8192, content.length);
        if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1])) end--;
        yield new TextEncoder().encode(content.slice(offset, end)); offset = end;
      }
    }
    const raw = await store.writePart(identity, { name: 'raw', kind: 'raw', input: chunks() });
    const parts = [raw];
    if (draft && typeof draft === 'object' && 'messageInput' in draft && typeof draft.messageInput === 'string') {
      const body = draft.messageInput;
      const bodyChunks = async function* () {
        for (let offset = 0; offset < body.length;) {
          let end = Math.min(offset + 8192, body.length);
          if (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1])) end--;
          yield new TextEncoder().encode(body.slice(offset, end)); offset = end;
        }
      };
      parts.push(await store.writePart(identity, { name: 'body', kind: 'body', input: bodyChunks() }));
    }
    await store.commit({ ...identity, parts });
    await publish(context, expected, identity);
    if (pendingWrite?.identity === identity) pendingWrite = null;
  }
  async function readBodySegment(header: DraftHeader, index: number) {
    const segment = await cache.readSegment({ identity: header, part: 'body', index });
    try { return new TextDecoder('utf-8', { fatal: true }).decode(segment.bytes); }
    finally { segment.release(); }
  }
  async function saveBodySegment(context: string, header: DraftHeader, index: number, text: string) {
    const expected = await basePointer(context);
    if (expected && typeof expected === 'object' && 'revision' in expected && (expected.revision !== header.revision || !('context' in expected) || expected.context !== header.context)) throw new DraftStorageError('conflict');
    const nextRevision = Math.max(Date.now(), header.revision + 1);
    pendingSave = { context, identity: { ...header, revision: nextRevision }, expected };
    const saved = await cache.editSegment({ identity: header, part: 'body', nextRevision, index, bytes: new TextEncoder().encode(text) });
    try {
      await publish(context, expected, { context: saved.header.context, clientOrigin: saved.header.clientOrigin, revision: saved.header.revision, ownerContext: context });
      pendingSave = null;
      return saved.header;
    } finally { saved.release(); }
  }
  async function retry(): Promise<DraftHeader | null> {
    await cache.retry();
    await preferences.retry();
    await threadDrafts.retry();
    if (pendingWrite) {
      const pointer = await store.readCheckpoint(`composer-active:${pendingWrite.context}`);
      if (pointer && typeof pointer === 'object' && 'context' in pointer && 'clientOrigin' in pointer && 'revision' in pointer && pointer.context === pendingWrite.identity.context && pointer.clientOrigin === pendingWrite.identity.clientOrigin && pointer.revision === pendingWrite.identity.revision) {
        if (loadedPointer?.context === pendingWrite.context) loadedPointer = { context: pendingWrite.context, value: pointer };
        pendingWrite = null;
      }
    }
    if (!pendingSave) return null;
    const saved = await store.header(pendingSave.identity);
    if (!saved) throw new Error('The edited draft is not yet durable. Save the segment again.');
    await publish(pendingSave.context, pendingSave.expected, { context: saved.context, clientOrigin: saved.clientOrigin, revision: saved.revision, ownerContext: pendingSave.context });
    pendingSave = null;
    return saved;
  }

  async function exportPart(header: DraftHeader, name: string, sink: { write(bytes: Uint8Array): Promise<void> }) {
    for await (const segment of cache.exportPart({ identity: header, part: name })) {
      try { await sink.write(segment.bytes); } finally { segment.release(); }
    }
  }
  return { read, open, write, readPreferences: preferences.read, writePreferences: preferences.write,
    initializeThread: async (context: string, source: DraftHeader | null) => {
      if (pendingSave || pendingWrite || preferences.recoveryPending) throw new DraftStorageError('paused');
      return threadDrafts.initialize(context, source);
    },
    readBodySegment, saveBodySegment, exportPart, usage: budget.usage, retry, get recoveryPending() { return store.paused || threadDrafts.recoveryPending || preferences.recoveryPending || pendingSave !== null || pendingWrite !== null; } };

}
