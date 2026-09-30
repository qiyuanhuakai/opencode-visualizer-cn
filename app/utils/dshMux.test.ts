import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS,
  DshMuxError,
  buildDshMuxCancelFrame,
  buildDshMuxEndFrame,
  buildDshMuxItemFrame,
  buildDshMuxOpenFrame,
  createDshMuxClient,
  decodeDshMuxFrame,
  dshMuxBridgeUrl,
  encodeDshMuxFrame,
  type DshMuxClient,
  type DshMuxScheduler,
  type DshMuxSocketCtor,
} from './dshMux';
import { DshWireParseError, type DshJsonValue, type DshRpcArgs } from '../backends/dsh/types';

// ---------------------------------------------------------------------------
// Fake WebSocket: records every constructed socket, sent frame, and close call.
// Deliberately minimal — the client only relies on addEventListener/send/close
// and readyState, mirroring the structural socket type in dshMux.ts.
// ---------------------------------------------------------------------------

type FakeListener = (event?: unknown) => void;

class FakeSocket {
  static readonly instances: FakeSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeListener): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(listener);
    else this.listeners.set(type, [listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close', { code: code ?? 1000, reason: reason ?? '', wasClean: true });
  }

  // --- test drivers (never used by product code) ---
  accept(): void {
    this.readyState = 1;
    this.emit('open');
  }

  deliverText(text: string): void {
    this.emit('message', { data: text });
  }

  deliverBinary(data: unknown = new ArrayBuffer(8)): void {
    this.emit('message', { data });
  }

  /** Server-side / network close (code 1006 = abnormal). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.emit('close', { code, reason: '', wasClean: false });
  }

  private emit(type: string, event?: unknown): void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const listener of listeners) listener(event);
  }
}

function fakeSocketCtor(): DshMuxSocketCtor {
  return FakeSocket as unknown as DshMuxSocketCtor;
}

// ---------------------------------------------------------------------------
// Deterministic fake clock: backoff must be asserted without real time.
// ---------------------------------------------------------------------------

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void; cancelled: boolean }>();
  const scheduler: DshMuxScheduler = {
    setTimeout(callback: () => void, delayMs: number) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delayMs, callback, cancelled: false });
      return () => {
        const timer = timers.get(id);
        if (timer) timer.cancelled = true;
      };
    },
  };
  return {
    scheduler,
    get pendingTimers(): number {
      return [...timers.values()].filter((timer) => !timer.cancelled).length;
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.cancelled = true;
        due.callback();
      }
      now = target;
    },
  };
}

/** Drains the microtask queue (token resolution + async connect handshake). */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BRIDGE_URL = 'ws://localhost:23004/dsh/ws';

function rpcArgs(args: Record<string, DshJsonValue>): DshRpcArgs {
  return { args };
}

function sentFrames(): Array<Record<string, unknown>> {
  return FakeSocket.instances.flatMap((socket) =>
    socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>),
  );
}

function openFrames(): Array<Record<string, unknown>> {
  return sentFrames().filter((frame) => frame.type === 'open');
}

function createHarness(
  options: {
    token?: string | null;
    delays?: readonly number[];
    autoReconnect?: boolean;
  } = {},
) {
  FakeSocket.instances.length = 0;
  const clock = createFakeClock();
  const tokenReads: string[] = [];
  const client: DshMuxClient = createDshMuxClient({
    url: BRIDGE_URL,
    getBridgeToken: async () => {
      const token = options.token === undefined ? 'bridge-token-123' : options.token;
      tokenReads.push(String(token));
      return token;
    },
    webSocketCtor: fakeSocketCtor(),
    scheduler: clock.scheduler,
    ...(options.delays ? { reconnectDelaysMs: options.delays } : {}),
    ...(options.autoReconnect === undefined ? {} : { autoReconnect: options.autoReconnect }),
  });
  return { client, clock, tokenReads };
}

