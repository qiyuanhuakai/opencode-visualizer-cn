import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeClient } from './client';
import { createRuntimeConnection } from './connection';
import { createRuntimeChannels } from './channels';
import { decodeBinary, decodeFrame, encodeBinary, encodeFrame } from '../../shared/runtime/protocol.js';
import type { BinaryChunk, Hello, Request } from '../../shared/runtime/protocol.js';
import { encodeWorkspaceKey, parseEnvironmentId, parseInstanceId } from '../../shared/runtime/identity.js';
import { parseCapabilities } from '../../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../../shared/runtime/runtimeWire.js';

const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const other = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const workspaceKey = encodeWorkspaceKey({ environmentId: target, canonicalPath: '/fixture', pathPolicy: { platform: 'posix', volumeId: 'test', caseSensitive: true } });
const capabilities = parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] });
const hello: Hello = { kind: 'hello', version: 1, target, epoch: 'epoch', generation: 1, instanceId: parseInstanceId('44444444-4444-4444-8444-444444444444'), capabilities };
const fileParams = { workspaceKey, path: 'fixture.bin', size: 5, sha256: 'a'.repeat(64) };
const descriptor = { channelId: 1, service: 'file', direction: 'upload', credits: 4, chunkBytes: 65536, offset: 0 };

class WireSocket extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  readonly requests: Request[] = [];
  readonly binaries: BinaryChunk[] = [];
  private waiter: ((request: Request) => void) | undefined;
  close() { this.readyState = 3; }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') { this.binaries.push(decodeBinary(data)); return; }
    const frame = decodeFrame(data);
    if (frame.kind !== 'request') throw new TypeError('Expected request');
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(frame); }
    else this.requests.push(frame);
  }
  next(): Promise<Request> {
    const request = this.requests.shift();
    return request ? Promise.resolve(request) : new Promise(resolve => { this.waiter = resolve; });
  }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  binary(chunk: { channelId: number; offset: number; data: Uint8Array }) { this.dispatchEvent(new MessageEvent('message', { data: encodeBinary(chunk).buffer })); }
  reply(request: Request, result: unknown) {
    this.frame({ version: 1, kind: 'result', target: request.target, epoch: request.epoch, generation: request.generation, id: request.id, ok: true, phase: 'read', result });
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
async function fixture() {
  const socket = new WireSocket();
  const created = Promise.withResolvers<void>();
  const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:43210/runtime' }, resolveAuthentication: async () => ({}), createWebSocket: () => { created.resolve(); return socket; } });
  const client = createRuntimeClient({ connection });
  const channels = createRuntimeChannels({ client, connection });
  cleanups.push(() => { channels.dispose(); client.dispose(); connection.dispose(); });
  const connected = connection.connect(); await created.promise; socket.frame(hello); await connected;
  return { socket, connection, client, channels };
}
async function file(f: Awaited<ReturnType<typeof fixture>>, size = 5) {
  const opened = f.channels.openFile(target, { ...fileParams, size });
  f.socket.reply(await f.socket.next(), descriptor);
  return opened;
}

describe('RuntimeChannels with production connection and fault-injected wire', () => {
  it('restores upload credit only after an exact correlated disk acknowledgement', async () => {
    const f = await fixture();
    const handle = await file(f);
    const writes = Array.from({ length: 4 }, () => handle.write(new Uint8Array([1])));
    const acks: Request[] = [];
    for (let index = 0; index < 4; index++) acks.push(await f.socket.next());
    const fifth = handle.write(new Uint8Array([2]));
    void fifth.then(undefined, () => undefined);
    expect(f.socket.binaries).toHaveLength(4);
    await expect(fifth).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(f.socket.binaries.map(chunk => chunk.offset)).toEqual([0, 1, 2, 3]);
    expect(f.connection.bufferedAmount).toBe(100);
    const first = acks[0]; if (!first) throw new TypeError('Missing ACK');
    f.socket.reply({ ...first, target: other }, first.params);
    await expect(handle.write(new Uint8Array([2]))).rejects.toMatchObject({ code: 'source_unavailable' });
    f.socket.reply(first, first.params); await writes[0];
    const final = handle.write(new Uint8Array([2])); const finalAck = await f.socket.next();
    for (const request of acks.slice(1)) f.socket.reply(request, request.params);
    f.socket.reply(finalAck, finalAck.params);
    await Promise.all([...writes, final]);
    expect(f.connection.bufferedAmount).toBe(0);
  });
  it('rejects a stale ACK and frees retained buffers when disconnected', async () => {
    const f = await fixture(); const handle = await file(f);
    const writing = handle.write(new Uint8Array([1])); const request = await f.socket.next();
    f.socket.reply({ ...request, generation: 2 }, request.params);
    expect(f.connection.bufferedAmount).toBe(25);
    f.connection.disconnect();
    await expect(writing).rejects.toMatchObject({ code: 'reconcile_required' });
    expect(f.connection.bufferedAmount).toBe(0);
    await expect(handle.write(new Uint8Array([2]))).rejects.toMatchObject({ code: 'reconcile_required' });
  });
  it('rejects mismatched ACK length instead of granting another upload credit', async () => {
    const f = await fixture(); const handle = await file(f);
    const writing = handle.write(new Uint8Array([1])); const request = await f.socket.next();
    f.socket.reply(request, { channelId: 1, offset: 0, length: 2 });
    await expect(writing).rejects.toMatchObject({ code: 'reconcile_required' });
    await expect(handle.write(new Uint8Array([2]))).rejects.toMatchObject({ code: 'reconcile_required' });
    expect(f.connection.bufferedAmount).toBe(0);
    expect(f.connection.status.state).toBe('disconnected');
  });
  it('keeps unfinished or inflight file content from being published', async () => {
    const f = await fixture(); const handle = await file(f, 1);
    await expect(handle.finish()).rejects.toMatchObject({ code: 'conflict' });
    const writing = handle.write(new Uint8Array([9])); const ack = await f.socket.next();
    await expect(handle.finish()).rejects.toMatchObject({ code: 'conflict' });
    f.socket.reply(ack, ack.params); await writing;
    const finishing = handle.finish(); const request = await f.socket.next();
    expect(request.method).toBe('runtime.channel.finish');
    f.socket.reply(request, { path: 'fixture.bin', sha256: fileParams.sha256, size: 1 });
    await expect(finishing).resolves.toMatchObject({ size: 1 });
  });
  it('bounds chunks at64KiB and counts socket bytes against a single shared8MiB budget', async () => {
    const f = await fixture(); const handle = await file(f, 65537);
    await expect(handle.write(new Uint8Array(65537))).rejects.toMatchObject({ code: 'invalid_request' });
    f.socket.bufferedAmount = 8 * 1024 * 1024 - 10;
    await expect(handle.write(new Uint8Array(1))).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(f.socket.binaries).toHaveLength(0);
    f.socket.bufferedAmount = 0;
  });
  it('limits combined file and PTY opening admissions to four per target', async () => {
    const f = await fixture();
    const openings = Array.from({ length: 4 }, (_, index) => f.channels.attachPty(target, `pty-${index}`));
    await expect(f.channels.openFile(target, fileParams)).rejects.toMatchObject({ code: 'source_unavailable' });
    for (let index = 0; index < 4; index++) f.socket.reply(await f.socket.next(), { ...descriptor, service: 'pty', direction: 'download', channelId: index + 1 });
    await Promise.all(openings);
  });
  it('burns channel identifiers after cancellation so a late frame cannot target a replacement', async () => {
    const f = await fixture(); const first = await file(f);
    const cancelling = first.cancel(); f.socket.reply(await f.socket.next(), { closed: true }); await cancelling;
    const replacement = f.channels.openFile(target, fileParams); f.socket.reply(await f.socket.next(), descriptor);
    await expect(replacement).rejects.toMatchObject({ code: 'conflict' });
  });
  it('holds PTY credit until consumer completion and explicit ACK', async () => {
    const f = await fixture();
    const opening = f.channels.attachPty(target, 'pty'); f.socket.reply(await f.socket.next(), { ...descriptor, service: 'pty', direction: 'download' });
    const handle = await opening;
    const consumed = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const bytes: number[] = [];
    const reading = handle.read(async chunk => { bytes.push(...chunk.data); entered.resolve(); await consumed.promise; });
    const request = await f.socket.next();
    const metadata = { channelId: 1, offset: 0, length: 2 };
    f.socket.reply(request, { chunks: [metadata], exited: false, exitCode: null, bufferedBytes: 2 });
    f.socket.binary({ channelId: 1, offset: 0, data: new Uint8Array([1, 255]) });
    await entered.promise;
    await expect(handle.ack(metadata)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.socket.requests).toHaveLength(0);
    consumed.resolve(); await reading;
    const acknowledgement = handle.ack(metadata); const ack = await f.socket.next();
    f.socket.reply(ack, metadata); await acknowledgement;
    await expect(handle.ack(metadata)).rejects.toMatchObject({ code: 'conflict' });
    expect(bytes).toEqual([1, 255]);
  });
  it('times out a missing PTY binary frame and releases its pending consumer', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const opening = f.channels.attachPty(target, 'pty'); f.socket.reply(await f.socket.next(), { ...descriptor, service: 'pty', direction: 'download' });
    const handle = await opening;
    const reading = handle.read(() => {}); const rejected = expect(reading).rejects.toMatchObject({ code: 'timeout' });
    f.socket.reply(await f.socket.next(), { chunks: [{ channelId: 1, offset: 0, length: 1 }], exited: false, exitCode: null, bufferedBytes: 1 });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a PTY metadata channel belonging to another mapping', async () => {
    const f = await fixture();
    const opening = f.channels.attachPty(target, 'pty'); f.socket.reply(await f.socket.next(), { ...descriptor, service: 'pty', direction: 'download' });
    const handle = await opening;
    const reading = handle.read(() => {});
    f.socket.reply(await f.socket.next(), { chunks: [{ channelId: 2, offset: 0, length: 1 }], exited: false, exitCode: null, bufferedBytes: 1 });
    await expect(reading).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('never frees a second credit for a duplicate upload ACK', async () => {
    const f = await fixture(); const handle = await file(f, 6);
    const first = handle.write(new Uint8Array([1])); const ack = await f.socket.next();
    f.socket.reply(ack, ack.params); await first;
    const held = Array.from({ length: 4 }, () => handle.write(new Uint8Array([2])));
    const requests: Request[] = []; for (let index = 0; index < 4; index++) requests.push(await f.socket.next());
    f.socket.reply(ack, ack.params);
    await expect(handle.write(new Uint8Array([3]))).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(f.socket.binaries).toHaveLength(5);
    for (const request of requests) f.socket.reply(request, request.params);
    await Promise.all(held);
  });
  it('rejects a misleading final hash even after every upload chunk was acknowledged', async () => {
    const f = await fixture(); const handle = await file(f, 1);
    const writing = handle.write(new Uint8Array([1])); const ack = await f.socket.next(); f.socket.reply(ack, ack.params); await writing;
    const finishing = handle.finish(); f.socket.reply(await f.socket.next(), { path: 'fixture.bin', sha256: 'b'.repeat(64), size: 1 });
    await expect(finishing).rejects.toMatchObject({ code: 'reconcile_required' });
  });
  it('admits all four credits on each of four file channels while ordinary capacity is free', async () => {
    const f = await fixture();
    const handles = [];
    for (let index = 0; index < 4; index++) {
      const opening = f.channels.openFile(target, { ...fileParams, size: 4, path: `fixture-${index}.bin` });
      f.socket.reply(await f.socket.next(), { ...descriptor, channelId: index + 1 });
      handles.push(await opening);
    }
    const writes = handles.flatMap(handle => Array.from({ length: 4 }, () => handle.write(new Uint8Array([1]))));
    const outcomes = Promise.allSettled(writes);
    expect(f.socket.requests.filter(request => request.method === 'runtime.channel.ack')).toHaveLength(16);
    for (let index = 0; index < 16; index++) { const request = await f.socket.next(); f.socket.reply(request, request.params); }
    expect((await outcomes).every(outcome => outcome.status === 'fulfilled')).toBe(true);
  });
  it('keeps an admission-blocked finish retryable and lets cancel reclaim the server upload slot', async () => {
    const f = await fixture();
    const handle = await file(f, 0);
    // 496 mirrors client.ts normalCount admission before a non-reserved method is refused.
    const suspended = Array.from({ length: 496 }, () => f.client.request(target, 'runtime.inspect', {}));
    for (const pending of suspended) void pending.catch(() => undefined);
    expect(f.socket.requests.filter(request => request.method === 'runtime.inspect')).toHaveLength(496);
    await expect(handle.finish()).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(f.socket.requests.some(request => request.method === 'runtime.channel.finish')).toBe(false);
    // An active handle is refused again; a released handle rejects with a binding error instead.
    await expect(handle.finish()).rejects.toMatchObject({ code: 'source_unavailable' });
    const cancelling = handle.cancel();
    const cancel = f.socket.requests.find(request => request.method === 'runtime.channel.cancel');
    if (!cancel) throw new TypeError('cancel was not sent to the server');
    f.socket.reply(cancel, { closed: true });
    await cancelling;
  });
  it('keeps an admission-blocked cancel cancellable instead of silently releasing the handle', async () => {
    const f = await fixture();
    const handle = await file(f, 0);
    // 496 ordinary plus 12 reserved mirrors both client.ts admission ceilings.
    const suspended = [
      ...Array.from({ length: 496 }, () => f.client.request(target, 'runtime.inspect', {})),
      ...Array.from({ length: 12 }, (_, index) => f.client.request(target, 'runtime.channel.ack', { channelId: 1, offset: index, length: 1 })),
    ];
    for (const pending of suspended) void pending.catch(() => undefined);
    await expect(handle.cancel()).rejects.toMatchObject({ code: 'source_unavailable' });
    await expect(handle.cancel()).rejects.toMatchObject({ code: 'source_unavailable' });
  });
  it('retires the connection when a finish outcome cannot be confirmed', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const handle = await file(f, 0);
    const finishing = handle.finish();
    const request = await f.socket.next();
    expect(request.method).toBe('runtime.channel.finish');
    const rejected = expect(finishing).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(f.connection.status.state).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });
});
