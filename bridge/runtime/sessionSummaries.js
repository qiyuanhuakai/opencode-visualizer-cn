import { parseEnvironmentId, parseHarnessInstanceId, parseInstanceId, parseSessionRef, encodeSessionKey } from '../../shared/runtime/identity.js';
import { StoreError } from './storage/storeProtocol.js';

const kinds = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'];
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('invalid_request', 'index_object');
  return value;
}
function text(value, maximum = 8192) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new StoreError('invalid_request', 'index_text');
  return value;
}
function optional(value, maximum) { return value == null ? null : text(value, maximum); }
function time(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return text(value, 128);
}
export function sourceIdentity(input) {
  if (!kinds.includes(input.kind)) throw new StoreError('unsupported', 'index_source_kind');
  return Object.freeze({ kind: input.kind, environmentId: parseEnvironmentId(input.environmentId), harnessInstanceId: parseHarnessInstanceId(input.harnessInstanceId) });
}
export function sourceAuthority(input) {
  const epoch = parseInstanceId(input.epoch);
  if (!Number.isSafeInteger(input.processGeneration) || input.processGeneration < 1) throw new StoreError('invalid_request', 'index_process_generation');
  return Object.freeze({ epoch, processGeneration: input.processGeneration });
}
export function sameAuthority(left, right) { return left.epoch === right.epoch && left.processGeneration === right.processGeneration; }
export function sessionSummary(source, input) {
  const row = record(input);
  const session = parseSessionRef(row.session);
  if (session.environmentId !== source.environmentId || session.harnessInstanceId !== source.harnessInstanceId) throw new StoreError('unauthorized', 'index_session_scope');
  text(session.nativeSessionId, 2048);
  let native = row;
  if (source.kind === 'opencode') native = record(row.summary);
  if (source.kind === 'acp') native = record(row.native);
  const directory = source.kind === 'codex' || source.kind === 'acp' ? native.cwd : native.directory;
  let parentSession = native.parentSession ?? null;
  if (source.kind === 'opencode' && native.parentID) parentSession = { ...session, nativeSessionId: text(native.parentID, 2048) };
  const spawn = source.kind === 'codex' ? native.source?.subAgent?.thread_spawn ?? native.source?.subAgent?.threadSpawn : undefined;
  const parent = spawn?.parent_thread_id ?? spawn?.parentThreadId;
  if (parent) parentSession = { ...session, nativeSessionId: text(parent, 2048) };
  if (parentSession !== null) {
    parentSession = parseSessionRef(parentSession);
    if (parentSession.environmentId !== source.environmentId || parentSession.harnessInstanceId !== source.harnessInstanceId) throw new StoreError('unauthorized', 'index_parent_scope');
  }
  const result = {
    session, title: text(native.title ?? ''), directory: optional(directory, 16384),
    archived: source.kind === 'opencode' ? native.time?.archived != null : native.archived === true,
    pinned: native.pinned === true, parentSession,
    createdAt: time(source.kind === 'opencode' ? native.time?.created : native.createdAt),
    updatedAt: time(source.kind === 'opencode' ? native.time?.updated : native.updatedAt),
    nativeWorkspaceId: optional(native.nativeWorkspaceId ?? native.workspaceId, 2048),
    nativeProjectId: optional(native.projectID, 2048),
    status: optional(native.status, 128), modelProvider: optional(native.modelProvider, 512),
    agentNickname: optional(native.agentNickname, 512), agentRole: optional(native.agentRole, 512),
    sourceKind: typeof native.source === 'string' ? text(native.source, 128) : native.source?.subAgent ? 'subAgent' : null,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 32768 || encodeSessionKey(session).length > 4096) throw new StoreError('source_unavailable', 'index_summary_budget');
  return Object.freeze(result);
}
export function discoveryScope(kind, input = {}) {
  record(input);
  const fields = ['directory', 'archived', ...(kind === 'opencode' ? ['projectID', 'parentID', 'roots'] : []), ...(kind === 'kimi-web' ? ['workspaceId'] : [])];
  const result = {};
  for (const key of Object.keys(input).sort()) {
    if (!fields.includes(key)) throw new StoreError('invalid_request', 'index_scope_field');
    if (['archived', 'roots'].includes(key)) {
      if (typeof input[key] !== 'boolean') throw new StoreError('invalid_request', 'index_scope_boolean');
      result[key] = input[key];
    } else result[key] = text(input[key], key === 'directory' ? 16384 : 2048);
  }
  if (result.roots === true && result.parentID !== undefined) throw new StoreError('invalid_request', 'index_scope_parent');
  return Object.freeze(result);
}
export function matchesScope(summary, scope) {
  return (scope.directory === undefined || summary.directory === scope.directory)
    && (scope.archived === undefined || summary.archived === scope.archived)
    && (scope.projectID === undefined || summary.nativeProjectId === scope.projectID)
    && (scope.workspaceId === undefined || summary.nativeWorkspaceId === scope.workspaceId)
    && (scope.parentID === undefined || summary.parentSession?.nativeSessionId === scope.parentID)
    && (scope.roots !== true || summary.parentSession === null);
}
export function nativePage(source, input) {
  const page = record(input);
  if (!Array.isArray(page.items) || page.items.length > 200) throw new StoreError('source_unavailable', 'index_native_page_budget');
  const completeness = source.kind === 'acp' ? page.status : page.completeness;
  if (!['complete', 'partial', 'unsupported'].includes(completeness)) throw new StoreError('invalid_request', 'index_completeness');
  const cursor = page.cursor == null ? null : text(page.cursor, 16384);
  if (cursor === '' || (cursor !== null && page.items.length === 0)) throw new StoreError('reconcile_required', 'index_cursor_progress');
  const items = page.items.map((item) => sessionSummary(source, item));
  if (Buffer.byteLength(JSON.stringify(items)) > 4194304) throw new StoreError('source_unavailable', 'index_page_bytes');
  const keys = items.map((item) => encodeSessionKey(item.session));
  if (new Set(keys).size !== keys.length) throw new StoreError('reconcile_required', 'index_duplicate_page');
  const result = { items, cursor, completeness: cursor === null ? completeness : 'partial', reason: page.reason == null ? cursor ? 'more_pages' : completeness === 'complete' ? 'native_exhausted' : 'native_partial' : text(page.reason, 1024) };
  if (page.total !== undefined) {
    if (!Number.isSafeInteger(page.total) || page.total < items.length) throw new StoreError('invalid_request', 'index_total');
    result.total = page.total;
  }
  if (page.epoch !== undefined || page.processGeneration !== undefined) result.authority = sourceAuthority(page);
  return result;
}
