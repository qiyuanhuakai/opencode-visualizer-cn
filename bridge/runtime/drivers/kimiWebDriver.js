import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, parseInstanceId } from '../../../shared/runtime/identity.js';
import { ProtocolError, jsonValue } from '../../../shared/runtime/capabilities.js';
import { CORE_OPERATIONS, unsupported, validateHarnessRegistration } from '../../../shared/runtime/harnessContract.js';
import { record, nativeText, pageSize, parseCatalogPage, sessionSummary, parseNativeCapabilities } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import { createAdmissionQueue } from '../admissionQueue.js';
import { createKimiWebTransport } from './kimiWebTransport.js';
import { createKimiWebHistory } from './kimiWebHistory.js';
import { createKimiWebOperations } from './kimiWebOperations.js';

function observer(onReturn) {
  const queue = []; let bytes = 0, waiter, done = false;
  return {
    push(value) {
      if (done) return;
      if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value, done: false }); return; }
      const size = Buffer.byteLength(JSON.stringify(value));
      if (queue.length >= 256 || bytes + size > 1048576) {
        queue.length = 0; bytes = 0;
        queue.push({ value: { type: 'replay_required', reason: 'observer_backpressure' }, size: 0 });
        done = true; return;
      }
      queue.push({ value, size }); bytes += size;
    },
    [Symbol.asyncIterator]() { return this; },
    next() {
      const entry = queue.shift();
      if (entry) { bytes -= entry.size; return Promise.resolve({ value: entry.value, done: false }); }
      if (done) return Promise.resolve({ value: undefined, done: true });
      if (waiter) return Promise.reject(new ProtocolError('conflict', 'observer_concurrent_next'));
      return new Promise((resolve) => { waiter = resolve; });
    },
    async return() {
      done = true; queue.length = 0; bytes = 0;
      if (waiter) { waiter({ value: undefined, done: true }); waiter = undefined; }
      onReturn(); return { value: undefined, done: true };
    },
  };
}
export async function createKimiWebDriver(options) {
  const scope = Object.freeze({ environmentId: parseEnvironmentId(options.environmentId), harnessInstanceId: parseHarnessInstanceId(options.harnessInstanceId) });
  const authority = () => {
    const value = options.getAuthority();
    const epoch = parseInstanceId(value.epoch);
    if (!Number.isSafeInteger(value.processGeneration) || value.processGeneration < 1) throw new ProtocolError('invalid_request', 'process_generation');
    return { epoch, processGeneration: value.processGeneration };
  };
  let sourceAuthority = authority();
  let state = options.enabled === false ? 'disabled' : options.installed === false ? 'missing' : 'starting';
  let closed = false, closing, sourceId;
  let capabilities = parseNativeCapabilities({}, { paths: {} }, { components: { messages: {} } });
  const admission = options.admission ?? createAdmissionQueue();
  const transport = state === 'starting' ? createKimiWebTransport({ endpoint: options.endpoint, getAuthorization: options.getAuthorization, deadlineMs: options.deadlineMs }) : undefined;
  const lifecycleTransport = transport ? createKimiWebTransport({ endpoint: options.endpoint, getAuthorization: options.getAuthorization, deadlineMs: options.deadlineMs }) : undefined;
  const lifecycleCursors = new Map();
  const lifecycleSubscriptions = new Map();
  const observers = new Set();
  const selected = new Map();
  const invalidated = new Set();
  let eventWork = Promise.resolve(), eventCount = 0, eventBytes = 0;
  let lastEventError;
  const stats = { recoveries: 0, nativeFrames: 0, lifecycleFrames: 0, sourceDisconnects: 0 };
  function emit(value, sessionId) {
    for (const entry of observers) if (!entry.sessionId || entry.sessionId === sessionId) entry.stream.push(value);
  }
  function capture(context, sessionRequired = false) {
    if (context.environmentId !== scope.environmentId || context.harnessInstanceId !== scope.harnessInstanceId)
      throw new ProtocolError('unauthorized', 'harness_scope');
    if (closed) throw new ProtocolError('source_unavailable', 'driver_closed');
    const session = context.session === undefined ? undefined : parseSessionRef(context.session);
    if (session && (session.environmentId !== scope.environmentId || session.harnessInstanceId !== scope.harnessInstanceId))
      throw new ProtocolError('unauthorized', 'session_scope');
    if (sessionRequired && !session) throw new ProtocolError('invalid_request', 'session_required');
    return Object.freeze({ target: scope.environmentId, ...authority(), ...(session ? { session } : { harnessInstanceId: scope.harnessInstanceId }) });
  }
  function isCurrent(candidate) {
    const current = authority();
    return !closed && candidate.target === scope.environmentId &&
      (candidate.session ? candidate.session.harnessInstanceId === scope.harnessInstanceId && !invalidated.has(candidate.session.nativeSessionId) : candidate.harnessInstanceId === scope.harnessInstanceId) &&
      candidate.epoch === current.epoch && candidate.processGeneration === current.processGeneration;
  }
  function fence(candidate) { if (!isCurrent(candidate)) throw new ProtocolError('reconcile_required', 'stale_generation'); }
  const operations = transport ? createKimiWebOperations({ store: options.store, transport, isCurrent, admission }) : undefined;
  const history = transport ? createKimiWebHistory({ transport, onRecovered(sessionId, result) {
    stats.recoveries++; emit({ type: 'resynchronized', session: { ...scope, nativeSessionId: sessionId }, ...result }, sessionId);
  } }) : undefined;
  function requireCapability(name) { if (!capabilities[name]) throw new ProtocolError('unsupported', `kimi_${name}`); }
  function scheduled(action, bytes = 0) {
    if (eventCount >= 256 || eventBytes + bytes > 4194304) {
      lastEventError = { code: 'replay_required', reason: 'producer_backpressure' };
      emit({ type: 'replay_required', reason: 'producer_backpressure' });
      for (const sessionId of selected.keys()) invalidated.add(sessionId);
      void transport.disconnect(); void lifecycleTransport.disconnect();
      return;
    }
    eventCount++; eventBytes += bytes;
    eventWork = eventWork.then(action).catch((error) => {
      lastEventError = { code: error?.code ?? 'source_unavailable', reason: error?.field ?? error?.reason ?? 'native_event' };
      emit({ type: 'source_error', ...lastEventError });
    }).finally(() => { eventCount--; eventBytes -= bytes; });
  }
  function onFrame(frame, connection) {
    stats.nativeFrames++;
    const sessionId = frame.session_id ?? frame.payload?.session_id;
    if (frame.type === 'resync_required' && selected.has(sessionId)) {
      scheduled(() => history.recover(sessionId)); return;
    }
    if (!sessionId || sessionId === '__global__') {
      if (frame.type.startsWith('event.workspace.')) emit({ type: 'catalog_changed' });
      return;
    }
    const session = { ...scope, nativeSessionId: sessionId };
    const captured = Object.freeze({ target: scope.environmentId, ...authority(), session });
    try {
      if (!history.receive(frame, connection)) return;
    } catch (error) {
      if (error instanceof ProtocolError && error.field === 'native_epoch_changed') {
        invalidated.add(sessionId);
        scheduled(async () => { await operations.invalidate(captured); await history.recover(sessionId); });
      } else {
        lastEventError = { code: error?.code ?? 'source_unavailable', reason: error?.field ?? error?.reason ?? 'native_event' };
        emit({ type: 'replay_required', session, ...lastEventError }, sessionId);
      }
      return;
    }
    const payload = frame.payload ?? {};
    if (frame.type === 'transcript.reset' || frame.type === 'transcript.ops') {
      emit({ type: frame.type, session, payload, nativeCursor: history.cursor(sessionId) ?? null }, sessionId);
    } else if (frame.type === 'agent.created' || frame.type === 'agent.updated') {
      emit({ type: 'native_agent', session, agentId: payload.agentId ?? payload.agent_id, payload }, sessionId);
    } else if (frame.type.startsWith('event.session.')) {
      emit({ type: 'catalog_changed', session }, sessionId);
    }
  }
  function onLifecycle(frame) {
    stats.lifecycleFrames++;
    const sessionId = frame.session_id;
    if (!selected.has(sessionId) || frame.volatile === true) return;
    const prior = lifecycleCursors.get(sessionId);
    const session = { ...scope, nativeSessionId: sessionId };
    const captured = Object.freeze({ target: scope.environmentId, ...authority(), session });
    if (frame.type === 'resync_required' || (prior && frame.epoch && frame.epoch !== prior.epoch)) {
      invalidated.add(sessionId);
      scheduled(async () => { await operations.invalidate(captured); await history.recover(sessionId); });
      return;
    }
    if (frame.seq === undefined || !frame.epoch || (prior?.epoch === frame.epoch && prior.seq >= frame.seq)) return;
    lifecycleCursors.set(sessionId, { epoch: frame.epoch, seq: frame.seq });
    const payload = frame.payload ?? {};
    if (frame.type === 'turn.started') scheduled(() => operations.started(captured, payload));
    else if (frame.type === 'turn.ended') scheduled(async () => {
      await operations.terminal(captured, payload);
      emit({ type: 'turn.ended', session, reason: payload.reason }, sessionId);
    });
    else if (frame.type === 'event.approval.requested' || frame.type === 'event.question.requested') {
      const kind = frame.type === 'event.approval.requested' ? 'approval' : 'question';
      scheduled(async () => {
        requireCapability(kind === 'approval' ? 'approvals' : 'questions');
        const interactionId = await operations.pending(captured, kind, nativeText(payload[kind === 'approval' ? 'approval_id' : 'question_id'], 'native_request_id', 512), payload);
        emit({ type: 'interaction.pending', session, interactionId, kind, payload }, sessionId);
      }, Buffer.byteLength(JSON.stringify(frame)));
    }
  }
  async function subscribeLifecycle(sessionId) {
    await lifecycleTransport.open(onLifecycle, () => { if (!closed) emit({ type: 'source_disconnected', lane: 'lifecycle' }); });
    const key = `${lifecycleTransport.generation}:${sessionId}`;
    if (lifecycleSubscriptions.has(key)) return lifecycleSubscriptions.get(key);
    const work = (async () => {
      const cursor = lifecycleCursors.get(sessionId);
      const ack = await lifecycleTransport.control('subscribe', { session_ids: [sessionId], ...(cursor ? { cursors: { [sessionId]: cursor } } : {}) });
      if (ack.payload.not_found?.includes(sessionId)) throw new ProtocolError('source_unavailable', 'native_session_missing');
      if (ack.resync.includes(sessionId)) {
        invalidated.add(sessionId);
        await operations.invalidate({ target: scope.environmentId, ...authority(), session: { ...scope, nativeSessionId: sessionId } });
        throw new ProtocolError('reconcile_required', 'lifecycle_replay_required');
      }
      if (!lifecycleCursors.has(sessionId) && ack.payload.cursors?.[sessionId]) lifecycleCursors.set(sessionId, ack.payload.cursors[sessionId]);
    })();
    lifecycleSubscriptions.set(key, work);
    try { await work; } catch (error) { lifecycleSubscriptions.delete(key); throw error; }
  }
  async function inspectNative() {
    if (state === 'disabled' || state === 'missing') return { state, protocolVersion: 1 };
    try {
      const [meta, spec, asyncspec] = await Promise.all([
        transport.request('GET', '/api/v1/meta'), transport.request('GET', '/openapi.json'), transport.request('GET', '/asyncapi.json'),
      ]);
      capabilities = parseNativeCapabilities(meta, spec, asyncspec);
      const id = nativeText(record(meta).server_id, 'native_server_id', 512);
      if (sourceId && sourceId !== id) {
        for (const [sid] of selected) {
          invalidated.add(sid);
          await operations.invalidate({ target: scope.environmentId, ...sourceAuthority, session: { ...scope, nativeSessionId: sid } });
        }
        const next = authority();
        if (next.epoch !== sourceAuthority.epoch || next.processGeneration > sourceAuthority.processGeneration) invalidated.clear();
      }
      sourceId = id; sourceAuthority = authority(); state = 'ready';
    } catch (error) {
      state = error?.code === 'unauthorized' ? 'auth-required' : 'failed';
    }
    return { state, protocolVersion: 1 };
  }
  async function connect() {
    requireCapability('subscribeV2'); requireCapability('subscribe');
    await transport.open(onFrame, () => { stats.sourceDisconnects++; if (!closed) emit({ type: 'source_disconnected' }); });
  }
  async function subscribeSession(sessionId, agentId = 'main') {
    requireCapability('subscribeV2'); requireCapability('snapshot'); requireCapability('transcript');
    history.selected(sessionId, agentId);
    let pending = selected.get(sessionId);
    if (!pending) { pending = new Map(); selected.set(sessionId, pending); }
    const key = `${transport.generation}:${agentId}`;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      if (!history.cursor(sessionId)) await history.recover(sessionId);
      await connect();
      await subscribeLifecycle(sessionId);
      const cursor = history.cursor(sessionId);
      const replay = await transport.control('subscribe', { session_ids: [sessionId], ...(cursor ? { cursors: { [sessionId]: cursor } } : {}) });
      if (replay.payload.not_found?.includes(sessionId)) throw new ProtocolError('source_unavailable', 'native_session_missing');
      if (replay.resync.includes(sessionId)) await history.recover(sessionId);
      const since = history.transcriptCursors(sessionId);
      const grades = Object.fromEntries([...new Set([...pending.keys()].map((entry) => entry.slice(entry.indexOf(':') + 1)).concat(agentId))].map((id) => [id, 'delta']));
      const attached = await transport.control('subscribe_v2', { session_id: sessionId, transcript: grades, ...(Object.keys(since).length ? { transcript_since: since } : {}) });
      if (attached.payload.not_found?.includes(sessionId)) throw new ProtocolError('source_unavailable', 'native_session_missing');
      if (attached.resync.includes(sessionId)) await history.recover(sessionId);
      if (!history.cursor(sessionId)) await history.recover(sessionId);
    })();
    pending.set(key, work);
    try { await work; } catch (error) { pending.delete(key); throw error; }
  }
  const methods = {
    async inspect(context) { capture(context); return inspectNative(); },
    async listSessionPage(context) {
      const captured = capture(context); requireCapability('catalogV2');
      const params = record(context.params); const limit = pageSize(params.limit);
      const query = new URLSearchParams({ page_size: String(limit), 'meta.archived': 'all' });
      if (params.cursor !== undefined && params.cursor !== null) query.set('page_token', nativeText(params.cursor, 'catalog_cursor'));
      if (params.workspaceId !== undefined) query.set('workspace.id', nativeText(params.workspaceId, 'native_workspace', 512));
      const result = await admission.run({}, (signal) => transport.request('GET', `/api/v2/sessions?${query}`, undefined, signal));
      fence(captured);
      const page = parseCatalogPage(result, params.cursor, limit);
      return { ...page, items: page.items.map((item) => sessionSummary(item, scope)) };
    },
    async getSession(context) {
      const captured = capture(context, true); requireCapability('snapshot');
      const snapshot = record(await transport.request('GET', `/api/v1/sessions/${encodeURIComponent(captured.session.nativeSessionId)}/snapshot`));
      fence(captured);
      return sessionSummary(snapshot.session, scope);
    },
    async readHistoryPage(context) {
      const captured = capture(context, true); requireCapability('transcript');
      const params = record(context.params); const agentId = params.agentId ?? 'main';
      await subscribeSession(captured.session.nativeSessionId, agentId);
      const page = await admission.run({}, (signal) => history.read(captured.session.nativeSessionId, { agentId, cursor: params.cursor, limit: params.limit ?? 100, signal }));
      fence(captured); return page;
    },
    async createSession(context) {
      const captured = capture(context); requireCapability('create');
      if (captured.session) throw new ProtocolError('invalid_request', 'instance_scope');
      const params = record(context.params); const cwd = nativeText(params.directory, 'workspace_directory', 4096);
      const payload = { metadata: { cwd }, ...(params.title !== undefined ? { title: nativeText(params.title, 'session_title', 512) } : {}) };
      if (options.authorizeWorkspace) await options.authorizeWorkspace({ ...scope, directory: cwd });
      fence(captured);
      const executed = await operations.instance(captured, 'createSession', payload, params.idempotencyKey, '/api/v1/sessions');
      return { phase: executed.phase, operationId: executed.operationId, session: sessionSummary(executed.result, scope) };
    },
    async send(context) {
      const captured = capture(context, true); requireCapability('send');
      const params = record(context.params); const content = params.content;
      if (!Array.isArray(content) || !content.length || content.some((part) => !part || part.type !== 'text' || typeof part.text !== 'string'))
        throw new ProtocolError('invalid_request', 'prompt_content');
      const payload = jsonValue({ content, ...(params.agentId ? { agent_id: nativeText(params.agentId, 'agent_id', 128) } : {}), ...(params.model ? { model: nativeText(params.model, 'model_id', 512) } : {}) });
      await subscribeSession(captured.session.nativeSessionId, params.agentId ?? 'main');
      fence(captured);
      return operations.send(captured, payload, params.idempotencyKey);
    },
    async cancel(context) {
      const captured = capture(context, true); requireCapability('cancel');
      const params = record(context.params);
      return operations.cancel(captured, params.operationId, params.idempotencyKey);
    },
    async respondInteraction(context) {
      const captured = capture(context, true); const params = record(context.params);
      return operations.reply(captured, params.interactionId, record(params.answer), params.idempotencyKey);
    },
    async subscribe(context) {
      const captured = capture(context); requireCapability('subscribeV2');
      const params = record(context.params); const entry = { sessionId: captured.session?.nativeSessionId, stream: undefined };
      entry.stream = observer(() => observers.delete(entry)); observers.add(entry);
      try {
        if (captured.session) await subscribeSession(captured.session.nativeSessionId, params.agentId ?? 'main'); else await connect();
        fence(captured); return entry.stream;
      } catch (error) { await entry.stream.return(); throw error; }
    },
    async close(context) { capture(context); await close(); return { closed: true }; },
  };
  const native = {
    async 'kimi.listWorkspacePage'(context) {
      const captured = capture(context); requireCapability('catalogV2');
      const params = record(context.params); const limit = pageSize(params.limit);
      const query = new URLSearchParams({ view: 'by_workspace', page_size: String(limit), 'group.page_size': '1', 'meta.archived': 'all' });
      if (params.cursor) query.set('page_token', nativeText(params.cursor, 'catalog_cursor'));
      const value = await admission.run({}, (signal) => transport.request('GET', `/api/v2/sessions?${query}`, undefined, signal));
      fence(captured); const page = parseCatalogPage(value, params.cursor, limit, true);
      return { ...page, items: page.items.map((item) => ({ nativeWorkspaceId: item.workspace.id, directory: item.workspace.cwd, sessionCount: item.total })) };
    },
    async listProviders(context) {
      const captured = capture(context); requireCapability('models');
      const value = record(await transport.request('GET', '/api/v1/models')); fence(captured);
      if (!Array.isArray(value.items) || value.items.length > 200) throw new ProtocolError('replay_required', 'models_page_size');
      return { items: value.items.map((item) => ({ id: nativeText(item.model, 'model_alias', 512), name: item.display_name ?? item.model, provider: nativeText(item.provider, 'provider_id', 512) })), completeness: 'complete' };
    },
    async 'kimi.sessionStatus'(context) {
      const captured = capture(context, true); requireCapability('status');
      const value = await transport.request('GET', `/api/v1/sessions/${encodeURIComponent(captured.session.nativeSessionId)}/status`); fence(captured); return value;
    },
  };
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await transport?.close(); await lifecycleTransport?.close(); await eventWork;
      await operations?.close();
      for (const entry of observers) await entry.stream.return();
      history?.clear(); selected.clear();
      if (options.ownership === 'owned') await options.stopOwned();
      return { closed: true };
    })();
    return closing;
  }
  await inspectNative();
  const supported = { state: 'supported' };
  const denied = unsupported('native capability not verified');
  const support = {
    inspect: true, close: true, listSessionPage: capabilities.catalogV2,
    getSession: capabilities.snapshot, readHistoryPage: capabilities.transcript && capabilities.subscribeV2 && capabilities.snapshot,
    createSession: capabilities.create,
    subscribe: capabilities.subscribeV2 && capabilities.subscribe && capabilities.snapshot,
    send: capabilities.send && capabilities.subscribeV2 && capabilities.subscribe && capabilities.snapshot,
    cancel: capabilities.cancel, respondInteraction: capabilities.approvals || capabilities.questions,
  };
  const extensions = [
    { name: 'kimi.listWorkspacePage', scope: 'instance', enabled: capabilities.catalogV2 },
    { name: 'listProviders', scope: 'instance', enabled: capabilities.models },
    { name: 'kimi.sessionStatus', scope: 'session', enabled: capabilities.status },
  ];
  const registration = validateHarnessRegistration({
    manifest: { ...scope, kind: 'kimi-web', protocolVersion: 1,
      core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, support[name] ? supported : denied])),
      extensions: extensions.map(({ name, scope: extensionScope, enabled }) => ({ name, owner: scope.harnessInstanceId, scope: extensionScope, permission: 'kimi.read', schemaVersion: 1, support: enabled ? supported : denied })),
      capabilities: { sessions: support.listSessionPage ? supported : denied, permissions: support.respondInteraction ? supported : denied, questions: capabilities.questions ? supported : denied },
    },
    driver: { core: Object.fromEntries(Object.entries(methods).filter(([name]) => support[name])), native: Object.fromEntries(extensions.filter(({ enabled }) => enabled).map(({ name }) => [name, native[name]])) },
  });
  return {
    registration, close,
    async reconnect() {
      if (closed) throw new ProtocolError('source_unavailable', 'driver_closed');
      await transport.disconnect(); await lifecycleTransport.disconnect();
      lifecycleSubscriptions.clear();
      await inspectNative();
      if (state !== 'ready') throw new ProtocolError('source_unavailable', 'native_reconnect');
      const sessions = [...selected].map(([id, pending]) => [id, [...new Set([...pending.keys()].map((key) => key.slice(key.indexOf(':') + 1)))]]);
      for (const [, pending] of selected) pending.clear();
      await connect();
      for (const [sessionId, agentIds] of sessions) for (const agentId of agentIds) await subscribeSession(sessionId, agentId);
      await eventWork;
    },
    async flush() { await eventWork; if (lastEventError) throw new ProtocolError(lastEventError.code, lastEventError.reason); },
    diagnostics() { return { state, capabilities, ...stats, heartbeats: transport?.heartbeats ?? { pings: 0, pongs: 0 }, observers: observers.size, selected: selected.size, connected: transport?.connected ?? false, nativeConnections: Number(transport?.connected ?? false) + Number(lifecycleTransport?.connected ?? false), eventQueue: eventCount, lastEventError: lastEventError ?? null }; },
    history: (sessionId, agentId) => history.inspect(sessionId, agentId),
    operations,
  };
}
