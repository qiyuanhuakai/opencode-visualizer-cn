import { requireValue, objectFields, integerValue, textValue } from './capabilities.js';
import { parseSessionRef } from './identity.js';

export const HISTORY_LIMITS = Object.freeze({ recordsPerPage: 200, logicalInlineBytesPerPage: 2097152, encodedResultBytes: 524288, decodedChunkBytes: 65536, selectedPages: 3, clientResidentAndPendingBytes: 16777216, inlineBytes: 32768, nodes: 4096, depth: 16, readTimeoutMs: 10000, tombstones: 1024 });
const encoder = new TextEncoder();
const uuid = value => requireValue(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'history.id');
function bounded(input) {
  let nodes = 0, units = 0;
  function textBudget(value) { units += value.length; requireValue(units <= HISTORY_LIMITS.encodedResultBytes, 'history.encoded_size'); }
  function visit(value, depth) {
    requireValue(++nodes <= HISTORY_LIMITS.nodes && depth <= HISTORY_LIMITS.depth, 'history.structure');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { textBudget(value); return value; }
    if (typeof value === 'number') { requireValue(Number.isFinite(value), 'history.number'); return value; }
    requireValue(typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'history.object');
    const keys = Reflect.ownKeys(value);
    requireValue(keys.length <= HISTORY_LIMITS.nodes && keys.every(key => typeof key === 'string' && (Array.isArray(value) && key === 'length' || Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))), 'history.fields');
    if (Array.isArray(value)) {
      requireValue(keys.length === value.length + 1, 'history.array');
      return Object.freeze(Array.from(value, item => visit(item, depth + 1)));
    }
    return Object.freeze(Object.fromEntries(keys.map(key => { textBudget(key); return [key, visit(value[key], depth + 1)]; })));
  }
  const value = visit(input, 0);
  requireValue(encoder.encode(JSON.stringify(value)).length <= HISTORY_LIMITS.encodedResultBytes, 'history.encoded_size');
  return value;
}
function fence(value) {
  objectFields(value, ['id', 'sourceGeneration']); uuid(value.id);
  if (typeof value.sourceGeneration === 'string') textValue(value.sourceGeneration, 'history.sourceGeneration');
  else integerValue(value.sourceGeneration, 'history.sourceGeneration');
}
function common(value, session = false) {
  uuid(value.historyId); fence(value.fence);
  if (session) { parseSessionRef(value.session); textValue(value.session.nativeSessionId, 'history.nativeSessionId'); }
  if (value.reason !== undefined) textValue(value.reason, 'history.reason');
}
export function parseHistoryOpen(input) {
  const value = objectFields(bounded(input), ['historyId', 'session', 'fence', 'capabilities'], ['reason']); common(value, true);
  objectFields(value.capabilities, ['archive', 'recordStream', 'live']);
  requireValue(['paged', 'live-only', 'unsupported'].includes(value.capabilities.archive) && typeof value.capabilities.recordStream === 'boolean' && ['invalidate', 'unsupported'].includes(value.capabilities.live), 'history.capabilities');
  return value;
}
export function parseHistoryPage(input) {
  const value = objectFields(bounded(input), ['historyId', 'session', 'fence', 'pageId', 'items', 'cursor', 'completeness'], ['reason', 'document']); common(value, true); uuid(value.pageId);
  requireValue(Array.isArray(value.items) && value.items.length <= HISTORY_LIMITS.recordsPerPage, 'history.records');
  if (value.cursor !== null) uuid(value.cursor);
  requireValue(['complete', 'partial', 'unsupported'].includes(value.completeness), 'history.completeness');
  requireValue(value.completeness !== 'unsupported' || value.items.length === 0 && value.cursor === null && value.document === undefined, 'history.unsupported');
  requireValue(value.completeness !== 'complete' || value.cursor === null, 'history.complete_cursor');
  const ids = new Set(), descriptors = new Set();
  let inlineBytes = 0;
  function validateDescriptor(descriptor) {
    objectFields(descriptor, ['id', 'format', 'totalBytes', 'sha256'], ['preview']); uuid(descriptor.id);
    requireValue(!descriptors.has(descriptor.id), 'history.duplicate_descriptor'); descriptors.add(descriptor.id);
    requireValue(descriptor.format === 'native-json-utf8', 'history.format'); integerValue(descriptor.totalBytes, 'history.totalBytes');
    requireValue(descriptor.totalBytes > 0 && typeof descriptor.sha256 === 'string' && /^[a-f0-9]{64}$/.test(descriptor.sha256), 'history.descriptor');
    if (descriptor.preview !== undefined) textValue(descriptor.preview, 'history.preview');
  }
  if (value.document !== undefined) validateDescriptor(value.document);
  for (const item of value.items) {
    textValue(item.recordId, 'history.recordId'); requireValue(!ids.has(item.recordId), 'history.duplicate_record'); ids.add(item.recordId);
    switch (item.kind) {
      case 'inline': {
        objectFields(item, ['recordId', 'kind', 'value']);
        const bytes = encoder.encode(JSON.stringify(item.value)).length;
        requireValue(bytes <= HISTORY_LIMITS.inlineBytes, 'history.inline'); inlineBytes += bytes; break;
      }
      case 'stream': {
        objectFields(item, ['recordId', 'kind', 'descriptor']); validateDescriptor(item.descriptor); break;
      }
      default: requireValue(false, 'history.item');
    }
  }
  requireValue(inlineBytes <= HISTORY_LIMITS.logicalInlineBytesPerPage, 'history.inline_page');
  return value;
}
export function parseHistoryChunk(input) {
  const value = objectFields(bounded(input), ['historyId', 'fence', 'pageId', 'descriptorId', 'offset', 'totalBytes', 'sha256', 'data', 'nextOffset']); common(value); uuid(value.pageId); uuid(value.descriptorId);
  integerValue(value.offset, 'history.offset'); integerValue(value.totalBytes, 'history.totalBytes');
  requireValue(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'history.sha256');
  requireValue(typeof value.data === 'string' && value.data.length <= 87384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data), 'history.base64');
  const bytes = atob(value.data); requireValue(btoa(bytes) === value.data && bytes.length > 0 && bytes.length <= HISTORY_LIMITS.decodedChunkBytes, 'history.chunk_size');
  const end = value.offset + bytes.length;
  requireValue(end <= value.totalBytes && value.nextOffset === (end === value.totalBytes ? null : end), 'history.chunk_range');
  return value;
}
export function parseHistoryChange(input) {
  const value = objectFields(bounded(input), ['historyId', 'fence', 'through', 'changed', 'status'], ['reason']); common(value);
  integerValue(value.through, 'history.through');
  requireValue(typeof value.changed === 'boolean' && ['current', 'replay_required', 'source_unavailable'].includes(value.status), 'history.change');
  return value;
}
