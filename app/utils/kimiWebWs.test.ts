import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRawWebSocketPeer,
  createWebSocketAccept,
  type RawWebSocketPeer,
  type RawWebSocketSocket,
} from '../../bridge/webSocketFrames.js';
import {
  KimiWebWsError,
  createKimiWebWsClient,
  kimiWebProxyHttpUrl,
  kimiWebWsUrl,
  type KimiWebWsClient,
  type KimiWebWsClientOptions,
  type KimiWebWsCloseInfo,
  type KimiWebWsFrame,
  type KimiWebWsResyncRequest,
} from './kimiWebWs';

const BRIDGE_TOKEN = 'bridge-token-test';
const SID_A = 'session_11111111-1111-4111-8111-111111111111';
const SID_B = 'session_22222222-2222-4222-8222-222222222222';
const EPOCH_A = 'ep_01M30ZNJTBH5G6NKA2S115YMPJ';
const EPOCH_B = 'ep_01M310C5950DCZ9JK7J1KQQ9VJ';

// ---------------------------------------------------------------------------
// Fake kimi web bridge: one ephemeral-port HTTP server that serves both the
// bridge WS route (`/kimi-web/ws`) and the bridge REST proxy (`/kimi-web/*`).
// The fake never touches the real kimi web instance.
// ---------------------------------------------------------------------------

type FakeFrame = {
  type: string;
  id?: string;
  code?: number;
  seq?: number;
  epoch?: string;
  volatile?: boolean;
  offset?: number;
  session_id?: string;
  payload?: Record<string, unknown>;
};

type RestPreset =
  | 'kimi-ok'
  | 'bridge-unauthorized'
  | 'kimi-unauthorized'
  | 'token-unavailable'
  | 'network-drop';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, Authorization',
};

