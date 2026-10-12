import { randomUUID } from 'node:crypto';
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { validateFrame } from '../../shared/runtime/protocol.js';
import { encodeSessionKey, decodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { INDEX_COLLECTIONS, RUNTIME_WIRE_METHODS, parseRuntimeParams, parseRuntimeResult, parseTargetGrant } from '../../shared/runtime/runtimeWire.js';
import { createRuntimeChannels } from './runtimeChannels.js';

const operations = { 'session.list': 'listSessionPage', 'session.get': 'getSession', 'session.history': 'readHistoryPage', 'session.create': 'createSession', 'session.send': 'send', 'session.cancel': 'cancel', 'interaction.respond': 'respondInteraction' };
const critical = new Set(['session.cancel', 'interaction.respond', 'runtime.channel.ack', 'runtime.channel.cancel', 'runtime.pty.detach', 'runtime.observer.read', 'runtime.observer.resume', 'runtime.observer.close', 'runtime.target.detach']);
const publicKinds = new Set(['operation', 'acp-operation', 'opencode-instance-operation', 'opencode-cancellation', 'codex-instance-operation', 'codex-cancel-operation', 'kimi-instance', 'kimi-control', 'dsh-operation', 'interaction']);
function project(collection, row) {
  if (!['operations', 'interactions'].includes(collection)) return row;
  if (!row.value || !publicKinds.has(row.value.kind)) return null;
  const allowed = ['kind', 'scope', 'method', 'phase', 'outcome', 'session', 'parent', 'parentOperationId'];
  return { key: row.key, revision: row.revision, value: Object.fromEntries(allowed.filter(key => row.value[key] !== undefined).map(key => [key, row.value[key]])) };
}
export function createRuntimeDispatch({ management, targets = [], grants, binding, assertCurrent, inspect, send, sendBinary, canSend }) {
  const graphs = new Map([management, ...targets].map(graph => [graph.target, graph]));
  const allowed = new Map((grants ?? [...graphs.values()].map(graph => graph.grant)).map(grant => [grant.target, parseTargetGrant(grant)]));
  const attached = new Map(), used = new Set();
  const channels = createRuntimeChannels({ canSend });
  const lifetime = new AbortController();
  let generation = binding.generation, active = true, normal = 0, reserved = 0, closing;
  function current() { requireValue(active, 'runtime.connection', 'reconcile_required'); assertCurrent(); }
  function grantFor(target) {
    const graph = graphs.get(target), grant = allowed.get(target);
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
    return entry;
  }
  attach(management.target, true);
  function hello(entry) { return validateFrame({ version: 1, kind: 'hello', ...entry.binding, instanceId: entry.graph.instanceId, capabilities: entry.grant.capabilities }); }
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
  async function snapshots(entry) { entry.snapshots ??= entry.graph.snapshots.connect(entry.binding, entry.isCurrent); return entry.snapshots; }
  async function detach(entry) {
    entry.active = false; attached.delete(entry.binding.target); channels.detach(entry.binding.target); entry.observer?.value?.close();
    if (entry.snapshots) await (await entry.snapshots).close();
    await entry.workspace?.disconnect();
  }
  async function native(entry, frame, params, accepted, signal) {
    const mutation = RUNTIME_WIRE_METHODS[frame.method] === 'mutation';
    permission(entry, mutation ? 'session:write' : 'session:read');
    const manifest = entry.graph.registry.list().find(item => item.harnessInstanceId === params.harnessInstanceId);
    requireValue(manifest && manifest.environmentId === entry.binding.target, 'runtime.harness', 'unauthorized');
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
    if (mutation && (manifest.kind !== 'codex' || ['session.create', 'session.send'].includes(frame.method))) args.idempotencyKey = frame.idempotencyKey;
    entry.current();
    const invoke = () => entry.graph.registry.invoke({ environmentId: entry.binding.target, harnessInstanceId: params.harnessInstanceId, ...(params.session ? { session: params.session } : {}), channel: 'core', operation: operations[frame.method], params: args });
    if (!mutation) return invoke();
    const execution = await entry.graph.acceptance.run({ scope: { target: entry.binding.target, harnessInstanceId: params.harnessInstanceId, ...authority, ...(params.session ? { session: params.session } : {}) }, method: frame.method, idempotencyKey: frame.idempotencyKey, interactionId: args.interactionId, signal, onAccepted: receipt => accepted({ operationId: receipt.operationId }) }, invoke);
    return { operationId: execution.receipt.operationId, value: execution.value };
  }
  async function execute(entry, frame, params, accepted, signal) {
    const graph = entry.graph;
    if (operations[frame.method]) return native(entry, frame, params, accepted, signal);
    switch (frame.method) {
      case 'runtime.inspect': permission(entry, 'runtime:read'); return graph.inspect(inspect(), [...allowed.values()]);
      case 'runtime.target.attach': {
        requireValue(entry.graph === management, 'runtime.management', 'unauthorized');
        const target = attach(params.target); return { hello: hello(target), grant: target.grant };
      }
      case 'runtime.target.detach': {
        requireValue(entry.graph === management && params.target !== management.target, 'runtime.management', 'unauthorized');
        const target = attached.get(params.target); requireValue(target, 'runtime.target', 'unauthorized'); await detach(target); return { detached: true };
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
      case 'runtime.entity.resolve': {
        indexAccess(entry); match(params.event);
        const patch = params.event.payload; requireValue(INDEX_COLLECTIONS.includes(patch.collection), 'runtime.collection', 'unauthorized');
        const row = await graph.events.log.resolve({ ...patch, epoch: entry.binding.epoch, entityRevision: params.event.entityRevision });
        requireValue(!row.chunked, 'runtime.entity_chunked', 'replay_required');
        const value = project(patch.collection, row); requireValue(value, 'runtime.private_entity', 'unauthorized'); return { ...value, collection: patch.collection };
      }
      case 'runtime.observer.open': {
        indexAccess(entry); requireValue(!entry.observer, 'runtime.observer_duplicate', 'conflict');
        const placeholder = { id: randomUUID(), value: null }; entry.observer = placeholder;
        try { placeholder.value = await graph.events.connect(entry.binding, { after: params.after, isCurrent: entry.isCurrent }); entry.current(); return { observerId: placeholder.id }; }
        catch (error) { placeholder.value?.close(); entry.observer = null; throw error; }
      }
      case 'runtime.observer.read': case 'runtime.observer.resume': case 'runtime.observer.close': {
        indexAccess(entry); const observer = entry.observer; requireValue(observer?.id === params.observerId && observer.value, 'runtime.observer', 'unauthorized');
        if (frame.method === 'runtime.observer.read') return observer.value.read();
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
      case 'runtime.pty.create': permission(entry, 'workspace:pty'); workspaceKey(entry, params.workspaceKey); return workspace(entry).ptys.create(params);
      case 'runtime.pty.read': {
        permission(entry, 'workspace:pty'); const output = channels.readPty({ binding: entry.binding, workspace: workspace(entry) }, params.ptyId); output.binary.forEach(sendBinary); return output.result;
      }
      case 'runtime.pty.write': permission(entry, 'workspace:pty'); workspace(entry).ptys.write(params.ptyId, params.data); return { written: true };
      case 'runtime.pty.resize': permission(entry, 'workspace:pty'); workspace(entry).ptys.resize(params.ptyId, params); return { resized: true };
      case 'runtime.pty.detach': permission(entry, 'workspace:pty'); channels.detachPty({ binding: entry.binding, current: entry.current, workspace: workspace(entry) }, params.ptyId); return { detached: true };
      default: throw new ProtocolError('unsupported', 'runtime.method');
    }
  }
  return {
    hello: () => hello(attached.get(management.target)),
    binary(bytes) { current(); channels.binary(bytes); },
    async request(input) {
      const frame = validateFrame(input); requireValue(frame.kind === 'request', 'runtime.request');
      const base = { version: 1, kind: 'result', target: frame.target, epoch: frame.epoch, generation: frame.generation, id: frame.id };
      let admitted = false, reservedAdmission = false, entry, timer;
      const controller = new AbortController();
      const priority = critical.has(frame.method);
      try {
        entry = match(frame); requireValue(!used.has(frame.id) && used.size < 65536, 'runtime.request_id', 'conflict'); used.add(frame.id);
        requireValue(entry.grant.capabilities.methods.includes(frame.method), 'runtime.method', 'unsupported');
        reservedAdmission = normal >= 496;
        const reserveLimit = frame.method === 'session.cancel' || frame.method === 'interaction.respond' ? 16 : 12;
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
      } finally { clearTimeout(timer); controller.abort(); if (admitted) { if (reservedAdmission) reserved--; else normal--; } }
    },
    close() { closing ??= (async () => { active = false; lifetime.abort(); channels.close(); await Promise.allSettled([...attached.values()].map(detach)); })(); return closing; },
  };
}
