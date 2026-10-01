import { once } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { DshUpgradeOptions } from '../bridge/dshWsProxy.js';
import { DSH_WS_PATH, DSH_WS_TARGET, handleDshUpgrade } from '../bridge/dshWsProxy.js';
import { createWebSocketAccept, encodeWebSocketFrame } from '../bridge/webSocketFrames.js';

const BRIDGE_TOKEN = 'bridge-secret-4a9f';
const DSH_COOKIE_NAME = 'dsh-auth-jvDF8txFDAfXue6lmQ9tIC2LWapK0vsnXbJ1l-jvKzM';
const COOKIE_FIRST = `${DSH_COOKIE_NAME}=session-cookie-first-1a2b`;
const COOKIE_SECOND = `${DSH_COOKIE_NAME}=session-cookie-second-3c4d`;
const BROWSER_COOKIE = 'vis-browser-session=browser-side-cookie-999';
const DSH_AUTH_EXCHANGE_FAILED = 'DSH_AUTH_EXCHANGE_FAILED';

// Twin of bridge/dshAuth.js's DshAuthError: Todo 1 ships typed, data-free
// errors (stable `code`, no credential values in the message). The twin shape
// is enough here because the proxy must treat every provider failure the same.
class DshAuthErrorTwin extends Error {
  readonly code = DSH_AUTH_EXCHANGE_FAILED;

  constructor(message: string) {
    super(message);
    this.name = 'DshAuthError';
  }
}

type UpstreamConnection = {
  socket: Socket;
  handshake: string;
  headers: Map<string, string>;
  afterHandshake: Buffer;
};

const httpServers: HttpServer[] = [];
const upstreamServers: Server[] = [];
const upstreamSockets: Set<Socket>[] = [];
const bridgeSockets: Set<Duplex>[] = [];
const clientSockets = new Set<Socket>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function startFakeUpstream(
  onHandshake: (socket: Socket, connection: UpstreamConnection) => void,
) {
  const connections: UpstreamConnection[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const connection: UpstreamConnection = {
      socket,
      handshake: '',
      headers: new Map(),
      afterHandshake: Buffer.alloc(0),
    };
    connections.push(connection);
    const chunks: Buffer[] = [];
    let handshakeDone = false;
    socket.on('data', (chunk: Buffer) => {
      if (handshakeDone) {
        connection.afterHandshake = Buffer.concat([connection.afterHandshake, chunk]);
        return;
      }
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const headerEnd = text.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      handshakeDone = true;
      connection.handshake = text;
      for (const line of text.slice(0, headerEnd).split('\r\n').slice(1)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        connection.headers.set(
          line.slice(0, separator).trim().toLowerCase(),
          line.slice(separator + 1).trim(),
        );
      }
      connection.afterHandshake = Buffer.from(text.slice(headerEnd + 4), 'utf8');
      onHandshake(socket, connection);
    });
  });
  upstreamServers.push(server);
  upstreamSockets.push(sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake upstream address unavailable.');
  return { connections, target: `ws://127.0.0.1:${address.port}/api/remote.mux` };
}

function acceptUpstreamHandshake(socket: Socket, connection: UpstreamConnection) {
  const key = connection.headers.get('sec-websocket-key');
  if (!key) throw new Error('Upstream handshake carried no Sec-WebSocket-Key.');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
      '',
      '',
    ].join('\r\n'),
  );
}

async function startBridge(options: DshUpgradeOptions) {
  const decisions: boolean[] = [];
  const sockets = new Set<Duplex>();
  const server = createHttpServer();
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    decisions.push(handleDshUpgrade(request, socket, head, options));
  });
  httpServers.push(server);
  bridgeSockets.push(sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Bridge address unavailable.');
  return { decisions, port: address.port };
}

async function openRawClient(
  port: number,
  requestPath: string,
  extraHeaders: Record<string, string> = {},
) {
  const socket = createConnection({ host: '127.0.0.1', port });
  clientSockets.add(socket);
  socket.on('close', () => clientSockets.delete(socket));
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  const headers = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  const bytes = () => Buffer.concat(chunks);
  return { socket, bytes, text: () => bytes().toString('utf8') };
}

function relayedBytes(bytes: Buffer) {
  const headerEnd = bytes.indexOf('\r\n\r\n');
  return headerEnd === -1 ? Buffer.alloc(0) : bytes.subarray(headerEnd + 4);
}

