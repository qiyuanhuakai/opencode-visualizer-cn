import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeClient } from './client';
import { createRuntimeConnection } from './connection';
import { decodeFrame, encodeFrame } from '../../shared/runtime/protocol.js';
import type { Hello, Request, RuntimeEvent } from '../../shared/runtime/protocol.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../shared/runtime/identity.js';
import { parseCapabilities } from '../../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../../shared/runtime/runtimeWire.js';

const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const other = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const harness = parseHarnessInstanceId('33333333-3333-4333-8333-333333333333');
const capabilities = parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] });
const hello: Hello = { kind: 'hello', version: 1, target, epoch: 'epoch', generation: 1, instanceId: parseInstanceId('44444444-4444-4444-8444-444444444444'), capabilities };
const native = { harnessInstanceId: harness, session: { environmentId: target, harnessInstanceId: harness, nativeSessionId: 'same' }, args: {} };
const grant = (environment = target) => ({ target: environment, role: 'execution', capabilities, permissions: [], workspaceKeys: [] });
const inspection = { role: 'local', state: 'ready', subscribers: 1, topology: [], sources: [], connectionProfileId: '55555555-5555-4555-8555-555555555555', targets: [grant(), grant(other)], harnesses: [], transports: { direct: true, ssh: false, slurm: false } };

class WireSocket extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  readonly requests: Request[] = [];
  readonly sent: Request[] = [];
  private waiter: ((request: Request) => void) | undefined;
  close() { this.readyState = 3; }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') return;
    const frame = decodeFrame(data);
    if (frame.kind !== 'request') throw new TypeError('Expected request');
    this.sent.push(frame);
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(frame); }
    else this.requests.push(frame);
  }
  next(): Promise<Request> {
    const request = this.requests.shift();
    return request ? Promise.resolve(request) : new Promise(resolve => { this.waiter = resolve; });
  }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(request: Request, result: unknown, phase = 'read') {
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase, result });
  }
  error(request: Request, code = 'replay_required') {
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: false, typedError: { code, message: 'bounded failure' } });
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
async function fixture() {
  const socket = new WireSocket();
  const created = Promise.withResolvers<void>();
  const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:43210/runtime' }, resolveAuthentication: async () => ({}), createWebSocket: () => { created.resolve(); return socket; } });
  const client = createRuntimeClient({ connection });
  cleanups.push(() => { client.dispose(); connection.dispose(); });
  const connected = connection.connect();
  await created.promise;
  socket.frame(hello);
  await connected;
  return { socket, connection, client };
}
function event(seq: number): RuntimeEvent {
  return { version: 1, kind: 'event', target, epoch: 'epoch', generation: 1, seq, entityRevision: seq + 10, scope: `row-${seq}`, type: 'entity.patch', payload: { collection: 'session_summaries', key: String(seq), deleted: false } };
}

