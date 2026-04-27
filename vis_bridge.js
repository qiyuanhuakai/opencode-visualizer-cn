#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 23004;
const DEFAULT_PATH = '/codex';
const DEFAULT_CODEX_WS_URL = 'ws://127.0.0.1:4500';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function usage() {
  return `vis_bridge - localhost WebSocket bridge for Codex app-server

Usage:
  vis_bridge [--target ws://127.0.0.1:4500] [--host 127.0.0.1] [--port 23004] [--path /codex]

Options:
  --target             Upstream Codex app-server WebSocket URL.
  --host               Bridge listen host. Defaults to 127.0.0.1.
  --port               Bridge listen port. Defaults to 23004.
  --path               Local WebSocket path. Defaults to /codex.
  --bridge-token       Optional token required from clients via Authorization Bearer or ?token=.
  --upstream-token     Bearer token sent to Codex app-server during WebSocket handshake.
  --upstream-token-file Read upstream bearer token from file.
  --help               Show this help.

Environment:
  VIS_BRIDGE_CODEX_WS_URL           Same as --target.
  VIS_BRIDGE_HOST                   Same as --host.
  VIS_BRIDGE_PORT                   Same as --port.
  VIS_BRIDGE_PATH                   Same as --path.
  VIS_BRIDGE_TOKEN                  Same as --bridge-token.
  VIS_BRIDGE_CODEX_TOKEN            Same as --upstream-token.
  VIS_BRIDGE_CODEX_TOKEN_FILE       Same as --upstream-token-file.
  VIS_BRIDGE_CODEX_AUTHORIZATION    Raw Authorization header for upstream.
`;
}

function parseCliOptions(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      path: { type: 'string' },
      'bridge-token': { type: 'string' },
      'upstream-token': { type: 'string' },
      'upstream-token-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  const tokenFile = values['upstream-token-file'] ?? env.VIS_BRIDGE_CODEX_TOKEN_FILE;
  const tokenFromFile = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
  const portText = values.port ?? env.VIS_BRIDGE_PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid vis_bridge port: ${portText}`);
  }

  return {
    help: Boolean(values.help),
    host: values.host ?? env.VIS_BRIDGE_HOST ?? DEFAULT_HOST,
    port,
    path: normalizePath(values.path ?? env.VIS_BRIDGE_PATH ?? DEFAULT_PATH),
    target: values.target ?? env.VIS_BRIDGE_CODEX_WS_URL ?? DEFAULT_CODEX_WS_URL,
    bridgeToken: values['bridge-token'] ?? env.VIS_BRIDGE_TOKEN,
    upstreamAuthorization:
      env.VIS_BRIDGE_CODEX_AUTHORIZATION ??
      bearerAuthorization(values['upstream-token'] ?? env.VIS_BRIDGE_CODEX_TOKEN ?? tokenFromFile),
  };
}

function normalizePath(path) {
  if (!path) return DEFAULT_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}

function bearerAuthorization(token) {
  return token ? `Bearer ${token}` : undefined;
}

function writeHttpResponse(socket, statusCode, statusText, body, headers = {}) {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
  socket.write([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(responseBody)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    responseBody,
  ].join('\r\n'));
  socket.destroy();
}

function createWebSocketAccept(secWebSocketKey) {
  return createHash('sha1').update(`${secWebSocketKey}${WS_GUID}`).digest('base64');
}

function isAuthorized(request, bridgeToken) {
  if (!bridgeToken) return true;
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${bridgeToken}`) return true;

  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  return requestUrl.searchParams.get('token') === bridgeToken ||
    requestUrl.searchParams.get('bridgeToken') === bridgeToken;
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    // Allow local Electron protocols (file://, app://, etc.)
    if (parsed.protocol === 'file:' || parsed.protocol === 'app:') return true;
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function assertWebSocketRequest(request) {
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  const key = request.headers['sec-websocket-key'];
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
    throw new Error('Missing WebSocket upgrade header.');
  }
  if (typeof connection !== 'string' || !connection.toLowerCase().includes('upgrade')) {
    throw new Error('Missing WebSocket connection upgrade header.');
  }
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('Missing Sec-WebSocket-Key header.');
  }
  return key;
}

function connectRawSocket(targetUrl) {
  const port = Number(targetUrl.port || (targetUrl.protocol === 'wss:' ? 443 : 80));
  const host = targetUrl.hostname;
  if (targetUrl.protocol === 'wss:') {
    return connectTls({ host, port, servername: host });
  }
  if (targetUrl.protocol === 'ws:') {
    return connectTcp({ host, port });
  }
  throw new Error(`Unsupported Codex WebSocket protocol: ${targetUrl.protocol}`);
}