function bodyOf(text: string) {
  const [, body = ''] = text.split('\r\n\r\n');
  return body;
}

afterEach(async () => {
  for (const socket of clientSockets) socket.destroy();
  clientSockets.clear();
  for (const sockets of upstreamSockets.splice(0)) {
    for (const socket of sockets) socket.destroy();
  }
  for (const sockets of bridgeSockets.splice(0)) {
    for (const socket of sockets) socket.destroy();
  }
  const closing: Promise<void>[] = [];
  for (const server of upstreamServers.splice(0)) {
    closing.push(new Promise<void>((resolve) => server.close(() => resolve())));
  }
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    closing.push(new Promise<void>((resolve) => server.close(() => resolve())));
  }
  await Promise.all(closing);
});

describe('dsh WebSocket upgrade proxy boundaries', () => {
  it('pins the dsh mux path and upstream endpoint constants', () => {
    expect(DSH_WS_PATH).toBe('/dsh/ws');
    expect(DSH_WS_TARGET).toBe('ws://127.0.0.1:3080/api/remote.mux');
  });

  it('rejects a missing bridge token with 401 before dialing upstream', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, DSH_WS_PATH);

    await waitFor(() => client.text().includes('\r\n\r\n'), '401 response');
    expect(client.text()).toContain('HTTP/1.1 401 Unauthorized');
    expect(client.text()).toContain('WWW-Authenticate: Bearer realm="vis_bridge"');
    expect(bridge.decisions).toEqual([true]);
    expect(upstream.connections).toHaveLength(0);
  });

  it('accepts the bridge token through the ?token= query parameter', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, `${DSH_WS_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');
    expect(upstream.connections).toHaveLength(1);
    expect(upstream.connections[0].headers.get('cookie')).toBe(COOKIE_FIRST);
  });

  it('accepts the bridge token through the Authorization header', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, DSH_WS_PATH, {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
    });

    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');
    expect(upstream.connections).toHaveLength(1);
    expect(upstream.connections[0].headers.get('cookie')).toBe(COOKIE_FIRST);
  });

  it('rejects a foreign browser origin with 403 before dialing upstream', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, DSH_WS_PATH, { Origin: 'https://example.com' });

    await waitFor(() => client.text().includes('403 Forbidden'), '403 response');
    expect(client.text()).toContain('HTTP/1.1 403 Forbidden');
    expect(bridge.decisions).toEqual([true]);
    expect(upstream.connections).toHaveLength(0);
  });

  it('forwards a loopback origin, omits Origin and the browser cookie upstream, injects the dsh cookie and echoes no subprotocol', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, DSH_WS_PATH, {
      Origin: 'http://localhost:5173',
      Cookie: BROWSER_COOKIE,
      'Sec-WebSocket-Protocol': 'dsh-mux, vis',
    });

    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');
    const handshake = upstream.connections[0]?.handshake ?? '';
    expect(handshake).toMatch(/^GET \/api\/remote\.mux HTTP\/1\.1\r\n/u);
    expect(handshake).toMatch(/^Host: 127\.0\.0\.1:\d+$/mu);
    expect(handshake).toContain(`Cookie: ${COOKIE_FIRST}`);
    expect(handshake).not.toMatch(/^origin:/imu);
    expect(handshake).not.toContain(BROWSER_COOKIE);
    expect(client.text().toLowerCase()).not.toContain('sec-websocket-protocol');
  });

  it('resolves the cookie provider fresh per dial after rotation', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    let cookie = COOKIE_FIRST;
    let providerCalls = 0;
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamCookie: async () => {
        providerCalls += 1;
        return cookie;
      },
    });

    const first = await openRawClient(bridge.port, DSH_WS_PATH);
    await waitFor(() => first.text().includes('101 Switching Protocols'), 'first 101 response');
    expect(providerCalls).toBe(1);

    cookie = COOKIE_SECOND;
    const second = await openRawClient(bridge.port, DSH_WS_PATH);
    await waitFor(() => second.text().includes('101 Switching Protocols'), 'second 101 response');

    expect(upstream.connections).toHaveLength(2);
    expect(upstream.connections[0].headers.get('cookie')).toBe(COOKIE_FIRST);
    expect(upstream.connections[1].headers.get('cookie')).toBe(COOKIE_SECOND);
    expect(providerCalls).toBe(2);
  });

  it('pipes bytes verbatim in both directions after 101, including mux open/item/end frames', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, DSH_WS_PATH);
    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');

    const openFrame = encodeWebSocketFrame(
      JSON.stringify({
        type: 'open',
        streamId: 'sf1',
        endpoint: 'session/follow',
        payload: {
          args: {
            request: { address: { kind: 'session', sessionId: 'session-abc' }, assistantStream: true },
          },
        },
      }),
    );
    const endFrame = encodeWebSocketFrame(JSON.stringify({ type: 'end', streamId: 'sf1' }));
    const itemFrame = encodeWebSocketFrame(
      JSON.stringify({
        type: 'item',
        streamId: 'sf1',
        value: {
          type: 'snapshot',
          header: { version: '0.2.0-rc.2' },
          cursor: 3,
          records: [],
          hasMore: false,
          projections: {},
        },
      }),
    );

    client.socket.write(Buffer.concat([openFrame, endFrame]));
    await waitFor(
      () => upstream.connections[0].afterHandshake.length >= openFrame.length + endFrame.length,
      'open and end frames at upstream',
    );
    expect(upstream.connections[0].afterHandshake.equals(Buffer.concat([openFrame, endFrame]))).toBe(
      true,
    );

    upstream.connections[0].socket.write(itemFrame);
    await waitFor(
      () => relayedBytes(client.bytes()).length >= itemFrame.length,
      'item frame at client',
    );
    expect(relayedBytes(client.bytes()).equals(itemFrame)).toBe(true);
  });

  it('turns an upstream 401 into a bridge-side 502 without a misleading success body', async () => {
    const upstream = await startFakeUpstream((socket) => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.end();
    });
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, `${DSH_WS_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    const response = client.text();
    expect(response).not.toContain('101 Switching Protocols');
    expect(response).not.toContain('Sec-WebSocket-Accept');
    expect(response).not.toContain('HTTP/1.1 401');
    expect(response).not.toContain(COOKIE_FIRST);
    const [head = '', body = ''] = response.split('\r\n\r\n');
    expect(head).toContain('HTTP/1.1 502 Bad Gateway');
    expect(Object.keys(JSON.parse(body))).toEqual(['error']);
  });

  it('reports 502 when the upstream refuses the connection', async () => {
    const bridge = await startBridge({
      target: 'ws://127.0.0.1:1/api/remote.mux',
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, `${DSH_WS_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    const response = client.text();
    expect(response).not.toContain('101 Switching Protocols');
    expect(response).not.toContain('Sec-WebSocket-Accept');
    expect(JSON.parse(bodyOf(response))).toEqual({ error: expect.any(String) });
  });

  it('rejects with 502 and never dials when the cookie provider throws a typed dsh auth error', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => {
        throw new DshAuthErrorTwin(
          'Dsh auth exchange request failed for 127.0.0.1:3080 (credential unavailable)',
        );
      },
    });

    const client = await openRawClient(bridge.port, `${DSH_WS_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    const response = client.text();
    expect(response).not.toContain('101 Switching Protocols');
    expect(response).not.toContain('Sec-WebSocket-Accept');
    expect(response).not.toContain(DSH_COOKIE_NAME);
    expect(upstream.connections).toHaveLength(0);
  });

  it('rejects with 502 and never dials when no cookie provider is configured', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
    });

    const client = await openRawClient(bridge.port, `${DSH_WS_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    expect(client.text()).not.toContain('101 Switching Protocols');
    expect(upstream.connections).toHaveLength(0);
  });

  it('rejects with 502 and never dials when the provider resolves an empty cookie', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamCookie: async () => '',
    });

    const client = await openRawClient(bridge.port, `${DSH_WS_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    expect(client.text()).not.toContain('101 Switching Protocols');
    expect(upstream.connections).toHaveLength(0);
  });

  it('declines non-dsh paths so the upgrade chain can continue', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamCookie: async () => COOKIE_FIRST,
    });

    const client = await openRawClient(bridge.port, '/dsh/other');
    await sleep(50);

    expect(bridge.decisions).toEqual([false]);
    expect(client.bytes()).toHaveLength(0);
    expect(upstream.connections).toHaveLength(0);
  });
});
