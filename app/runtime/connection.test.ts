import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBinary, encodeFrame, LIMITS, type Hello, type Request } from '../../shared/runtime/protocol.js';
import { parseEnvironmentId, parseInstanceId } from '../../shared/runtime/identity.js';
import { createRuntimeConnection, type RuntimeConnectionEvent, type RuntimeSocket } from './connection';

const hello: Hello = { version: 1, kind: 'hello', target: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), epoch: 'epoch-a', generation: 1, instanceId: parseInstanceId('22222222-2222-4222-8222-222222222222'), capabilities: { methods: ['runtime.inspect'], extensions: [] } };
const request: Request = { version: 1, kind: 'request', target: hello.target, epoch: hello.epoch, generation: hello.generation, id: 'read-1', method: 'runtime.inspect', params: {} };
class Socket extends EventTarget implements RuntimeSocket {
  binaryType: BinaryType = 'blob';
  readyState: WebSocket['readyState'] = 1;
  bufferedAmount = 0;
  send = vi.fn<(data: string | Uint8Array<ArrayBuffer>) => void>();
  close = vi.fn(() => { this.readyState = 3; });
  listeners: Array<{ type: string; callback: EventListenerOrEventListenerObject }> = [];
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (callback) this.listeners.push({ type, callback });
    super.addEventListener(type, callback, options);
  }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
function setup(authentication = async () => ({ bridgeToken: 'private-canary-19' })) {
  const sockets: Socket[] = [];
  const factory = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket; });
  const connection = createRuntimeConnection({ reference: { url: 'ws://runtime.test/runtime' }, resolveAuthentication: authentication, createWebSocket: factory });
  const events: RuntimeConnectionEvent[] = [];
  connection.subscribe(event => events.push(event));
  async function ready() {
    const connecting = connection.connect(); await vi.advanceTimersByTimeAsync(0);
    const socket = sockets.at(-1); if (!socket) throw new Error('socket missing');
    socket.message(encodeFrame(hello)); await connecting; return socket;
  }
  return { connection, sockets, factory, events, ready };
}

