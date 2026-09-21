import { request as httpRequest } from 'node:http';
import { writeCorsHeaders } from './bridgeHttp.js';
import { createKimiWebTokenProvider } from './kimiWebToken.js';

export const KIMI_WEB_PROXY_PREFIX = '/kimi-web/';
export const KIMI_WEB_UPSTREAM_ORIGIN = 'http://127.0.0.1:58627';

export const KIMI_WEB_PROXY_PATH = 'KIMI_WEB_PROXY_PATH';
export const KIMI_WEB_TOKEN_UNAVAILABLE = 'KIMI_WEB_TOKEN_UNAVAILABLE';
export const KIMI_WEB_UPSTREAM_TIMEOUT = 'KIMI_WEB_UPSTREAM_TIMEOUT';
export const KIMI_WEB_UPSTREAM_UNREACHABLE = 'KIMI_WEB_UPSTREAM_UNREACHABLE';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

// Hop-by-hop headers (RFC 7230 section 6.1) are scoped to one connection and
// must never be forwarded by a proxy; Node regenerates its own on both hops.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// The client authenticates against the bridge, not against kimi web: its
// `authorization` carries the bridge credential, `origin` is a browser
// artifact that kimi web rejects, and `host` must describe the upstream
// socket so kimi's DNS-rebinding check sees the loopback authority.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'authorization',
  ...HOP_BY_HOP_HEADERS,
]);

const BODYLESS_STATUS_CODES = new Set([204, 205, 304]);

function canonicalHeaderName(lowerCaseName) {
  return lowerCaseName
    .split('-')
    .map((segment) => (segment ? `${segment[0].toUpperCase()}${segment.slice(1)}` : segment))
    .join('-');
}

function rewriteUpstreamTarget(requestUrl) {
  const url = new URL(requestUrl ?? '/', 'http://localhost');
  if (url.pathname === '/kimi-web') return { path: '/', search: url.search };
  if (!url.pathname.startsWith(KIMI_WEB_PROXY_PREFIX)) return null;
  return {
    path: `/${url.pathname.slice(KIMI_WEB_PROXY_PREFIX.length)}`,
    search: url.search,
  };
}

function buildUpstreamHeaders(requestHeaders, authorization) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  if (typeof authorization === 'string' && authorization.trim()) {
    headers.authorization = authorization;
  }
  return headers;
}

function buildDownstreamHeaders(upstreamHeaders, statusCode) {
  const bodyless = BODYLESS_STATUS_CODES.has(statusCode);
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // The bridge owns downstream CORS: kimi only reflects loopback origins,
    // and forwarding its `Access-Control-*` values would break Pages clients.
    if (lower.startsWith('access-control-')) continue;
    if (bodyless && lower === 'content-length') continue;
    // Node ignores a later case-variant duplicate in a writeHead object, so
    // canonicalize names to let content headers override writeCorsHeaders's
    // JSON default instead of silently losing to it.
    headers[canonicalHeaderName(lower)] = value;
  }
  return headers;
}

function resolveAuthorizationGetter(options) {
  if (typeof options.getUpstreamAuthorization === 'function') {
    return options.getUpstreamAuthorization;
  }
  if (options.tokenProvider && typeof options.tokenProvider.getAuthorization === 'function') {
    return () => options.tokenProvider.getAuthorization();
  }
  const provider = createKimiWebTokenProvider({ tokenPath: options.tokenPath });
  return () => provider.getAuthorization();
}

function errorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code) {
    return error.code;
  }
  return undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// `writeHttpResponse` from bridgeHttp.js writes raw sockets and is reserved
// for upgrade-reject paths; ServerResponse errors must go through
// `writeCorsHeaders` so Pages cross-origin clients can read them.
function writeLocalError(response, statusCode, code, message) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  writeCorsHeaders(response, statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: message, code }));
}

/**
 * Streams one kimi web REST request/response over the bridge.
 *
 * The local `/kimi-web/` prefix is rewritten onto the kimi web loopback
 * origin, the bridge's own CORS headers are layered over the upstream content
 * headers, and both bodies are piped byte-for-byte. Status codes and kimi's
 * `{code,msg,data,request_id}` envelopes are never interpreted here.
 */
export function proxyKimiWebHttp(request, response, options = {}) {
  const target = rewriteUpstreamTarget(request.url);
  if (!target) {
    writeLocalError(
      response,
      404,
      KIMI_WEB_PROXY_PATH,
      `Kimi web proxy only serves ${KIMI_WEB_PROXY_PREFIX}`,
    );
    return;
  }

  let authorization;
  try {
    authorization = resolveAuthorizationGetter(options)();
  } catch (error) {
    writeLocalError(
      response,
      502,
      errorCode(error) ?? KIMI_WEB_TOKEN_UNAVAILABLE,
      `Kimi web upstream credentials unavailable: ${errorMessage(error)}`,
    );
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(
      `${target.path}${target.search}`,
      options.upstreamOrigin ?? KIMI_WEB_UPSTREAM_ORIGIN,
    );
  } catch (error) {
    writeLocalError(
      response,
      502,
      KIMI_WEB_UPSTREAM_UNREACHABLE,
      `Invalid kimi web upstream origin: ${errorMessage(error)}`,
    );
    return;
  }
  if (upstreamUrl.protocol !== 'http:') {
    writeLocalError(
      response,
      502,
      KIMI_WEB_UPSTREAM_UNREACHABLE,
      `Unsupported kimi web upstream protocol: ${upstreamUrl.protocol}`,
    );
    return;
  }

  const upstreamRequest = httpRequest({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 80,
    method: request.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: buildUpstreamHeaders(request.headers, authorization),
  });

  // `responseStarted` also doubles as the "single settle" latch for the
  // upstream request, so a late error after headers cannot write a 502 over
  // an already-started body.
  let responseStarted = false;
  let timedOut = false;

  // Bounds only the wait for upstream response headers. Once the body is
  // streaming there is deliberately no idle timeout, so long downloads are
  // not severed between chunks.
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    timedOut = true;
    upstreamRequest.destroy(new Error('Kimi web upstream did not respond in time.'));
  }, timeoutMs);
  timeout.unref?.();

  const stopTimeout = () => clearTimeout(timeout);

  upstreamRequest.on('response', (upstreamResponse) => {
    stopTimeout();
    responseStarted = true;
    const statusCode = upstreamResponse.statusCode ?? 502;
    try {
      writeCorsHeaders(response, statusCode, buildDownstreamHeaders(upstreamResponse.headers, statusCode));
    } catch {
      upstreamResponse.destroy();
      response.destroy();
      return;
    }
    upstreamResponse.on('error', () => response.destroy());
    response.on('close', () => {
      if (!response.writableEnded) upstreamResponse.destroy();
    });
    upstreamResponse.pipe(response);
  });

  upstreamRequest.on('error', (error) => {
    stopTimeout();
    if (responseStarted) {
      response.destroy();
      return;
    }
    responseStarted = true;
    writeLocalError(
      response,
      502,
      timedOut ? KIMI_WEB_UPSTREAM_TIMEOUT : KIMI_WEB_UPSTREAM_UNREACHABLE,
      `Kimi web upstream request failed: ${errorMessage(error)}`,
    );
  });

  response.on('close', () => {
    stopTimeout();
    if (!responseStarted) {
      responseStarted = true;
      upstreamRequest.destroy();
    }
  });

  request.on('error', () => upstreamRequest.destroy());
  request.on('close', () => {
    if (!request.readableEnded) upstreamRequest.destroy();
  });

  request.pipe(upstreamRequest);
}
