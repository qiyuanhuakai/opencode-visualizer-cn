import { randomUUID } from 'node:crypto';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { ProtocolError, requireValue, jsonValue, textValue } from '../../../shared/runtime/capabilities.js';
import { CORE_OPERATIONS, validateHarnessRegistration, unsupported } from '../../../shared/runtime/harnessContract.js';
import { createOperationJournal, fingerprint } from '../operationJournal.js';
import { createInteractionStore } from '../interactionStore.js';
import { createInstanceOperations } from '../../../shared/runtime/native/opencode/instanceOperations.js';
import { OPEN_CODE_VERSION, OPEN_CODE_LIMITS, summary, pageLimit, nativeEvent, redactSettings, assertNoCredentials } from '../../../shared/runtime/native/opencode/protocol.js';
import { OPEN_CODE_OPERATIONS, nativeRoute, supportsNativeRoute, cancelOwnedOperation } from '../../../shared/runtime/native/opencode/operations.js';
import { createSseDecoder, createEventSubscriptions } from '../../../shared/runtime/native/opencode/sse.js';
import { createOpenCodeStoreReader } from './openCodeStoreReader.mjs';
import { createOpenCodeDiscovery } from './openCodeDiscovery.js';

export async function createOpenCodeDriver(options) {
  const identity = { environmentId: parseEnvironmentId(options.environmentId), harnessInstanceId: parseHarnessInstanceId(options.harnessInstanceId) };
  const processScope = { ...identity, epoch: options.epoch, processGeneration: options.processGeneration };
  const origin = new URL(options.endpoint);
  requireValue(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && !origin.search && !origin.hash, 'opencode.endpoint');
  const lifetime = new AbortController();
  let closed = false, seq = 0, sourceState = 'starting', streamTask, streamController, reconnect, reader, discovery;
  let ordinaryRequests = 0, controlRequests = 0;
  const active = new Map(); const bound = new Map(); const historyCursors = new Map();
  const nativeEvents = new Set();
  const current = () => ({ ...options.currentProcess(), seq });
  const processCurrent = () => !closed && options.currentProcess().epoch === options.epoch && options.currentProcess().processGeneration === options.processGeneration;
  const instances = createInstanceOperations({ store: options.store, scope: processScope, current: options.currentProcess, fingerprint, randomUUID });
  async function fence() { requireValue(processCurrent(), 'opencode.generation', 'reconcile_required'); await instances.assertCurrent(); requireValue(processCurrent(), 'opencode.generation', 'reconcile_required'); }
  const journal = createOperationJournal({ store: options.store, isProcessCurrent: (scope) => processCurrent() && scope.target === identity.environmentId && scope.epoch === options.epoch && scope.processGeneration === options.processGeneration && scope.session.harnessInstanceId === identity.harnessInstanceId });
  const interactions = createInteractionStore({ store: options.store });
  const subscriptions = createEventSubscriptions({ maxBytes: options.eventBufferBytes ?? OPEN_CODE_LIMITS.producer, onOverflow: () => { discovery?.invalidate('native-buffer-overflow'); sourceState = 'failed'; } });
  function context(input, sessionRequired = false) {
    requireValue(input.environmentId === identity.environmentId && input.harnessInstanceId === identity.harnessInstanceId, 'opencode.target', 'unauthorized');
    const session = input.session === undefined ? undefined : parseSessionRef(input.session);
    requireValue(!session || (session.environmentId === identity.environmentId && session.harnessInstanceId === identity.harnessInstanceId), 'opencode.session_target', 'unauthorized');
    requireValue(!sessionRequired || session, 'opencode.session_required');
    const params = jsonValue(input.params);
    requireValue(params !== null && typeof params === 'object' && !Array.isArray(params), 'opencode.params');
    return { session, params };
  }
  const sessionRef = (id) => parseSessionRef({ ...identity, nativeSessionId: id });
  const operationScope = (session) => ({ target: identity.environmentId, epoch: options.epoch, processGeneration: options.processGeneration, session });
  function mutation(params) { requireValue(sourceState === 'ready', 'opencode.stream_unavailable', 'reconcile_required'); requireValue(params.processGeneration === options.processGeneration, 'opencode.request_generation', 'reconcile_required'); textValue(params.idempotencyKey, 'opencode.idempotency'); }
  async function request(route, { method = 'GET', query = {}, body, signal, maxBytes = 2097152, stream = false, control = false, historyPage = false } = {}) {
    requireValue(processCurrent(), 'opencode.generation', 'reconcile_required');
    requireValue(control ? controlRequests < 4 : ordinaryRequests < 16, 'opencode.http_queue', 'source_unavailable');
    if (control) controlRequests++; else ordinaryRequests++;
    const headerDeadline = new AbortController();
    const headerTimer = stream ? setTimeout(() => headerDeadline.abort(), options.requestTimeoutMs ?? 15000) : null;
    const controller = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(options.requestTimeoutMs ?? 15000)]);
    const url = new URL(route.replace(/^\//, ''), origin.href.endsWith('/') ? origin : new URL(`${origin.href}/`));
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    try {
      const response = await fetch(url, { method, headers: { Accept: stream ? 'text/event-stream' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.authorization ? { Authorization: options.authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: stream ? AbortSignal.any([lifetime.signal, headerDeadline.signal, ...(signal ? [signal] : [])]) : controller, redirect: 'error' });
      if (headerTimer) clearTimeout(headerTimer);
      requireValue(processCurrent(), 'opencode.generation', 'reconcile_required');
      if (!response.ok) { await response.body?.cancel(); throw new ProtocolError(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 404 ? 'source_unavailable' : 'invalid_request', `opencode.http_${response.status}`); }
      if (stream) { requireValue(response.headers.get('content-type')?.includes('text/event-stream') && response.body, 'opencode.sse_content_type', 'unsupported'); return response.body; }
      if (!response.body) return null;
      const streamReader = response.body.getReader(); const chunks = []; let size = 0;
      try { for (;;) { const next = await streamReader.read(); if (next.done) break; size += next.value.byteLength; requireValue(size <= maxBytes, 'opencode.response_size', 'reconcile_required'); chunks.push(next.value); } }
      finally { await streamReader.cancel(); streamReader.releaseLock(); }
      requireValue(processCurrent(), 'opencode.generation', 'reconcile_required');
      if (!size) return null;
      try { const value = jsonValue(JSON.parse(Buffer.concat(chunks).toString('utf8'))); return historyPage ? { items: value, nextCursor: response.headers.get('x-next-cursor') } : value; }
      catch (error) { if (error instanceof SyntaxError) throw new ProtocolError('reconcile_required', 'opencode.response_json'); throw error; }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (error instanceof Error) throw new ProtocolError((controller.aborted || headerDeadline.signal.aborted) ? lifetime.signal.aborted ? 'cancelled' : 'timeout' : 'source_unavailable', 'opencode.http');
      throw error;
    } finally { if (headerTimer) clearTimeout(headerTimer); if (control) controlRequests--; else ordinaryRequests--; }
  }
  async function bind(session) {
    const key = encodeSessionKey(session);
    if (!bound.has(key)) {
      requireValue(bound.size < 256, 'opencode.interaction_sessions', 'reconcile_required');
      const promise = interactions.bindProcess(operationScope(session)); bound.set(key, { session, promise });
    }
    await bound.get(key).promise; await fence();
  }
  async function consume(input) {
    await fence();
    const event = nativeEvent(input); const properties = event.properties;
    if (event.nativeEventId) {
      if (nativeEvents.has(event.nativeEventId)) return;
      nativeEvents.add(event.nativeEventId);
      if (nativeEvents.size > 4096) nativeEvents.delete(nativeEvents.values().next().value);
    }
    const id = properties.sessionID ?? properties.info?.sessionID ?? (event.type.startsWith('session.') ? properties.info?.id : undefined) ?? properties.part?.sessionID;
    const session = typeof id === 'string' ? sessionRef(id) : undefined;
    const envelope = { ...identity, epoch: options.epoch, processGeneration: options.processGeneration, seq: ++seq, type: event.type, ...(session ? { session } : {}), payload: properties };
    if (['session.created', 'session.updated', 'session.deleted'].includes(event.type)) {
      envelope.summary = summary(properties.info); discovery.event(envelope);
    }
    if (['permission.asked', 'question.asked'].includes(event.type)) {
      requireValue(session !== undefined, 'opencode.interaction_session'); await bind(session);
      envelope.interactionId = await interactions.pending({ scope: operationScope(session), nativeRequestId: properties.id, payload: { type: event.type, properties, directory: event.directory ?? '' } });
      await fence();
    }
    if (session && event.type === 'message.updated' && properties.info?.role === 'user') {
      const turn = active.get(encodeSessionKey(session));
      if (turn && (turn.messageID ? properties.info.id === turn.messageID : properties.info.time?.created >= turn.startedAt)) turn.observed = true;
    }
    if (session && (event.type === 'session.idle' || event.type === 'session.error' || (event.type === 'session.status' && properties.status?.type === 'idle'))) {
      const key = encodeSessionKey(session); const operation = active.get(key);
      if (operation?.observed) {
        const state = await journal.get(operation.operationId);
        if (['sent', 'observed', 'reconciling'].includes(state.phase)) { await journal.terminal(operation.operationId, operationScope(session), event.type === 'session.error' ? 'failed' : state.cancelRequested ? 'cancelled' : 'completed'); active.delete(key); }
      }
    }
    await fence(); subscriptions.publish(envelope);
  }
  async function pump(body) {
    const nativeReader = body.getReader(); const decoder = createSseDecoder();
    try { for (;;) { const chunk = await nativeReader.read(); if (chunk.done) { decoder.finish(); if (!closed) throw new ProtocolError('reconcile_required', 'opencode.sse_closed'); break; } for (const event of decoder.push(chunk.value)) await consume(event); } }
    finally { await nativeReader.cancel(); nativeReader.releaseLock(); }
  }
  async function close() {
    if (closed) return;
    closed = true; lifetime.abort(); sourceState = 'failed'; discovery?.close(); subscriptions.close();
    if (streamTask) await streamTask;
    await reader?.close();
    for (const { session, promise } of bound.values()) { await promise; await interactions.processExited(operationScope(session)); }
    bound.clear(); active.clear(); historyCursors.clear(); await instances.close();
  }
  async function startStream() {
    streamController?.abort(); if (streamTask) await streamTask;
    sourceState = 'starting';
    const controller = new AbortController(); streamController = controller;
    const body = await request('/global/event', { stream: true, signal: controller.signal });
    streamTask = pump(body).catch((error) => {
      if ((closed || controller.signal.aborted) && error instanceof Error) return;
      if (error instanceof Error) { sourceState = 'failed'; discovery.invalidate('native-stream-lost'); subscriptions.fail(new ProtocolError('reconcile_required', 'opencode.sse_failed')); return; }
      throw error;
    });
    sourceState = 'ready';
  }
  let health, document;
  try {
    await instances.ready;
    health = await request('/global/health'); requireValue(health?.healthy === true, 'opencode.health', 'source_unavailable');
    requireValue(health.version === OPEN_CODE_VERSION, 'opencode.version', 'version_mismatch');
    document = await request('/doc', { maxBytes: 4194304 });
    if (options.officialStorePath) reader = createOpenCodeStoreReader({ databasePath: options.officialStorePath, nativeVersion: health.version });
    discovery = createOpenCodeDiscovery({ reader, request, current, assertCurrent: fence });
    await startStream();
  } catch (error) { await close(); throw error; }
  async function sessionMutation(name, session, params, route, turn = false) {
    mutation(params); await fence();
    const scope = operationScope(session);
    const accepted = await journal.accept({ scope, idempotencyKey: params.idempotencyKey, method: name, payload: params });
    await fence();
    const key = encodeSessionKey(session);
    if (turn) requireValue(active.size < 256 && !active.has(key), 'opencode.active_turn', 'conflict');
    try {
      const executed = await journal.execute(accepted.operationId, scope, ({ signal }) => { if (turn) active.set(key, { operationId: accepted.operationId, observed: false, startedAt: Date.now(), messageID: params.body?.messageID }); return request(route.path, { method: route.method, query: { directory: params.directory }, body: params.body ?? {}, signal }); });
      await fence();
      if (!turn || params.body?.noReply === true) { active.delete(key); await journal.terminal(accepted.operationId, scope, 'completed'); }
      return { ...executed, accepted, result: route.redact ? redactSettings(executed.result) : executed.result };
    } catch (error) { if (turn && (await journal.get(accepted.operationId)).phase === 'accepted') active.delete(key); throw error; }
  }
  async function instanceMutation(name, params, route) {
    assertNoCredentials(params.body ?? {});
    if (['setProviderAuth', 'completeProviderOAuth'].includes(name)) requireValue(typeof params.credentialRef === 'string' && params.body === undefined, 'opencode.auth_credential_ref', 'unauthorized');
    mutation(params); await fence();
    const accepted = await instances.accept({ idempotencyKey: params.idempotencyKey, method: name, payload: params });
    const executed = await instances.execute(accepted.operationId, async ({ payload }) => {
      const secret = payload.credentialRef === undefined ? undefined : await options.resolveCredential?.(textValue(payload.credentialRef, 'opencode.credential_ref'));
      requireValue(payload.credentialRef === undefined || secret !== undefined, 'opencode.credential_missing', 'unauthorized');
      await fence();
      return request(route.path, { method: route.method, query: { directory: payload.directory, workspace: payload.workspace }, body: secret ?? payload.body ?? {} });
    });
    return { ...executed, accepted, result: route.redact ? redactSettings(executed.result) : executed.result };
  }
  const core = {
    async inspect(input) { context(input); await fence(); return { state: sourceState, protocolVersion: 1 }; },
    async listSessionPage(input) { const { params } = context(input); const page = await discovery.listSessionPage(params); return { ...page, items: page.items.map((item) => ({ ...item, session: sessionRef(item.summary.id) })) }; },
    async getSession(input) { const { session, params } = context(input, true); await fence(); const item = summary(await request(`/session/${encodeURIComponent(session.nativeSessionId)}`, { query: { directory: params.directory } })); requireValue(item.id === session.nativeSessionId, 'opencode.session_response', 'reconcile_required'); return { session, summary: item, ...current() }; },
    async readHistoryPage(input) {
      const { session, params } = context(input, true); await fence(); const limit = pageLimit(params.limit);
      let before;
      if (params.cursor != null) { const cursor = historyCursors.get(params.cursor); requireValue(cursor && cursor.key === encodeSessionKey(session) && cursor.expiresAt > Date.now(), 'opencode.history_cursor', 'reconcile_required'); before = cursor.before; historyCursors.delete(params.cursor); }
      const { items, nextCursor } = await request(`/session/${encodeURIComponent(session.nativeSessionId)}/message`, { query: { directory: params.directory, limit, before }, historyPage: true });
      requireValue(Array.isArray(items) && items.length <= limit, 'opencode.history_page', 'reconcile_required');
      const ids = new Set(); for (const item of items) { textValue(item.info?.id, 'opencode.message_id'); requireValue(item.info.sessionID === session.nativeSessionId && !ids.has(item.info.id) && item.info.id !== before, 'opencode.history_scope', 'reconcile_required'); ids.add(item.info.id); }
      let cursor = null;
      if (nextCursor !== null) { textValue(nextCursor, 'opencode.history_native_cursor'); requireValue(nextCursor !== before && items.length > 0, 'opencode.history_repeated_cursor', 'reconcile_required'); for (const [key, entry] of historyCursors) if (entry.expiresAt <= Date.now()) historyCursors.delete(key); requireValue(historyCursors.size < 32, 'opencode.history_snapshots', 'reconcile_required'); cursor = randomUUID(); historyCursors.set(cursor, { key: encodeSessionKey(session), before: nextCursor, expiresAt: Date.now() + 60000 }); }
      await fence(); return { session, items, cursor, completeness: cursor ? 'partial' : 'complete', ...current() };
    },
    async createSession(input) { const { params } = context(input); const result = await instanceMutation('createSession', params, { path: '/session', method: 'POST' }); const item = summary(result.result); const session = sessionRef(item.id); await instances.bindResult(result.operationId, session); return { ...result, result: { session, summary: item } }; },
    async send(input) { const { session, params } = context(input, true); return sessionMutation('send', session, params, { path: `/session/${encodeURIComponent(session.nativeSessionId)}/prompt_async`, method: 'POST' }, true); },
    async cancel(input) {
      const { session, params } = context(input, true); mutation(params); await fence();
      const operationId = active.get(encodeSessionKey(session))?.operationId;
      if (!operationId) return sessionMutation('cancel', session, params, { path: `/session/${encodeURIComponent(session.nativeSessionId)}/abort`, method: 'POST' });
      return cancelOwnedOperation({ store: options.store, scope: operationScope(session), operationId, idempotencyKey: params.idempotencyKey, authority: instances.assertCurrent, current: processCurrent, fingerprint, randomUUID,
        send: () => request(`/session/${encodeURIComponent(session.nativeSessionId)}/abort`, { method: 'POST', query: { directory: params.directory }, control: true }),
        reconcile: () => journal.reconcile(operationId, operationScope(session)),
      });
    },
    async respondInteraction(input) {
      const { session, params } = context(input, true); requireValue(params.processGeneration === options.processGeneration, 'opencode.request_generation', 'reconcile_required'); await fence();
      const pending = await interactions.get(textValue(params.interactionId, 'opencode.interaction_id'));
      requireValue(encodeSessionKey(pending.scope.session) === encodeSessionKey(session), 'opencode.interaction_scope', 'unauthorized');
      const kind = pending.payload.type === 'permission.asked' ? 'permission' : 'question';
      requireValue(['permission.asked', 'question.asked'].includes(pending.payload.type), 'opencode.interaction_type');
      return interactions.reply(params.interactionId, operationScope(session), params.answer, async ({ nativeRequestId, answer, signal }) => { await fence(); await request(`/${kind}/${encodeURIComponent(nativeRequestId)}/${kind === 'question' && answer.reject === true ? 'reject' : 'reply'}`, { method: 'POST', body: answer, query: { directory: pending.payload.directory }, signal, control: true }); await fence(); });
    },
    subscribe(input) { const { session } = context(input); return subscriptions.subscribe((event) => !session || (event.session && encodeSessionKey(event.session) === encodeSessionKey(session))); },
    async close(input) { context(input); await close(); return null; },
  };
  const native = {};
  const extensions = Object.keys(OPEN_CODE_OPERATIONS).map((name) => {
    const operation = OPEN_CODE_OPERATIONS[name]; const supported = supportsNativeRoute(document, name);
    if (supported) native[name] = async (input) => {
      const { session, params } = context(input, operation.scope === 'session'); await fence(); const route = nativeRoute(name, session, params);
      if (route.method === 'GET') { const result = await request(route.path, { query: { directory: params.directory, workspace: params.workspace, messageID: params.messageID } }); await fence(); return route.redact ? redactSettings(result) : result; }
      return operation.scope === 'session' ? sessionMutation(name, session, params, route, name === 'sendCommand') : instanceMutation(name, params, route);
    };
    return { name, owner: identity.harnessInstanceId, scope: operation.scope, permission: `opencode.${operation.method === 'GET' ? 'read' : 'write'}`, schemaVersion: 1, support: supported ? { state: 'supported' } : unsupported('native endpoint absent') };
  });
  const registration = validateHarnessRegistration({ manifest: { ...identity, kind: 'opencode', protocolVersion: 1, core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, { state: 'supported' }])), extensions, capabilities: { sessions: { state: 'supported' }, permissions: { state: 'supported' }, questions: { state: 'supported' }, sessionFork: { state: 'supported' }, sessionRevert: { state: 'supported' }, sessionRename: { state: 'supported' }, sessionArchive: { state: 'supported' }, sessionUnarchive: { state: 'supported' }, sessionDelete: { state: 'supported' }, sessionPin: unsupported('OpenCode 1.18.34 session.update does not expose pinned'), sessionUnpin: unsupported('OpenCode 1.18.34 session.update does not expose pinned'), sessionCompact: unsupported('not exposed by the previous OpenCode adapter'), todos: { state: 'supported' }, status: { state: 'supported' }, providerConfig: { state: 'supported' } } }, driver: { core, native } });
  options.runtime.resources.register(`opencode:${identity.harnessInstanceId}:${options.processGeneration}`, 'owned', close);
  return { registration, nativeVersion: health.version, close, async retryDiscovery() { reconnect ??= (async () => { await instances.assertCurrent(); await startStream(); discovery.retry(); })().finally(() => { reconnect = undefined; }); await reconnect; }, get bufferedBytes() { return subscriptions.bufferedBytes; } };
}
