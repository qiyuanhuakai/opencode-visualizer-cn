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

export const DSH_WS_PATH = '/dsh/ws';
export const DSH_WS_TARGET = 'ws://127.0.0.1:3080/api/remote.mux';

const UPSTREAM_UNAVAILABLE_ERROR = 'DSH WebSocket upstream is unavailable.';

/**
 * Bridges the browser's `/dsh/ws` WebSocket to the dsh web mux endpoint
 * `ws://127.0.0.1:3080/api/remote.mux` (docs/dsh.md §6).
 *
 * dsh fences the upgrade exactly like `/api`: loopback Host plus its session
 * cookie, and it 401s cross-site mux attempts. vis_bridge satisfies that fence
 * as a non-browser client, so this proxy:
 *
 *   - authenticates the browser with the bridge token only
 *     (`isAllowedOrigin` + `isAuthorized`, `?token=` accepted);
 *   - resolves the dsh session cookie per dial through the injected
 *     `options.getUpstreamCookie()` (bridge/dshAuth.js: async exchange via
 *     `getCookie(authority)`), so a rotated/re-exchanged credential is used by
 *     the NEXT connection while an expired one never reaches the upstream;
 *   - never constructs an upstream Origin header (the bridge dials as a
 *     server-side client, not a browser);
 *   - relays pure bytes after the 101: mux `open`/`item`/`end` frames pass
 *     through untouched and no frame is ever parsed or rewritten here.
 *
 * The upstream handshake is built entirely by `connectUpstreamWebSocket`
 * (Host/Upgrade/Connection/Sec-WebSocket-Key/Cookie only) — no browser header
 * of any kind is forwarded, and no subprotocol is echoed back to the browser.
 */
async function relayToUpstream(clientSocket, head, secWebSocketKey, options) {
  try {
    // Resolved per dial and never dialed without a resolved cookie: a typed
    // DshAuthError from bridge/dshAuth.js (DSH_COOKIE_MISSING /
    // DSH_AUTH_EXCHANGE_FAILED) fails here, before any upstream socket opens.
    const cookie = typeof options.getUpstreamCookie === 'function'
      ? await options.getUpstreamCookie()
      : undefined;
    if (typeof cookie !== 'string' || cookie.trim() === '') {
      throw new Error('DSH upstream cookie is unavailable.');
    }
    const upstream = await connectUpstreamWebSocket(
      options.target ?? DSH_WS_TARGET,
      { cookie },
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
export function handleDshUpgrade(request, socket, head, options = {}) {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (requestPath !== DSH_WS_PATH) return false;

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