/** Connects and accepts the first fake socket. */
async function connectAndAccept(harness_: ReturnType<typeof createHarness>): Promise<FakeSocket> {
  const connected = harness_.client.connect();
  await flush();
  const socket = FakeSocket.instances[0];
  expect(socket).toBeDefined();
  socket.accept();
  await connected;
  return socket;
}

async function expectRejection(promise: Promise<unknown>): Promise<DshMuxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DshMuxError);
    return error as DshMuxError;
  }
  throw new Error('expected the stream promise to reject, but it resolved');
}

beforeEach(() => {
  FakeSocket.instances.length = 0;
});

// ---------------------------------------------------------------------------
// Pure frame codecs
// ---------------------------------------------------------------------------

describe('dsh mux frame codecs', () => {
  it('builds an open frame with exactly the wire key set', () => {
    const frame = buildDshMuxOpenFrame('7', 'session/follow', rpcArgs({ request: { address: { kind: 'session', sessionId: 's1' } } }));
    expect(frame).toEqual({
      type: 'open',
      streamId: '7',
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: 's1' } } } },
    });
    expect(Object.keys(frame).sort()).toEqual(['endpoint', 'payload', 'streamId', 'type']);
  });

  it('round-trips open/item/end/cancel frames through encode + decode', () => {
    const frames = [
      buildDshMuxOpenFrame('1', '$events', rpcArgs({})),
      buildDshMuxItemFrame('1', { type: 'snapshot', cursor: 3 }),
      buildDshMuxItemFrame('1'),
      buildDshMuxEndFrame('1'),
      buildDshMuxCancelFrame('1'),
    ];
    for (const frame of frames) {
      expect(decodeDshMuxFrame(encodeDshMuxFrame(frame))).toEqual(frame);
    }
  });

  it('omits an absent item value on the wire instead of sending undefined', () => {
    expect(encodeDshMuxFrame(buildDshMuxItemFrame('4'))).toBe('{"type":"item","streamId":"4"}');
    expect(decodeDshMuxFrame('{"type":"item","streamId":"4"}')).toEqual({ type: 'item', streamId: '4' });
  });

  it('rejects unusable frame text with classified parse errors', () => {
    expect(() => decodeDshMuxFrame('{not json')).toThrow(DshWireParseError);
    try {
      decodeDshMuxFrame('{not json');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('not-json');
    }
    try {
      decodeDshMuxFrame('{"type":"mystery","streamId":"1"}');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('unknown-frame-type');
    }
    try {
      decodeDshMuxFrame('{"type":"end","streamId":"1","extra":true}');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('unexpected-field');
    }
    try {
      decodeDshMuxFrame('{"type":"open","streamId":"1","endpoint":"$events"}');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('missing-field');
    }
  });
});

// ---------------------------------------------------------------------------
// Bridge URL / token convention
// ---------------------------------------------------------------------------

describe('dshMuxBridgeUrl', () => {
  it('appends the bridge token as a query parameter like the bridge WS convention', () => {
    expect(dshMuxBridgeUrl(BRIDGE_URL, 'bridge-token-123')).toBe('ws://localhost:23004/dsh/ws?token=bridge-token-123');
  });

  it('leaves the URL untouched without a token and rejects non-ws URLs', () => {
    expect(dshMuxBridgeUrl(BRIDGE_URL)).toBe(BRIDGE_URL);
    expect(dshMuxBridgeUrl(BRIDGE_URL, null)).toBe(BRIDGE_URL);
    expect(() => dshMuxBridgeUrl('http://localhost:23004/dsh/ws')).toThrow(/ws:\/\/ or wss:/);
    expect(() => dshMuxBridgeUrl('   ')).toThrow(/required/);
  });
});

// ---------------------------------------------------------------------------
// Stream lifecycle: open / item / end
// ---------------------------------------------------------------------------

