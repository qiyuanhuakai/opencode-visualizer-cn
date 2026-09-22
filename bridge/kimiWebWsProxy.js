import {
  assertWebSocketRequest,
  isAllowedOrigin,
  isAuthorized,
  rejectUnprotectedBridgeControlUpgrade,
  requiresPtyToken,
  writeHttpResponse,
} from './bridgeHttp.js';
import { connectUpstreamWebSocket } from './codexWebSocketProxy.js';
import { createWebSocketAccept } from './webSocketFrames.js';

export const KIMI_WEB_WS_PATH = '/kimi-web/ws';
export const KIMI_WEB_WS_TARGET = 'ws://127.0.0.1:58627/api/v1/ws';

const UPSTREAM_UNAVAILABLE_ERROR = 'Kimi web WebSocket upstream is unavailable.';

async function relayToUpstream(clientSocket, head, secWebSocketKey, options) {
  try {
    const upstream = await connectUpstreamWebSocket(
      options.target ?? KIMI_WEB_WS_TARGET,
      options.getUpstreamAuthorization,
      { handshakeTimeoutMs: options.handshakeTimeoutMs },
    );
    if (clientSocket.destroyed) {
      upstream.socket.destroy();
      return;
    }
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
  } catch {
    if (!clientSocket.destroyed) {
      // The browser cannot read this body; it never claims a successful
      // upgrade and never relays the upstream's own HTTP status.
      writeHttpResponse(clientSocket, 502, 'Bad Gateway', { error: UPSTREAM_UNAVAILABLE_ERROR });
    }
  }
}

// false = path not ours, the bridge upgrade chain keeps falling through.
export function handleKimiWebUpgrade(request, socket, head, options = {}) {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (requestPath !== KIMI_WEB_WS_PATH) return false;

  if (requiresPtyToken(options)) {
    rejectUnprotectedBridgeControlUpgrade(socket);
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
  try {
    secWebSocketKey = assertWebSocketRequest(request);
  } catch (error) {
    writeHttpResponse(socket, 400, 'Bad Request', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  void relayToUpstream(socket, head ?? Buffer.alloc(0), secWebSocketKey, options);
  return true;
}
