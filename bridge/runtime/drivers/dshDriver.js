import { randomUUID } from 'node:crypto';
import { createDshTransport } from './dshTransport.js';
import { createDshOperations } from './dshOperations.js';
import { readDshHistoryPage } from './dshHistory.js';
import { createFollowState } from '../../../shared/runtime/native/dsh/follow.js';
import { record, text, integer, summaries, selectModel, approvalOutcome, fail, DshError } from '../../../shared/runtime/native/dsh/protocol.js';
import { parseSessionRef, parseEnvironmentId, parseHarnessInstanceId } from '../../../shared/runtime/identity.js';
import { jsonValue } from '../../../shared/runtime/capabilities.js';
import { CORE_OPERATIONS, unsupported } from '../../../shared/runtime/harnessContract.js';
import { readRecord, compareRecord, fingerprint } from '../operationJournal.js';

const supported = Object.freeze({ state: 'supported' });
const EXTENSIONS = Object.freeze({
  'dsh.providers.list': { method: 'session/modelCatalog', scope: 'instance' },
  'dsh.models.list': { method: 'session/modelCatalog', scope: 'instance' },
  'dsh.models.select': { method: 'session/selectModel', scope: 'session', mutation: true },
  'dsh.plugins.list': { method: 'pluginInventory/list', scope: 'instance' },
  'dsh.agentPresets.list': { method: 'agentPresets/list', scope: 'instance' },
  'dsh.permissions.catalog': { method: 'permissionPresets/catalog', scope: 'instance' },
});

