import type { ImportChunk, ImportService } from '../../../bridge/runtime/migration/importService.js';
import { DraftStore } from '../draftStore';
import { legacyDigest } from './legacyExport';
import { bindLegacySource, type ProvenMapping } from './legacyBinding';
import { archiveLegacySource, archivedRecords, type LegacySourcePort } from './sourceArchive';
import { importLegacyDrafts, persistPendingLegacyWrite } from './draftImport';
import { completeLegacyCutover, flushFrozenLegacyWrites, freezeLegacyWriters, legacyWriterPhase, retryFrozenLegacyWrites } from './writerFreeze';
export class ImportCoordinatorError extends Error {
  constructor(readonly code: 'target_changed' | 'source_changed' | 'incomplete_import') { super(code); this.name = 'ImportCoordinatorError'; }
}
export type ImportResult = Readonly<{ importId: string; sourceRevision: string; records: number; chunks: number; drafts: number; boundRecords: number; localOnlyRecords: number; phase: 'cutover' }>;
export type ImportCoordinatorOptions = Readonly<{
  source: LegacySourcePort; local: DraftStore; target: Readonly<{ environmentId: string; service: ImportService }>;
  currentEnvironment: () => string | null; mappings: readonly ProvenMapping[]; clientOrigin: string;
}>;
export function createImportCoordinator(options: ImportCoordinatorOptions) {
  const { source, local, target, currentEnvironment, clientOrigin } = options;
  // Capture routing for the whole attempt. An edited profile requires another attempt.
  const mappings = structuredClone(options.mappings);
  const assertTarget = () => { if (currentEnvironment() !== target.environmentId) throw new ImportCoordinatorError('target_changed'); };
  async function sourceMatches(revision: string): Promise<void> {
    if ((await source.open()).revision !== revision) throw new ImportCoordinatorError('source_changed');
  }
  return {
    async run(): Promise<ImportResult> {
      assertTarget();
      switch (legacyWriterPhase()) {
        case 'legacy': await freezeLegacyWriters({ clientOrigin, persist: write => persistPendingLegacyWrite(local, write) }); break;
        case 'paused': await local.retry(); await retryFrozenLegacyWrites(); break;
        case 'frozen': case 'cutover': break;
        case 'draining': throw new ImportCoordinatorError('incomplete_import');
        default: throw new ImportCoordinatorError('incomplete_import');
      }
      const token = await source.open();
      const mappingIdentity = mappings.map(mapping => JSON.stringify([mapping.profileId, mapping.environmentId, mapping.harnessInstanceId, mapping.nativeSessionId, mapping.scopeFingerprint, mapping.evidence])).sort();
      const importId = await legacyDigest(JSON.stringify([token.revision, target.environmentId, mappingIdentity]));
      await local.checkpoint('migration-active', { importId, sourceRevision: token.revision, environmentId: target.environmentId, phase: 'staging' });
      const inventory = await archiveLegacySource({ source, store: local, token, mappings });
      let drafts = 0;
      for await (const record of archivedRecords(local, token.revision)) drafts += await importLegacyDrafts(local, record);
      // Trial restore traverses the actual persisted bytes before any target acknowledgement or cutover.
      let restoredRecords = 0; let restoredChunks = 0;
      for await (const record of archivedRecords(local, token.revision)) {
        const raw = record.header.parts.find(part => part.name === 'raw');
        if (!raw) throw new ImportCoordinatorError('incomplete_import');
        await local.commit(record.header); restoredRecords++; restoredChunks += raw.chunks;
      }
      if (restoredRecords !== inventory.records || restoredChunks !== inventory.chunks) throw new ImportCoordinatorError('incomplete_import');
      await local.checkpoint(`backup:${importId}`, { token, inventory, drafts, trialRestore: { records: restoredRecords, chunks: restoredChunks }, sourceRetained: true });
      assertTarget(); await sourceMatches(token.revision);
      let offset = 0; let batch: ImportChunk[] = [];
      async function sendBatch(): Promise<void> {
        if (!batch.length) return;
        assertTarget();
        await target.service.accept({ importId, environmentId: target.environmentId, sourceRevision: token.revision, offset, nextOffset: offset + batch.length, total: inventory.boundChunks, chunks: batch });
        assertTarget(); offset += batch.length; batch = [];
        await local.checkpoint(`target-progress:${importId}`, { offset, total: inventory.boundChunks });
      }
      for await (const record of archivedRecords(local, token.revision)) {
        const binding = bindLegacySource(record.metadata.hint, mappings);
        if (binding.kind === 'unattached') continue;
        if (binding.binding.environmentId !== target.environmentId) throw new ImportCoordinatorError('target_changed');
        const raw = record.header.parts.find(part => part.name === 'raw');
        if (!raw) throw new ImportCoordinatorError('incomplete_import');
        let byteOffset = 0; let index = 0;
        for await (const bytes of local.readPart(record.header, raw)) {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          batch.push({ sourceKey: record.metadata.sourceKey, offset: byteOffset, content, checksum: await legacyDigest(content), end: ++index === raw.chunks,
            authority: record.metadata.authority, binding: binding.binding }); byteOffset += bytes.length;
          if (batch.length === 8) await sendBatch();
        }
      }
      await sendBatch();
      if (inventory.boundChunks) { assertTarget(); await target.service.verify({ importId, sourceRevision: token.revision, expectedRecords: inventory.boundRecords, expectedChunks: inventory.boundChunks }); }
      assertTarget(); await sourceMatches(token.revision); await flushFrozenLegacyWrites();
      const result: ImportResult = { importId, sourceRevision: token.revision, records: inventory.records, chunks: inventory.chunks, drafts, boundRecords: inventory.boundRecords, localOnlyRecords: token.localOnlyRecords, phase: 'cutover' };
      await local.checkpoint('migration-active', { ...result, environmentId: target.environmentId });
      try { await sourceMatches(token.revision); assertTarget(); }
      catch (error) { await local.checkpoint('migration-active', { importId, sourceRevision: token.revision, phase: 'reconcile' }); throw error; }
      await completeLegacyCutover(); return result;
    },
    async cutoverStatus(): Promise<unknown> {
      const checkpoint = await local.readCheckpoint('migration-active');
      if (typeof checkpoint === 'object' && checkpoint !== null && 'phase' in checkpoint && checkpoint.phase === 'cutover') {
        if (!('environmentId' in checkpoint) || checkpoint.environmentId !== target.environmentId) throw new ImportCoordinatorError('target_changed');
        if (!('sourceRevision' in checkpoint) || typeof checkpoint.sourceRevision !== 'string') throw new ImportCoordinatorError('incomplete_import');
        await sourceMatches(checkpoint.sourceRevision); assertTarget();
      }
      return checkpoint;
    },
  };
}