function framePayload(frame: FakeFrame): Record<string, unknown> {
  return frame.payload ?? {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

class FakeConnection {
  readonly frames: FakeFrame[] = [];
  readonly pings: FakeFrame[] = [];
  readonly pongs: FakeFrame[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly waiters: Array<{
    predicate: (frame: FakeFrame) => boolean;
    resolve: (frame: FakeFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly peer: RawWebSocketPeer,
    private readonly socket: RawWebSocketSocket,
  ) {
    peer.on('message', (text: string) => {
      let frame: FakeFrame;
      try {
        frame = JSON.parse(text) as FakeFrame;
      } catch {
        return;
      }
      if (frame.type === 'pong') this.pongs.push(frame);
      this.frames.push(frame);
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index];
        if (!waiter.predicate(frame)) continue;
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    });
  }

  send(frame: unknown) {
    this.peer.send(JSON.stringify(frame));
  }

  /** Server-initiated close: the client observes `code`/`reason`. */
  close(code = 1000, reason = '') {
    this.stopHeartbeat();
    this.closed = true;
    this.peer.close(code, reason);
  }

  /** Abrupt socket death: the client observes an unclean 1006 close. */
  kill() {
    this.stopHeartbeat();
    this.closed = true;
    this.socket.destroy();
  }

  /** Mirrors the measured server heartbeat: ping every interval, 2 misses → 1001. */
  startHeartbeat(intervalMs: number) {
    let beat = 0;
    let unanswered = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) {
        this.stopHeartbeat();
        return;
      }
      if (unanswered >= 2) {
        this.close(1001, 'heartbeat timeout');
        return;
      }
      unanswered = beat > 0 && this.pongs.length < beat ? unanswered + 1 : 0;
      beat += 1;
      const ping = { type: 'ping', payload: { nonce: `nonce_${beat}` } };
      this.pings.push(ping);
      this.send(ping);
    }, intervalMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  waitForFrame(predicate: (frame: FakeFrame) => boolean, timeoutMs = 2000): Promise<FakeFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for a client frame.'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

type FakeBridge = {
  port: number;
  wsUrl: string;
  restRequests: Array<{ path: string; authorization: string | undefined }>;
  setPreset: (preset: RestPreset) => void;
  waitForConnection: (timeoutMs?: number) => Promise<FakeConnection>;
  close: () => Promise<void>;
};

async function createFakeBridge(): Promise<FakeBridge> {
  let preset: RestPreset = 'kimi-ok';
  const restRequests: Array<{ path: string; authorization: string | undefined }> = [];
  const pendingConnections: FakeConnection[] = [];
  const connectionWaiters: Array<{
    resolve: (connection: FakeConnection) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let closed = false;

  const server = createServer((request, response) => {
    if (request.method !== 'OPTIONS') {
      restRequests.push({ path: request.url ?? '', authorization: request.headers.authorization });
    }
    if (preset === 'network-drop') {
      request.socket.destroy();
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    if (preset === 'bridge-unauthorized') {
      response.writeHead(401, {
        ...CORS_HEADERS,
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="vis_bridge"',
      });
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (preset === 'kimi-unauthorized') {
      response.writeHead(401, { ...CORS_HEADERS, 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ code: 40101, msg: 'unauthorized', data: null, request_id: 'req_test' }),
      );
      return;
    }
    if (preset === 'token-unavailable') {
      response.writeHead(502, { ...CORS_HEADERS, 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: 'Kimi web upstream credentials unavailable',
          code: 'KIMI_WEB_TOKEN_UNAVAILABLE',
        }),
      );
      return;
    }
    response.writeHead(200, { ...CORS_HEADERS, 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 0, msg: 'success', data: { ok: true }, request_id: 'req_test' }));
  });

  server.on('upgrade', (request, socket, head) => {
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createWebSocketAccept(String(request.headers['sec-websocket-key']))}`,
        '',
        '',
      ].join('\r\n'),
    );
    const raw = socket as unknown as RawWebSocketSocket;
    const connection = new FakeConnection(createRawWebSocketPeer(raw, head), raw);
    const waiter = connectionWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(connection);
    } else {
      pendingConnections.push(connection);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/kimi-web/ws`,
    restRequests,
    setPreset: (next) => {
      preset = next;
    },
    waitForConnection: (timeoutMs = 2000) => {
      const queued = pendingConnections.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = connectionWaiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) connectionWaiters.splice(index, 1);
          reject(new Error('Timed out waiting for a bridge WebSocket connection.'));
        }, timeoutMs);
        connectionWaiters.push({ resolve, reject, timer });
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const waiter of connectionWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Fake bridge closed.'));
      }
      server.closeAllConnections();
      server.closeIdleConnections();
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 500);
        server.close(() => {
          clearTimeout(fallback);
          resolve();
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Protocol frame builders (shapes measured in task-26 evidence)
// ---------------------------------------------------------------------------

function serverHello() {
  return {
    type: 'server_hello',
    timestamp: '2026-09-21T03:23:18.091Z',
    payload: {
      ws_connection_id: 'conn_test_1',
      protocol_version: 2,
      heartbeat_ms: 10000,
      max_event_buffer_size: 1000,
      capabilities: { event_batching: false, compression: false },
    },
  };
}

function durable(sessionId: string, seq: number, epoch: string, type: string) {
  return {
    type,
    seq,
    epoch,
    session_id: sessionId,
    timestamp: '2026-09-21T03:23:18.100Z',
    payload: { type },
  };
}

function volatile(sessionId: string, seq: number, epoch: string, type: string, offset?: number) {
  return {
    type,
    seq,
    epoch,
    volatile: true,
    ...(offset === undefined ? {} : { offset }),
    session_id: sessionId,
    timestamp: '2026-09-21T03:23:18.110Z',
    payload: { type },
  };
}

function ack(id: string, payload: Record<string, unknown>, code = 0) {
  return { type: 'ack', id, code, msg: code === 0 ? 'success' : 'failed', payload };
}

function subscribeAckPayload(sessionId: string, seq: number, epoch: string) {
  return {
    accepted: [sessionId],
    not_found: [],
    resync_required: [],
    cursors: { [sessionId]: { seq, epoch } },
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}.`);
    await delay(5);
  }
}

// ---------------------------------------------------------------------------

describe('kimiWebWs', () => {
  const bridges: FakeBridge[] = [];
  const clients: KimiWebWsClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  });

  async function startBridge(preset: RestPreset = 'kimi-ok') {
    const bridge = await createFakeBridge();
    bridge.setPreset(preset);
    bridges.push(bridge);
    return bridge;
  }

  function makeClient(bridge: FakeBridge, overrides: Partial<KimiWebWsClientOptions> = {}) {
    const client = createKimiWebWsClient({
      url: kimiWebWsUrl(bridge.wsUrl, BRIDGE_TOKEN),
      getToken: () => BRIDGE_TOKEN,
      autoReconnect: false,
      ...overrides,
    });
    clients.push(client);
    return client;
  }

  it('derives the bridge WS URL with the token query and the proxy HTTP root', () => {
    expect(kimiWebWsUrl('ws://localhost:23004/kimi-web/ws', BRIDGE_TOKEN)).toBe(
      'ws://localhost:23004/kimi-web/ws?token=bridge-token-test',
    );
    expect(kimiWebWsUrl('ws://localhost:23004/kimi-web/ws')).toBe(
      'ws://localhost:23004/kimi-web/ws',
    );
    expect(kimiWebProxyHttpUrl('ws://localhost:23004/kimi-web/ws?token=x')).toBe(
      'http://localhost:23004/kimi-web',
    );
    expect(() => kimiWebWsUrl('http://localhost:23004/kimi-web/ws')).toThrow();
  });

  it('completes the server_hello handshake and pairs subscribe acks by control id', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    const helloFrame = await connection.waitForFrame((frame) => frame.type === 'client_hello');
    expect(stringArray(framePayload(helloFrame).subscriptions)).toEqual([]);
    expect(typeof framePayload(helloFrame).client_id).toBe('string');
    expect(typeof helloFrame.id).toBe('string');
    await waitFor(() => client.hello() !== null, 2000, 'server_hello handling');
    expect(client.hello()).toMatchObject({
      connectionId: 'conn_test_1',
      protocolVersion: 2,
      heartbeatMs: 10000,
      maxEventBufferSize: 1000,
    });

    const ackPromise = client.subscribe([SID_A], { [SID_A]: { seq: 3, epoch: EPOCH_A } });
    const subscribeFrame = await connection.waitForFrame((frame) => frame.type === 'subscribe');
    expect(framePayload(subscribeFrame)).toEqual({
      session_ids: [SID_A],
      cursors: { [SID_A]: { seq: 3, epoch: EPOCH_A } },
    });

    // An ack with a different id must not settle the pending subscription.
    let settled = false;
    void ackPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    connection.send(ack('some-other-id', { cursors: { [SID_A]: { seq: 4, epoch: EPOCH_A } } }));
    await delay(25);
    expect(settled).toBe(false);

    // Measured replay contract: durable replay frames first, the ack LAST.
    connection.send(durable(SID_A, 4, EPOCH_A, 'turn.started'));
    connection.send(durable(SID_A, 5, EPOCH_A, 'turn.step.started'));
    connection.send(ack(String(subscribeFrame.id), subscribeAckPayload(SID_A, 5, EPOCH_A)));

    const ackResult = await ackPromise;
    expect(ackResult).toMatchObject({ id: subscribeFrame.id, code: 0 });
    expect(ackResult.payload?.accepted).toEqual([SID_A]);
    expect(client.cursors()).toEqual({ [SID_A]: { seq: 5, epoch: EPOCH_A } });
  });

  it('answers an application-level ping with a field-exact pong frame', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send({ type: 'ping', payload: { nonce: 'nonce-abc-123' } });

    const pong = await connection.waitForFrame((frame) => frame.type === 'pong');
    // Field-exact: nonce lives inside payload, there is no top-level nonce and no control id.
    expect(pong).toEqual({ type: 'pong', payload: { nonce: 'nonce-abc-123' } });
  });

  it('answers the fake server application-level heartbeat and stays connected', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    connection.startHeartbeat(15);

    await waitFor(() => connection.pongs.length >= 2, 3000, 'heartbeat pongs');
    expect(connection.pongs[0]).toEqual({
      type: 'pong',
      payload: { nonce: framePayload(connection.pings[0]).nonce },
    });
    expect(connection.pongs[1]).toEqual({
      type: 'pong',
      payload: { nonce: framePayload(connection.pings[1]).nonce },
    });
    expect(client.isConnected()).toBe(true);
  });

  it('hands event frames to the upper layer and advances cursors from durable frames only', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    const frames: KimiWebWsFrame[] = [];
    client.onFrame((frame) => frames.push(frame));
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    const subscribed = client.subscribe([SID_A], { [SID_A]: { seq: 2, epoch: EPOCH_A } });
    const subscribeFrame = await connection.waitForFrame((frame) => frame.type === 'subscribe');
    connection.send(ack(String(subscribeFrame.id), subscribeAckPayload(SID_A, 2, EPOCH_A)));
    await subscribed;

    connection.send(durable(SID_A, 3, EPOCH_A, 'turn.started'));
    connection.send(volatile(SID_A, 3, EPOCH_A, 'assistant.delta', 0));
    await waitFor(() => frames.length === 2);
    expect(frames[0]).toMatchObject({ type: 'turn.started', seq: 3, session_id: SID_A });
    expect(frames[1]).toMatchObject({
      type: 'assistant.delta',
      seq: 3,
      volatile: true,
      offset: 0,
      session_id: SID_A,
    });
    expect(client.cursors()).toEqual({ [SID_A]: { seq: 3, epoch: EPOCH_A } });

    // Volatile frames share the durable seq of their step opener: never advance the cursor.
    connection.send(volatile(SID_A, 9, EPOCH_A, 'agent.status.updated'));
    await waitFor(() => frames.length === 3);
    expect(client.cursors()).toEqual({ [SID_A]: { seq: 3, epoch: EPOCH_A } });
  });

  it('reconnects automatically and resubscribes from each session cursor without duplicate delivery', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge, { autoReconnect: true, reconnectDelaysMs: [0] });
    const frames: KimiWebWsFrame[] = [];
    client.onFrame((frame) => frames.push(frame));
    await client.connect();

    const first = await bridge.waitForConnection();
    first.send(serverHello());
    await first.waitForFrame((frame) => frame.type === 'client_hello');

    const subscribed = client.subscribe([SID_A], { [SID_A]: { seq: 10, epoch: EPOCH_A } });
    const firstSubscribe = await first.waitForFrame((frame) => frame.type === 'subscribe');
    first.send(durable(SID_A, 11, EPOCH_A, 'turn.started'));
    first.send(durable(SID_A, 12, EPOCH_A, 'turn.step.started'));
    first.send(ack(String(firstSubscribe.id), subscribeAckPayload(SID_A, 12, EPOCH_A)));
    await subscribed;
    expect(client.cursors()).toEqual({ [SID_A]: { seq: 12, epoch: EPOCH_A } });

    first.kill();

    const second = await bridge.waitForConnection();
    second.send(serverHello());
    const secondHello = await second.waitForFrame((frame) => frame.type === 'client_hello');
    expect(framePayload(secondHello)).toMatchObject({
      subscriptions: [SID_A],
      cursors: { [SID_A]: { seq: 12, epoch: EPOCH_A } },
    });

    // Replay resumes at the cursor: 11/12 are not delivered twice.
    second.send(durable(SID_A, 13, EPOCH_A, 'turn.step.completed'));
    second.send(durable(SID_A, 14, EPOCH_A, 'turn.ended'));
    second.send(ack(String(secondHello.id), subscribeAckPayload(SID_A, 14, EPOCH_A)));

    const deliveredSeqs = () =>
      frames.filter((frame) => typeof frame.seq === 'number').map((frame) => frame.seq);
    await waitFor(() => deliveredSeqs().join(',') === '11,12,13,14', 3000, 'replayed frames');
    expect(deliveredSeqs()).toEqual([11, 12, 13, 14]);
    expect(client.cursors()).toEqual({ [SID_A]: { seq: 14, epoch: EPOCH_A } });
  });

  it('replays the gap again on a duplicate subscribe and honors caller-provided cursors', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    const frames: KimiWebWsFrame[] = [];
    client.onFrame((frame) => frames.push(frame));
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    await connection.waitForFrame((frame) => frame.type === 'client_hello');

    const first = client.subscribe([SID_A], { [SID_A]: { seq: 5, epoch: EPOCH_A } });
    const firstFrame = await connection.waitForFrame((frame) => frame.type === 'subscribe');
    connection.send(durable(SID_A, 6, EPOCH_A, 'turn.started'));
    connection.send(ack(String(firstFrame.id), subscribeAckPayload(SID_A, 6, EPOCH_A)));
    await first;

    const second = client.subscribe([SID_A], { [SID_A]: { seq: 5, epoch: EPOCH_A } });
    const secondFrame = await connection.waitForFrame(
      (frame) => frame.type === 'subscribe' && frame.id !== firstFrame.id,
    );
    expect(framePayload(secondFrame).cursors).toEqual({ [SID_A]: { seq: 5, epoch: EPOCH_A } });
    connection.send(durable(SID_A, 6, EPOCH_A, 'turn.started'));
    connection.send(ack(String(secondFrame.id), subscribeAckPayload(SID_A, 6, EPOCH_A)));
    await second;

    await waitFor(
      () => frames.filter((frame) => frame.seq === 6).length === 2,
      3000,
      'duplicate replay burst',
    );
    expect(frames.filter((frame) => frame.seq === 6)).toHaveLength(2);
  });

  it('surfaces resync_required from the system frame and from a code-0 ack payload', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    const resyncs: KimiWebWsResyncRequest[] = [];
    client.onResyncRequired((request) => resyncs.push(request));
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    await connection.waitForFrame((frame) => frame.type === 'client_hello');

    const firstSubscribe = client.subscribe([SID_A], { [SID_A]: { seq: 1, epoch: EPOCH_A } });
    const subscribeFrame = await connection.waitForFrame((frame) => frame.type === 'subscribe');
    connection.send({
      type: 'resync_required',
      session_id: SID_A,
      payload: { session_id: SID_A, reason: 'epoch_changed', current_seq: 9, epoch: EPOCH_B },
    });
    connection.send(
      ack(String(subscribeFrame.id), {
        accepted: [SID_A],
        not_found: [],
        resync_required: [SID_A],
        cursors: { [SID_A]: { seq: 9, epoch: EPOCH_B } },
      }),
    );
    // The ack stays code 0 even when replay is impossible; resync must still fire.
    await firstSubscribe;
    expect(resyncs).toEqual([
      {
        sessionId: SID_A,
        reason: 'epoch_changed',
        currentSeq: 9,
        epoch: EPOCH_B,
        source: 'frame',
      },
    ]);

    // The misleading-success trap: a code-0 ack listing resync_required without the frame.
    const secondSubscribe = client.subscribe([SID_B], { [SID_B]: { seq: 2, epoch: EPOCH_B } });
    const secondFrame = await connection.waitForFrame(
      (frame) => frame.type === 'subscribe' && stringArray(framePayload(frame).session_ids).includes(SID_B),
    );
    connection.send(
      ack(String(secondFrame.id), {
        accepted: [SID_B],
        not_found: [],
        resync_required: [SID_B],
        cursors: { [SID_B]: { seq: 20, epoch: EPOCH_B } },
      }),
    );
    await secondSubscribe;
    expect(resyncs).toHaveLength(2);
    expect(resyncs[1]).toMatchObject({ sessionId: SID_B, source: 'ack' });
  });

  it('sends unsubscribe and abort, and drops unsubscribed sessions from the reconnect handshake', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge, { autoReconnect: true, reconnectDelaysMs: [0] });
    await client.connect();

    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    await connection.waitForFrame((frame) => frame.type === 'client_hello');

    const subscribed = client.subscribe([SID_A, SID_B]);
    const subscribeFrame = await connection.waitForFrame((frame) => frame.type === 'subscribe');
    expect(framePayload(subscribeFrame)).toEqual({ session_ids: [SID_A, SID_B] });
    connection.send(
      ack(String(subscribeFrame.id), {
        accepted: [SID_A, SID_B],
        not_found: [],
        resync_required: [],
        cursors: {},
      }),
    );
    await subscribed;

    const unsubscribed = client.unsubscribe([SID_B]);
    const unsubscribeFrame = await connection.waitForFrame((frame) => frame.type === 'unsubscribe');
    expect(framePayload(unsubscribeFrame)).toEqual({ session_ids: [SID_B] });
    connection.send(ack(String(unsubscribeFrame.id), {}));
    await unsubscribed;
    expect(client.subscriptions()).toEqual([SID_A]);

    const aborted = client.abort(SID_A, 'msg_1');
    const abortFrame = await connection.waitForFrame((frame) => frame.type === 'abort');
    expect(framePayload(abortFrame)).toEqual({ session_id: SID_A, prompt_id: 'msg_1' });
    connection.send(ack(String(abortFrame.id), {}));
    await aborted;

    connection.kill();
    const second = await bridge.waitForConnection();
    second.send(serverHello());
    const hello = await second.waitForFrame((frame) => frame.type === 'client_hello');
    expect(stringArray(framePayload(hello).subscriptions)).toEqual([SID_A]);
  });

  it('rejects control frames sent while disconnected instead of swallowing them', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge);
    await expect(client.subscribe([SID_A])).rejects.toMatchObject({ code: 'not-connected' });
    await expect(client.subscribe([SID_A])).rejects.toBeInstanceOf(KimiWebWsError);
  });

  it('rejects a hung subscription on ack timeout and recycles the connection', async () => {
    const bridge = await startBridge();
    const client = makeClient(bridge, {
      autoReconnect: true,
      reconnectDelaysMs: [0],
      ackTimeoutMs: 40,
    });
    await client.connect();

    const first = await bridge.waitForConnection();
    first.send(serverHello());
    const helloFrame = await first.waitForFrame((frame) => frame.type === 'client_hello');
    first.send(
      ack(String(helloFrame.id), { accepted_subscriptions: [], resync_required: [], cursors: {} }),
    );

    const subscribed = client.subscribe([SID_A], { [SID_A]: { seq: 5, epoch: EPOCH_A } });
    await first.waitForFrame((frame) => frame.type === 'subscribe');
    await expect(subscribed).rejects.toMatchObject({ code: 'ack-timeout' });

    await bridge.waitForConnection(3000);
    client.disconnect();
  });

  async function killAndClassify(
    preset: RestPreset,
    closeKind: 'kill' | 'close' = 'kill',
  ): Promise<{ info: KimiWebWsCloseInfo; bridge: FakeBridge }> {
    const bridge = await startBridge(preset);
    const client = makeClient(bridge);
    const closes: KimiWebWsCloseInfo[] = [];
    client.onClose((info) => closes.push(info));
    await client.connect();
    const connection = await bridge.waitForConnection();
    connection.send(serverHello());
    if (closeKind === 'close') connection.close(1001, 'heartbeat timeout');
    else connection.kill();
    await waitFor(() => closes.length === 1, 3000, 'close classification');
    return { info: closes[0], bridge };
  }

  it('classifies a bridge-authenticated rejection as bridge-credential', async () => {
    const { info, bridge } = await killAndClassify('bridge-unauthorized');
    expect(info.manual).toBe(false);
    expect(info.classification).toMatchObject({ kind: 'bridge-credential', status: 401 });
    expect(bridge.restRequests).toEqual([
      { path: '/kimi-web/api/v1/meta', authorization: `Bearer ${BRIDGE_TOKEN}` },
    ]);
  });

  it('classifies a kimi meta 401 relayed through the proxy as kimi-credential', async () => {
    const { info } = await killAndClassify('kimi-unauthorized');
    expect(info.classification).toMatchObject({ kind: 'kimi-credential', status: 401 });
  });

  it('classifies an unreadable kimi token as kimi-credential', async () => {
    const { info } = await killAndClassify('token-unavailable');
    expect(info.classification).toMatchObject({ kind: 'kimi-credential', status: 502 });
  });

  it('classifies a dead proxy connection as upstream-unreachable', async () => {
    const { info } = await killAndClassify('network-drop');
    expect(info.classification).toMatchObject({ kind: 'upstream-unreachable' });
  });

  it('classifies a 1001 heartbeat close as heartbeat-timeout, never as a credential error', async () => {
    const { info } = await killAndClassify('kimi-ok', 'close');
    expect(info.code).toBe(1001);
    expect(info.classification).toMatchObject({ kind: 'heartbeat-timeout' });
    expect(info.classification?.kind).not.toBe('bridge-credential');
    expect(info.classification?.kind).not.toBe('kimi-credential');
  });

  it('does not invent a credential failure for an unexplained close with a healthy precheck', async () => {
    const { info } = await killAndClassify('kimi-ok');
    expect(info.classification).toMatchObject({ kind: 'unknown' });
  });

  it('rejects connect() when the bridge is unreachable and classifies it as upstream-unreachable', async () => {
    const bridge = await startBridge();
    const port = bridge.port;
    await bridge.close();

    const client = createKimiWebWsClient({
      url: `ws://127.0.0.1:${port}/kimi-web/ws`,
      getToken: () => BRIDGE_TOKEN,
      proxyHttpUrl: `http://127.0.0.1:${port}/kimi-web`,
      autoReconnect: false,
    });
    clients.push(client);
    const closes: KimiWebWsCloseInfo[] = [];
    client.onClose((info) => closes.push(info));

    await expect(client.connect()).rejects.toMatchObject({ code: 'connection-failed' });
    await waitFor(() => closes.length === 1, 3000, 'refused-connection close');
    expect(closes[0].classification).toMatchObject({ kind: 'upstream-unreachable' });
  });
});
