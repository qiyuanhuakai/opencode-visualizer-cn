import { createRawWebSocketPeer, createWebSocketAccept } from './webSocketFrames.js';
import {
  assertWebSocketRequest,
  isAllowedOrigin,
  isAuthorized,
  rejectUnprotectedBridgeControlUpgrade,
  rejectUnprotectedPtySocket,
  requiresPtyToken,
  writeHttpResponse,
} from './bridgeHttp.js';

export function handlePtyUpgrade(request, clientSocket, head, options, manager) {
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

export function handleAcpUpgrade(request, socket, head, options) {
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
