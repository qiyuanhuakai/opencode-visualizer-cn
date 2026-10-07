import { ProtocolError, jsonValue } from '../../capabilities.js';

export function record(value, reason = 'native_object') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError('invalid_request', reason);
  return value;
}
export function nativeText(value, reason = 'native_text', maximum = 8192) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0'))
    throw new ProtocolError('invalid_request', reason);
  return value;
}
export function nativeInteger(value, reason = 'native_integer') {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError('invalid_request', reason);
  return value;
}
export function pageSize(value) {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw new ProtocolError('invalid_request', 'page_size');
  return value;
}
export function parseFrame(value) {
  const frame = record(jsonValue(value), 'native_frame');
  nativeText(frame.type, 'native_frame_type', 128);
  if (frame.seq !== undefined) nativeInteger(frame.seq, 'native_sequence');
  if (frame.epoch !== undefined) nativeText(frame.epoch, 'native_epoch', 512);
  if (frame.offset !== undefined) nativeInteger(frame.offset, 'native_offset');
  if (frame.session_id !== undefined) nativeText(frame.session_id, 'native_session', 512);
  if (frame.volatile !== undefined && typeof frame.volatile !== 'boolean')
    throw new ProtocolError('invalid_request', 'native_volatile');
  return frame;
}
export function updateDurableCursor(current, frame) {
  if (frame.volatile === true || frame.seq === undefined || frame.epoch === undefined) return current;
  const seq = nativeInteger(frame.seq, 'native_sequence');
  const epoch = nativeText(frame.epoch, 'native_epoch', 512);
  if (current?.epoch === epoch && current.seq >= seq) return current;
  return { epoch, seq };
}
export function parseAck(frame) {
  if (frame.type !== 'ack' || typeof frame.code !== 'number')
    throw new ProtocolError('invalid_request', 'native_ack');
  nativeText(frame.id, 'native_ack_id', 512);
  if (frame.code !== 0)
    throw new ProtocolError(frame.code === 40112 ? 'unauthorized' : 'source_unavailable', 'native_ack_rejected');
  const payload = record(frame.payload ?? {}, 'native_ack_payload');
  const resync = payload.resync_required ?? [];
  if (!Array.isArray(resync) || resync.some((id) => typeof id !== 'string' || !id.length))
    throw new ProtocolError('invalid_request', 'native_resync');
  return { payload, resync };
}
export function parseCatalogPage(value, previousCursor, limit = 100, grouped = false) {
  const page = record(value, 'catalog_page');
  const items = grouped ? page.groups : page.items;
  if (!Array.isArray(items) || items.length > limit || typeof page.has_more !== 'boolean')
    throw new ProtocolError('invalid_request', 'catalog_page');
  const cursor = page.next_page_token;
  if (page.has_more && (typeof cursor !== 'string' || !cursor || cursor === previousCursor || items.length === 0))
    throw new ProtocolError('replay_required', 'catalog_cursor');
  if (!page.has_more && cursor !== null && cursor !== undefined)
    throw new ProtocolError('invalid_request', 'catalog_terminal_cursor');
  const ids = items.map((item) => nativeText(grouped ? record(item.workspace).id : record(item).id, 'catalog_id', 512));
  if (new Set(ids).size !== ids.length) throw new ProtocolError('replay_required', 'catalog_duplicate');
  return { items, cursor: page.has_more ? cursor : null, completeness: page.has_more ? 'partial' : 'complete' };
}
export function sessionSummary(value, scope) {
  const item = record(value, 'session');
  const id = nativeText(item.id, 'session_id', 512);
  const meta = item.meta ?? item;
  const workspace = item.workspace ?? { id: item.workspace_id ?? null, cwd: item.metadata?.cwd ?? null };
  return {
    session: { ...scope, nativeSessionId: id },
    title: typeof meta.title === 'string' ? meta.title : '',
    directory: typeof workspace.cwd === 'string' ? workspace.cwd : null,
    nativeWorkspaceId: typeof workspace.id === 'string' ? workspace.id : null,
    archived: meta.archived === true,
    updatedAt: meta.updated_at ?? null,
    status: item.activity?.status ?? (item.busy ? 'running' : 'idle'),
    ...(typeof item.parent_session_id === 'string'
      ? { parentSession: { ...scope, nativeSessionId: item.parent_session_id } }
      : {}),
  };
}
export function parseNativeCapabilities(metaValue, openapiValue, asyncapiValue) {
  const meta = record(metaValue, 'native_meta');
  const paths = record(record(openapiValue).paths ?? {});
  const messages = record(record(asyncapiValue).components?.messages ?? {});
  const route = (path, method = 'get') => typeof paths[path]?.[method] === 'object';
  const v2 = meta.backend === 'v2';
  // Kimi 2.1.1 serves :abort through the same dispatcher but omits that alias from OpenAPI.
  // This exact profile is verified with a live pending native turn and cancellation readback.
  const knownAbortDispatcher = v2 && meta.server_version === '2.1.1' &&
    paths['/api/v1/sessions/{session_id}:archive']?.post?.operationId === 'runSessionArchiveAction';
  return Object.freeze({
    catalogV2: v2 && route('/api/v2/sessions'),
    transcript: route('/api/v1/sessions/{session_id}/transcript'),
    snapshot: route('/api/v1/sessions/{session_id}/snapshot'),
    subscribeV2: meta.capabilities?.websocket === true && messages.subscribe_v2?.name === 'subscribe_v2',
    subscribe: meta.capabilities?.websocket === true && messages.subscribe?.name === 'subscribe',
    create: route('/api/v1/sessions', 'post'),
    send: route('/api/v1/sessions/{session_id}/prompts', 'post'),
    cancel: route('/api/v1/sessions/{session_id}:abort', 'post') || knownAbortDispatcher,
    approvals: route('/api/v1/sessions/{session_id}/approvals/{approval_id}', 'post'),
    questions: route('/api/v1/sessions/{session_id}/questions/{tail}', 'post'),
    models: route('/api/v1/models'),
    agents: route('/api/v1/sessions/{session_id}/agents'),
    status: route('/api/v1/sessions/{session_id}/status'),
  });
}
function overlap(authoritative, buffered) {
  for (let length = Math.min(authoritative.length, buffered.length); length > 0; length--)
    if (authoritative.endsWith(buffered.slice(0, length))) return length;
  return 0;
}
export function recoverSnapshotFrames(snapshot, buffered) {
  const boundary = buffered.filter((frame) => frame.volatile === true && frame.seq === snapshot.as_of_seq);
  const remaining = new Map(['assistant.delta', 'thinking.delta'].map((type) => [type,
    overlap(snapshot.in_flight_turn?.[type === 'assistant.delta' ? 'assistant_text' : 'thinking_text'] ?? '',
      boundary.filter((frame) => frame.type === type).map((frame) => frame.payload?.delta ?? '').join('')),
  ]));
  return buffered.flatMap((frame) => {
    if (frame.epoch && frame.epoch !== snapshot.epoch) return [];
    if (frame.volatile !== true) return frame.seq <= snapshot.as_of_seq ? [] : [frame];
    if (frame.seq !== snapshot.as_of_seq) {
      const { offset: _offset, seq: _seq, ...appendOnly } = frame;
      return [appendOnly];
    }
    if (typeof frame.payload?.delta !== 'string') return [frame];
    const skip = Math.min(remaining.get(frame.type) ?? 0, frame.payload.delta.length);
    remaining.set(frame.type, Math.max(0, (remaining.get(frame.type) ?? 0) - skip));
    if (skip === frame.payload.delta.length) return [];
    const { offset: _offset, ...appendOnly } = frame;
    return [{ ...appendOnly, payload: { ...frame.payload, delta: frame.payload.delta.slice(skip) } }];
  });
}
