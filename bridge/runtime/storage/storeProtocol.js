import { jsonValue } from '../../../shared/runtime/capabilities.js';
import { ProtocolError } from '../../../shared/runtime/protocol.js';
import { parseEnvironmentId, parseInstanceId } from '../../../shared/runtime/identity.js';
export const COLLECTIONS = Object.freeze(['environments', 'harnesses', 'workspaces', 'session_summaries', 'threads', 'participants', 'turns', 'teams', 'tasks', 'attempts', 'interactions', 'artifacts', 'checkpoints', 'operations', 'imports', 'tombstones']);
export const STORE_LIMITS = Object.freeze({ requests: 256, bytes: 16 * 1024 * 1024, control: 16, controlBytes: 65536, reservedBytes: 1048576, requestBytes: 1024 * 1024, page: 100, maxPage: 200, pageBytes: 512 * 1024, chunkBytes: 65536 });
export class StoreError extends ProtocolError {
  constructor(code, reason) { super(code, `runtime.store.${reason}`); this.name = 'StoreError'; this.reason = reason; }
}
export function requireStore(condition, reason) { if (!condition) throw new StoreError('invalid_request', reason); }
export function text(value) { requireStore(typeof value === 'string' && value.length > 0 && value.length <= 4096, 'text'); return value; }
export function collection(value) { requireStore(COLLECTIONS.includes(value), 'collection'); return value; }
export function parseOptions(value) {
  requireStore(value !== null && typeof value === 'object' && !Array.isArray(value), 'options');
  try { parseEnvironmentId(value.environmentId); parseInstanceId(value.ownerId); parseInstanceId(value.epoch); }
  catch (error) { if (error instanceof TypeError) throw new StoreError('invalid_request', 'identity'); throw error; }
  text(value.stateDirectory);
  if (value.requestTimeoutMs !== undefined) requireStore(Number.isInteger(value.requestTimeoutMs) && value.requestTimeoutMs >= 100 && value.requestTimeoutMs <= 15000, 'request_timeout');
  if (value.storageBudgetBytes !== undefined) requireStore(Number.isSafeInteger(value.storageBudgetBytes) && value.storageBudgetBytes >= 131072, 'storage_budget');
  if (value.takeover) requireStore(Number.isSafeInteger(value.takeover.expectedFence) && value.takeover.expectedFence > 0, 'fence');
  return { stateDirectory: value.stateDirectory, environmentId: parseEnvironmentId(value.environmentId), ownerId: parseInstanceId(value.ownerId), epoch: parseInstanceId(value.epoch), ...(value.takeover ? { takeover: { expectedFence: value.takeover.expectedFence } } : {}), ...(value.installRoot ? { installRoot: text(value.installRoot) } : {}), ...(value.requestTimeoutMs ? { requestTimeoutMs: value.requestTimeoutMs } : {}), ...(value.storageBudgetBytes ? { storageBudgetBytes: value.storageBudgetBytes } : {}) };
}
export function parseRequest(method, input = {}) {
  requireStore(input !== null && typeof input === 'object' && !Array.isArray(input), 'params');
  let params;
  try { params = jsonValue(input); } catch (error) { if (error instanceof ProtocolError) throw new StoreError('invalid_request', 'json_value'); throw error; }
  requireStore(Buffer.byteLength(JSON.stringify(params)) <= STORE_LIMITS.requestBytes, 'request_size');
  switch (method) {
    case 'mutateControl':
      requireStore(Buffer.byteLength(JSON.stringify(params)) <= STORE_LIMITS.controlBytes, 'control_size');
      requireStore(Array.isArray(params.changes) && params.changes.every((change) => change !== null && typeof change === 'object' && ['interactions', 'operations'].includes(change.collection)), 'control_collection');
      // Only control-plane entities may consume reserved admission.
      return parseRequest('mutate', params);
    case 'readIntent': text(params.intentId); break;
    case 'mutate':
      text(params.intentId);
      requireStore(Array.isArray(params.changes) && params.changes.length > 0 && params.changes.length <= 200, 'changes');
      for (const change of params.changes) {
        requireStore(change !== null && typeof change === 'object' && !Array.isArray(change), 'change');
        collection(change.collection); text(change.key);
        requireStore(Object.hasOwn(change, 'value'), 'value');
        if (change.expectedRevision !== undefined) requireStore(Number.isSafeInteger(change.expectedRevision) && change.expectedRevision >= 0, 'revision');
      }
      break;
    case 'get': case 'readChunk':
      collection(params.collection); text(params.key);
      if (params.token !== undefined) text(params.token);
      if (method === 'readChunk') {
        requireStore(Number.isSafeInteger(params.revision) && params.revision > 0, 'revision');
        requireStore(Number.isSafeInteger(params.offset) && params.offset >= 0, 'offset');
      }
      break;
    case 'page': case 'snapshot':
      collection(params.collection);
      if (params.cursor !== undefined && params.cursor !== null) text(params.cursor);
      if (params.token !== undefined) text(params.token);
      if (params.limit !== undefined) requireStore(Number.isInteger(params.limit) && params.limit > 0 && params.limit <= STORE_LIMITS.maxPage, 'limit');
      break;
    case 'replay':
      text(params.epoch);
      requireStore(Number.isSafeInteger(params.after) && params.after >= 0, 'cursor');
      if (params.limit !== undefined) requireStore(Number.isInteger(params.limit) && params.limit > 0 && params.limit <= STORE_LIMITS.maxPage, 'limit');
      break;
    case 'inspect': case 'close': break;
    default: throw new StoreError('unsupported', 'method');
  }
  return params;
}
export function storageError(error) {
  if (error instanceof StoreError) return error;
  const reason = { 5: 'database_busy', 6: 'database_busy', 13: 'disk_full', 11: 'database_corrupt', 26: 'database_corrupt' }[error?.errcode & 255];
  return new StoreError('source_unavailable', reason ?? (error?.code === 'ENOSPC' ? 'disk_full' : 'storage_failure'));
}