describe('dsh mux stream lifecycle', () => {
  it('opens with a monotonic stream id, accumulates items, and ends with all values', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);

    const seen: unknown[] = [];
    const stream = harness.client.open('session/follow', rpcArgs({ request: { cursor: 0 } }));
    stream.onItem((value) => seen.push(value));

    expect(stream.streamId).toBe('1');
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'open',
        streamId: '1',
        endpoint: 'session/follow',
        payload: { args: { request: { cursor: 0 } } },
      }),
    ]);

    const second = harness.client.open('$events', rpcArgs({}));
    expect(second.streamId).toBe('2');

    socket.deliverText('{"type":"item","streamId":"1","value":{"type":"snapshot","cursor":1}}');
    socket.deliverText('{"type":"item","streamId":"1","value":{"type":"event","seq":2}}');
    expect(seen).toEqual([{ type: 'snapshot', cursor: 1 }, { type: 'event', seq: 2 }]);

    socket.deliverText('{"type":"end","streamId":"1"}');
    await expect(stream.promise).resolves.toEqual([
      { type: 'snapshot', cursor: 1 },
      { type: 'event', seq: 2 },
    ]);
  });

  it('keeps stream ids monotonic across opens, ends, and cancels', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const first = harness.client.open('$events', rpcArgs({}));
    const second = harness.client.open('workspace/follow', rpcArgs({}));
    harness.client.cancel(second.streamId);
    socket.deliverText(`{"type":"end","streamId":"${first.streamId}"}`);
    await first.promise;
    const third = harness.client.open('session/follow', rpcArgs({ request: {} }));
    expect([first.streamId, second.streamId, third.streamId]).toEqual(['1', '2', '3']);
  });

  it('auto-connects on the first open without an explicit connect()', async () => {
    const harness = createHarness();
    harness.client.open('$events', rpcArgs({}));
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0].accept();
    expect(openFrames()).toEqual([
      { type: 'open', streamId: '1', endpoint: '$events', payload: { args: {} } },
    ]);
    expect(harness.client.isConnected()).toBe(true);
  });

  it('resolves connect() once the socket is open', async () => {
    const harness = createHarness();
    const connecting = harness.client.connect();
    await flush();
    FakeSocket.instances[0].accept();
    await expect(connecting).resolves.toBeUndefined();
    expect(harness.client.isConnected()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('dsh mux cancel', () => {
  it('sends a cancel frame and settles the stream', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('session/follow', rpcArgs({ request: {} }));

    stream.cancel();
    expect(socket.sent).toContain(JSON.stringify({ type: 'cancel', streamId: '1' }));
    const error = await expectRejection(stream.promise);
    expect(error.code).toBe('stream-cancelled');

    // client-level cancel targets the same wire frame and is idempotent for
    // unknown ids (late frames after a cancel must not throw either).
    harness.client.cancel('1');
    harness.client.cancel('does-not-exist');
    expect(socket.sent.filter((text) => JSON.parse(text).type === 'cancel')).toHaveLength(1);
    socket.deliverText('{"type":"item","streamId":"1","value":{}}');
  });
});

// ---------------------------------------------------------------------------
// error frames
// ---------------------------------------------------------------------------

describe('dsh mux error frames', () => {
  it('rejects the stream with the wire error instead of resolving', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('session/follow', rpcArgs({ request: {} }));
    const other = harness.client.open('$events', rpcArgs({}));

    socket.deliverText(
      JSON.stringify({
        type: 'error',
        streamId: '1',
        error: { code: 'gateway/arguments-invalid', message: 'bad request', details: { field: 'address' } },
      }),
    );

    const error = await expectRejection(stream.promise);
    expect(error.code).toBe('stream-error');
    expect(error.remoteError).toEqual({
      code: 'gateway/arguments-invalid',
      message: 'bad request',
      details: { field: 'address' },
    });

    // The error must not silently terminate sibling streams.
    socket.deliverText('{"type":"end","streamId":"2"}');
    await expect(other.promise).resolves.toEqual([]);
  });

  it('ignores error frames for unknown streams (late frames are dropped)', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('$events', rpcArgs({}));
    socket.deliverText(JSON.stringify({ type: 'error', streamId: '99', error: { code: 'x', message: 'y' } }));
    socket.deliverText('{"type":"end","streamId":"1"}');
    await expect(stream.promise).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close → reconnect → reopen
// ---------------------------------------------------------------------------

describe('dsh mux reconnect', () => {
  it('reopens every in-flight stream after a close, using resume params from above', async () => {
    const harness = createHarness();
    const first = await connectAndAccept(harness);

    const finished = harness.client.open('session/follow', rpcArgs({ request: { cursor: 0 } }));
    const live = harness.client.open('session/follow', rpcArgs({ request: { cursor: 4 } }), {
      resume: { endpoint: 'session/follow', payload: rpcArgs({ request: { cursor: 9 } }) },
    });
    const dynamic = harness.client.open('$events', rpcArgs({}), {
      resume: (streamId) => ({ endpoint: '$events', payload: rpcArgs({ resumedFor: streamId }) }),
    });

    first.deliverText('{"type":"end","streamId":"1"}');
    await finished.promise;

    first.drop(1006);
    expect(harness.clock.pendingTimers).toBe(1);
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0] - 1);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);

    harness.clock.advance(1);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1];
    expect(harness.tokenReads).toHaveLength(2);
    second.accept();

    expect(second.sent).toEqual([
      JSON.stringify({ type: 'open', streamId: '2', endpoint: 'session/follow', payload: { args: { request: { cursor: 9 } } } }),
      JSON.stringify({ type: 'open', streamId: '3', endpoint: '$events', payload: { args: { resumedFor: '3' } } }),
    ]);
    // The ended stream is not reopened, and both live streams keep their ids.
    expect(second.sent.some((text) => JSON.parse(text).streamId === '1')).toBe(false);
    expect(live.streamId).toBe('2');
    expect(dynamic.streamId).toBe('3');

    second.deliverText('{"type":"end","streamId":"2"}');
    await expect(live.promise).resolves.toEqual([]);
  });

  it('reopens with the original params when no resume params were supplied', async () => {
    const harness = createHarness();
    const first = await connectAndAccept(harness);
    harness.client.open('workspace/follow', rpcArgs({ scope: 'all' }));
    first.drop();
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0]);
    await flush();
    const second = FakeSocket.instances[1];
    second.accept();
    expect(second.sent).toEqual([
      JSON.stringify({ type: 'open', streamId: '1', endpoint: 'workspace/follow', payload: { args: { scope: 'all' } } }),
    ]);
  });

  it('grows the backoff per failed attempt and resets it after a successful open', async () => {
    const harness = createHarness();
    const first = await connectAndAccept(harness);
    first.drop();
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0]);
    await flush();
    const second = FakeSocket.instances[1];
    // Not accepted yet: the attempt is still counted as failed.
    second.drop();
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[1] - 1);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    harness.clock.advance(1);
    await flush();
    const third = FakeSocket.instances[2];
    third.accept();
    await flush();
    third.drop();
    // Attempt counter reset by the successful open: back to the first delay.
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0]);
    await flush();
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('does not reconnect when autoReconnect is disabled', async () => {
    const harness = createHarness({ autoReconnect: false });
    const socket = await connectAndAccept(harness);
    socket.drop();
    harness.clock.advance(60_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(harness.client.isConnected()).toBe(false);
  });

  it('rejects connect() when the socket closes before opening, then keeps retrying', async () => {
    const harness = createHarness();
    const connecting = harness.client.connect();
    await flush();
    FakeSocket.instances[0].drop();
    const error = await expectRejection(connecting);
    expect(error.code).toBe('connection-failed');
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0]);
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].accept();
    expect(harness.client.isConnected()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fatal frames: binary / invalid JSON fail streams WITHOUT reconnecting
// ---------------------------------------------------------------------------

describe('dsh mux fatal frames', () => {
  it('fails in-flight streams on a binary frame without reconnecting', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('session/follow', rpcArgs({ request: {} }));

    socket.deliverBinary(new ArrayBuffer(16));
    const error = await expectRejection(stream.promise);
    expect(error.code).toBe('binary-frame');

    harness.clock.advance(60_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.closeCalls.length).toBeGreaterThan(0);
    expect(harness.client.isConnected()).toBe(false);

    // The failure is sticky: further opens fail immediately instead of hanging.
    const after = harness.client.open('$events', rpcArgs({}));
    expect((await expectRejection(after.promise)).code).toBe('binary-frame');
    await expect(harness.client.connect()).rejects.toThrow();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('fails in-flight streams on invalid JSON without reconnecting', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('session/follow', rpcArgs({ request: {} }));

    socket.deliverText('{"type":"item","streamId":"1"'); // truncated JSON
    expect((await expectRejection(stream.promise)).code).toBe('invalid-json');

    harness.clock.advance(60_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('fails the connection on a well-formed but unknown frame type', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('session/follow', rpcArgs({ request: {} }));
    socket.deliverText('{"type":"heartbeat","streamId":"1"}');
    expect((await expectRejection(stream.promise)).code).toBe('invalid-json');
    harness.clock.advance(60_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bridge credential convention
// ---------------------------------------------------------------------------

describe('dsh mux bridge credentials', () => {
  it('attaches only the bridge token to the socket URL and never a dsh cookie', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const url = new URL(socket.url);
    expect(url.searchParams.get('token')).toBe('bridge-token-123');
    expect(socket.url.toLowerCase()).not.toContain('cookie');
    expect(socket.url).not.toContain('3080'); // the upstream dsh host never appears
    expect(socket.url.startsWith(BRIDGE_URL)).toBe(true);
    expect(JSON.stringify(sentFrames()).toLowerCase()).not.toContain('cookie');
  });

  it('re-resolves the bridge token for every connection attempt', async () => {
    const harness = createHarness();
    const first = await connectAndAccept(harness);
    expect(harness.tokenReads).toEqual(['bridge-token-123']);
    first.drop();
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0]);
    await flush();
    expect(harness.tokenReads).toEqual(['bridge-token-123', 'bridge-token-123']);
    expect(new URL(FakeSocket.instances[1].url).searchParams.get('token')).toBe('bridge-token-123');
  });

  it('omits the token parameter when the bridge token is unavailable', async () => {
    const harness = createHarness({ token: null });
    const socket = await connectAndAccept(harness);
    expect(new URL(socket.url).searchParams.has('token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat: the client must never construct application-layer ping/pong frames
// ---------------------------------------------------------------------------

describe('dsh mux heartbeat', () => {
  it('never sends application-layer heartbeat frames across a full session', async () => {
    const harness = createHarness();
    const first = await connectAndAccept(harness);
    const stream = harness.client.open('$events', rpcArgs({}));
    first.deliverText('{"type":"item","streamId":"1","value":{"type":"ready"}}');
    first.drop();
    harness.clock.advance(DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS[0]);
    await flush();
    FakeSocket.instances[1].accept();
    FakeSocket.instances[1].deliverText('{"type":"end","streamId":"1"}');
    await stream.promise;

    const types = sentFrames().map((frame) => frame.type);
    expect(types).not.toContain('ping');
    expect(types).not.toContain('pong');
    expect([...new Set(types)].sort()).toEqual(['open']);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('dsh mux disconnect', () => {
  it('settles in-flight streams, closes the socket, and stops reconnecting', async () => {
    const harness = createHarness();
    const socket = await connectAndAccept(harness);
    const stream = harness.client.open('session/follow', rpcArgs({ request: {} }));

    harness.client.disconnect();
    const error = await expectRejection(stream.promise);
    expect(error.code).toBe('disposed');
    expect(socket.closeCalls.length).toBeGreaterThan(0);
    expect(harness.client.isConnected()).toBe(false);

    harness.clock.advance(60_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);

    const after = harness.client.open('$events', rpcArgs({}));
    expect((await expectRejection(after.promise)).code).toBe('disposed');
  });
});
