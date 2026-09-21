import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createVisBridgeServer } from '../vis_bridge';
import { createWebSocketAccept, encodeWebSocketFrame } from '../bridge/webSocketFrames.js';

const KIMI_WS_PATH = '/kimi-web/ws';
const BRIDGE_TOKEN = 'bridge-secret-task4';
const UPSTREAM_BEARER = 'Bearer kimi-upstream-token-task4';
const NON_LOOPBACK_REJECTION =
  'Bridge control requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.';

type TestServer = ReturnType<typeof createVisBridgeServer>;

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type UpstreamConnection = {
  socket: Socket;
  handshake: string;
  headers: Map<string, string>;
  afterHandshake: Buffer;
};

const bridgeServers: TestServer[] = [];
const httpUpstreams: HttpServer[] = [];
const tcpUpstreams: TcpServer[] = [];
const upstreamSocketSets: Set<Socket>[] = [];
const clientSockets = new Set<Socket>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function listenHttpServer(server: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test address unavailable.');
      resolve(address.port);
    });
  });
}

async function listenBridge(server: TestServer): Promise<number> {
  bridgeServers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Bridge address unavailable.');
  return address.port;
}

async function startRestUpstream(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<{ origin: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  httpUpstreams.push(server);
  const port = await listenHttpServer(server);
  return { origin: `http://127.0.0.1:${port}`, requests };
}

function respondJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

async function startWsUpstream(
  onHandshake: (socket: Socket, connection: UpstreamConnection) => void,
): Promise<{ target: string; connections: UpstreamConnection[] }> {
  const connections: UpstreamConnection[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const connection: UpstreamConnection = {
      socket,
      handshake: '',
      headers: new Map(),
      afterHandshake: Buffer.alloc(0),
    };
    connections.push(connection);
    let raw = Buffer.alloc(0);
    let handshakeDone = false;
    socket.on('data', (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (handshakeDone) {
        connection.afterHandshake = raw.subarray(raw.indexOf('\r\n\r\n') + 4);
        return;
      }
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      handshakeDone = true;
      connection.handshake = raw.subarray(0, headerEnd).toString('utf8');
      for (const line of connection.handshake.split('\r\n').slice(1)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        connection.headers.set(
          line.slice(0, separator).trim().toLowerCase(),
          line.slice(separator + 1).trim(),
        );
      }
      connection.afterHandshake = raw.subarray(headerEnd + 4);
      onHandshake(socket, connection);
    });
  });
  tcpUpstreams.push(server);
  upstreamSocketSets.push(sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fake WebSocket upstream address unavailable.');
  }
  return { target: `ws://127.0.0.1:${address.port}/api/v1/ws`, connections };
}

async function startSilentUpstream(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => {});
  });
  tcpUpstreams.push(server);
  upstreamSocketSets.push(sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Silent upstream address unavailable.');
  return address.port;
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

async function closedPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test address unavailable.');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startBridge(
  options: {
    bridgeToken?: string;
    host?: string;
    upstreamOrigin?: string;
    wsTarget?: string;
    upstreamTimeoutMs?: number;
    handshakeTimeoutMs?: number;
  } = {},
) {
  const server = createVisBridgeServer({
    host: options.host ?? '127.0.0.1',
    path: '/codex',
    target: 'ws://127.0.0.1:1',
    bridgeToken: options.bridgeToken,
    kimiWeb: {
      upstreamOrigin: options.upstreamOrigin,
      target: options.wsTarget,
      getUpstreamAuthorization: () => UPSTREAM_BEARER,
      upstreamTimeoutMs: options.upstreamTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    },
  });
  const port = await listenBridge(server);
  return { server, port };
}

function restRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          ...(body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
              }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function restJson(port: number, path: string, options?: Parameters<typeof restRequest>[2]) {
  const result = await restRequest(port, path, options);
  return {
    ...result,
    body: result.text ? (JSON.parse(result.text) as unknown) : null,
  };
}

