import { readRecord, readPayload } from './operationJournal.js';
import { authorizeNativeCall } from './nativeWirePolicy.js';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { validateFrame, decodeBinary, encodeBinary, LIMITS } from '../../shared/runtime/protocol.js';
import { encodeSessionKey, decodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { INDEX_COLLECTIONS, RUNTIME_WIRE_METHODS, parseRuntimeParams, parseRuntimeResult, parseTargetGrant } from '../../shared/runtime/runtimeWire.js';
import { createHistoryService } from './historyService.js';
import { createRuntimeChannels } from './runtimeChannels.js';

const operations = { 'session.list': 'listSessionPage', 'session.get': 'getSession', 'session.history': 'readHistoryPage', 'session.create': 'createSession', 'session.send': 'send', 'session.cancel': 'cancel', 'interaction.respond': 'respondInteraction' };
const critical = new Set(['runtime.history.close', 'session.cancel', 'interaction.respond', 'runtime.channel.ack', 'runtime.channel.cancel', 'runtime.pty.detach', 'runtime.observer.read', 'runtime.observer.resume', 'runtime.observer.close', 'runtime.target.detach']);
const TREE_BOOTSTRAP_BUDGET_MS = 450;
// A shorter lease leaves a full round trip between empty reads on remote
// links. Keep an idle lease open below the shared 15-second request deadline.
const INLINE_OBSERVER_WAIT_MS = 10_000;
const publicKinds = new Set(['operation', 'acp-operation', 'opencode-instance-operation', 'opencode-cancellation', 'codex-instance-operation', 'codex-cancel-operation', 'kimi-instance', 'kimi-control', 'dsh-operation', 'interaction', 'acp-interaction']);
function project(collection, row) {
  if (!['operations', 'interactions'].includes(collection)) return row;
  if (!row.value || !publicKinds.has(row.value.kind)) return null;
  const allowed = ['kind', 'scope', 'method', 'phase', 'outcome', 'session', 'parent', 'parentOperationId'];
  return { key: row.key, revision: row.revision, value: Object.fromEntries(allowed.filter(key => row.value[key] !== undefined).map(key => [key, row.value[key]])) };
}
export function createRuntimeDispatch({ management, targets = [], grants, binding, assertCurrent, inspect, send, sendBinary, canSend, retire }) {
  const graphs = new Map([management, ...targets].map(graph => [graph.target, graph]));
  const allowed = new Map((grants ?? [...graphs.values()].map(graph => graph.grant)).map(grant => [grant.target, parseTargetGrant(grant)]));
  const attached = new Map(), used = new Set();
  const channels = createRuntimeChannels({ canSend });
  const remoteChannels = new Map();
  let remoteChannelSerial = 65536;
  const lifetime = new AbortController();
  let historyOwner;
  let sessionSearch = false;
  function advertisedGrant(grant) {
    // Old peers reject unknown method names in hello and target grants.
    return sessionSearch || !grant.capabilities.methods.includes('runtime.session.search') ? grant : {
      ...grant, capabilities: { ...grant.capabilities, methods: grant.capabilities.methods.filter(method => method !== 'runtime.session.search') },
    };
  }
  let generation = binding.generation, active = true, normal = 0, reserved = 0, closing;
  function current() { requireValue(active, 'runtime.connection', 'reconcile_required'); assertCurrent(); }
  function grantFor(target) {
    let graph = graphs.get(target), grant = allowed.get(target);
    if (!graph) {
      const remote = management.remoteServices?.getTarget(target);
      if (remote) {
        graph = { target, epoch: remote.hello.epoch, instanceId: remote.hello.instanceId, capabilities: remote.hello.capabilities, grant: remote.grant, remote };
        grant = parseTargetGrant(remote.grant); graphs.set(target, graph); allowed.set(target, grant);
      }
    }
    requireValue(graph && grant, 'runtime.target', 'unauthorized');
    requireValue(grant.capabilities.methods.every(method => graph.capabilities.methods.includes(method)) && grant.permissions.every(permission => graph.grant.permissions.includes(permission)) && grant.workspaceKeys.every(key => graph.grant.workspaceKeys.includes(key)), 'runtime.grant', 'unauthorized');
    return { graph, grant };
  }
  function attach(target, initial = false) {
    current(); requireValue(!attached.has(target), 'runtime.attached', 'conflict');
    const { graph, grant } = grantFor(target);
    const targetBinding = initial ? binding : { target, epoch: graph.epoch, generation: ++generation };
    const entry = { graph, grant, binding: targetBinding, observer: null, snapshots: null, workspace: null, active: true };
    entry.current = () => { current(); requireValue(entry.active && attached.get(target) === entry, 'runtime.target_binding', 'reconcile_required'); };
    entry.isCurrent = () => { try { entry.current(); return true; } catch { return false; } };
    attached.set(target, entry);
    if (graph.remote) entry.unsubscribe = graph.remote.subscribe(frame => {
      if (!entry.isCurrent()) return;
      if (frame.kind === 'closed') { entry.active = false; attached.delete(target); graphs.delete(target); allowed.delete(target); entry.unsubscribe?.(); return; }
      if (frame.kind === 'binary') { const chunk = decodeBinary(frame.data); const match = [...remoteChannels].find(([, channel]) => channel.entry === entry && channel.remoteId === chunk.channelId); if (match) sendBinary(encodeBinary({ ...chunk, channelId: match[0] })); return; }
      if (frame.kind === 'event') send({ ...frame, ...entry.binding });
    });
    return entry;
  }
  attach(management.target, true);
  function hello(entry) { return validateFrame({ version: 1, kind: 'hello', ...entry.binding, instanceId: entry.graph.instanceId, capabilities: advertisedGrant(entry.grant).capabilities }); }
  function match(frame) {
    current(); const entry = attached.get(frame.target);
    requireValue(entry, 'runtime.target', 'unauthorized'); entry.current();
    requireValue(frame.epoch === entry.binding.epoch && frame.generation === entry.binding.generation, 'runtime.binding', 'reconcile_required');
    return entry;
  }
  function permission(entry, value) { requireValue(entry.grant.permissions.includes(value), 'runtime.permission', 'unauthorized'); }
  function workspace(entry) {
    entry.workspace ??= entry.graph.workspace.connect({ ...entry.binding, subscriberId: randomUUID(), assertCurrent: entry.current });
    return entry.workspace;
  }
  function workspaceKey(entry, key) { requireValue(entry.grant.workspaceKeys.includes(key) && decodeWorkspaceKey(key).environmentId === entry.binding.target, 'runtime.workspace', 'unauthorized'); return decodeWorkspaceKey(key).canonicalPath; }
  function indexAccess(entry) {
    permission(entry, 'runtime:read');
    requireValue(entry.graph.grant.workspaceKeys.every(key => entry.grant.workspaceKeys.includes(key)), 'runtime.index_scope', 'unauthorized');
  }
  async function resolveEntity(entry, event) {
    const patch = event.payload;
    requireValue(INDEX_COLLECTIONS.includes(patch.collection), 'runtime.collection', 'unauthorized');
    const row = await entry.graph.events.log.resolve({ ...patch, epoch: entry.binding.epoch, entityRevision: event.entityRevision });
    requireValue(!row.chunked, 'runtime.entity_chunked', 'replay_required');
    const value = project(patch.collection, row);
    return { ...(value ?? { key: row.key, revision: row.revision, value: null }), collection: patch.collection };
  }
  async function snapshots(entry) { entry.snapshots ??= entry.graph.snapshots.connect(entry.binding, entry.isCurrent); return entry.snapshots; }
  function history(entry) {
    entry.history ??= createHistoryService({
      binding: entry.binding,
      async authorize(params) {
        entry.current(); grantFor(entry.binding.target); permission(entry, 'session:read');
        requireValue(params.session.environmentId === entry.binding.target, 'runtime.history_target', 'unauthorized');
        const manifest = entry.graph.registry.list().find(item => item.harnessInstanceId === params.session.harnessInstanceId);
        requireValue(manifest && manifest.environmentId === entry.binding.target, 'runtime.harness', 'unauthorized');
        const summary = await entry.graph.store.get({ collection: 'session_summaries', key: encodeSessionKey(params.session) });
        requireValue(summary?.value?.workspaceKey, 'runtime.session_workspace', 'unauthorized'); workspaceKey(entry, summary.value.workspaceKey);
        entry.current(); return entry.graph.authority(params.session.harnessInstanceId);
      },
      openProducer: (params, authority) => entry.graph.registry.invoke({ environmentId: entry.binding.target, harnessInstanceId: params.session.harnessInstanceId, session: params.session, channel: 'core', operation: 'openHistory', params: { ...authority, ...(params.agentId === undefined ? {} : { agentId: params.agentId }) } }),
    });
    return entry.history;
  }
  async function detach(entry) {
    if (historyOwner?.entry === entry) historyOwner = undefined;
    for (const [id, channel] of remoteChannels) if (channel.entry === entry) remoteChannels.delete(id);
    entry.active = false; entry.unsubscribe?.(); attached.delete(entry.binding.target); channels.detach(entry.binding.target); entry.observer?.value?.close();
    const cleanup = await Promise.allSettled([entry.history?.dispose(), entry.snapshots ? Promise.resolve(entry.snapshots).then(snapshot => snapshot.close()) : undefined, entry.workspace?.disconnect()]);
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime target cleanup failed');
  }
  async function native(entry, frame, params, accepted, signal) {
    const mutation = RUNTIME_WIRE_METHODS[frame.method] === 'mutation';
    permission(entry, mutation ? 'session:write' : 'session:read');
    const manifest = entry.graph.registry.list().find(item => item.harnessInstanceId === params.harnessInstanceId);
    requireValue(manifest && manifest.environmentId === entry.binding.target, 'runtime.harness', 'unauthorized');
    const extension = frame.method === 'native.query' || frame.method === 'native.extension';
    if (extension) {
      authorizeNativeCall(manifest, params, frame.method, entry.grant.permissions);
      if (!params.session) indexAccess(entry);
    }
    if (params.session) {
      requireValue(params.session.environmentId === entry.binding.target, 'runtime.session', 'unauthorized');
      const summary = await entry.graph.store.get({ collection: 'session_summaries', key: encodeSessionKey(params.session) });
      requireValue(summary?.value?.workspaceKey, 'runtime.session_workspace', 'unauthorized');
      workspaceKey(entry, summary.value.workspaceKey);
    }
    const args = { ...params.args };
    let directory;
    if (params.workspaceKey) directory = workspaceKey(entry, params.workspaceKey);
    for (const candidate of [args.directory, args.cwd, args.request?.cwd]) if (candidate !== undefined) requireValue(candidate === directory, 'runtime.directory', 'unauthorized');
    if (frame.method === 'session.create') requireValue(directory, 'runtime.workspace', 'unauthorized');
    if (frame.method === 'session.list') indexAccess(entry);
    if (frame.method === 'session.list' && !params.session && !params.workspaceKey && Object.keys(args).length === 0) {
      await entry.graph.index.retry(params.harnessInstanceId);
      entry.current();
    }
    const authority = entry.graph.authority(params.harnessInstanceId);
    if (manifest.kind === 'codex') { if (params.workspaceKey && frame.method === 'session.create') args.workspaceKey = params.workspaceKey; }
    else {
      Object.assign(args, authority);
      if (directory) {
        if (manifest.kind === 'dsh' && frame.method === 'session.create') { requireValue(!args.request?.workspaceId, 'runtime.native_workspace', 'unauthorized'); args.request = { ...args.request, cwd: directory }; }
        else if (manifest.kind === 'acp') args.cwd = directory;
        else args.directory = directory;
      }
    }
    if (mutation && (extension || manifest.kind !== 'codex' || ['session.create', 'session.send'].includes(frame.method))) args.idempotencyKey = frame.idempotencyKey;
    entry.current();
    const invoke = () => entry.graph.registry.invoke({ environmentId: entry.binding.target, harnessInstanceId: params.harnessInstanceId, ...(params.session ? { session: params.session } : {}), channel: extension ? 'native' : 'core', operation: extension ? params.operation : operations[frame.method], ...(extension ? { permissions: entry.grant.permissions } : {}), params: args });
    if (!mutation) return invoke();
    const execution = await entry.graph.acceptance.run({ scope: { target: entry.binding.target, harnessInstanceId: params.harnessInstanceId, ...authority, ...(params.session ? { session: params.session } : {}) }, method: frame.method, idempotencyKey: frame.idempotencyKey, interactionId: args.interactionId, signal, onAccepted: receipt => accepted({ operationId: receipt.operationId }) }, invoke);
    return { operationId: execution.receipt.operationId, value: execution.value };
  }
  async function execute(entry, frame, params, accepted, signal) {
    const graph = entry.graph;
    if (graph.remote) {
      let remoteParams = params, channel;
      if (frame.method === 'runtime.entity.resolve') {
        requireValue(match(params.event) === entry, 'runtime.event_target', 'unauthorized');
        const remoteBinding = graph.remote.hello;
        remoteParams = { ...params, event: { ...params.event, target: remoteBinding.target, epoch: remoteBinding.epoch, generation: remoteBinding.generation } };
      }
      if (params.channelId !== undefined) {
        channel = remoteChannels.get(params.channelId);
        requireValue(channel?.entry === entry, 'runtime.remote_channel', 'unauthorized');
        remoteParams = { ...params, channelId: channel.remoteId };
      }
      if (frame.method === 'runtime.inspect' && params.bootstrapEncoding) remoteParams = { bootstrapTree: true };
      const result = await graph.remote.request({ ...frame, params: remoteParams }, accepted);
      const rebind = nested => {
        const source = graph.remote.hello;
        requireValue(nested.target === source.target && nested.epoch === source.epoch && nested.generation === source.generation, 'runtime.remote_binding', 'reconcile_required');
        return { ...nested, ...entry.binding };
      };
      if (frame.method === 'runtime.inspect' && result.treeBootstrap) return { ...result, treeBootstrap: result.treeBootstrap.map(rebind) };
      if (frame.method === 'runtime.snapshot') return rebind(result);
      if (frame.method === 'runtime.replay') return { ...rebind(result), events: result.events.map(rebind) };
      if (frame.method === 'runtime.observer.read' && result?.kind === 'events') {
        return { ...result, events: result.events.map(delivery => ({ ...delivery, frame: rebind(delivery.frame) })) };
      }
      if (frame.method === 'runtime.observer.read' && result && ['event', 'control'].includes(result.kind)) return { ...result, frame: rebind(result.frame) };
      if (frame.method === 'runtime.channel.open') {
        requireValue(remoteChannelSerial < 0xffffffff, 'runtime.remote_channels', 'source_unavailable');
        const channelId = ++remoteChannelSerial;
        remoteChannels.set(channelId, { entry, remoteId: result.channelId, ptyId: params.ptyId });
        return { ...result, channelId };
      }
      if (frame.method === 'runtime.channel.ack') return { ...result, channelId: params.channelId };
      if (frame.method === 'runtime.channel.cancel' || frame.method === 'runtime.channel.finish') remoteChannels.delete(params.channelId);
      if (frame.method === 'runtime.pty.detach' || frame.method === 'runtime.pty.remove') for (const [id, owned] of remoteChannels) if (owned.entry === entry && owned.ptyId === params.ptyId) remoteChannels.delete(id);
      if (frame.method === 'runtime.pty.read') return { ...result, chunks: result.chunks.map(chunk => { const match = [...remoteChannels].find(([, owned]) => owned.entry === entry && owned.remoteId === chunk.channelId); requireValue(match, 'runtime.remote_channel', 'unauthorized'); return { ...chunk, channelId: match[0] }; }) };
      return result;
    }
    if (operations[frame.method] || frame.method === 'native.query' || frame.method === 'native.extension') return native(entry, frame, params, accepted, signal);
    switch (frame.method) {
      case 'runtime.history.open': {
        const old = historyOwner, owner = { entry, historyId: params.historyId }; historyOwner = owner;
        if (old && old.entry !== entry) {
          try { await history(old.entry).close({ historyId: old.historyId }); }
          catch (error) { if (!(error instanceof ProtocolError) || !['unauthorized', 'reconcile_required', 'replay_required'].includes(error.code)) throw error; }
        }
        requireValue(historyOwner === owner, 'history.superseded', 'cancelled');
        return history(entry).open(params);
      }
      case 'runtime.history.page': return history(entry).page(params);
      case 'runtime.history.chunk': return history(entry).chunk(params);
      case 'runtime.history.read': return history(entry).read(params);
      case 'runtime.history.close': return history(entry).close(params);
      case 'runtime.host.read':
        return graph.hostServices.read(params, { target: entry.binding.target, permissions: entry.grant.permissions, workspaceKeys: entry.grant.workspaceKeys });
      case 'runtime.host.mutate':
        return graph.hostServices.mutate(params, { target: entry.binding.target, permissions: entry.grant.permissions, workspaceKeys: entry.grant.workspaceKeys, idempotencyKey: frame.idempotencyKey, onAccepted: accepted });
      case 'runtime.inspect': {
        permission(entry, 'runtime:read');
        await management.remoteServices?.refreshTargets?.();
        for (const [target, cached] of graphs) {
          if (cached.remote && management.remoteServices?.getTarget(target) !== cached.remote) {
            const stale = attached.get(target);
            if (stale) await detach(stale);
            graphs.delete(target); allowed.delete(target);
          }
          if (!grants && !cached.remote) {
            const refreshed = parseTargetGrant(cached.grant);
            allowed.set(target, refreshed);
            const currentTarget = attached.get(target);
            if (currentTarget) currentTarget.grant = refreshed;
          }
        }
        for (const grant of management.remoteServices?.listTargets() ?? []) grantFor(grant.target);
        if (params.sessionSearch === true) sessionSearch = true;
        const inspection = Promise.resolve(graph.inspect(inspect(), [...allowed.values()].map(advertisedGrant)));
        if (!params.bootstrapTree || entry.treeBootstrapStarted || !entry.grant.capabilities.methods.includes('runtime.snapshot')
          || !graph.grant.workspaceKeys.every(key => entry.grant.workspaceKeys.includes(key))) return inspection;
        // Only the first opt-in inspection on this attachment owns a startup token.
        entry.treeBootstrapStarted = true;
        const view = snapshots(entry);
        let first;
        let keep = false;
        let abandoned = false;
        const loadPages = async () => {
          const snapshot = await view;
          first = await snapshot.page({ collection: 'harnesses', limit: 200 });
          if (abandoned) return undefined;
          const token = first.token;
          const remaining = await Promise.allSettled([
            snapshot.page({ collection: 'workspaces', token, limit: 200 }),
            snapshot.page({ collection: 'session_summaries', token, limit: 32 }),
          ]);
          if (remaining.some(page => page.status === 'rejected')) return undefined;
          return [first, ...remaining.map(page => page.value)];
        };
        const loaded = loadPages().catch(() => undefined);
        let timer;
        const budget = new Promise(resolve => { timer = setTimeout(resolve, TREE_BOOTSTRAP_BUDGET_MS); });
        const optionalPages = Promise.race([loaded, budget]);
        try {
          const base = await inspection;
          const pages = await optionalPages;
          entry.current();
          if (!pages || signal.aborted) return base;
          const result = { ...base };
          if (params.bootstrapEncoding) {
            const includesInspection = params.bootstrapEncoding === 'gzip-inspection';
            const payload = includesInspection ? { targets: base.targets, harnesses: base.harnesses, treeBootstrap: pages } : pages;
            const raw = Buffer.from(JSON.stringify(payload));
            if (raw.length > LIMITS.jsonBytes - 4096) return base;
            if (includesInspection) {
              result.targets = [];
              result.harnesses = [];
            }
            result.treeBootstrapGzip = {
              bytes: raw.length, data: gzipSync(raw, { level: 1 }).toString('base64'),
              ...(includesInspection ? { includesInspection: true } : {}),
            };
          } else result.treeBootstrap = pages;
          if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.jsonBytes - 4096) return base;
          keep = true;
          return result;
        } finally {
          clearTimeout(timer);
          // A slow store request may still create a token after plain inspection has returned.
          if (!keep) {
            abandoned = true;
            const release = async () => {
              if (first) await (await view).release({ token: first.token });
            };
            void (first ? release() : loaded.then(release)).catch(() => {});
          }
        }
      }
      case 'runtime.target.attach': {
        requireValue(entry.graph === management, 'runtime.management', 'unauthorized');
        const target = attach(params.target); return { hello: hello(target), grant: advertisedGrant(target.grant) };
      }
      case 'runtime.target.detach': {
        requireValue(entry.graph === management && params.target !== management.target, 'runtime.management', 'unauthorized');
        const target = attached.get(params.target); requireValue(target, 'runtime.target', 'unauthorized'); await detach(target); return { detached: true };
      }
      case 'runtime.interaction.read': {
        permission(entry, 'session:read');
        const session = params.session;
        requireValue(session.environmentId === entry.binding.target, 'interaction.target', 'unauthorized');
        const summary = await graph.store.get({ collection: 'session_summaries', key: encodeSessionKey(session) });
        requireValue(summary?.value?.workspaceKey, 'interaction.workspace', 'unauthorized');
        workspaceKey(entry, summary.value.workspaceKey);
        const row = await readRecord(graph.store, 'interactions', params.interactionId);
        requireValue(row?.value && ['interaction', 'acp-interaction'].includes(row.value.kind), 'interaction.missing', 'conflict');
        const scope = row.value.scope;
        requireValue(scope?.session && encodeSessionKey(scope.session) === encodeSessionKey(session), 'interaction.session', 'unauthorized');
        const authority = graph.authority(session.harnessInstanceId);
        requireValue(scope.epoch === authority.epoch && scope.processGeneration === authority.processGeneration, 'interaction.generation', 'reconcile_required');
        requireValue(row.value.payloadRef.bytes <= 48 * 1024, 'interaction.payload_budget', 'source_unavailable');
        const payload = await readPayload(graph.store, 'interactions', row.value.payloadRef);
        entry.current();
        const currentAuthority = graph.authority(session.harnessInstanceId);
        requireValue(scope.epoch === currentAuthority.epoch && scope.processGeneration === currentAuthority.processGeneration, 'interaction.generation', 'reconcile_required');
        return { interactionId: params.interactionId, session, phase: row.value.phase, payload };
      }
      case 'runtime.session.search': {
        indexAccess(entry);
        const page = await entry.graph.store.searchSessions(params);
        return { ...page, items: page.items.map(row => ({ ...row, collection: 'session_summaries' })) };
      }
      case 'runtime.snapshot': {
        indexAccess(entry); const page = await (await snapshots(entry)).page(params);
        return { ...page, items: page.items.map(row => { const item = project(params.collection, row); return item && { ...item, collection: params.collection }; }).filter(Boolean) };
      }
      case 'runtime.snapshot.chunk': {
        indexAccess(entry); requireValue(!['operations', 'interactions'].includes(params.collection), 'runtime.private_chunk', 'unauthorized');
        return (await snapshots(entry)).readChunk(params);
      }
      case 'runtime.replay': indexAccess(entry); return (await snapshots(entry)).replay(params);
      case 'runtime.snapshot.release': indexAccess(entry); return (await snapshots(entry)).release(params);
      case 'runtime.entity.resolve': {
        indexAccess(entry); match(params.event);
        return resolveEntity(entry, params.event);
      }
      case 'runtime.observer.open': {
        indexAccess(entry); requireValue(!entry.observer, 'runtime.observer_duplicate', 'conflict');
        const placeholder = { id: randomUUID(), value: null }; entry.observer = placeholder;
        try { placeholder.value = await graph.events.connect(entry.binding, { after: params.after, isCurrent: entry.isCurrent }); entry.current(); return { observerId: placeholder.id }; }
        catch (error) { placeholder.value?.close(); entry.observer = null; throw error; }
      }
      case 'runtime.observer.read': case 'runtime.observer.resume': case 'runtime.observer.close': {
        indexAccess(entry); const observer = entry.observer; requireValue(observer?.id === params.observerId && observer.value, 'runtime.observer', 'unauthorized');
        if (frame.method === 'runtime.observer.read') {
          requireValue(!observer.reading, 'runtime.observer_reading', 'conflict');
          observer.reading = true;
          try {
            const delivery = await observer.value.waitRead(signal, params.resolveSummary ? INLINE_OBSERVER_WAIT_MS : undefined);
            if (delivery?.kind !== 'event') return delivery;
            const events = [delivery];
            if (params.maxEvents > 1) {
              const reserve = 256 * 1024 - Buffer.byteLength(JSON.stringify(delivery));
              events.push(...observer.value.drainEvents(params.maxEvents - 1, reserve));
            }
            let canonicalBudget = 512 * 1024;
            const resolved = await Promise.all(events.map(async item => {
              const collection = item.frame.payload?.collection;
              if (!params.resolveSummary || item.frame.type !== 'entity.patch'
                || (collection !== 'session_summaries' && !(params.resolveWorkspace && collection === 'workspaces'))) return item;
              const canonical = await resolveEntity(entry, item.frame).catch(() => undefined);
              if (!canonical) return item;
              const bytes = Buffer.byteLength(JSON.stringify(canonical));
              if (bytes > canonicalBudget) return item;
              canonicalBudget -= bytes;
              return { ...item, canonical };
            }));
            requireValue(entry.observer === observer, 'runtime.observer', 'reconcile_required');
            return resolved.length === 1 ? resolved[0] : { kind: 'events', events: resolved };
          } finally { observer.reading = false; }
        }
        if (frame.method === 'runtime.observer.resume') { observer.value.resume(params.after); return { resumed: true }; }
        observer.value.close(); entry.observer = null; return { closed: true };
      }
      case 'runtime.channel.open': {
        permission(entry, params.service === 'file' ? 'workspace:write' : 'workspace:pty');
        if (params.service === 'file') workspaceKey(entry, params.workspaceKey);
        return channels.open({ binding: entry.binding, current: entry.current, workspace: workspace(entry) }, params);
      }
      case 'runtime.channel.ack': return channels.acknowledge(entry.binding, params);
      case 'runtime.channel.finish': return channels.finish(entry.binding, params.channelId);
      case 'runtime.channel.cancel': return channels.cancel(entry.binding, params.channelId);
      case 'runtime.workspace.info': case 'runtime.workspace.list': case 'runtime.workspace.read': {
        permission(entry, 'workspace:read'); workspaceKey(entry, params.workspaceKey);
        const result = await workspace(entry).reads[frame.method.slice('runtime.workspace.'.length)](params);
        entry.current(); return result;
      }
      case 'runtime.pty.create': permission(entry, 'workspace:pty'); workspaceKey(entry, params.workspaceKey); return workspace(entry).ptys.create(params);
      case 'runtime.pty.read': {
        permission(entry, 'workspace:pty'); const output = channels.readPty({ binding: entry.binding, workspace: workspace(entry) }, params.ptyId); output.binary.forEach(sendBinary); return output.result;
      }
      case 'runtime.pty.write': permission(entry, 'workspace:pty'); workspace(entry).ptys.write(params.ptyId, params.data); return { written: true };
      case 'runtime.pty.resize': permission(entry, 'workspace:pty'); workspace(entry).ptys.resize(params.ptyId, params); return { resized: true };
      case 'runtime.pty.detach': permission(entry, 'workspace:pty'); channels.detachPty({ binding: entry.binding, current: entry.current, workspace: workspace(entry) }, params.ptyId); return { detached: true };
      case 'runtime.pty.remove': permission(entry, 'workspace:pty'); channels.detachPty({ binding: entry.binding, current: entry.current, workspace: workspace(entry) }, params.ptyId); await workspace(entry).ptys.remove(params.ptyId); return { removed: true };
      default: throw new ProtocolError('unsupported', 'runtime.method');
    }
  }
  function closeConnection() {
    closing ??= (async () => {
      active = false; lifetime.abort(); channels.close();
      try {
        const cleanup = await Promise.allSettled([...attached.values()].map(detach));
        const failures = cleanup.filter(result => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime connection cleanup failed');
      } finally { retire?.(); }
    })();
    return closing;
  }
  function retireConnection() {
    return closeConnection();
  }
  return {
    hello: () => hello(attached.get(management.target)),
    binary(bytes) { current(); const chunk = decodeBinary(bytes), channel = remoteChannels.get(chunk.channelId); if (channel) { channel.entry.current(); channel.entry.graph.remote.sendBinary(encodeBinary({ ...chunk, channelId: channel.remoteId })); } else channels.binary(bytes); },
    async request(input) {
      const frame = validateFrame(input); requireValue(frame.kind === 'request', 'runtime.request');
      const base = { version: 1, kind: 'result', target: frame.target, epoch: frame.epoch, generation: frame.generation, id: frame.id };
      let admitted = false, reservedAdmission = false, entry, timer;
      const controller = new AbortController();
      const priority = critical.has(frame.method);
      try {
        entry = match(frame); requireValue(!used.has(frame.id) && used.size < 65536, 'runtime.request_id', 'conflict'); used.add(frame.id);
        requireValue(entry.grant.capabilities.methods.includes(frame.method)
          && (frame.method !== 'runtime.session.search' || sessionSearch), 'runtime.method', 'unsupported');
        reservedAdmission = normal >= 496;
        const reserveLimit = frame.method === 'runtime.history.close' || frame.method === 'session.cancel' || frame.method === 'interaction.respond' ? 16 : 12;
        requireValue(!reservedAdmission || (priority && reserved < reserveLimit), 'runtime.admission', 'source_unavailable');
        if (reservedAdmission) reserved++; else normal++; admitted = true;
        const params = parseRuntimeParams(frame.method, frame.params);
        const result = await Promise.race([
          execute(entry, frame, params, result => { if (!controller.signal.aborted && entry.isCurrent()) send({ ...base, ok: true, phase: 'durable-accepted', result }); }, AbortSignal.any([lifetime.signal, controller.signal])),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new ProtocolError('timeout', 'runtime.deadline')), 15000); timer.unref?.(); }),
        ]);
        entry.current(); send({ ...base, ok: true, phase: RUNTIME_WIRE_METHODS[frame.method] === 'mutation' ? 'native-executed' : 'read', result: parseRuntimeResult(frame.method, result) });
      } catch (error) {
        const codes = new Set(['invalid_request', 'unauthorized', 'unsupported', 'version_mismatch', 'conflict', 'reconcile_required', 'replay_required', 'source_unavailable', 'timeout', 'cancelled']);
        if (active) send({ ...base, ok: false, typedError: { code: codes.has(error?.code) ? error.code : 'source_unavailable', message: codes.has(error?.code) ? error.message : 'Runtime request failed.' } });
        if (error?.field === 'history.tombstones_exhausted') await retireConnection();
      } finally { clearTimeout(timer); controller.abort(); if (admitted) { if (reservedAdmission) reserved--; else normal--; } }
    },
    close: closeConnection,
  };
}
