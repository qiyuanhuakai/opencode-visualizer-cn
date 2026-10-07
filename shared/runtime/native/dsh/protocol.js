import { jsonValue, ProtocolError } from '../../capabilities.js';
export { ProtocolError as DshError };
export const fail = (code, reason) => { throw new ProtocolError(code, `dsh.${reason}`); };
export function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request', 'object');
  return value;
}
export function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail('invalid_request', 'text');
  return value;
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_request', 'integer');
  return value;
}
export function request(method, args, rpcId) {
  if (!/^\$?[a-zA-Z][\w]*\/[a-zA-Z][\w]*$/.test(method)) fail('invalid_request', 'method');
  return { type: 'client-request', rpcId: text(rpcId), method, payload: { args: jsonValue(record(args)) } };
}
export function response(value, rpcId) {
  const envelope = record(value), result = record(envelope.result);
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof result.ok !== 'boolean') fail('invalid_request', 'envelope');
  if (!result.ok) {
    const code = text(record(result.error).code);
    const error = new ProtocolError(code === 'MISSING_CREDENTIAL' ? 'unauthorized' : 'source_unavailable', 'dsh.remote');
    error.remoteCode = /^[\w/-]{1,100}$/.test(code) ? code : 'unknown';
    throw error;
  }
  return jsonValue(result.value ?? null);
}
export function muxFrame(value) {
  const frame = record(jsonValue(value));
  text(frame.streamId);
  if (!['item', 'end', 'error'].includes(frame.type)) fail('invalid_request', 'mux');
  if (frame.type === 'error') text(record(frame.error).code);
  return frame;
}
export function approvalOutcome(value) {
  if (value === 'allowed-once' || value === 'rejected') return { kind: 'result', value };
  if (value === 'unavailable') return { kind: 'rejected', error: { name: 'Error', message: 'DSH interaction unavailable' } };
  fail('invalid_request', 'approval_outcome');
}
export function summaries(value, baseline, identity) {
  const items = record(value).items;
  const frame = record(baseline);
  if (frame.type !== 'baseline') fail('invalid_request', 'baseline');
  const workspaces = record(frame.value);
  if (!Array.isArray(items) || !Array.isArray(workspaces.items) || !Array.isArray(workspaces.archivedSessionIds) || !Array.isArray(workspaces.pinnedSessionIds)) fail('invalid_request', 'summary_list');
  const byId = new Map(), owner = new Map(), ids = new Set();
  for (const workspace of workspaces.items) {
    record(workspace); text(workspace.workspaceId);
    byId.set(workspace.workspaceId, workspace);
    for (const id of workspace.sessionIds ?? []) if (!owner.has(id)) owner.set(id, workspace);
  }
  const archived = new Set(workspaces.archivedSessionIds), pinned = new Set(workspaces.pinnedSessionIds);
  return items.map((item) => {
    record(item); const nativeSessionId = text(item.sessionId);
    if (ids.has(nativeSessionId)) fail('invalid_request', 'duplicate_session');
    ids.add(nativeSessionId);
    const workspace = item.workspaceId ? byId.get(text(item.workspaceId)) : owner.get(nativeSessionId);
    const values = item.projections?.values ?? {};
    return { session: { ...identity, nativeSessionId }, title: typeof values.title === 'string' ? values.title : '',
      directory: typeof workspace?.path === 'string' ? workspace.path : typeof item.cwd === 'string' ? item.cwd : null,
      workspaceId: item.workspaceId ?? workspace?.workspaceId ?? null, archived: archived.has(nativeSessionId), pinned: pinned.has(nativeSessionId),
      createdAt: item.createdAt ?? null, updatedAt: item.updatedAt ?? null };
  });
}
export function selectModel(catalog, selection) {
  record(selection); const model = text(selection.model);
  const groups = record(catalog).groups;
  if (!Array.isArray(groups)) fail('invalid_request', 'catalog');
  const matches = groups.flatMap((group) => {
    record(group); text(group.id);
    if (!Array.isArray(group.models)) fail('invalid_request', 'catalog');
    return group.models.filter((entry) => record(entry).id === model && (!selection.provider || selection.provider === group.id)).map(() => ({ provider: group.id, model }));
  });
  if (matches.length !== 1) fail('invalid_request', 'ambiguous_model');
  return { ...matches[0], ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: text(selection.reasoningEffort) }) };
}
