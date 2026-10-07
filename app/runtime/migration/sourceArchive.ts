import type { LegacyExportChunk, LegacyExportPage, LegacyExportToken, LegacyPageRequest } from './legacyExport';
import { legacyDigest } from './legacyExport';
import { DraftStore, type DraftHeader } from '../draftStore';
import { DraftDigest, DraftStorageError } from './draftChunks';
import { bindLegacySource, type LegacyBinding, type LocalBindingHint, type ProvenMapping } from './legacyBinding';
export interface LegacySourcePort {
  open(): Promise<LegacyExportToken>;
  page(request: LegacyPageRequest): Promise<LegacyExportPage>;
  binding(sourceKey: string): Promise<LocalBindingHint>;
}
export type ArchiveMetadata = Readonly<{ sourceKey: string; source: string; namespace: string; authority: string; binding: LegacyBinding; hint: LocalBindingHint }>;
export type ArchivedRecord = Readonly<{ header: DraftHeader; metadata: ArchiveMetadata }>;
export function archiveContext(revision: string, sourceKey: string): string { return `legacy-raw:${revision}:${sourceKey}`; }
export async function* readArchiveText(store: DraftStore, header: DraftHeader): AsyncGenerator<string> {
  const part = header.parts.find(entry => entry.name === 'raw');
  if (!part) throw new DraftStorageError('corrupt');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const bytes of store.readPart(header, part)) yield decoder.decode(bytes, { stream: true });
  yield decoder.decode();
}
export async function* archivedRecords(store: DraftStore, revision: string): AsyncGenerator<ArchivedRecord> {
  let after: string | undefined;
  do {
    const page = await store.page({ after, limit: 100 });
    for (const header of page.headers) {
      if (!header.context.startsWith(`legacy-raw:${revision}:`)) continue;
      const metadata: unknown = await store.readCheckpoint(header.context);
      if (typeof metadata !== 'object' || metadata === null || !('sourceKey' in metadata) || typeof metadata.sourceKey !== 'string'
        || !('source' in metadata) || typeof metadata.source !== 'string' || !('namespace' in metadata) || typeof metadata.namespace !== 'string'
        || !('authority' in metadata) || typeof metadata.authority !== 'string' || !('hint' in metadata) || typeof metadata.hint !== 'object' || metadata.hint === null
        || !('sourceKey' in metadata.hint) || metadata.hint.sourceKey !== metadata.sourceKey || !('binding' in metadata)
        || header.context !== archiveContext(revision, metadata.sourceKey)) throw new DraftStorageError('corrupt');
      // Routing is recomputed from current proven mappings; archived binding is provenance only.
      yield { header, metadata: { sourceKey: metadata.sourceKey, source: metadata.source, namespace: metadata.namespace, authority: metadata.authority,
        hint: { sourceKey: metadata.sourceKey, ...('kind' in metadata.hint && ['composer', 'question'].includes(String(metadata.hint.kind)) ? { kind: metadata.hint.kind === 'composer' ? 'composer' : 'question' } : {}),
          ...('nativeSessionId' in metadata.hint && typeof metadata.hint.nativeSessionId === 'string' ? { nativeSessionId: metadata.hint.nativeSessionId } : {}),
          ...('scopeFingerprint' in metadata.hint && typeof metadata.hint.scopeFingerprint === 'string' ? { scopeFingerprint: metadata.hint.scopeFingerprint } : {}) },
        binding: { kind: 'unattached', sourceKey: metadata.sourceKey } } };
    }
    after = page.next ?? undefined;
  } while (after);
}
export async function archiveLegacySource(options: Readonly<{ source: LegacySourcePort; store: DraftStore; token: LegacyExportToken; mappings: readonly ProvenMapping[] }>): Promise<Readonly<{ records: number; chunks: number; boundRecords: number; boundChunks: number }>> {
  const { source, store, token, mappings } = options;
  let next: LegacyExportToken | null = token; let records = 0; let chunks = 0; let boundRecords = 0; let boundChunks = 0;
  let current: { first: LegacyExportChunk; digest: DraftDigest; bytes: number; chunks: number; hint: LocalBindingHint; binding: LegacyBinding } | null = null;
  do {
    const page = await source.page({ token: next, limit: 8 });
    if (page.revision !== token.revision || page.next && (page.next.offset <= next.offset || page.next.revision !== token.revision)) throw new DraftStorageError('corrupt');
    for (const chunk of page.chunks) {
      if (!current) { const hint = await source.binding(chunk.sourceKey); current = { first: chunk, digest: new DraftDigest(), bytes: 0, chunks: 0, hint, binding: bindLegacySource(hint, mappings) }; }
      if (chunk.sourceKey !== current.first.sourceKey || chunk.offset !== current.bytes || chunk.authority !== current.first.authority || await legacyDigest(chunk.content) !== chunk.checksum) throw new DraftStorageError('corrupt');
      const bytes = new TextEncoder().encode(chunk.content); current.digest.update(bytes);
      const identity = { context: archiveContext(token.revision, chunk.sourceKey), clientOrigin: 'legacy-source', revision: 0 };
      await store.writeChunk(identity, { name: 'raw', kind: 'raw', index: current.chunks, bytes }); current.bytes += bytes.length; current.chunks++; chunks++;
      if (current.binding.kind === 'bound') boundChunks++;
      if (chunk.end) {
        const header: DraftHeader = { ...identity, sourceRevision: token.revision, parts: [{ name: 'raw', kind: 'raw', bytes: current.bytes, chunks: current.chunks, sha256: current.digest.finish() }] };
        await store.commit(header);
        await store.checkpoint(identity.context, { sourceKey: chunk.sourceKey, source: chunk.source, namespace: chunk.namespace, authority: chunk.authority, hint: current.hint, binding: current.binding } satisfies ArchiveMetadata);
        if (current.binding.kind === 'bound') boundRecords++; records++; current = null;
      }
    }
    await store.checkpoint(`source-progress:${token.revision}`, { offset: page.next?.offset ?? token.count, count: token.count, records, chunks });
    next = page.next;
  } while (next);
  if (current || records !== token.exportableRecords) throw new DraftStorageError('corrupt');
  return { records, chunks, boundRecords, boundChunks };
}
