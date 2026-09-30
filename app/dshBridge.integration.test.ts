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
import { createDshAuthProvider, DSH_COOKIE_MISSING, type DshAuthProvider } from '../bridge/dshAuth.js';
import { createWebSocketAccept, encodeWebSocketFrame } from '../bridge/webSocketFrames.js';
import type { BridgeRuntime } from '../bridge/bridgeRuntime.js';

const BRIDGE_TOKEN = 'dsh-bridge-secret-task11';
const DSH_COOKIE = 'dsh-auth-task11=fake-session-cookie';
const DSH_WS_PATH = '/dsh/ws';
const DSH_AUTHORITY = '127.0.0.1:3080';
const DSH_SUPERVISOR_STATUS = {
  services: [{ id: 'dsh', state: 'disabled' }],
  acpAgents: [],
};

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

type RecordingProvider = DshAuthProvider & { authorities: string[] };

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

async function startDshRestUpstream(
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

async function startDshWsUpstream(): Promise<{ target: string; connections: UpstreamConnection[] }> {
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
    socket.on('data', (chunk) => {
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
      acceptUpstreamHandshake(socket, connection);
    });
  });
  tcpUpstreams.push(server);
  upstreamSocketSets.push(sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fake dsh WebSocket upstream address unavailable.');
  }
  return { target: `ws://127.0.0.1:${address.port}/api/remote.mux`, connections };
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

function createRecordingProvider(cookie: string): RecordingProvider {
  const authorities: string[] = [];
  return {
    authorities,
    async getCookie(authority: string) {
      authorities.push(authority);
      return cookie;
    },
    invalidate() {
      return false;
    },
  };
}

// The disabled dsh native service never spawns a child, so the supervisor's
// auth provider has no launch token: exactly this real provider shape must
// fail closed with the typed DSH_COOKIE_MISSING rejection.
function createDisabledProvider(): DshAuthProvider {
  return createDshAuthProvider({ getLaunchToken: () => null });
}

function createFakeRuntime(dshAuthProvider: DshAuthProvider): BridgeRuntime {
  return {
    async start() {
      return { services: [], acpAgents: [] };
    },
    async stop() {},
    getStatus: () => ({ services: DSH_SUPERVISOR_STATUS.services, acpAgents: [] }),
    async getConfig() {
      return { version: 1, nativeServices: { opencode: true, codex: true, 'kimi-web': true, dsh: false }, acpAgents: [] };
    },
    async listAgents() {
      return [];
    },
    async upsertAgent() {
      return undefined;
    },
    async updateAgent() {
      return undefined;
    },
    async removeAgent() {
      return false;
    },
    attachAgent() {},
    getDshAuthProvider: () => dshAuthProvider,
  } as unknown as BridgeRuntime;
}

