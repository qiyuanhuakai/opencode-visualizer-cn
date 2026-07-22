#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  createRawWebSocketPeer,
  createWebSocketAccept,
  decodeWebSocketFrames,
  encodeWebSocketFrame,
} from './bridge/webSocketFrames.js';
import { createBridgeConfigStore } from './bridge/bridgeConfig.js';
import { createBridgeRuntime } from './bridge/bridgeRuntime.js';
import { runWorkspaceCommand } from './bridge/workspaceCommand.js';
import { createWorkspaceFsManager } from './bridge/workspaceFs.js';
import { loadAcpSessionTurnMeta } from './bridge/acpSessionMeta.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 23004;
const DEFAULT_PATH = '/codex';
const DEFAULT_CODEX_WS_URL = 'ws://127.0.0.1:4500';

function usage() {
  return `vis_bridge - local supervisor and protocol bridge for OpenCode, Codex, and ACP agents

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
  --config             Bridge supervisor config path.
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
  VIS_BRIDGE_CONFIG                 Same as --config.
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
      config: { type: 'string' },
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
    configPath: values.config ?? env.VIS_BRIDGE_CONFIG,
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
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Connection: close',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(responseBody)}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      responseBody,
    ].join('\r\n'),
  );
  socket.destroy();
}

function isAuthorized(request, bridgeToken) {
  if (!bridgeToken) return true;
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${bridgeToken}`) return true;

  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  return (
    requestUrl.searchParams.get('token') === bridgeToken ||
    requestUrl.searchParams.get('bridgeToken') === bridgeToken
  );
}

function isLoopbackHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function isWildcardHost(hostname) {
  return hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]';
}

const TOKENLESS_VIS_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
  'http://127.0.0.1:23003',
  'http://localhost:23003',
  'http://[::1]:23003',
]);

function isAllowedOrigin(origin, bridgeToken) {
  if (!origin) return true;
  if (bridgeToken) return true;
  try {
    return TOKENLESS_VIS_ORIGINS.has(new URL(origin).origin);
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
    writeHttpResponse(clientSocket, 404, 'Not Found', {
      error: `Use WebSocket path ${options.path}`,
    });
    return;
  }

  if (!isAllowedOrigin(request.headers.origin, options.bridgeToken)) {
    writeHttpResponse(clientSocket, 403, 'Forbidden', { error: 'Forbidden origin' });
    return;
  }

  if (!isAuthorized(request, options.bridgeToken)) {
    writeHttpResponse(
      clientSocket,
      401,
      'Unauthorized',
      { error: 'Unauthorized' },
      {
        'WWW-Authenticate': 'Bearer realm="vis_bridge"',
      },
    );
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
    clientSocket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createWebSocketAccept(secWebSocketKey)}`,
        '',
        '',
      ].join('\r\n'),
    );

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  };
  response.writeHead(statusCode, headers);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function loadNodePty(ptyModule) {
  if (ptyModule) return ptyModule;
  try {
    const runtimeImport = new Function('specifier', 'return import(specifier)');
    return await runtimeImport('node-pty');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PTY support requires the optional node-pty package: ${message}`);
  }
}

function defaultPtyShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || 'bash';
}

function normalizePtyCwd(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : homedir();
}

const PTY_BUFFER_LIMIT = 2 * 1024 * 1024;
const PTY_EXIT_GRACE_MS = 1500;

function encodePtyMetaFrame(meta) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(meta), 'utf8')]);
  return encodeWebSocketFrame(payload, 2);
}

function trimPtyBuffer(buffer) {
  if (buffer.length <= PTY_BUFFER_LIMIT) return buffer;
  return buffer.slice(buffer.length - PTY_BUFFER_LIMIT);
}

