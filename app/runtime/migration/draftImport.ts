import { DraftStore, type DraftHeader, type DraftIdentity, type DraftPart, type InlineDraft } from '../draftStore';
import { decodeDataUrl, DraftDigest, DraftStorageError } from './draftChunks';
import { jsonEntries, jsonLeaves } from './nestedJson';
import { legacyDigest } from './legacyExport';
import { readArchiveText, type ArchivedRecord } from './sourceArchive';
import type { PendingLegacyWrite } from './writerFreeze';
async function* encoded(input: AsyncIterable<string>): AsyncGenerator<Uint8Array> { for await (const text of input) yield new TextEncoder().encode(text); }
async function* leafText(store: DraftStore, header: DraftHeader, path: readonly (string | number)[]): AsyncGenerator<string> {
  for await (const leaf of jsonLeaves(readArchiveText(store, header))) if (leaf.string && JSON.stringify(leaf.path) === JSON.stringify(path)) yield leaf.content;
}
async function completeDraft(store: DraftStore, raw: DraftHeader): Promise<DraftHeader> {
  const fields: { path: readonly (string | number)[]; kind: 'body' | 'attachment'; name: string }[] = [];
  for await (const leaf of jsonLeaves(readArchiveText(store, raw))) {
    if (!leaf.string || !leaf.end) continue;
    if (leaf.path.length === 1 && leaf.path[0] === 'messageInput') fields.push({ path: leaf.path, kind: 'body', name: 'body' });
    if (leaf.path.length === 3 && leaf.path[0] === 'attachments' && typeof leaf.path[1] === 'number' && leaf.path[2] === 'dataUrl') fields.push({ path: leaf.path, kind: 'attachment', name: `attachment:${leaf.path[1]}` });
    if (fields.length > 256) throw new DraftStorageError('invalid_chunk');
  }
  const parts: DraftPart[] = [...raw.parts];
  for (const field of fields) {
    const input = leafText(store, raw, field.path);
    parts.push(await store.writePart(raw, { name: field.name, kind: field.kind, input: field.kind === 'attachment' ? decodeDataUrl(input) : encoded(input) }));
  }
  const header = { ...raw, parts }; await store.commit(header); return header;
}
async function smallDraftParts(content: string): Promise<InlineDraft['parts']> {
  const value: unknown = JSON.parse(content);
  const parts: { name: string; kind: DraftPart['kind']; bytes: Uint8Array }[] = [{ name: 'raw', kind: 'raw', bytes: new TextEncoder().encode(content) }];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if ('messageInput' in value && typeof value.messageInput === 'string') parts.push({ name: 'body', kind: 'body', bytes: new TextEncoder().encode(value.messageInput) });
    if ('attachments' in value && Array.isArray(value.attachments)) for (const [index, attachment] of value.attachments.entries()) {
      if (typeof attachment !== 'object' || attachment === null || !('dataUrl' in attachment) || typeof attachment.dataUrl !== 'string') continue;
      const text = attachment.dataUrl;
      const input = async function* () { yield text; };
      let decoded: Uint8Array = new Uint8Array(0);
      for await (const bytes of decodeDataUrl(input())) decoded = bytes;
      parts.push({ name: `attachment:${index}`, kind: 'attachment', bytes: decoded });
    }
  }
  return parts;
}
export async function importLegacyDrafts(store: DraftStore, record: ArchivedRecord): Promise<number> {
  if (record.metadata.hint.kind !== 'composer' && record.metadata.hint.kind !== 'question') return 0;
  let identity: DraftIdentity | null = null; let digest = new DraftDigest(); let bytes = 0; let chunks = 0; let count = 0;
  const traversal = crypto.randomUUID(); let pending: InlineDraft[] = [];
  const metadata = (key: string) => ({ sourceKey: record.metadata.sourceKey, legacyContext: key, kind: record.metadata.hint.kind, traversal });
  async function checkUnique(keys: readonly string[]): Promise<void> {
    if (new Set(keys).size !== keys.length) throw new DraftStorageError('corrupt');
    for (const previous of await store.readCheckpoints(keys)) if (typeof previous === 'object' && previous !== null && 'traversal' in previous && previous.traversal === traversal) throw new DraftStorageError('corrupt');
  }
  async function flushSmall(): Promise<void> {
    if (!pending.length) return;
    await checkUnique(pending.map(entry => entry.identity.context));
    await store.commitInlineBatch(pending); count += pending.length; pending = [];
  }
  for await (const entry of jsonEntries(readArchiveText(store, record.header))) {
    if (!identity) identity = { context: `unattached:${record.metadata.sourceKey}:${await legacyDigest(entry.key)}`, clientOrigin: `legacy:${record.header.sourceRevision}`, revision: 0 };
    if (entry.end && chunks === 0) {
      pending.push({ identity, parts: await smallDraftParts(entry.content), checkpoint: { key: identity.context, value: metadata(entry.key) } });
      identity = null; if (pending.length === 32) await flushSmall(); continue;
    }
    await flushSmall();
    const value = new TextEncoder().encode(entry.content); digest.update(value);
    await store.writeChunk(identity, { name: 'raw', kind: 'raw', index: chunks, bytes: value }); bytes += value.length; chunks++;
    if (entry.end) {
      const raw: DraftHeader = { ...identity, sourceRevision: record.header.sourceRevision, parts: [{ name: 'raw', kind: 'raw', bytes, chunks, sha256: digest.finish() }] };
      const previous = await store.header(identity);
      await checkUnique([identity.context]);
      if (previous) { if (previous.parts.find(part => part.name === 'raw')?.sha256 !== raw.parts[0].sha256) throw new DraftStorageError('conflict'); await store.commit(previous); }
      else await completeDraft(store, raw);
      await store.checkpoint(identity.context, metadata(entry.key));
      identity = null; digest = new DraftDigest(); bytes = 0; chunks = 0; count++;
    }
  }
  await flushSmall();
  return count;
}
export async function persistPendingLegacyWrite(store: DraftStore, write: PendingLegacyWrite): Promise<void> {
  const identity = { context: `pending:${await legacyDigest(JSON.stringify([write.channel, write.key]))}`, clientOrigin: write.clientOrigin, revision: write.revision };
  async function* input() {
    const text = write.value ?? '';
    for (let offset = 0; offset < text.length;) { let end = Math.min(offset + 16384, text.length); if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--; yield new TextEncoder().encode(text.slice(offset, end)); offset = end; }
  }
  const raw = await store.writePart(identity, { name: 'raw', kind: 'raw', input: input() });
  await store.commit({ ...identity, parts: [raw] });
  await store.checkpoint(identity.context + ':' + write.clientOrigin + ':' + write.revision, { channel: write.channel, key: write.key, removed: write.value === null });
}
