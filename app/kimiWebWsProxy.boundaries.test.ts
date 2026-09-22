import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiWebTokenProvider } from '../bridge/kimiWebToken.js';
import { handleKimiWebUpgrade } from '../bridge/kimiWebWsProxy.js';
import { createWebSocketAccept, encodeWebSocketFrame } from '../bridge/webSocketFrames.js';

const KIMI_PATH = '/kimi-web/ws';
const BRIDGE_TOKEN = 'bridge-secret-3f2a';
const UPSTREAM_BEARER = 'Bearer upstream-token-91bb';

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
const tempDirs: string[] = [];

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
  return { connections, target: `ws://127.0.0.1:${address.port}/api/v1/ws` };
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

type KimiUpgradeOptions = NonNullable<Parameters<typeof handleKimiWebUpgrade>[3]>;

async function startBridge(options: KimiUpgradeOptions) {
  const decisions: boolean[] = [];
  const sockets = new Set<Duplex>();
  const server = createHttpServer();
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    decisions.push(handleKimiWebUpgrade(request, socket, head, options));
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
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('kimi web WebSocket upgrade proxy boundaries', () => {
  it('rejects a missing bridge token with 401 before dialing upstream', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, KIMI_PATH);

    await waitFor(() => client.text().includes('\r\n\r\n'), '401 response');
    expect(client.text()).toContain('HTTP/1.1 401 Unauthorized');
    expect(client.text()).toContain('WWW-Authenticate: Bearer realm="vis_bridge"');
    expect(bridge.decisions).toEqual([true]);
    expect(upstream.connections).toHaveLength(0);
  });

  it('fails closed on non-loopback hosts without a bridge token', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      host: '0.0.0.0',
      target: upstream.target,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, KIMI_PATH);

    await waitFor(() => client.text().includes('403 Forbidden'), '403 response');
    expect(client.text()).toContain('VIS_BRIDGE_TOKEN');
    expect(upstream.connections).toHaveLength(0);
  });

  it('accepts the bridge token through the ?token= query parameter', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, `${KIMI_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');
    expect(upstream.connections).toHaveLength(1);
    expect(upstream.connections[0].headers.get('authorization')).toBe(UPSTREAM_BEARER);
  });

  it('rejects a foreign browser origin with 403 before dialing upstream', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, KIMI_PATH, { Origin: 'https://example.com' });

    await waitFor(() => client.text().includes('403 Forbidden'), '403 response');
    expect(client.text()).toContain('HTTP/1.1 403 Forbidden');
    expect(upstream.connections).toHaveLength(0);
  });

  it('forwards a loopback origin, omits Origin upstream and does not echo kimi subprotocols', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, KIMI_PATH, {
      Origin: 'http://localhost:5173',
      'Sec-WebSocket-Protocol': 'kimi-code.bearer.upstream-token-91bb',
    });

    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');
    const handshake = upstream.connections[0]?.handshake ?? '';
    expect(handshake).toMatch(/^GET \/api\/v1\/ws HTTP\/1\.1\r\n/u);
    expect(handshake).toContain(`Authorization: ${UPSTREAM_BEARER}`);
    expect(handshake).not.toMatch(/^origin:/imu);
    expect(client.text().toLowerCase()).not.toContain('sec-websocket-protocol');
  });

  it('injects the latest Bearer token on every dial after rotation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kimi-ws-proxy-'));
    tempDirs.push(dir);
    const tokenPath = path.join(dir, 'server.token');
    await writeFile(tokenPath, 'token-first-111\n', 'utf8');
    const provider = createKimiWebTokenProvider({ tokenPath });

    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamAuthorization: () => provider.getAuthorization(),
    });

    const first = await openRawClient(bridge.port, KIMI_PATH);
    await waitFor(() => first.text().includes('101 Switching Protocols'), 'first 101 response');

    await writeFile(tokenPath, 'token-second-222\n', 'utf8');
    const second = await openRawClient(bridge.port, KIMI_PATH);
    await waitFor(() => second.text().includes('101 Switching Protocols'), 'second 101 response');

    expect(upstream.connections).toHaveLength(2);
    expect(upstream.connections[0].headers.get('authorization')).toBe('Bearer token-first-111');
    expect(upstream.connections[1].headers.get('authorization')).toBe('Bearer token-second-222');
  });

  it('pipes bytes in both directions verbatim after 101, including a JSON ping frame', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, KIMI_PATH);
    await waitFor(() => client.text().includes('101 Switching Protocols'), '101 response');

    const ping = encodeWebSocketFrame(
      JSON.stringify({ type: 'ping', payload: { nonce: 'nonce-42' } }),
    );
    upstream.connections[0].socket.write(ping);
    await waitFor(() => relayedBytes(client.bytes()).length >= ping.length, 'ping frame at client');
    const received = relayedBytes(client.bytes());
    expect(received.equals(ping)).toBe(true);
    expect(received.toString('utf8')).toContain('"type":"ping"');

    const hello = encodeWebSocketFrame(
      JSON.stringify({ type: 'client_hello', id: 'c1', payload: { client_id: 'vis' } }),
    );
    client.socket.write(hello);
    await waitFor(
      () => upstream.connections[0].afterHandshake.equals(hello),
      'client_hello frame at upstream',
    );
    expect(upstream.connections[0].afterHandshake.equals(hello)).toBe(true);
  });

  it('turns an upstream 401 into a bridge-side 502 without a misleading success body', async () => {
    const upstream = await startFakeUpstream((socket) => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.end();
    });
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, `${KIMI_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    const response = client.text();
    expect(response).not.toContain('101 Switching Protocols');
    expect(response).not.toContain('Sec-WebSocket-Accept');
    expect(response).not.toContain('HTTP/1.1 401');
    expect(response).not.toContain('Unauthorized');
    const [head = '', body = ''] = response.split('\r\n\r\n');
    expect(head).toContain('HTTP/1.1 502 Bad Gateway');
    expect(JSON.parse(body)).toEqual({ error: expect.any(String) });
  });

  it('reports 502 when the upstream refuses the connection', async () => {
    const bridge = await startBridge({
      target: 'ws://127.0.0.1:1/api/v1/ws',
      bridgeToken: BRIDGE_TOKEN,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, `${KIMI_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    expect(client.text()).not.toContain('101 Switching Protocols');
    expect(client.text()).not.toContain('Sec-WebSocket-Accept');
  });

  it('times out a stalled upstream handshake and destroys the upstream socket', async () => {
    const upstream = await startFakeUpstream(() => {});
    const bridge = await startBridge({
      target: upstream.target,
      bridgeToken: BRIDGE_TOKEN,
      handshakeTimeoutMs: 40,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, `${KIMI_PATH}?token=${BRIDGE_TOKEN}`);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 after timeout');
    await waitFor(
      () => upstream.connections[0]?.socket.destroyed === true,
      'upstream socket destroyed',
    );
  });

  it('declines non-kimi paths so the upgrade chain can continue', async () => {
    const upstream = await startFakeUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({
      target: upstream.target,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
    });

    const client = await openRawClient(bridge.port, '/kimi-web/other');
    await sleep(50);

    expect(bridge.decisions).toEqual([false]);
    expect(client.bytes()).toHaveLength(0);
    expect(upstream.connections).toHaveLength(0);
  });
});