function createPtyManager(options = {}) {
  const sessions = new Map();

  function scheduleCleanup(session, delay = PTY_EXIT_GRACE_MS) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      if (sessions.get(session.id) !== session) return;
      sessions.delete(session.id);
    }, delay);
  }

  function appendOutput(session, data) {
    const chunk = String(data);
    session.buffer = trimPtyBuffer(session.buffer + chunk);
    for (const socket of session.sockets) {
      if (socket.destroyed) continue;
      socket.write(encodeWebSocketFrame(chunk, 1));
    }
  }

  function sendExitToSocket(session, socket) {
    if (socket.destroyed) return;
    if (typeof session.exitCode === 'number') {
      socket.write(encodePtyMetaFrame({ exitCode: session.exitCode }));
    }
    socket.end(encodeWebSocketFrame(Buffer.alloc(0), 8));
  }

  async function create(payload = {}) {
    const nodePty = await loadNodePty(options.ptyModule);
    const id = randomBytes(16).toString('hex');
    const command =
      typeof payload.command === 'string' && payload.command.trim()
        ? payload.command.trim()
        : defaultPtyShell();
    const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
    const ptyProcess = nodePty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: normalizePtyCwd(payload.cwd || payload.directory),
      env: process.env,
    });
    const session = {
      id,
      command,
      args,
      cwd: normalizePtyCwd(payload.cwd || payload.directory),
      title: typeof payload.title === 'string' ? payload.title : undefined,
      createdAt: Date.now(),
      pty: ptyProcess,
      sockets: new Set(),
      buffer: '',
      status: 'running',
      exitCode: undefined,
      cleanupTimer: undefined,
      disposed: false,
    };
    sessions.set(id, session);
    ptyProcess.onData?.((data) => {
      appendOutput(session, data);
    });
    ptyProcess.onExit?.((event = {}) => {
      session.disposed = true;
      session.status = 'exited';
      if (typeof event.exitCode === 'number') session.exitCode = event.exitCode;
      for (const socket of session.sockets) {
        try {
          sendExitToSocket(session, socket);
        } catch {}
      }
      scheduleCleanup(session);
    });
    return { id };
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      id: session.id,
      command: session.command,
      args: session.args,
      cwd: session.cwd,
      title: session.title,
      status: session.status,
      ...(typeof session.exitCode === 'number' ? { exitCode: session.exitCode } : {}),
      createdAt: session.createdAt,
    }));
  }

  function resize(id, rows, cols) {
    const session = sessions.get(id);
    if (!session) return false;
    session.pty.resize(Number(cols) || 80, Number(rows) || 24);
    return true;
  }

  function remove(id) {
    const session = sessions.get(id);
    if (!session) return false;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    sessions.delete(id);
    session.disposed = true;
    for (const socket of session.sockets) socket.destroy();
    try {
      session.pty.kill();
    } catch {}
    return true;
  }

  function disposeAll() {
    for (const id of sessions.keys()) remove(id);
  }

  function attach(id, socket, head) {
    const session = sessions.get(id);
    if (!session) return false;
    let buffer = Buffer.alloc(0);
    session.sockets.add(socket);
    if (session.buffer) {
      socket.write(encodeWebSocketFrame(session.buffer, 1));
    }
    const detach = () => {
      session.sockets.delete(socket);
    };
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeWebSocketFrames(buffer);
        buffer = decoded.remaining;
        for (const frame of decoded.frames) {
          if (frame.opcode === 8) {
            socket.end(encodeWebSocketFrame(Buffer.alloc(0), 8));
            return;
          }
          if (frame.opcode === 9) {
            socket.write(encodeWebSocketFrame(frame.payload, 10));
            continue;
          }
          if (frame.opcode === 1 || frame.opcode === 2)
            session.pty.write(frame.payload.toString('utf8'));
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once('close', detach);
    socket.once('error', detach);
    if (head.length > 0) socket.emit('data', head);
    if (session.status === 'exited') {
      sendExitToSocket(session, socket);
      scheduleCleanup(session, 100);
    }
    return true;
  }

  return { create, list, resize, remove, disposeAll, attach };
}

