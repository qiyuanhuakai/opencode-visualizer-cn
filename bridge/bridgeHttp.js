const DEFAULT_HOST = '127.0.0.1';

export function writeHttpResponse(socket, statusCode, statusText, body, headers = {}) {
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

export function isAuthorized(request, bridgeToken) {
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
  'app://index.html',
  'https://qiyuanhuakai.github.io',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://[::1]:5173',
  'http://127.0.0.1:23003',
  'http://localhost:23003',
  'http://[::1]:23003',
]);

export function isAllowedOrigin(origin, bridgeToken) {
  if (!origin) return true;
  if (bridgeToken) return true;
  if (TOKENLESS_VIS_ORIGINS.has(origin)) return true;
  try {
    return TOKENLESS_VIS_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function assertWebSocketRequest(request) {
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

export function writeCorsHeaders(response, statusCode, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  };
  response.writeHead(statusCode, headers);
}

export function writeJsonHttpResponse(response, statusCode, body, extraHeaders = {}) {
  writeCorsHeaders(response, statusCode, extraHeaders);
  response.end(JSON.stringify(body));
}

export function authorizeHttpRequest(request, response, bridgeToken) {
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

export function requiresPtyToken(options) {
  const host = String(options.host ?? DEFAULT_HOST).trim();
  return Boolean(
    !options.bridgeToken &&
    (!host || (!isLoopbackHostname(host) && (isWildcardHost(host) || host !== 'localhost'))),
  );
}

export function requiresFsToken(options) {
  return requiresPtyToken(options);
}

const BRIDGE_CONTROL_TOKEN_ERROR =
  'Bridge control requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.';

export function rejectUnprotectedBridgeControlHttp(response) {
  writeJsonHttpResponse(response, 403, { error: BRIDGE_CONTROL_TOKEN_ERROR });
}

export function rejectUnprotectedBridgeControlUpgrade(socket) {
  writeHttpResponse(socket, 403, 'Forbidden', { error: BRIDGE_CONTROL_TOKEN_ERROR });
}

export function rejectUnprotectedPtyHttp(response) {
  writeJsonHttpResponse(response, 403, {
    error: 'PTY requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
  });
}

export function rejectUnprotectedPtySocket(socket) {
  writeHttpResponse(socket, 403, 'Forbidden', {
    error: 'PTY requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
  });
}

export function rejectUnprotectedFsHttp(response) {
  writeJsonHttpResponse(response, 403, {
    error: 'FS requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.',
  });
}
