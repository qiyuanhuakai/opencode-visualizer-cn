import { admissionDigest, admissionKey, admissionSeed, bindingValue, chunkDigest, chunkKey, continueChunk, digest, exact, hashValue,
  ImportError, nonnegative, readImportValue, validateAdmission, validateBatch, validateChunk } from './manifest.js';

function validateManifest(value, environmentId) {
  if (!exact(value, ['sourceRevision', 'environmentId', 'offset', 'total', 'continuation', 'records', 'chunks', 'bytes', 'phase', 'admissionHash', 'admissions', 'verification'])
    || !hashValue(value.sourceRevision) || value.environmentId !== environmentId || !hashValue(value.admissionHash)
    || ![value.offset, value.total, value.records, value.chunks, value.bytes, value.admissions].every(nonnegative)
    || value.offset > value.total || value.chunks !== value.offset || value.records > value.chunks || value.admissions > value.chunks
    || !['staged', 'verified'].includes(value.phase)
    || (value.phase === 'staged' ? value.verification !== null : !exact(value.verification, ['manifestRevision', 'stateHash'])
      || !nonnegative(value.verification.manifestRevision) || !hashValue(value.verification.stateHash))) throw new ImportError('corrupt_import');
  if (value.continuation !== null && (!exact(value.continuation, ['sourceKey', 'offset', 'authority', 'binding'])
    || !hashValue(value.continuation.sourceKey) || !nonnegative(value.continuation.offset)
    || typeof value.continuation.authority !== 'string'
    || !exact(value.continuation.binding, ['environmentId', 'harnessInstanceId', 'nativeSessionId', 'profileId'])
    || bindingValue(value.continuation.binding).some(part => typeof part !== 'string'))) throw new ImportError('corrupt_import');
}

async function verifyCurrent(store, environmentId, importId, manifest, snapshotRevision) {
  let offset = 0; let records = 0; let chunks = 0; let bytes = 0; let admissions = 0; let continuation = null;
  let chain = admissionSeed(importId, manifest.sourceRevision, environmentId, manifest.total);
  let stateHash = chain;
  while (offset < manifest.total) {
    const key = admissionKey(importId, offset); const row = await store.get({ collection: 'imports', key });
    if (!row || !Number.isSafeInteger(row.revision) || row.revision <= 0 || row.revision > snapshotRevision) throw new ImportError('corrupt_import');
    const admission = await readImportValue(store, row); validateAdmission(admission);
    if (admission.importId !== importId || admission.environmentId !== environmentId || admission.sourceRevision !== manifest.sourceRevision
      || admission.offset !== offset || admission.total !== manifest.total || admission.previousHash !== chain) throw new ImportError('corrupt_import');
    chain = admissionDigest(admission); stateHash = digest(JSON.stringify([stateHash, key, row.revision, chain]));
    for (const entry of admission.entries) {
      const stored = await store.get({ collection: 'imports', key: entry.key });
      if (!stored || !Number.isSafeInteger(stored.revision) || stored.revision <= 0 || stored.revision > snapshotRevision) throw new ImportError('corrupt_import');
      const chunk = await readImportValue(store, stored);
      try { validateChunk(chunk, environmentId); continuation = continueChunk(continuation, chunk); }
      catch (error) { if (error instanceof ImportError) throw new ImportError('corrupt_import'); throw error; }
      if (stored.key !== chunkKey(importId, chunk) || entry.bytes !== Buffer.byteLength(chunk.content) || entry.digest !== chunkDigest(chunk)) throw new ImportError('corrupt_import');
      stateHash = digest(JSON.stringify([stateHash, stored.key, stored.revision, entry.digest]));
      chunks++; bytes += entry.bytes; if (chunk.end) records++;
    }
    offset = admission.nextOffset; admissions++;
  }
  if (chain !== manifest.admissionHash || continuation !== null || records !== manifest.records || chunks !== manifest.chunks
    || bytes !== manifest.bytes || admissions !== manifest.admissions) throw new ImportError('corrupt_import');
  let cursor; let actualChunks = 0; let actualAdmissions = 0;
  do {
    const page = await store.page({ collection: 'imports', ...(cursor ? { cursor } : {}), limit: 100 });
    for (const row of page.items) {
      if (row.key.startsWith(`chunk:${importId}:`)) actualChunks++;
      if (row.key.startsWith(`admission:${importId}:`)) actualAdmissions++;
    }
    cursor = page.cursor;
  } while (cursor);
  if (actualChunks !== chunks || actualAdmissions !== admissions) throw new ImportError('corrupt_import');
  return stateHash;
}