async function handlePtyHttpRequest(request, response, requestUrl, manager) {
  try {
    if (requestUrl.pathname === '/pty' && request.method === 'GET') {
      writeJsonHttpResponse(response, 200, manager.list());
      return true;
    }
    if (requestUrl.pathname === '/pty' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const result = await manager.create(payload);
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    const match = requestUrl.pathname.match(/^\/pty\/([^/]+)$/u);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    if (request.method === 'PUT') {
      const payload = await readJsonBody(request);
      const ok = manager.resize(
        id,
        payload?.size?.rows ?? payload?.rows,
        payload?.size?.cols ?? payload?.cols,
      );
      writeJsonHttpResponse(response, ok ? 200 : 404, ok ? {} : { error: 'PTY not found.' });
      return true;
    }
    if (request.method === 'DELETE') {
      const ok = manager.remove(id);
      writeJsonHttpResponse(response, ok ? 200 : 404, ok ? {} : { error: 'PTY not found.' });
      return true;
    }
    return false;
  } catch (error) {
    writeJsonHttpResponse(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function handleFsHttpRequest(request, response, requestUrl, manager) {
  try {
    if (requestUrl.pathname === '/fs/capabilities' && request.method === 'GET') {
      const result = await manager.getCapabilities(requestUrl.searchParams.get('root'));
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === '/fs/list' && request.method === 'GET') {
      const result = await manager.listDirectory(
        requestUrl.searchParams.get('path'),
        requestUrl.searchParams.get('root'),
      );
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === '/fs/readFile' && request.method === 'GET') {
      const result = await manager.readFile(
        requestUrl.searchParams.get('path'),
        requestUrl.searchParams.get('root'),
      );
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    if (requestUrl.pathname === '/fs/writeFile' && request.method === 'POST') {
      const payload = await readJsonBody(request);
      const result = await manager.writeFile(payload?.path, payload?.root, payload?.content);
      writeJsonHttpResponse(response, 200, result);
      return true;
    }
    return false;
  } catch (error) {
    writeJsonHttpResponse(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

function requiresPtyToken(options) {
  const host = String(options.host ?? DEFAULT_HOST).trim();
  return Boolean(
    !options.bridgeToken &&
    (!host || (!isLoopbackHostname(host) && (isWildcardHost(host) || host !== 'localhost'))),
  );
}

function requiresFsToken(options) {
  return requiresPtyToken(options);
}

const BRIDGE_CONTROL_TOKEN_ERROR =
  'Bridge control requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.';

function rejectUnprotectedBridgeControlHttp(response) {
  writeJsonHttpResponse(response, 403, { error: BRIDGE_CONTROL_TOKEN_ERROR });
}

function rejectUnprotectedBridgeControlUpgrade(socket) {
  writeHttpResponse(socket, 403, 'Forbidden', { error: BRIDGE_CONTROL_TOKEN_ERROR });
}

function rejectUnprotectedPtyHttp(response) {
  writeJsonHttpResponse(response, 403, {
    error: 'PTY requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
  });
}

function rejectUnprotectedPtySocket(socket) {
  writeHttpResponse(socket, 403, 'Forbidden', {
    error: 'PTY requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
  });
}

function rejectUnprotectedFsHttp(response) {
  writeJsonHttpResponse(response, 403, {
    error: 'FS requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
  });
}

function handlePtyUpgrade(request, clientSocket, head, options, manager) {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const match = requestUrl.pathname.match(/^\/pty\/([^/]+)\/connect$/u);
  if (!match) return false;
  if (requiresPtyToken(options)) {
    rejectUnprotectedPtySocket(clientSocket);
    return true;
  }
  if (!isAllowedOrigin(request.headers.origin, options.bridgeToken)) {
    writeHttpResponse(clientSocket, 403, 'Forbidden', { error: 'Forbidden origin' });
    return true;
  }
  if (!isAuthorized(request, options.bridgeToken)) {
    writeHttpResponse(
      clientSocket,
      401,
      'Unauthorized',
      { error: 'Unauthorized' },
      {
        'WWW-Authenticate': 'Bearer realm="vis_bridge"',
      },
    );
    return true;
  }
  let secWebSocketKey;
  try {
    secWebSocketKey = assertWebSocketRequest(request);
  } catch (error) {
    writeHttpResponse(clientSocket, 400, 'Bad Request', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  const id = decodeURIComponent(match[1]);
  clientSocket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createWebSocketAccept(secWebSocketKey)}`,
      '',
      '',
    ].join('\r\n'),
  );
  if (!manager.attach(id, clientSocket, head)) {
    clientSocket.destroy();
  }
  return true;
}

function writeJsonHttpResponse(response, statusCode, body, extraHeaders = {}) {
  writeCorsHeaders(response, statusCode, extraHeaders);
  response.end(JSON.stringify(body));
}

function authorizeHttpRequest(request, response, bridgeToken) {
  if (!isAllowedOrigin(request.headers.origin, bridgeToken)) {
    writeJsonHttpResponse(response, 403, { error: 'Forbidden origin' });
    return false;
  }

  if (!isAuthorized(request, bridgeToken)) {
    writeJsonHttpResponse(
      response,
      401,
      { error: 'Unauthorized' },
      {
        'WWW-Authenticate': 'Bearer realm="vis_bridge"',
      },
    );
    return false;
  }

  return true;
}

async function handleSupervisorHttpRequest(request, response, requestUrl, runtime) {
  if (requestUrl.pathname === '/api/v1/supervisor' && request.method === 'GET') {
    writeJsonHttpResponse(response, 200, runtime.getStatus());
    return true;
  }
  if (requestUrl.pathname === '/api/v1/agents' && request.method === 'GET') {
    writeJsonHttpResponse(response, 200, await runtime.listAgents());
    return true;
  }
  if (requestUrl.pathname === '/api/v1/agents' && request.method === 'POST') {
    const agent = await runtime.upsertAgent(await readJsonBody(request));
    writeJsonHttpResponse(response, 201, agent);
    return true;
  }
  const sessionMetaMatch = requestUrl.pathname.match(
    /^\/api\/v1\/agents\/([^/]+)\/session-meta\/([^/]+)$/u,
  );
  if (sessionMetaMatch && request.method === 'GET') {
    const meta = await loadAcpSessionTurnMeta(
      decodeURIComponent(sessionMetaMatch[1]),
      decodeURIComponent(sessionMetaMatch[2]),
    );
    writeJsonHttpResponse(response, meta ? 200 : 404, meta ?? { error: 'ACP session meta unavailable.' });
    return true;
  }
  const match = requestUrl.pathname.match(/^\/api\/v1\/agents\/([^/]+)$/u);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  if (request.method === 'PUT') {
    const agent = await runtime.updateAgent(id, await readJsonBody(request));
    writeJsonHttpResponse(response, agent ? 200 : 404, agent ?? { error: 'ACP agent not found.' });
    return true;
  }
  if (request.method === 'DELETE') {
    const removed = await runtime.removeAgent(id);
    writeJsonHttpResponse(
      response,
      removed ? 200 : 404,
      removed ? { removed: true } : { error: 'ACP agent not found.' },
    );
    return true;
  }
  return false;
}

function handleAcpUpgrade(request, socket, head, options) {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  const match = requestPath.match(/^\/acp\/([^/]+)$/u);
  if (!match) return false;
  if (requiresPtyToken(options)) {
    rejectUnprotectedBridgeControlUpgrade(socket);
    return true;
  }
  if (!options.runtime) {
    writeHttpResponse(socket, 503, 'Service Unavailable', {
      error: 'ACP supervisor is unavailable.',
    });
    return true;
  }
  if (!isAllowedOrigin(request.headers.origin, options.bridgeToken)) {
    writeHttpResponse(socket, 403, 'Forbidden', { error: 'Forbidden origin' });
    return true;
  }
  if (!isAuthorized(request, options.bridgeToken)) {
    writeHttpResponse(
      socket,
      401,
      'Unauthorized',
      { error: 'Unauthorized' },
      {
        'WWW-Authenticate': 'Bearer realm="vis_bridge"',
      },
    );
    return true;
  }
  let secWebSocketKey;
  let id;
  try {
    secWebSocketKey = assertWebSocketRequest(request);
    id = decodeURIComponent(match[1]);
  } catch (error) {
    writeHttpResponse(socket, 400, 'Bad Request', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  const status = options.runtime.getStatus().acpAgents.find((agent) => agent.id === id);
  if (!status) {
    writeHttpResponse(socket, 404, 'Not Found', { error: `ACP agent not found: ${id}.` });
    return true;
  }
  if (status.state !== 'running' || status.connected) {
    writeHttpResponse(socket, 409, 'Conflict', { error: `ACP agent is not available: ${id}.` });
    return true;
  }
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createWebSocketAccept(secWebSocketKey)}`,
      '',
      '',
    ].join('\r\n'),
  );
  const peer = createRawWebSocketPeer(socket, head, { heartbeatIntervalMs: 5_000 });
  try {
    options.runtime.attachAgent(id, peer);
  } catch (error) {
    peer.close(1013, error instanceof Error ? error.message : String(error));
  }
  return true;
}

export function createVisBridgeServer(options) {
  const bridgeOptions = { host: DEFAULT_HOST, ...options };
  const ptyManager = createPtyManager(bridgeOptions);
  const fsManager = createWorkspaceFsManager();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'OPTIONS') {
      writeCorsHeaders(response, 204);
      response.end();
      return;
    }

    if (requestUrl.pathname === '/homedir') {
      if (!authorizeHttpRequest(request, response, options.bridgeToken)) return;
      writeJsonHttpResponse(response, 200, { home: homedir() });
      return;
    }

    if (requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz') {
      if (!authorizeHttpRequest(request, response, options.bridgeToken)) return;
      writeJsonHttpResponse(response, 200, { ok: true, service: 'vis_bridge' });
      return;
    }

    if (requestUrl.pathname === '/pty' || requestUrl.pathname.startsWith('/pty/')) {
      if (requiresPtyToken(bridgeOptions)) {
        rejectUnprotectedPtyHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      void handlePtyHttpRequest(request, response, requestUrl, ptyManager).then((handled) => {
        if (!handled) writeJsonHttpResponse(response, 404, { error: 'Not found' });
      });
      return;
    }

    if (
      requestUrl.pathname === '/fs/capabilities' ||
      requestUrl.pathname === '/fs/list' ||
      requestUrl.pathname === '/fs/readFile' ||
      requestUrl.pathname === '/fs/writeFile'
    ) {
      if (requiresFsToken(bridgeOptions)) {
        rejectUnprotectedFsHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      void handleFsHttpRequest(request, response, requestUrl, fsManager).then((handled) => {
        if (!handled) writeJsonHttpResponse(response, 404, { error: 'Not found' });
      });
      return;
    }

    if (requestUrl.pathname === '/command/exec') {
      if (requiresPtyToken(bridgeOptions)) {
        rejectUnprotectedBridgeControlHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      if (request.method !== 'POST') {
        writeJsonHttpResponse(response, 405, { error: 'Method not allowed' });
        return;
      }
      void readJsonBody(request)
        .then((payload) => runWorkspaceCommand(payload))
        .then((result) => writeJsonHttpResponse(response, 200, result))
        .catch((error) =>
          writeJsonHttpResponse(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }

    if (requestUrl.pathname.startsWith('/api/v1/')) {
      if (requiresPtyToken(bridgeOptions)) {
        rejectUnprotectedBridgeControlHttp(response);
        return;
      }
      if (!authorizeHttpRequest(request, response, bridgeOptions.bridgeToken)) return;
      if (!bridgeOptions.runtime) {
        writeJsonHttpResponse(response, 503, { error: 'Bridge supervisor is unavailable.' });
        return;
      }
      void handleSupervisorHttpRequest(
        request,
        response,
        requestUrl,
        bridgeOptions.runtime,
      )
        .then((handled) => {
          if (!handled) writeJsonHttpResponse(response, 404, { error: 'Not found' });
        })
        .catch((error) => {
          writeJsonHttpResponse(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (!authorizeHttpRequest(request, response, options.bridgeToken)) return;
    writeJsonHttpResponse(response, 200, {
      service: 'vis_bridge',
      websocketPath: options.path,
      target: options.target,
      bridgeAuth: Boolean(options.bridgeToken),
      upstreamAuth: Boolean(options.upstreamAuthorization),
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (handlePtyUpgrade(request, socket, head, bridgeOptions, ptyManager)) return;
    if (handleAcpUpgrade(request, socket, head, bridgeOptions)) return;
    if (requiresPtyToken(bridgeOptions)) {
      rejectUnprotectedBridgeControlUpgrade(socket);
      return;
    }
    void proxyWebSocket(request, socket, head, bridgeOptions);
  });

  server.on('close', () => {
    ptyManager.disposeAll();
    void bridgeOptions.runtime?.stop();
  });

  return server;
}

export function main() {
  const options = parseCliOptions();
  if (options.help) {
    console.log(usage());
    return;
  }

  const configStore = createBridgeConfigStore({ configPath: options.configPath });
  const runtime = createBridgeRuntime({ configStore });
  const server = createVisBridgeServer({ ...options, runtime });
  void runtime.start().catch((error) => {
    console.error(
      `vis_bridge supervisor failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  server.listen(options.port, options.host, () => {
    console.log(`vis_bridge listening on ws://${options.host}:${options.port}${options.path}`);
    console.log(`vis_bridge proxy target: ${options.target}`);
  });

  const shutdown = async () => {
    await runtime.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

if (process.argv[1]?.endsWith('vis_bridge.js')) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
