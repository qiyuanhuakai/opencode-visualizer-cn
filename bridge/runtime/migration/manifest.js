import { createHash } from 'node:crypto';
import { parseConnectionProfileId, parseSessionRef } from '../../../shared/runtime/identity.js';
export class ImportError extends Error {
  constructor(code) { super(code); this.name = 'ImportError'; this.code = code; }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
export const bindingValue = binding => [binding.environmentId, binding.harnessInstanceId, binding.nativeSessionId, binding.profileId];
export const chunkKey = (importId, chunk) => `chunk:${importId}:${chunk.sourceKey}:${String(chunk.offset).padStart(16, '0')}`;
export const admissionKey = (importId, offset) => `admission:${importId}:${String(offset).padStart(16, '0')}`;
export const admissionSeed = (importId, sourceRevision, environmentId, total) => digest(JSON.stringify([importId, sourceRevision, environmentId, total]));
export function validateChunk(chunk, environmentId) {
  if (!exact(chunk, ['sourceKey', 'offset', 'content', 'end', 'checksum', 'authority', 'binding'])
    || !hashValue(chunk.sourceKey) || typeof chunk.content !== 'string' || Buffer.byteLength(chunk.content) > 65536
    || !nonnegative(chunk.offset) || !nonnegative(chunk.offset + Buffer.byteLength(chunk.content)) || typeof chunk.end !== 'boolean'
    || typeof chunk.authority !== 'string' || chunk.authority.length > 64 || digest(chunk.content) !== chunk.checksum
    || !exact(chunk.binding, ['environmentId', 'harnessInstanceId', 'nativeSessionId', 'profileId'])
    || chunk.binding.environmentId !== environmentId) throw new ImportError('invalid_chunk');
  try {
    parseConnectionProfileId(chunk.binding.profileId);
    parseSessionRef({ environmentId, harnessInstanceId: chunk.binding.harnessInstanceId, nativeSessionId: chunk.binding.nativeSessionId });
  } catch (error) { if (error instanceof TypeError) throw new ImportError('invalid_chunk'); throw error; }
}
export function chunkDigest(chunk) {
  return digest(JSON.stringify([chunk.sourceKey, chunk.offset, Buffer.byteLength(chunk.content), chunk.checksum, chunk.end, chunk.authority, bindingValue(chunk.binding)]));
}
export function continueChunk(continuation, chunk) {
  if (continuation ? chunk.sourceKey !== continuation.sourceKey || chunk.offset !== continuation.offset || chunk.authority !== continuation.authority
    || JSON.stringify(bindingValue(chunk.binding)) !== JSON.stringify(bindingValue(continuation.binding)) : chunk.offset !== 0) throw new ImportError('chunk_sequence');
  return chunk.end ? null : { sourceKey: chunk.sourceKey, offset: chunk.offset + Buffer.byteLength(chunk.content), authority: chunk.authority, binding: chunk.binding };
}
export function admissionDigest(admission) {
  return digest(JSON.stringify([admission.importId, admission.environmentId, admission.sourceRevision, admission.offset, admission.nextOffset,
    admission.total, admission.previousHash, admission.entries.map(entry => [entry.key, entry.bytes, entry.digest])]));
}
export function validateAdmission(admission) {
  if (!exact(admission, ['importId', 'environmentId', 'sourceRevision', 'offset', 'nextOffset', 'total', 'previousHash', 'entries'])
    || !hashValue(admission.importId) || !hashValue(admission.sourceRevision) || !hashValue(admission.previousHash)
    || ![admission.offset, admission.nextOffset, admission.total].every(nonnegative)
    || admission.nextOffset <= admission.offset || admission.nextOffset > admission.total
    || !Array.isArray(admission.entries) || admission.entries.length > 100 || admission.entries.length !== admission.nextOffset - admission.offset
    || admission.entries.some(entry => !exact(entry, ['key', 'bytes', 'digest']) || typeof entry.key !== 'string' || entry.key.length > 160
      || !nonnegative(entry.bytes) || entry.bytes > 65536 || !hashValue(entry.digest))
    || Buffer.byteLength(JSON.stringify(admission)) > 65536) throw new ImportError('corrupt_import');
}
export function validateBatch(batch, environmentId) {
  if (batch?.environmentId !== environmentId) throw new ImportError('target_changed');
  if (!exact(batch, ['importId', 'environmentId', 'sourceRevision', 'offset', 'nextOffset', 'total', 'chunks'])
    || !/^[a-f0-9]{64}$/u.test(batch.importId) || !/^[a-f0-9]{64}$/u.test(batch.sourceRevision)
    || ![batch.offset, batch.nextOffset, batch.total].every(value => Number.isSafeInteger(value) && value >= 0)
    || batch.nextOffset <= batch.offset || batch.nextOffset > batch.total || batch.nextOffset - batch.offset > 100
    || !Array.isArray(batch.chunks) || batch.chunks.length !== batch.nextOffset - batch.offset) throw new ImportError('invalid_batch');
  for (const chunk of batch.chunks) validateChunk(chunk, environmentId);
  if (Buffer.byteLength(JSON.stringify(batch)) > 900000) throw new ImportError('batch_too_large');
}
export async function readImportValue(store, item) {
  if (item.value !== undefined) return item.value;
  if (!item.chunked || item.bytes > 900000) throw new ImportError('corrupt_import');
  const chunks = []; let offset = 0;
  do { const chunk = await store.readChunk({ collection: 'imports', key: item.key, revision: item.revision, offset }); chunks.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset; } while (offset !== null);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
