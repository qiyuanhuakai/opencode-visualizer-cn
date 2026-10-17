import { effectScope, toRaw } from 'vue';
import { useRuntimeConnection } from '../../composables/useRuntimeConnection';
import { createRuntimeChannels } from '../../runtime/channels';
import { parseRuntimeSelection } from '../../runtime/pendingSelection';
import { parseEnvironmentId, parseSessionRef, parseConnectionProfileId, decodeWorkspaceKey, encodeWorkspaceKey } from '../../../shared/runtime/identity.js';
import { parseRuntimeParams } from '../../../shared/runtime/runtimeWire.js';
import type { RuntimeMutationMethod } from '../../../shared/runtime/runtimeWire.js';
import type { Snapshot, Result } from '../../../shared/runtime/protocol.js';

type Start = Readonly<{ url: string; token: string; expectedEnvironmentId?: string; profileId?: string }>;
type FileInput = Readonly<{ target: string; workspaceKey: string; prefix: string }>;
type MutationInput = Readonly<{ target: string; method: RuntimeMutationMethod; params: unknown; idempotencyKey: string }>;
type Observer = Awaited<ReturnType<ReturnType<typeof useRuntimeConnection>['client']['snapshot']>>['observer'];
const main = document.querySelector('main');
if (!main) throw new Error('QA document has no main element');
main.hidden = true;
const surface = document.createElement('section');
surface.innerHTML = '<h1>Runtime connection QA</h1><p>Authenticated management connection and native runtime evidence.</p><button id="task19-disconnect" type="button">Disconnect runtime</button><pre id="task19-status" role="status" aria-live="polite">Ready</pre><details><summary>Observed actions</summary><pre id="task19-actions"></pre></details>';
document.body.append(surface);
const status = surface.querySelector('#task19-status');
const actions = surface.querySelector('#task19-actions');
if (!status || !actions) throw new Error('QA controls are missing');
const statusNode = status;
const actionsNode = actions;
const trace: unknown[] = [];
let runtime: ReturnType<typeof useRuntimeConnection> | undefined;
let channels: ReturnType<typeof createRuntimeChannels> | undefined;
let scope: ReturnType<typeof effectScope> | undefined;
let socketCount = 0;
let helloCount = 0;
const observers = new Map<string, Observer>();
function record(kind: string, value: unknown) {
  trace.push({ index: trace.length, at: performance.now(), kind, value });
  actionsNode.textContent = JSON.stringify(trace, null, 2);
}
function ready() {
  if (!runtime || !channels) throw new Error('QA runtime is not connected');
  return { runtime, channels };
}
async function stop() {
  for (const observer of observers.values()) await observer.close();
  observers.clear();
  channels?.dispose();
  runtime?.dispose();
  scope?.stop();
  runtime = undefined; channels = undefined; scope = undefined;
  statusNode.textContent = 'Disconnected';
  record('disposed', { socketCount, helloCount });
}
async function start(input: Start) {
  await stop();
  if (typeof input.token !== 'string' || input.token.length > 4096) throw new Error('Invalid QA authentication input');
  const selection = parseRuntimeSelection(location.search);
  const authentication = { bridgeToken: input.token };
  scope = effectScope();
  runtime = scope.run(() => useRuntimeConnection({
    reference: { url: input.url, ...(input.expectedEnvironmentId ? { expectedEnvironmentId: parseEnvironmentId(input.expectedEnvironmentId) } : {}), ...(input.profileId ? { profileId: parseConnectionProfileId(input.profileId) } : {}) },
    ...(selection ? { selection } : {}),
    resolveAuthentication: async () => authentication,
    createWebSocket(url) { socketCount += 1; return new WebSocket(url); },
  }));
  if (!runtime) throw new Error('QA scope did not create a runtime');
  runtime.connection.subscribe(event => {
    switch (event.kind) {
      case 'hello': helloCount += 1; record(event.kind, event); break;
      case 'binary': record(event.kind, { generation: event.generation, bytes: event.bytes.byteLength }); break;
      case 'frame': case 'error': case 'disconnected': record(event.kind, event); break;
      default: event satisfies never;
    }
  });
  channels = createRuntimeChannels(runtime);
  const reference = await runtime.connect();
  const inspection = await runtime.client.inspect();
  statusNode.textContent = JSON.stringify({ state: runtime.status.value.state, reference, harnesses: inspection.harnesses.map(entry => ({ kind: entry.manifest.kind, state: entry.inspection.state })) }, null, 2);
  return { reference, inspection, socketCount, helloCount, selection: toRaw(runtime.selection.value) };
}
async function snapshot(targetInput: string) {
  const { runtime } = ready();
  const target = parseEnvironmentId(targetInput);
  const pages: Snapshot[] = [];
  const result = await runtime.client.snapshot(target, ['harnesses', 'workspaces', 'session_summaries', 'interactions', 'operations'], { onPage(_collection, page) { pages.push(page); } });
  const observerKey = `${target}:${observers.size}`;
  observers.set(observerKey, result.observer);
  const sessions = pages.flatMap(page => page.items).flatMap(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || !('collection' in item) || item.collection !== 'session_summaries' || !('value' in item)) return [];
    const value = item.value;
    return typeof value === 'object' && value !== null && !Array.isArray(value) && 'session' in value ? [parseSessionRef(value.session)] : [];
  });
  const selection = runtime.resolveSelection(sessions, true);
  record('snapshot', { target, revision: result.revision, watermark: result.watermark, pages: pages.length, selection });
  return { pages, observerKey, token: result.token, revision: result.revision, watermark: result.watermark, selection };
}
async function upload(input: FileInput) {
  const { runtime, channels } = ready();
  const target = parseEnvironmentId(input.target);
  const workspaceKey = encodeWorkspaceKey(decodeWorkspaceKey(input.workspaceKey));
  const data = Uint8Array.from({ length: 4 * 65536 }, (_, index) => index % 251);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
  const files = await Promise.all(Array.from({ length: 4 }, (_, index) => channels.openFile(target, { workspaceKey, path: `${input.prefix}-${index}.bin`, size: data.length, sha256 })));
  let capacity: unknown;
  try { await channels.openFile(target, { workspaceKey, path: `${input.prefix}-overflow.bin`, size: data.length, sha256 }); }
  catch (error) { if (!(error instanceof Error)) throw error; capacity = 'code' in error ? error.code : error.name; }
  const writes = files.flatMap(file => Array.from({ length: 4 }, (_, index) => file.write(data.slice(index * 65536, (index + 1) * 65536))));
  record('writes-dispatched', { count: writes.length, channels: files.map(file => file.descriptor), bufferedBytes: runtime.connection.bufferedAmount });
  await Promise.all(writes);
  const receipts = await Promise.all(files.map(file => file.finish()));
  record('disk-acknowledged', { chunks: writes.length, receipts });
  return { receipts, capacity, chunks: writes.length, bufferedBytes: runtime.connection.bufferedAmount };
}
async function mutate(input: MutationInput) {
  const { runtime } = ready();
  const mutation = runtime.client.mutate(parseEnvironmentId(input.target), input.method, parseRuntimeParams(input.method, input.params), { idempotencyKey: input.idempotencyKey });
  const accepted = await mutation.accepted;
  record('durable-accepted', accepted);
  const executed = await mutation.executed;
  record('native-executed', executed);
  return { accepted, executed };
}
async function pty(input: FileInput) {
  const { runtime, channels } = ready();
  const target = parseEnvironmentId(input.target);
  const pty = await runtime.client.request(target, 'runtime.pty.create', { workspaceKey: encodeWorkspaceKey(decodeWorkspaceKey(input.workspaceKey)), command: '/bin/sh', args: ['-c', 'printf TASK19_PTY; head -c 131072 /dev/zero; printf TASK19_END'] });
  const channel = await channels.attachPty(target, pty.ptyId);
  const chunks: Uint8Array[] = [];
  let exited = false;
  const deadline = Date.now() + 15000;
  try {
    while (!exited && Date.now() < deadline) {
      const result = await channel.read(chunk => { chunks.push(chunk.data); });
      await Promise.all(result.chunks.map(chunk => channel.ack(chunk)));
      exited = result.exited && result.chunks.length === 0;
      if (exited && result.exitCode !== 0) throw new Error(`Real PTY exited with code ${result.exitCode}`);
    }
    if (!exited) throw new Error('Real PTY did not exit within its existing deadline');
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const decoded = chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
    record('pty', { pty, bytes, exited });
    return { pty, bytes, exited, starts: decoded.includes('TASK19_PTY'), ends: decoded.includes('TASK19_END') };
  } finally { await channel.detach(); await runtime.client.request(target, 'runtime.pty.detach', { ptyId: pty.ptyId }); }
}
export const task19 = {
  start, stop, snapshot, upload, mutate, pty,
  async attach(target: string) { return ready().runtime.client.attach(parseEnvironmentId(target)); },
  async read(observerKey: string) { const observer = observers.get(observerKey); if (!observer) throw new Error('Unknown QA observer'); return observer.read(); },
  async replay(target: string, after: number) { return ready().runtime.client.replay(parseEnvironmentId(target), after); },
  async snapshotToken(input: { target: string; token: string }) { return ready().runtime.client.request(parseEnvironmentId(input.target), 'runtime.snapshot', { collection: 'session_summaries', token: input.token }); },
  async reconnect() { const { runtime } = ready(); runtime.disconnect(); return runtime.connect(); },
  async failure(input: Start) {
    try { await start(input); return { rejected: false, code: null, status: toRaw(runtime?.status.value), selection: toRaw(runtime?.selection.value) }; }
    catch (error) { if (!(error instanceof Error)) throw error; return { rejected: true, code: 'code' in error ? error.code : error.name, status: toRaw(runtime?.status.value), selection: toRaw(runtime?.selection.value) }; }
  },
  async rejectedMutation(input: MutationInput) {
    try { await mutate(input); return { rejected: false, code: null }; }
    catch (error) { if (!(error instanceof Error)) throw error; return { rejected: true, code: 'code' in error ? error.code : error.name }; }
  },
  async rawAuthorityProbe(input: MutationInput) {
    const { runtime } = ready();
    const binding = runtime.client.scope(parseEnvironmentId(input.target)).binding;
    const id = `task19-auth-${crypto.randomUUID()}`;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Result>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Raw authority probe deadline')), 5000);
        unsubscribe = runtime.connection.subscribe(event => {
          if (event.kind === 'frame' && event.frame.kind === 'result' && event.frame.id === id) resolve(event.frame);
        });
        runtime.connection.send({ version: 1, kind: 'request', ...binding, id, method: input.method, params: parseRuntimeParams(input.method, input.params), idempotencyKey: input.idempotencyKey });
      });
      return { rejected: !result.ok, code: result.ok ? null : result.typedError.code, result };
    } finally { clearTimeout(timer); unsubscribe(); }
  },
  async unsupported(target: string) {
    try { await snapshot(target); return { rejected: false, code: null, selection: toRaw(ready().runtime.selection.value) }; }
    catch (error) { if (!(error instanceof Error)) throw error; return { rejected: true, code: 'code' in error ? error.code : error.name, selection: toRaw(ready().runtime.selection.value) }; }
  },
  async staleChannel(input: FileInput) {
    const { runtime, channels } = ready();
    const bytes = new Uint8Array([1]);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    const channel = await channels.openFile(parseEnvironmentId(input.target), { workspaceKey: encodeWorkspaceKey(decodeWorkspaceKey(input.workspaceKey)), path: input.prefix, size: 1, sha256 });
    const old = runtime.client.scope(parseEnvironmentId(input.target));
    runtime.disconnect(); await runtime.connect();
    let rejected: unknown;
    try { await channel.write(bytes); } catch (error) { if (!(error instanceof Error)) throw error; rejected = 'code' in error ? error.code : error.name; }
    return { rejected, oldCurrent: old.isCurrent(), oldGeneration: old.generation, generation: runtime.connection.status.generation, bufferedBytes: runtime.connection.bufferedAmount };
  },
  state() { return { trace, socketCount, helloCount, status: toRaw(runtime?.status.value), selection: toRaw(runtime?.selection.value), bufferedBytes: runtime?.connection.bufferedAmount }; },
};
declare global { interface Window { task19: typeof task19 } }
window.task19 = task19;
surface.querySelector('#task19-disconnect')?.addEventListener('click', () => { void stop().catch(error => { if (!(error instanceof Error)) throw error; statusNode.textContent = error.message; }); });
record('module-ready', { renderer: navigator.userAgent });
