import { randomBytes } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createWebSocketAccept } from './webSocketFrames.js';
import {
  assertWebSocketRequest,
  isAllowedOrigin,
  isAuthorized,
  writeHttpResponse,
} from './bridgeHttp.js';

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

export async function proxyWebSocket(request, clientSocket, head, options) {
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