async function openUpgrade(
  port: number,
  path: string,
  options: { authorization?: string; origin?: string; headBytes?: Buffer } = {},
) {
  const socket = createConnection({ host: '127.0.0.1', port });
  clientSockets.add(socket);
  socket.on('close', () => clientSockets.delete(socket));
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
  ];
  if (options.authorization) headers.push(`Authorization: ${options.authorization}`);
  if (options.origin) headers.push(`Origin: ${options.origin}`);
  socket.write(
    Buffer.concat([
      Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'utf8'),
      options.headBytes ?? Buffer.alloc(0),
    ]),
  );
  const bytes = () => Buffer.concat(chunks);
  return { socket, bytes, text: () => bytes().toString('utf8') };
}

function relayedBytes(bytes: Buffer) {
  const headerEnd = bytes.indexOf('\r\n\r\n');
  return headerEnd === -1 ? Buffer.alloc(0) : bytes.subarray(headerEnd + 4);
}

function encodeMaskedWebSocketFrame(data: string) {
  const payload = Buffer.from(data, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

afterEach(async () => {
  for (const socket of clientSockets) socket.destroy();
  clientSockets.clear();
  for (const sockets of upstreamSocketSets.splice(0)) {
    for (const socket of sockets) socket.destroy();
  }
  const closing: Promise<void>[] = [];
  for (const server of tcpUpstreams.splice(0)) {
    closing.push(new Promise<void>((resolve) => server.close(() => resolve())));
  }
  for (const server of httpUpstreams.splice(0)) {
    server.closeAllConnections();
    closing.push(new Promise<void>((resolve) => server.close(() => resolve())));
  }
  for (const server of bridgeServers.splice(0)) {
    server.closeAllConnections();
    closing.push(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    );
  }
  await Promise.all(closing);
});

describe('kimi web bridge route integration', () => {
  it('rejects kimi REST requests without the bridge token before dialing upstream', async () => {
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 200, { code: 0, data: { unexpected: true } }),
    );
    const bridge = await startBridge({
      bridgeToken: BRIDGE_TOKEN,
      upstreamOrigin: upstream.origin,
    });

    const result = await restJson(bridge.port, '/kimi-web/api/v1/meta');

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(result.headers['www-authenticate']).toBe('Bearer realm="vis_bridge"');
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects unknown browser origins on the kimi REST route with 403', async () => {
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 200, { code: 0 }),
    );
    const bridge = await startBridge({ upstreamOrigin: upstream.origin });

    const result = await restJson(bridge.port, '/kimi-web/api/v1/meta', {
      headers: { Origin: 'https://example.com' },
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'Forbidden origin' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('authenticates with the bridge token header and streams the fake upstream REST response with bridge CORS', async () => {
    const envelope = { code: 0, msg: 'success', data: { ok: true, source: 'fake-kimi' } };
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 200, envelope),
    );
    const bridge = await startBridge({
      bridgeToken: BRIDGE_TOKEN,
      upstreamOrigin: upstream.origin,
    });

    const result = await restJson(bridge.port, '/kimi-web/api/v1/meta', {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(envelope);
    expect(result.text).not.toContain('"service":"vis_bridge"');
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.method).toBe('GET');
    expect(upstream.requests[0]?.url).toBe('/api/v1/meta');
    expect(upstream.requests[0]?.headers.authorization).toBe(UPSTREAM_BEARER);
    expect(upstream.requests[0]?.headers.origin).toBeUndefined();
  });

  it('forwards method, query, and JSON body bytes to the fake upstream', async () => {
    const upstream = await startRestUpstream((request, response) =>
      respondJson(response, 201, {
        code: 0,
        data: { echoed: JSON.parse(request.body.toString('utf8')) },
      }),
    );
    const bridge = await startBridge({ upstreamOrigin: upstream.origin });

    const result = await restJson(bridge.port, '/kimi-web/api/v1/sessions?workspace=w1', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello kimi' }),
    });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      code: 0,
      data: { echoed: { prompt: 'hello kimi' } },
    });
    expect(upstream.requests[0]?.method).toBe('POST');
    expect(upstream.requests[0]?.url).toBe('/api/v1/sessions?workspace=w1');
    expect(upstream.requests[0]?.body.toString('utf8')).toBe('{"prompt":"hello kimi"}');
  });

  it('maps /kimi-web without a subpath onto the upstream root', async () => {
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 200, { service: 'fake-kimi-root' }),
    );
    const bridge = await startBridge({ upstreamOrigin: upstream.origin });

    const result = await restJson(bridge.port, '/kimi-web');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ service: 'fake-kimi-root' });
    expect(upstream.requests[0]?.url).toBe('/');
  });

  it('preserves a kimi upstream 404 envelope instead of returning a bridge route 404', async () => {
    const envelope = { code: 40401, msg: 'Session not found', data: null };
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 404, envelope),
    );
    const bridge = await startBridge({ upstreamOrigin: upstream.origin });

    const result = await restRequest(bridge.port, '/kimi-web/api/v1/sessions/missing');

    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual(envelope);
    expect(result.text).not.toContain('KIMI_WEB_PROXY_PATH');
    expect(result.text).not.toContain('Not found');
  });

  it('does not route prefix-adjacent paths into the kimi proxy', async () => {
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 200, { code: 0, data: { unexpected: true } }),
    );
    const bridge = await startBridge({ upstreamOrigin: upstream.origin });

    const result = await restJson(bridge.port, '/kimi-web-extra/api/v1/meta');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ service: 'vis_bridge' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('fails closed on non-loopback hosts without a bridge token for REST and upgrade', async () => {
    const upstream = await startRestUpstream((_request, response) =>
      respondJson(response, 200, { code: 0 }),
    );
    const bridge = await startBridge({ host: '0.0.0.0', upstreamOrigin: upstream.origin });

    const rest = await restJson(bridge.port, '/kimi-web/api/v1/meta');
    expect(rest.status).toBe(403);
    expect(rest.body).toEqual({ error: NON_LOOPBACK_REJECTION });

    const upgrade = await openUpgrade(bridge.port, KIMI_WS_PATH);
    await waitFor(() => upgrade.text().includes('403 Forbidden'), '403 upgrade rejection');
    expect(upgrade.text()).toContain('VIS_BRIDGE_TOKEN');
    expect(upstream.requests).toHaveLength(0);
  });

  it('reports a bounded 502 when the fake kimi REST upstream is absent', async () => {
    const port = await closedPort();
    const bridge = await startBridge({ upstreamOrigin: `http://127.0.0.1:${port}` });

    const result = await restJson(bridge.port, '/kimi-web/api/v1/meta');

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ code: 'KIMI_WEB_UPSTREAM_UNREACHABLE' });
    expect(result.headers['access-control-allow-origin']).toBe('*');

    await expect(restJson(bridge.port, '/healthz')).resolves.toMatchObject({ status: 200 });
  });

  it('times out a stalled kimi REST upstream without hanging the bridge', async () => {
    const upstream = await startRestUpstream(() => {});
    const bridge = await startBridge({
      upstreamOrigin: upstream.origin,
      upstreamTimeoutMs: 60,
    });

    const result = await restJson(bridge.port, '/kimi-web/api/v1/meta');

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ code: 'KIMI_WEB_UPSTREAM_TIMEOUT' });
    await expect(restJson(bridge.port, '/healthz')).resolves.toMatchObject({ status: 200 });
  });

  it('rejects kimi WebSocket upgrades without the bridge token with 401 before dialing', async () => {
    const upstream = await startWsUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({ bridgeToken: BRIDGE_TOKEN, wsTarget: upstream.target });

    const client = await openUpgrade(bridge.port, KIMI_WS_PATH);

    await waitFor(() => client.text().includes('\r\n\r\n'), '401 response');
    expect(client.text()).toContain('HTTP/1.1 401 Unauthorized');
    expect(client.text()).toContain('WWW-Authenticate: Bearer realm="vis_bridge"');
    expect(upstream.connections).toHaveLength(0);
  });

  it('rejects unknown browser origins on the kimi WebSocket route with 403', async () => {
    const upstream = await startWsUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({ wsTarget: upstream.target });

    const client = await openUpgrade(bridge.port, KIMI_WS_PATH, {
      origin: 'https://example.com',
    });

    await waitFor(() => client.text().includes('403 Forbidden'), '403 response');
    expect(client.text()).not.toContain('101 Switching Protocols');
    expect(upstream.connections).toHaveLength(0);
  });

  it('falls through to the Codex 404 for non-kimi upgrade paths', async () => {
    const upstream = await startWsUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({ wsTarget: upstream.target });

    const client = await openUpgrade(bridge.port, '/kimi-web/other');

    await waitFor(() => client.text().includes('\r\n\r\n'), '404 response');
    expect(client.text()).toContain('HTTP/1.1 404 Not Found');
    expect(client.text()).toContain('Use WebSocket path /codex');
    expect(upstream.connections).toHaveLength(0);
  });

  it('upgrades to the fake kimi upstream with 101 and relays frames both ways', async () => {
    const upstream = await startWsUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({ bridgeToken: BRIDGE_TOKEN, wsTarget: upstream.target });

    const client = await openUpgrade(bridge.port, `${KIMI_WS_PATH}?token=${BRIDGE_TOKEN}`);
    await waitFor(
      () => client.text().includes('101 Switching Protocols'),
      '101 Switching Protocols',
    );

    const responseHead = client.text().split('\r\n\r\n')[0] ?? '';
    expect(responseHead).toContain(
      `Sec-WebSocket-Accept: ${createWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')}`,
    );
    expect(upstream.connections).toHaveLength(1);
    const handshake = upstream.connections[0]?.handshake ?? '';
    expect(handshake).toMatch(/^GET \/api\/v1\/ws HTTP\/1\.1\r\n/u);
    expect(handshake).toContain(`Authorization: ${UPSTREAM_BEARER}`);
    expect(handshake).not.toMatch(/^origin:/imu);

    const serverFrame = encodeWebSocketFrame(
      JSON.stringify({ type: 'server_hello', payload: { nonce: 'n1' } }),
    );
    upstream.connections[0]?.socket.write(serverFrame);
    await waitFor(
      () => relayedBytes(client.bytes()).length >= serverFrame.length,
      'server frame at client',
    );
    expect(relayedBytes(client.bytes()).equals(serverFrame)).toBe(true);

    const clientFrame = encodeMaskedWebSocketFrame(
      JSON.stringify({ type: 'pong', payload: { nonce: 'n1' } }),
    );
    client.socket.write(clientFrame);
    await waitFor(
      () => upstream.connections[0]?.afterHandshake.equals(clientFrame) === true,
      'client frame at upstream',
    );
    expect(upstream.connections[0]?.afterHandshake.equals(clientFrame)).toBe(true);
  });

  it('relays upgrade head bytes verbatim to the fake upstream', async () => {
    const headBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    const upstream = await startWsUpstream(acceptUpstreamHandshake);
    const bridge = await startBridge({ wsTarget: upstream.target });

    const client = await openUpgrade(bridge.port, KIMI_WS_PATH, { headBytes });
    await waitFor(
      () => client.text().includes('101 Switching Protocols'),
      '101 Switching Protocols',
    );
    await waitFor(
      () => upstream.connections[0]?.afterHandshake.equals(headBytes) === true,
      'head bytes at upstream',
    );
    expect(upstream.connections[0]?.afterHandshake.equals(headBytes)).toBe(true);
  });

  it('reports 502 when the kimi WebSocket upstream is absent', async () => {
    const port = await closedPort();
    const bridge = await startBridge({ wsTarget: `ws://127.0.0.1:${port}/api/v1/ws` });

    const client = await openUpgrade(bridge.port, KIMI_WS_PATH);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    expect(client.text()).not.toContain('101 Switching Protocols');
    expect(client.text()).not.toContain('Sec-WebSocket-Accept');
    await expect(restJson(bridge.port, '/healthz')).resolves.toMatchObject({ status: 200 });
  });

  it('times out a stalled kimi WebSocket handshake without hanging the bridge', async () => {
    const port = await startSilentUpstream();
    const bridge = await startBridge({
      wsTarget: `ws://127.0.0.1:${port}/api/v1/ws`,
      handshakeTimeoutMs: 60,
    });

    const client = await openUpgrade(bridge.port, KIMI_WS_PATH);

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 after timeout');
    expect(client.text()).not.toContain('101 Switching Protocols');
    await expect(restJson(bridge.port, '/healthz')).resolves.toMatchObject({ status: 200 });
  });
});