describe('Runtime management connection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('preserves the global receiver for default browser timers through Hello and reconnect disposal', async () => {
    const schedule = globalThis.setTimeout; const cancel = globalThis.clearTimeout;
    const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation(function (this: unknown, ...args: Parameters<typeof setTimeout>) {
      if (this !== globalThis) throw new TypeError('Illegal invocation: setTimeout receiver');
      return Reflect.apply(schedule, globalThis, args);
    });
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
      if (this !== globalThis) throw new TypeError('Illegal invocation: clearTimeout receiver');
      return Reflect.apply(cancel, globalThis, args);
    });
    const fixture = setup();
    try {
      const socket = await fixture.ready();
      expect(fixture.connection.status.state).toBe('ready');
      expect(set).toHaveBeenCalledOnce(); expect(clear).toHaveBeenCalledOnce();
      socket.dispatchEvent(new Event('close'));
      expect(set).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
      fixture.connection.dispose();
      expect(clear).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    } finally { set.mockRestore(); clear.mockRestore(); }
  });

  it('opens only the explicit candidate once and keeps authentication out of public state', async () => {
    const fixture = setup();
    const first = fixture.connection.connect();
    expect(fixture.connection.connect()).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.factory).toHaveBeenCalledExactlyOnceWith('ws://runtime.test/runtime?token=private-canary-19');
    const socket = fixture.sockets[0]; socket.message(encodeFrame(hello)); await first;
    expect(socket.binaryType).toBe('arraybuffer');
    expect(JSON.stringify([fixture.connection.status, fixture.events])).not.toContain('private-canary-19');
    fixture.connection.dispose(); expect(socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('disposal fences a private auth resolution that completes after teardown', async () => {
    let finish: (auth: { bridgeToken: string }) => void = () => {};
    const fixture = setup(() => new Promise(resolve => { finish = resolve; }));
    const pending = fixture.connection.connect(); const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0); fixture.connection.dispose(); finish({ bridgeToken: 'late-private' });
    await rejected; await vi.advanceTimersByTimeAsync(20000);
    expect(fixture.factory).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores queued callbacks belonging to the replaced socket', async () => {
    const fixture = setup(); const first = await fixture.ready();
    const callback = first.listeners.find(({ type }) => type === 'message')?.callback;
    fixture.connection.disconnect(); const second = await fixture.ready();
    const before = fixture.events.length;
    if (typeof callback !== 'function') throw new Error('message listener missing');
    callback(new MessageEvent('message', { data: '{"version":999}' }));
    expect(fixture.events).toHaveLength(before); expect(fixture.connection.status.state).toBe('ready');
    expect(second.close).not.toHaveBeenCalled(); fixture.connection.dispose();
  });

  it('times out pending authentication and prevents a later socket from opening', async () => {
    let finish: (auth: { bridgeToken: string }) => void = () => {};
    const fixture = setup(() => new Promise(resolve => { finish = resolve; }));
    const pending = fixture.connection.connect(); const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(15000); await rejected; finish({ bridgeToken: 'late' });
    await vi.advanceTimersByTimeAsync(0); expect(fixture.factory).not.toHaveBeenCalled(); fixture.connection.dispose();
  });

  it('rejects a wrong Hello version with a sanitized typed error', async () => {
    const fixture = setup(); const pending = fixture.connection.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'version_mismatch' });
    await vi.advanceTimersByTimeAsync(0); fixture.sockets[0].message(JSON.stringify({ ...hello, version: 99 })); await rejected;
    expect(fixture.connection.status.state).toBe('error'); expect(fixture.sockets[0].close).toHaveBeenCalledOnce(); fixture.connection.dispose();
  });

  it('redacts auth resolver and browser socket errors', async () => {
    const fixture = setup(async () => { throw new Error('private-canary-19'); });
    await expect(fixture.connection.connect()).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(JSON.stringify(fixture.events)).not.toContain('private-canary-19'); fixture.connection.dispose();
    const socketFixture = setup(); const pending = socketFixture.connection.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'source_unavailable' });
    await vi.advanceTimersByTimeAsync(0); socketFixture.sockets[0].dispatchEvent(new Event('error')); await rejected;
    expect(socketFixture.events.filter(event => event.kind === 'hello')).toHaveLength(0); socketFixture.connection.dispose();
  });

  it('enforces a single shared outbound budget and fences old reservation releases', async () => {
    const fixture = setup(); const first = await fixture.ready();
    const release = fixture.connection.reserveOutbound(LIMITS.outboundBytes - 100);
    fixture.connection.subscribe(event => { if (event.kind === 'disconnected') release(); });
    first.bufferedAmount = 100;
    expect(() => fixture.connection.reserveOutbound(1)).toThrow(expect.objectContaining({ code: 'source_unavailable' }));
    expect(() => fixture.connection.send(request)).toThrow(expect.objectContaining({ code: 'source_unavailable' }));
    fixture.connection.disconnect(); expect(fixture.connection.bufferedAmount).toBe(0); await fixture.ready();
    const currentRelease = fixture.connection.reserveOutbound(200); release(); release();
    expect(fixture.connection.bufferedAmount).toBe(200); currentRelease(); currentRelease(); expect(fixture.connection.bufferedAmount).toBe(0); fixture.connection.dispose();
  });

  it('scrubs server error text before publishing a typed result event', async () => {
    const fixture = setup(); const socket = await fixture.ready();
    socket.message(encodeFrame({ version: 1, kind: 'result', target: hello.target, epoch: hello.epoch, generation: hello.generation, id: 'read-1', ok: false, typedError: { code: 'unauthorized', message: 'private-canary-19' } }));
    expect(fixture.events.at(-1)).toMatchObject({ kind: 'frame', frame: { typedError: { code: 'unauthorized' } } });
    expect(JSON.stringify(fixture.events)).not.toContain('private-canary-19'); fixture.connection.dispose();
  });

  it('bounds text and binary frames and delivers validated binary bytes', async () => {
    const fixture = setup(); const socket = await fixture.ready();
    const binary = encodeBinary({ channelId: 1, offset: 0, data: new Uint8Array(65536) });
    fixture.connection.send(binary); expect(socket.send).toHaveBeenCalledOnce();
    socket.message(new Uint8Array(binary).buffer); expect(fixture.events.at(-1)?.kind).toBe('binary');
    expect(() => fixture.connection.send(new Uint8Array(65561))).toThrow();
    expect(() => fixture.connection.send({ ...request, params: { text: 'x'.repeat(LIMITS.jsonBytes) } })).toThrow();
    socket.message('x'.repeat(LIMITS.jsonBytes + 1)); expect(fixture.connection.status.state).toBe('error'); fixture.connection.dispose();
  });

  it('reconnects the same candidate at most three times without replaying sent requests', async () => {
    const fixture = setup(); let socket = await fixture.ready(); fixture.connection.send(request);
    for (const delay of [250, 1000, 4000]) {
      socket.dispatchEvent(new Event('close')); await vi.advanceTimersByTimeAsync(delay);
      socket = fixture.sockets.at(-1) ?? socket; socket.message(encodeFrame(hello));
    }
    socket.dispatchEvent(new Event('close')); await vi.advanceTimersByTimeAsync(10000);
    expect(fixture.factory).toHaveBeenCalledTimes(4); expect(fixture.sockets.reduce((sum, item) => sum + item.send.mock.calls.length, 0)).toBe(1);
    expect(vi.getTimerCount()).toBe(0); fixture.connection.dispose();
  });
});