async function startBridge(
  dshAuthProvider: DshAuthProvider,
  dsh: { upstreamOrigin?: string; target?: string } = {},
): Promise<{ server: TestServer; port: number }> {
  const server = createVisBridgeServer({
    host: '127.0.0.1',
    path: '/codex',
    target: 'ws://127.0.0.1:1',
    bridgeToken: BRIDGE_TOKEN,
    runtime: createFakeRuntime(dshAuthProvider),
    dsh,
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
  options: { authorization?: string; origin?: string } = {},
) {
  const socket = createConnection({ host: '127.0.0.1', port });
  clientSockets.add(socket);
  socket.on('close', () => clientSockets.delete(socket));
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
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
  socket.write(Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'utf8'));
  const bytes = () => Buffer.concat(chunks);
  return { socket, bytes, text: () => bytes().toString('utf8') };
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

describe('dsh web bridge route integration', () => {
  it('routes /dsh REST to the dsh proxy with the supervisor cookie while /api/v1 stays on the supervisor', async () => {
    const upstream = await startDshRestUpstream((_request, response) =>
      respondJson(response, 200, { ok: true, source: 'fake-dsh' }),
    );
    const provider = createRecordingProvider(DSH_COOKIE);
    const bridge = await startBridge(provider, { upstreamOrigin: upstream.origin });

    const dsh = await restJson(bridge.port, '/dsh/session/list', {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });

    expect(dsh.status).toBe(200);
    expect(dsh.body).toEqual({ ok: true, source: 'fake-dsh' });
    expect(dsh.text).not.toContain('"service":"vis_bridge"');
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.method).toBe('GET');
    expect(upstream.requests[0]?.url).toBe('/api/session/list');
    // The cookie is resolved per authority from the supervisor's dsh auth
    // provider and injected upstream; the browser only ever holds the bridge
    // token.
    expect(upstream.requests[0]?.headers.cookie).toBe(DSH_COOKIE);
    expect(provider.authorities).toEqual([DSH_AUTHORITY]);

    const supervisor = await restJson(bridge.port, '/api/v1/supervisor', {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });

    expect(supervisor.status).toBe(200);
    expect(supervisor.body).toEqual(DSH_SUPERVISOR_STATUS);
    expect(upstream.requests).toHaveLength(1);
  });

  it('maps the bare /dsh prefix onto the upstream /api/ root', async () => {
    const upstream = await startDshRestUpstream((_request, response) =>
      respondJson(response, 200, { ok: true }),
    );
    const bridge = await startBridge(createRecordingProvider(DSH_COOKIE), {
      upstreamOrigin: upstream.origin,
    });

    const result = await restJson(bridge.port, '/dsh', {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });

    expect(result.status).toBe(200);
    expect(upstream.requests[0]?.url).toBe('/api/');
  });

  it('rejects /dsh REST requests without the bridge token with 401 before dialing upstream', async () => {
    const upstream = await startDshRestUpstream((_request, response) =>
      respondJson(response, 200, { ok: true }),
    );
    const provider = createRecordingProvider(DSH_COOKIE);
    const bridge = await startBridge(provider, { upstreamOrigin: upstream.origin });

    const result = await restJson(bridge.port, '/dsh/api/session/list');

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(result.headers['www-authenticate']).toBe('Bearer realm="vis_bridge"');
    expect(upstream.requests).toHaveLength(0);
    expect(provider.authorities).toEqual([]);
  });

  it('does not route prefix-adjacent paths into the dsh proxy', async () => {
    const upstream = await startDshRestUpstream((_request, response) =>
      respondJson(response, 200, { ok: true }),
    );
    const provider = createRecordingProvider(DSH_COOKIE);
    const bridge = await startBridge(provider, { upstreamOrigin: upstream.origin });

    const result = await restJson(bridge.port, '/dsh-extra/api/session/list', {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ service: 'vis_bridge' });
    expect(upstream.requests).toHaveLength(0);
    expect(provider.authorities).toEqual([]);
  });

  it('rejects /dsh/ws upgrades without the bridge token with 401 before dialing', async () => {
    const upstream = await startDshWsUpstream();
    const provider = createRecordingProvider(DSH_COOKIE);
    const bridge = await startBridge(provider, { target: upstream.target });

    const client = await openUpgrade(bridge.port, DSH_WS_PATH);

    await waitFor(() => client.text().includes('\r\n\r\n'), '401 response');
    expect(client.text()).toContain('HTTP/1.1 401 Unauthorized');
    expect(client.text()).toContain('WWW-Authenticate: Bearer realm="vis_bridge"');
    expect(upstream.connections).toHaveLength(0);
    expect(provider.authorities).toEqual([]);
  });

  it('upgrades /dsh/ws to the dsh mux upstream with the injected cookie and relays frames', async () => {
    const upstream = await startDshWsUpstream();
    const provider = createRecordingProvider(DSH_COOKIE);
    const bridge = await startBridge(provider, { target: upstream.target });

    const client = await openUpgrade(bridge.port, DSH_WS_PATH, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
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
    expect(handshake).toContain(`GET /api/remote.mux HTTP/1.1`);
    expect(handshake).toContain(`Cookie: ${DSH_COOKIE}`);
    expect(handshake).not.toMatch(/^origin:/imu);
    expect(provider.authorities).toEqual([DSH_AUTHORITY]);

    const serverFrame = encodeWebSocketFrame(
      JSON.stringify({ type: 'mux_open', id: 'fake-ws' }),
    );
    upstream.connections[0]?.socket.write(serverFrame);
    await waitFor(
      () => {
        const headerEnd = client.bytes().indexOf('\r\n\r\n');
        return headerEnd !== -1 && client.bytes().subarray(headerEnd + 4).equals(serverFrame);
      },
      'server frame at client',
    );
    const headerEnd = client.bytes().indexOf('\r\n\r\n');
    expect(client.bytes().subarray(headerEnd + 4).equals(serverFrame)).toBe(true);
  });

  it('fails closed with a typed 502 on REST when the dsh native service is disabled', async () => {
    const upstream = await startDshRestUpstream((_request, response) =>
      respondJson(response, 200, { ok: true }),
    );
    const bridge = await startBridge(createDisabledProvider(), {
      upstreamOrigin: upstream.origin,
    });

    const result = await restJson(bridge.port, '/dsh/api/session/list', {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ code: DSH_COOKIE_MISSING });
    expect(result.headers['access-control-allow-origin']).toBe('*');
    // The route never proxies to dsh, and the bridge itself stays healthy.
    expect(upstream.requests).toHaveLength(0);
    await expect(
      restJson(bridge.port, '/healthz', { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('fails closed with a 502 upgrade response when the dsh native service is disabled', async () => {
    const upstream = await startDshWsUpstream();
    const bridge = await startBridge(createDisabledProvider(), { target: upstream.target });

    const client = await openUpgrade(bridge.port, DSH_WS_PATH, {
      authorization: `Bearer ${BRIDGE_TOKEN}`,
    });

    await waitFor(() => client.text().includes('502 Bad Gateway'), '502 response');
    expect(client.text()).not.toContain('101 Switching Protocols');
    expect(upstream.connections).toHaveLength(0);
    await expect(
      restJson(bridge.port, '/healthz', { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('rejects dsh control routes on a non-loopback host without a bridge token with 403', async () => {
    const upstream = await startDshRestUpstream((_request, response) =>
      respondJson(response, 200, { ok: true }),
    );
    const provider = createRecordingProvider(DSH_COOKIE);
    const server = createVisBridgeServer({
      host: '0.0.0.0',
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      runtime: createFakeRuntime(provider),
      dsh: { upstreamOrigin: upstream.origin },
    });
    const port = await listenBridge(server);

    const result = await restJson(port, '/dsh/api/session/list');

    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'Bridge control requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
    });
    expect(upstream.requests).toHaveLength(0);
    expect(provider.authorities).toEqual([]);
  });
});