export function createDshDriver(options) {
  const identity = Object.freeze({ environmentId: parseEnvironmentId(options.environmentId), harnessInstanceId: parseHarnessInstanceId(options.harnessInstanceId) });
  const transport = createDshTransport(options);
  const operations = createDshOperations({ ...options, ...identity, transport });
  const snapshots = new Map(), selected = new Map(), deliveries = new Map(), observers = new Set(), known = new Set();
  let mux, connecting, clientId, liveGeneration = 0, closed = false, reconnectTimer, reconnectAttempt = 0, retryBlocked = false;
  const pendingWork = new Set();
  const now = options.now ?? Date.now;
  function publish(event) {
    const clean = jsonValue({ ...event, environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, generation: liveGeneration });
    options.onEvent?.(clean);
    for (const observer of observers) observer.push(clean);
  }
  function background(promise) {
    pendingWork.add(promise);
    promise.catch((error) => publish({ type: 'source-error', code: error instanceof DshError ? error.code : 'source_unavailable' }))
      .finally(() => pendingWork.delete(promise));
  }
  function context(input, needsSession = false) {
    record(input);
    if (input.environmentId !== identity.environmentId || input.harnessInstanceId !== identity.harnessInstanceId) fail('conflict', 'target');
    const params = jsonValue(record(input.params ?? {}));
    const session = input.session === undefined ? undefined : parseSessionRef(input.session);
    if (needsSession && !session) fail('invalid_request', 'session_required');
    if (session && (session.environmentId !== identity.environmentId || session.harnessInstanceId !== identity.harnessInstanceId)) fail('conflict', 'session_scope');
    return Object.freeze({ params, session });
  }
  function leaseCurrent(generation, boundClient) {
    if (closed || generation !== liveGeneration || boundClient !== clientId || !mux) fail('reconcile_required', 'stale_client');
  }
  async function invalidate(delivery) {
    delivery.live = false;
    if (delivery.key) {
      const prior = await readRecord(options.store, 'interactions', delivery.key);
      if (prior && ['pending', 'replying'].includes(prior.value.phase)) {
        try { await compareRecord(options.store, 'interactions', delivery.key, prior, { ...prior.value, phase: 'invalidated' }); }
        catch (error) { if (error?.reason !== 'entity_revision') throw error; }
      }
    }
  }
  async function receiveEvent(frame, generation) {
    record(frame);
    if (generation !== liveGeneration || closed) return;
    if (frame.type === 'ready') { clientId = text(frame.clientId); return; }
    if (frame.type === 'emit') { text(frame.event); publish({ type: 'native-emit', event: frame.event, args: jsonValue(frame.args) }); return; }
    if (frame.type === 'cancel') {
      const delivery = deliveries.get(text(frame.eventId));
      if (delivery) { delivery.live = false; await invalidate(delivery); deliveries.delete(frame.eventId); publish({ type: 'interaction-invalidated', interactionId: delivery.key ?? null }); }
      return;
    }
    if (frame.type !== 'waterfall') fail('invalid_request', 'events_frame');
    const eventId = text(frame.eventId), boundClient = text(clientId), nativeSessionId = text(frame.agentId);
    if (deliveries.has(eventId)) return;
    if (deliveries.size >= 256) { retryBlocked = true; publish({ type: 'source-error', code: 'source_unavailable', reason: 'interaction-budget' }); mux?.close(); return; }
    const delivery = { generation, clientId: boundClient, eventId, live: true, key: undefined };
    deliveries.set(eventId, delivery);
    const guard = () => { leaseCurrent(generation, boundClient); if (!delivery.live || deliveries.get(eventId) !== delivery) fail('conflict', 'interaction_cancelled'); };
    if (frame.event !== 'approval/request' || !known.has(nativeSessionId)) {
      const outcome = approvalOutcome('unavailable');
      try {
        await operations.durable({ idempotencyKey: `event:${boundClient}:${eventId}`, method: '$events/result', args: { clientId: boundClient, eventId, outcome }, guard });
        publish({ type: 'interaction-unavailable', nativeEvent: text(frame.event), eventId });
      } finally { delivery.live = false; deliveries.delete(eventId); }
      return;
    }
    const session = parseSessionRef({ ...identity, nativeSessionId }), scope = operations.capture(session);
    delivery.session = session; delivery.scope = scope;
    await operations.bind(scope); guard();
    delivery.key = await operations.interactions.pending({ scope, nativeRequestId: JSON.stringify([boundClient, eventId]), payload: {
      clientId: boundClient, eventId, event: frame.event, request: jsonValue(frame.request) } });
    if (!delivery.live || generation !== liveGeneration || boundClient !== clientId) { await invalidate(delivery); return; }
    publish({ type: 'interaction-pending', session, interactionId: delivery.key, request: jsonValue(frame.request) });
  }
  function scheduleReconnect() {
    if (closed || retryBlocked || reconnectTimer || selected.size === 0) return;
    const delay = [500, 1000, 2000, 4000, 8000][Math.min(reconnectAttempt++, 4)];
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; background(ensureMux().catch((error) => { scheduleReconnect(); throw error; })); }, delay);
  }
  function disconnected(error, connectionGeneration) {
    if (connectionGeneration !== liveGeneration) return;
    mux = undefined; clientId = undefined; liveGeneration++; snapshots.clear();
    for (const delivery of deliveries.values()) { delivery.live = false; background(invalidate(delivery)); }
    deliveries.clear();
    for (const entry of selected.values()) { entry.state.disconnect(); entry.handle = undefined; }
    if (!closed) {
      publish({ type: 'source-disconnected', code: error.code ?? 'source_unavailable' });
      if (error.code !== 'invalid_request') scheduleReconnect();
    }
  }
  function openFollow(entry) {
    if (!mux) fail('source_unavailable', 'mux');
    const connectionGeneration = liveGeneration, generation = entry.state.rebuild();
    entry.handle = mux.open('session/follow', { request: { address: { kind: 'session', sessionId: entry.session.nativeSessionId }, assistantStream: true, maxMessages: 200 } }, {
      onItem(value) {
        try {
          if (connectionGeneration !== liveGeneration || entry.handle === undefined) return;
          const admitted = entry.state.ingest(value, generation);
          if (admitted.action === 'drop') return;
          if (admitted.action === 'snapshot') {
            if (value.header.id !== entry.session.nativeSessionId) fail('conflict', 'snapshot_session');
            entry.snapshot = value; known.add(entry.session.nativeSessionId); entry.resolve?.(value); entry.resolve = undefined; entry.reject = undefined;
          }
          publish({ type: admitted.action === 'snapshot' ? 'session-snapshot' : 'session-event', session: entry.session, value: admitted.value,
            revision: entry.state.inspect().revision });
          if (admitted.action === 'event' && value.type === 'event' && value.event.type === 'turn/end') {
            const kind = value.event.data?.reason?.kind;
            background(operations.finish(entry.session, kind === 'completed' ? 'completed' : kind === 'aborted' ? 'cancelled' : 'failed'));
          }
        } catch (error) {
          entry.reject?.(error); entry.reject = undefined; entry.resolve = undefined;
          entry.state.disconnect(); entry.handle?.cancel(); entry.handle = undefined;
          publish({ type: 'session-replay-required', session: entry.session });
        }
      },
      onEnd(error) {
        entry.state.disconnect(); entry.handle = undefined; entry.reject?.(error ?? new DshError('source_unavailable', 'dsh.follow_ended'));
        entry.reject = undefined; entry.resolve = undefined;
        if (!closed && mux && connectionGeneration === liveGeneration) publish({ type: 'session-replay-required', session: entry.session });
      },
    });
  }
  async function ensureMux() {
    if (closed) fail('source_unavailable', 'closed');
    if (mux) return mux;
    if (connecting) return connecting;
    connecting = (async () => {
      const generation = ++liveGeneration;
      const connection = await transport.connect({ onDisconnect: (error) => disconnected(error, generation) });
      if (closed || generation !== liveGeneration) { connection.close(); fail('reconcile_required', 'connection_changed'); }
      mux = connection;
      try {
        await new Promise((resolve, reject) => {
          let readySeen = false;
          const timer = setTimeout(() => reject(new DshError('timeout', 'dsh.events_ready')), 15000);
          connection.open('$events', {}, { onItem(frame) {
            if (frame?.type === 'ready') {
              if (readySeen) fail('invalid_request', 'duplicate_ready');
              try { clientId = text(frame.clientId); readySeen = true; clearTimeout(timer); resolve(); }
              catch (error) { clearTimeout(timer); reject(error); throw error; }
            } else background(receiveEvent(frame, generation));
          }, onEnd(error) { clearTimeout(timer); reject(error ?? new DshError('source_unavailable', 'dsh.events_ended')); connection.close(); } });
        });
        leaseCurrent(generation, clientId); reconnectAttempt = 0;
        for (const entry of selected.values()) openFollow(entry);
        return connection;
      } catch (error) { connection.close(); throw error; }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  async function baseline() {
    const connection = await ensureMux();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { handle.cancel(); reject(new DshError('timeout', 'dsh.baseline')); }, 15000);
      const handle = connection.open('workspace/follow', {}, { onItem(value) { clearTimeout(timer); handle.cancel(); resolve(value); },
        onEnd(error) { clearTimeout(timer); reject(error ?? new DshError('source_unavailable', 'dsh.baseline')); } });
    });
  }
  async function select(session, refresh = false) {
    const key = session.nativeSessionId;
    let entry = selected.get(key);
    if (!entry) {
      if (selected.size >= 4) fail('source_unavailable', 'selected_limit');
      entry = { session, state: createFollowState() }; selected.set(key, entry);
    }
    await ensureMux();
    if (refresh && entry.state.inspect().phase === 'live' && !entry.waiting) { entry.handle?.cancel(); entry.handle = undefined; entry.state.disconnect(); }
    if (entry.state.inspect().phase === 'live') return entry;
    if (entry.waiting) { await entry.waiting; return entry; }
    entry.waiting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { entry.handle?.cancel(); entry.handle = undefined; entry.state.disconnect(); entry.reject = undefined; entry.resolve = undefined; reject(new DshError('timeout', 'dsh.follow_snapshot')); }, 15000);
      entry.resolve = (value) => { clearTimeout(timer); resolve(value); };
      entry.reject = (error) => { clearTimeout(timer); reject(error); };
      if (!entry.handle) openFollow(entry);
    }).finally(() => { entry.waiting = undefined; });
    await entry.waiting;
    return entry;
  }
  async function listSessionPage(input) {
    const { params } = context(input); const limit = integer(params.limit ?? 100, 1, 200);
    for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now()) snapshots.delete(id);
    let snapshot, offset = 0, token;
    if (params.cursor !== undefined && params.cursor !== null) {
      const match = /^([\da-f-]{36}):(\d+)$/.exec(text(params.cursor));
      if (!match) fail('invalid_request', 'cursor');
      token = match[1]; offset = integer(Number(match[2]), 0);
      snapshot = snapshots.get(token);
      if (!snapshot || offset >= snapshot.items.length) fail('replay_required', 'snapshot_expired');
      transport.assertCurrent(snapshot.lease);
    } else {
      const lease = transport.capture(), generation = liveGeneration;
      const workspace = await baseline();
      const native = await transport.call('session/list', { _request: {} });
      transport.assertCurrent(lease);
      if (generation && generation !== liveGeneration) fail('replay_required', 'discovery_generation');
      const items = summaries(native, workspace, identity);
      const bytes = Buffer.byteLength(JSON.stringify(items));
      if (bytes > 16777216 || items.length > 100000) fail('source_unavailable', 'summary_snapshot_budget');
      if (snapshots.size >= 3 || [...snapshots.values()].reduce((sum, value) => sum + value.bytes, bytes) > 33554432) fail('source_unavailable', 'summary_snapshot_slots');
      token = randomUUID(); snapshot = { items, lease, bytes, expiresAt: now() + 60000 }; snapshots.set(token, snapshot);
      known.clear();
      for (const item of items) known.add(item.session.nativeSessionId);
      for (const id of selected.keys()) known.add(id);
    }
    const items = snapshot.items.slice(offset, offset + limit), next = offset + items.length;
    return { items, cursor: next < snapshot.items.length ? `${token}:${next}` : null, completeness: next < snapshot.items.length ? 'partial' : 'complete',
      source: 'native-summary-snapshot', total: snapshot.items.length, expiresAt: snapshot.expiresAt };
  }
  async function respondInteraction(input) {
    const { session, params } = context(input, true), key = text(params.interactionId), outcome = approvalOutcome(params.answer);
    const delivery = [...deliveries.values()].find((value) => value.key === key);
    if (!delivery || !delivery.live || fingerprint(delivery.session) !== fingerprint(session)) fail('conflict', 'interaction_stale');
    const guard = () => { leaseCurrent(delivery.generation, delivery.clientId); if (!delivery.live || deliveries.get(delivery.eventId) !== delivery) fail('conflict', 'interaction_cancelled'); };
    guard();
    const prepared = await transport.prepare('$events/result', { clientId: delivery.clientId, eventId: delivery.eventId, outcome });
    guard();
    const result = await operations.interactions.reply(key, delivery.scope, outcome, ({ signal }) => { guard(); return prepared.send(signal); });
    delivery.live = false; deliveries.delete(delivery.eventId);
    return result;
  }
  function subscribe(input) {
    const { session } = context(input, true);
    if (observers.size >= 64) fail('source_unavailable', 'observer_limit');
    const queue = []; let bytes = 0, wake, error, ended = false;
    const observer = { stop() { ended = true; wake?.(); wake = undefined; }, push(value) {
      if (ended || (value.session && value.session.nativeSessionId !== session.nativeSessionId)) return;
      const size = Buffer.byteLength(JSON.stringify(value));
      if (queue.length >= 256 || bytes + size > 2097152) { error = new DshError('replay_required', 'dsh.subscriber_overflow'); ended = true; observers.delete(observer); }
      else { queue.push({ value, size }); bytes += size; }
      wake?.(); wake = undefined;
    } };
    observers.add(observer);
    const ready = select(session, true).then(async () => {
      for (const delivery of deliveries.values()) {
        if (!delivery.live || !delivery.key || delivery.session?.nativeSessionId !== session.nativeSessionId) continue;
        const pending = await operations.interactions.get(delivery.key);
        if (delivery.live && delivery.generation === liveGeneration && pending.phase === 'pending') observer.push({ type: 'interaction-pending', session, interactionId: delivery.key, request: pending.payload.request });
      }
    }).catch((failure) => { error = failure; ended = true; wake?.(); });
    return { ready, async next() {
      await ready;
      if (error) throw error;
      if (!queue.length && !ended) await new Promise((resolve) => { wake = resolve; });
      if (error) throw error;
      const item = queue.shift(); if (item) { bytes -= item.size; return { value: item.value, done: false }; }
      return { value: undefined, done: true };
    }, async return() { ended = true; observers.delete(observer); queue.length = 0; bytes = 0; wake?.(); return { value: undefined, done: true }; },
    [Symbol.asyncIterator]() { return this; } };
  }
  async function close() {
    if (closed) return;
    closed = true; clearTimeout(reconnectTimer); reconnectTimer = undefined;
    mux?.close(); mux = undefined; clientId = undefined;
    transport.close();
    for (const entry of selected.values()) entry.reject?.(new DshError('cancelled', 'dsh.closed'));
    for (const delivery of deliveries.values()) await invalidate(delivery);
    deliveries.clear(); snapshots.clear(); selected.clear(); known.clear();
    await Promise.allSettled(pendingWork);
    publish({ type: 'source-closed' }); for (const observer of observers) observer.stop(); observers.clear();
  }
  const core = {
    inspect(input) { context(input); const state = options.getOwnedEndpoint()?.state ?? 'missing'; return { state: closed ? 'disabled' : state, protocolVersion: 1 }; },
    listSessionPage,
    async getSession(input) { const { session } = context(input, true); const entry = await select(session, true); return { session, snapshot: entry.snapshot, ...entry.state.inspect(), connectionGeneration: liveGeneration }; },
    async readHistoryPage(input) { const { session, params } = context(input, true); const entry = await select(session); return readDshHistoryPage({ transport, session, state: entry.state, beforeSeq: params.beforeSeq, throughSeq: params.throughSeq, limit: params.limit }); },
    async createSession(input) {
      const { params } = context(input), idempotencyKey = text(params.idempotencyKey);
      const request = record(params.request);
      if (!!request.cwd === !!request.workspaceId) fail('invalid_request', 'create_workspace');
      const result = await operations.durable({ idempotencyKey, method: 'session/create', args: { request } });
      text(record(result.result).sessionId); snapshots.clear(); known.add(result.result.sessionId);
      return { ...result, session: parseSessionRef({ ...identity, nativeSessionId: result.result.sessionId }) };
    },
    async send(input) {
      const { session, params } = context(input, true), idempotencyKey = text(params.idempotencyKey);
      const capturedScope = operations.capture(session);
      const payload = jsonValue(record(params.request));
      if (payload.sessionId !== undefined && payload.sessionId !== session.nativeSessionId) fail('conflict', 'prompt_session');
      await select(session);
      return operations.sessionMutation({ session, capturedScope, idempotencyKey, method: 'session/prompt', args: { request: { ...payload, sessionId: session.nativeSessionId } }, ongoing: true });
    },
    async cancel(input) {
      const { session, params } = context(input, true);
      return operations.durable({ session, parentOperationId: text(params.operationId), idempotencyKey: text(params.idempotencyKey), method: 'session/cancel', args: { request: { sessionId: session.nativeSessionId } } });
    },
    respondInteraction, subscribe,
    close(input) { context(input); return close(); },
  };
  const native = Object.fromEntries(Object.entries(EXTENSIONS).map(([name, declaration]) => [name, async (input) => {
    const { session, params } = context(input, declaration.scope === 'session');
    if (name === 'dsh.models.select') {
      const capturedScope = operations.capture(session);
      const catalog = await transport.call('session/modelCatalog', {});
      const selection = selectModel(catalog, params);
      const result = await operations.sessionMutation({ session, capturedScope, idempotencyKey: text(params.idempotencyKey), method: declaration.method,
        args: { request: { sessionId: session.nativeSessionId, ...selection } } });
      const selectedModel = record(record(result.result).selected);
      if (selectedModel.provider !== selection.provider || selectedModel.model !== selection.model) fail('reconcile_required', 'model_selection');
      return result;
    }
    return transport.call(declaration.method, {});
  }]));
  return { manifest: { ...identity, kind: 'dsh', protocolVersion: 1,
    core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, supported])),
    extensions: [...Object.entries(EXTENSIONS).map(([name, declaration]) => ({ name, owner: identity.harnessInstanceId, scope: declaration.scope,
      permission: declaration.mutation ? 'harness.mutate' : 'harness.read', schemaVersion: 1, support: supported })),
      ...['dsh.auth', 'dsh.providers.configure', 'dsh.plugins.configure', 'dsh.questions', 'dsh.delete', 'dsh.revert'].map((name) => ({ name, owner: identity.harnessInstanceId,
        scope: 'instance', permission: 'harness.mutate', schemaVersion: 1, support: unsupported('Native capability not verified for this driver') }))], capabilities: {} },
    driver: { core, native }, close };
}