export function createImportService({ store, environmentId }) {
  const ready = store.ready.then(inspection => { if (inspection.environment !== environmentId) throw new ImportError('target_changed'); });
  return {
    async accept(batch) {
      await ready; validateBatch(batch, environmentId);
      const intentId = `import:${batch.importId}:${batch.offset}:${digest(JSON.stringify(batch))}`;
      const known = await store.readIntent({ intentId }); if (known) return known;
      const key = `manifest:${batch.importId}`;
      const previous = await store.get({ collection: 'imports', key }); const value = previous?.value;
      if (previous) validateManifest(value, environmentId);
      if (previous && (value.sourceRevision !== batch.sourceRevision || value.offset !== batch.offset || value.total !== batch.total
        || value.environmentId !== environmentId || value.phase !== 'staged') || !previous && batch.offset !== 0) {
        const accepted = await store.readIntent({ intentId }); if (accepted) return accepted;
        throw new ImportError('source_revision_conflict');
      }
      let continuation = value?.continuation ?? null;
      for (const chunk of batch.chunks) continuation = continueChunk(continuation, chunk);
      const admission = { importId: batch.importId, environmentId, sourceRevision: batch.sourceRevision, offset: batch.offset, nextOffset: batch.nextOffset,
        total: batch.total, previousHash: value?.admissionHash ?? admissionSeed(batch.importId, batch.sourceRevision, environmentId, batch.total),
        entries: batch.chunks.map(chunk => ({ key: chunkKey(batch.importId, chunk), bytes: Buffer.byteLength(chunk.content), digest: chunkDigest(chunk) })) };
      validateAdmission(admission);
      const changes = batch.chunks.map(chunk => ({ collection: 'imports', key: chunkKey(batch.importId, chunk), value: chunk, expectedRevision: 0 }));
      changes.push({ collection: 'imports', key: admissionKey(batch.importId, batch.offset), expectedRevision: 0, value: admission });
      changes.push({ collection: 'imports', key, expectedRevision: previous?.revision ?? 0,
        value: { sourceRevision: batch.sourceRevision, environmentId, offset: batch.nextOffset, total: batch.total, continuation,
          records: (value?.records ?? 0) + batch.chunks.filter(chunk => chunk.end).length,
          chunks: (value?.chunks ?? 0) + batch.chunks.length, bytes: (value?.bytes ?? 0) + admission.entries.reduce((sum, entry) => sum + entry.bytes, 0),
          admissions: (value?.admissions ?? 0) + 1, admissionHash: admissionDigest(admission), phase: 'staged', verification: null } });
      try { return await store.mutate({ intentId, changes }); }
      catch (error) { const accepted = await store.readIntent({ intentId }); if (accepted) return accepted; throw error; }
    },
    async verify({ importId, sourceRevision, expectedRecords, expectedChunks }) {
      await ready;
      if (!hashValue(importId) || !hashValue(sourceRevision) || !nonnegative(expectedRecords) || !nonnegative(expectedChunks)) throw new ImportError('incomplete_import');
      const before = await store.inspect();
      const key = `manifest:${importId}`; const item = await store.get({ collection: 'imports', key });
      if (!item) throw new ImportError('incomplete_import');
      let written;
      try {
        validateManifest(item.value, environmentId);
        if (!Number.isSafeInteger(item.revision) || item.revision <= 0 || item.revision > before.revision) throw new ImportError('corrupt_import');
        if (item.value.offset !== item.value.total || item.value.continuation !== null) throw new ImportError(item.value.phase === 'verified' ? 'corrupt_import' : 'incomplete_import');
        const stateHash = await verifyCurrent(store, environmentId, importId, item.value, before.revision);
        if (item.value.sourceRevision !== sourceRevision || item.value.records !== expectedRecords || item.value.chunks !== expectedChunks) throw new ImportError('incomplete_import');
        if ((await store.inspect()).revision !== before.revision) throw new ImportError('source_revision_conflict');
        if (item.value.phase === 'verified' && item.value.verification.stateHash === stateHash) {
          const known = await store.readIntent({ intentId: `verify:${importId}:${sourceRevision}:${item.value.verification.manifestRevision}:${stateHash}` });
          if (known?.revision === item.revision) {
            if ((await store.inspect()).revision !== before.revision) throw new ImportError('source_revision_conflict');
            return known;
          }
        }
        const intentId = `verify:${importId}:${sourceRevision}:${item.revision}:${stateHash}`;
        written = await store.mutate({ intentId, changes: [{ collection: 'imports', key, expectedRevision: item.revision,
          value: { ...item.value, phase: 'verified', verification: { manifestRevision: item.revision, stateHash } } }] });
        if (written.revision !== before.revision + 1 || (await store.inspect()).revision !== written.revision) throw new ImportError('source_revision_conflict');
        return written;
      } catch (error) {
        if (written || item.value?.phase === 'verified' && error instanceof ImportError && ['corrupt_import', 'source_revision_conflict'].includes(error.code)) {
          await store.mutate({ intentId: `invalidate:${importId}:${written?.revision ?? item.revision}`, changes: [{ collection: 'imports', key,
            expectedRevision: written?.revision ?? item.revision, value: { ...item.value, phase: 'staged', verification: null } }] });
        }
        throw error;
      }
    },
  };
}