function buildUpstreamHandshake(targetUrl, authorization) {
  const path = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`;
  const host = targetUrl.port ? `${targetUrl.hostname}:${targetUrl.port}` : targetUrl.hostname;
  const key = randomBytes(16).toString('base64');
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (authorization) headers.push(`Authorization: ${authorization}`);
  headers.push('', '');
  return headers.join('\r\n');
}

function connectUpstreamWebSocket(target, authorization) {
  const targetUrl = new URL(target);
  const upstream = connectRawSocket(targetUrl);
  const handshake = buildUpstreamHandshake(targetUrl, authorization);

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let handshakeSent = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      upstream.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      const firstLine = headerText.split('\r\n')[0] ?? '';
      if (!firstLine.includes(' 101 ')) {
        fail(new Error(`Codex upstream rejected WebSocket handshake: ${firstLine}`));
        return;
      }

      settled = true;
      upstream.off('data', onData);
      upstream.off('error', fail);
      const head = buffer.subarray(headerEnd + 4);
      resolve({ socket: upstream, head });
    };

    const sendHandshake = () => {
      if (handshakeSent) return;
      handshakeSent = true;
      upstream.write(handshake);
    };

    upstream.once('connect', sendHandshake);
    upstream.once('secureConnect', sendHandshake);
    upstream.on('data', onData);
    upstream.once('error', fail);
    upstream.once('close', () => {
      if (!settled) fail(new Error('Codex upstream closed during WebSocket handshake.'));
    });
  });
}

async function proxyWebSocket(request, clientSocket, head, options) {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (requestPath !== options.path) {
    writeHttpResponse(clientSocket, 404, 'Not Found', { error: `Use WebSocket path ${options.path}` });
    return;
  }

  if (!isAllowedOrigin(request.headers.origin)) {
    writeHttpResponse(clientSocket, 403, 'Forbidden', { error: 'Forbidden origin' });
    return;
  }

  if (!isAuthorized(request, options.bridgeToken)) {
    writeHttpResponse(clientSocket, 401, 'Unauthorized', { error: 'Unauthorized' }, {
      'WWW-Authenticate': 'Bearer realm="vis_bridge"',
    });
    return;
  }

  let secWebSocketKey;
  try {
    secWebSocketKey = assertWebSocketRequest(request);
  } catch (error) {
    writeHttpResponse(clientSocket, 400, 'Bad Request', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const upstream = await connectUpstreamWebSocket(options.target, options.upstreamAuthorization);
    clientSocket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createWebSocketAccept(secWebSocketKey)}`,
      '',
      '',
    ].join('\r\n'));

    if (head.length > 0) upstream.socket.write(head);
    if (upstream.head.length > 0) clientSocket.write(upstream.head);

    clientSocket.pipe(upstream.socket);
    upstream.socket.pipe(clientSocket);
    clientSocket.on('error', () => upstream.socket.destroy());
    upstream.socket.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.socket.destroy());
    upstream.socket.on('close', () => clientSocket.destroy());
  } catch (error) {
    writeHttpResponse(clientSocket, 502, 'Bad Gateway', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeCorsHeaders(response, statusCode, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  };
  response.writeHead(statusCode, headers);
}

export function createVisBridgeServer(options) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'OPTIONS') {
      writeCorsHeaders(response, 204);
      response.end();
      return;
    }

    if (requestUrl.pathname === '/homedir') {
      writeCorsHeaders(response, 200);
      response.end(JSON.stringify({ home: homedir() }));
      return;
    }

    if (requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz') {
      writeCorsHeaders(response, 200);
      response.end(JSON.stringify({ ok: true, service: 'vis_bridge' }));
      return;
    }

    writeCorsHeaders(response, 200);
    response.end(JSON.stringify({
      service: 'vis_bridge',
      websocketPath: options.path,
      target: options.target,
      bridgeAuth: Boolean(options.bridgeToken),
      upstreamAuth: Boolean(options.upstreamAuthorization),
    }));
  });

  server.on('upgrade', (request, socket, head) => {
    void proxyWebSocket(request, socket, head, options);
  });

  return server;
}

export function main() {
  const options = parseCliOptions();
  if (options.help) {
    console.log(usage());
    return;
  }

  const server = createVisBridgeServer(options);
  server.listen(options.port, options.host, () => {
    console.log(`vis_bridge listening on ws://${options.host}:${options.port}${options.path}`);
    console.log(`vis_bridge proxy target: ${options.target}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1]?.endsWith('vis_bridge.js')) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