describe('RuntimeClient production connection with fault-injected wire', () => {
  it('keeps explicit targets unattached until their authenticated grant is inspected', async () => {
    const { client, socket } = await fixture();
    await expect(client.attach(other)).rejects.toMatchObject({ code: 'unauthorized' });
    const inspected = client.inspect(); socket.reply(await socket.next(), inspection); await inspected;
    const attaching = client.attach(other); socket.reply(await socket.next(), { hello: { ...hello, target: other, generation: 8 }, grant: grant(other) });
    await attaching;
    const result = client.request(other, 'session.list', { harnessInstanceId: harness, args: {} });
    const request = await socket.next();
    expect(request).toMatchObject({ target: other, generation: 8 });
    socket.reply(request, { rows: ['remote'] });
    await expect(result).resolves.toEqual({ rows: ['remote'] });
  });
  it('ignores a same-id result from the wrong target and stale binding', async () => {
    const { client, socket } = await fixture();
    const result = client.request(target, 'session.get', native);
    const request = await socket.next();
    let settled = false; void result.then(() => { settled = true; });
    socket.reply({ ...request, target: other }, { wrong: true });
    socket.reply({ ...request, generation: 22 }, { wrong: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.reply(request, { title: 'correct' });
    await expect(result).resolves.toEqual({ title: 'correct' });
  });
  it('rejects stale selection after the wire result without dispatching another scope', async () => {
    const { client, socket } = await fixture();
    let selected = true;
    const result = client.request(target, 'session.get', native, { selectionCurrent: () => selected });
    const request = await socket.next();
    selected = false;
    socket.reply(request, { title: 'stale' });
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(socket.sent).toHaveLength(1);
  });
  it('aborts reads locally while consuming their late reply without native cancellation', async () => {
    const { client, socket } = await fixture();
    const controller = new AbortController();
    const result = client.request(target, 'session.get', native, { signal: controller.signal });
    const request = await socket.next();
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled', uncertain: false });
    socket.reply(request, { late: true });
    expect(socket.sent.map(frame => frame.method)).toEqual(['session.get']);
  });
  it('bounds hung reads at15 seconds while reserving cancellation capacity', async () => {
    vi.useFakeTimers();
    const { client, socket } = await fixture();
    const result = client.request(target, 'session.get', native);
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout', uncertain: false });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(socket.sent).toHaveLength(1);
  });
  it('keeps accepted and native-executed separate including interaction receipt namespace', async () => {
    const { client, socket } = await fixture();
    const mutation = client.mutate(target, 'interaction.respond', native, { idempotencyKey: 'answer' });
    const request = await socket.next();
    let executed = false; void mutation.executed.then(() => { executed = true; });
    socket.reply(request, { operationId: 'interaction:key' }, 'durable-accepted');
    await expect(mutation.accepted).resolves.toEqual({ operationId: 'interaction:key' });
    expect(executed).toBe(false);
    socket.reply(request, { operationId: 'interaction:key', value: { status: 'observed' } }, 'native-executed');
    await expect(mutation.executed).resolves.toEqual({ operationId: 'interaction:key', value: { status: 'observed' } });
  });
  it('rejects duplicate acceptance without claiming native execution', async () => {
    const { client, socket } = await fixture();
    const mutation = client.mutate(target, 'session.send', native, { idempotencyKey: 'intent' });
    const request = await socket.next();
    socket.reply(request, { operationId: 'operation' }, 'durable-accepted');
    await mutation.accepted;
    socket.reply(request, { operationId: 'operation' }, 'durable-accepted');
    socket.reply(request, { operationId: 'operation', value: { status: 'observed' } }, 'native-executed');
    await expect(mutation.executed).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects execution with a different accepted receipt', async () => {
    const { client, socket } = await fixture();
    const mutation = client.mutate(target, 'session.send', native, { idempotencyKey: 'intent' });
    const request = await socket.next();
    socket.reply(request, { operationId: 'child' }, 'durable-accepted');
    await mutation.accepted;
    socket.reply(request, { operationId: 'parent', value: {} }, 'native-executed');
    await expect(mutation.executed).rejects.toMatchObject({ code: 'reconcile_required' });
  });
  it('reports uncertain mutation on repeated disconnects and never resends it', async () => {
    const { client, socket, connection } = await fixture();
    const mutation = client.mutate(target, 'session.send', native, { idempotencyKey: 'intent' });
    await socket.next();
    connection.disconnect(); connection.disconnect();
    await expect(mutation.accepted).rejects.toMatchObject({ uncertain: true });
    await expect(mutation.executed).rejects.toMatchObject({ uncertain: true });
    expect(socket.sent.map(frame => frame.method)).toEqual(['session.send']);
  });
  it('rejects injected native authority before it reaches the wire', async () => {
    const { client, socket } = await fixture();
    await expect(client.request(target, 'session.get', { ...native, args: { permissions: ['admin'] } })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(socket.sent).toHaveLength(0);
  });
  it('preserves cancellation and permission capacity during normal transient request flooding', async () => {
    const { client, socket, connection } = await fixture();
    const held = Array.from({ length: 496 }, () => client.request(target, 'runtime.pty.read', { ptyId: 'bulk' }).then(undefined, () => undefined));
    await expect(client.request(target, 'runtime.pty.read', { ptyId: 'bulk' })).rejects.toMatchObject({ code: 'source_unavailable' });
    const cancel = client.mutate(target, 'session.cancel', native, { idempotencyKey: 'stop' });
    expect(socket.sent.at(-1)?.method).toBe('session.cancel');
    connection.disconnect();
    await Promise.all(held);
    await expect(cancel.executed).rejects.toMatchObject({ uncertain: true });
  });
  it('delivers out-of-order control hints without advancing the contiguous cursor', async () => {
    const { client, socket } = await fixture();
    const received: number[] = [];
    const opening = client.observe(target, { after: 0, onDelivery: delivery => { if (delivery?.kind === 'event' || delivery?.kind === 'control') received.push(delivery.frame.seq); } });
    socket.reply(await socket.next(), { observerId: 'observer' });
    const observer = await opening;
    const hint = observer.read(); socket.reply(await socket.next(), { kind: 'control', frame: event(4) }); await hint;
    const ordered = observer.read(); socket.reply(await socket.next(), { kind: 'event', frame: event(1) }); await ordered;
    expect(received).toEqual([4, 1]);
  });
  it('loops replay when a concurrent write advances the observer resume highwater', async () => {
    const { client, socket } = await fixture();
    const received: number[] = [];
    const opening = client.observe(target, { after: 0, onDelivery: delivery => { if (delivery?.kind === 'event') received.push(delivery.frame.seq); } });
    socket.reply(await socket.next(), { observerId: 'observer' });
    const observer = await opening;
    const reading = observer.read(); socket.reply(await socket.next(), { kind: 'replay_required', after: 0, through: 1, reason: 'overflow' });
    const first = await socket.next(); expect(first.params).toEqual({ after: 0 });
    socket.reply(first, { version: 1, kind: 'replay', target, epoch: 'epoch', generation: 1, after: 0, through: 1, events: [event(1)] });
    socket.error(await socket.next());
    socket.reply(await socket.next(), { kind: 'replay_required', after: 0, through: 2, reason: 'advanced' });
    const second = await socket.next(); expect(second.params).toEqual({ after: 1 });
    socket.reply(second, { version: 1, kind: 'replay', target, epoch: 'epoch', generation: 1, after: 1, through: 2, events: [event(2)] });
    socket.reply(await socket.next(), { resumed: true });
    await reading;
    expect(received).toEqual([1, 2]);
  });
  it('streams all collection pages at one token before ordered event consumption', async () => {
    const { client, socket } = await fixture();
    const pages: string[] = [];
    const page = { version: 1, kind: 'snapshot', target, epoch: 'epoch', generation: 1, token: 'atomic', revision: 10, watermark: 4, expiresAt: Date.now() + 60000, items: [], cursor: 'next' };
    const snapshot = client.snapshot(target, ['workspaces', 'session_summaries'], { onPage: (collection) => { pages.push(collection); } });
    socket.reply(await socket.next(), page);
    const observerRequest = await socket.next(); expect(observerRequest).toMatchObject({ method: 'runtime.observer.open', params: { after: 4 } });
    socket.reply(observerRequest, { observerId: 'observer' });
    const next = await socket.next(); expect(next.params).toMatchObject({ token: 'atomic', cursor: 'next' });
    socket.reply(next, { ...page, cursor: null });
    const collection = await socket.next(); expect(collection.params).toMatchObject({ token: 'atomic', collection: 'session_summaries', cursor: null });
    socket.reply(collection, { ...page, cursor: null });
    const result = await snapshot;
    const reading = result.observer.read(); socket.reply(await socket.next(), { kind: 'event', frame: event(5) });
    await reading;
    expect(pages).toEqual(['workspaces', 'workspaces', 'session_summaries']);
  });
  it('rejects mixed snapshot tokens and closes the pending observer', async () => {
    const { client, socket } = await fixture();
    const page = { version: 1, kind: 'snapshot', target, epoch: 'epoch', generation: 1, token: 'atomic', revision: 10, watermark: 4, expiresAt: Date.now() + 60000, items: [], cursor: null };
    const snapshot = client.snapshot(target, ['workspaces', 'session_summaries'], { onPage: () => {} });
    socket.reply(await socket.next(), page);
    socket.reply(await socket.next(), { observerId: 'observer' });
    socket.reply(await socket.next(), { ...page, token: 'foreign' });
    const closing = await socket.next(); expect(closing.method).toBe('runtime.observer.close'); socket.reply(closing, { closed: true });
    await expect(snapshot).rejects.toMatchObject({ code: 'replay_required' });
  });
  it('surfaces trimmed replay as an explicit fresh snapshot requirement', async () => {
    const { client, socket } = await fixture();
    const replay = client.replay(target, 0);
    socket.error(await socket.next());
    await expect(replay).rejects.toMatchObject({ code: 'replay_required' });
  });
  it('retires the connection after65536 correlation identities instead of recycling them', async () => {
    const { client, socket, connection } = await fixture();
    for (let index = 0; index < 65536; index++) {
      const pending = client.request(target, 'runtime.pty.write', { ptyId: 'pty', data: 'x' });
      socket.reply(await socket.next(), { written: true });
      await pending;
    }
    await expect(client.request(target, 'runtime.pty.write', { ptyId: 'pty', data: 'x' })).rejects.toMatchObject({ code: 'reconcile_required' });
    expect(new Set(socket.sent.map(request => request.id)).size).toBe(65536);
    expect(connection.status.state).toBe('disconnected');
  }, 20000);
  it('keeps four reserved slots for permissions when recovery acknowledgements are saturated', async () => {
    const { client, socket, connection } = await fixture();
    const normal = Array.from({ length: 496 }, () => client.request(target, 'runtime.pty.read', { ptyId: 'bulk' }).then(undefined, () => undefined));
    const held = Array.from({ length: 12 }, (_, offset) => client.request(target, 'runtime.channel.ack', { channelId: 1, offset, length: 1 }).then(undefined, () => undefined));
    await expect(client.request(target, 'runtime.channel.ack', { channelId: 1, offset: 12, length: 1 })).rejects.toMatchObject({ code: 'source_unavailable' });
    const replies = Array.from({ length: 4 }, (_, index) => client.mutate(target, 'interaction.respond', native, { idempotencyKey: `answer-${index}` }));
    const overflow = client.mutate(target, 'session.cancel', native, { idempotencyKey: 'overflow' });
    await expect(overflow.executed).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(socket.sent.at(-1)?.method).toBe('interaction.respond');
    expect(socket.sent).toHaveLength(512);
    connection.disconnect(); await Promise.all([...normal, ...held]);
    for (const reply of replies) await expect(reply.executed).rejects.toMatchObject({ uncertain: true });
  });
  it('rejects malformed incoming data and settles every held request', async () => {
    const { client, socket } = await fixture();
    const pending = client.request(target, 'session.get', native);
    socket.dispatchEvent(new MessageEvent('message', { data: '{malformed' }));
    await expect(pending).rejects.toMatchObject({ code: 'reconcile_required' });
  });
  it('rejects a native SessionRef from another environment before dispatch', async () => {
    const { client, socket } = await fixture();
    await expect(client.request(target, 'session.get', { ...native, session: { ...native.session, environmentId: other } })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(socket.sent).toHaveLength(0);
  });
  it('rejects expired atomic snapshots and closes their pending observer', async () => {
    const { client, socket } = await fixture();
    const snapshot = client.snapshot(target, 'workspaces', { onPage: () => {} });
    socket.reply(await socket.next(), { version: 1, kind: 'snapshot', target, epoch: 'epoch', generation: 1, token: 'expired', revision: 1, watermark: 0, expiresAt: Date.now() - 1, items: [], cursor: null });
    socket.reply(await socket.next(), { observerId: 'observer' });
    const close = await socket.next(); expect(close.method).toBe('runtime.observer.close'); socket.reply(close, { closed: true });
    await expect(snapshot).rejects.toMatchObject({ code: 'replay_required' });
  });
  it('requires a fresh snapshot when canonical resolution is chunked', async () => {
    const { client, socket } = await fixture();
    const pending = client.request(target, 'runtime.entity.resolve', { event: event(1) });
    socket.reply(await socket.next(), { collection: 'session_summaries', key: '1', revision: 11, chunked: true, bytes: 100000 });
    await expect(pending).rejects.toMatchObject({ code: 'replay_required' });
  });
});
