import { request as httpRequest } from 'node:http';
import { writeCorsHeaders } from './bridgeHttp.js';

export const DSH_HTTP_PROXY_PREFIX = '/dsh/';
export const DSH_HTTP_UPSTREAM_ORIGIN = 'http://127.0.0.1:3080';

export const DSH_HTTP_PROXY_PATH = 'DSH_HTTP_PROXY_PATH';
export const DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE = 'DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE';
export const DSH_HTTP_UPSTREAM_TIMEOUT = 'DSH_HTTP_UPSTREAM_TIMEOUT';
export const DSH_HTTP_UPSTREAM_UNREACHABLE = 'DSH_HTTP_UPSTREAM_UNREACHABLE';

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

// The browser authenticates against the bridge, not against dsh, and dsh's
// /api fence (docs/dsh.md 4.2) rejects wrong authorities: `authorization`
// carries the bridge credential, `origin` fails the same-origin check, the
// client `host` must be replaced by the loopback target, `cookie` must only
// carry the injected authority cookie, and `sec-fetch-site: cross-site` (the
// Fetch Metadata a Pages downlink would send) is refused outright.
// The upstream Host is deliberately NOT suppressed here in spirit: the request
// object passes no `host`, so the Node HTTP client generates one for the
// `127.0.0.1:3080` target, satisfying dsh's loopback authority check.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'authorization',
  'cookie',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  ...HOP_BY_HOP_HEADERS,
]);

// The upstream auth cookie is a bridge-held credential and must never be
// handed to the browser: the cookie provider re-injects it per authority on
// the next uplink instead of a client-side store.
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie']);

const BODYLESS_STATUS_CODES = new Set([204, 205, 304]);

function canonicalHeaderName(lowerCaseName) {
  return lowerCaseName
    .split('-')
    .map((segment) => (segment ? `${segment[0].toUpperCase()}${segment.slice(1)}` : segment))
    .join('-');
}

function rewriteUpstreamTarget(requestUrl) {
  const url = new URL(requestUrl ?? '/', 'http://localhost');
  // The bridge authenticates the browser via `?token=`/`?bridgeToken=`
  // (bridge/bridgeHttp.js isAuthorized); neither key means anything to dsh,
  // so the bridge token must never leak upstream as a query key. Every other
  // query key is preserved.
  url.searchParams.delete('token');
  url.searchParams.delete('bridgeToken');
  if (url.pathname === '/dsh') return { path: '/api/', search: url.search };
  if (!url.pathname.startsWith(DSH_HTTP_PROXY_PREFIX)) return null;
  // `/dsh/session/list` -> `/api/session/list`: dsh serves every unary RPC
  // behind the `/api` fence, reachable only from a loopback authority.
  return {
    path: `/api/${url.pathname.slice(DSH_HTTP_PROXY_PREFIX.length)}`,
    search: url.search,
  };
}

function buildUpstreamHeaders(requestHeaders, cookie) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  if (typeof cookie === 'string' && cookie.trim()) {
    headers.cookie = cookie;
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
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    // The bridge owns downstream CORS: dsh reflects its loopback origin and
    // forwarding its `Access-Control-*` values would break Pages clients.
    if (lower.startsWith('access-control-')) continue;
    if (bodyless && lower === 'content-length') continue;
    // Node ignores a later case-variant duplicate in a writeHead object, so
    // canonicalize names to let content headers override writeCorsHeaders's
    // JSON default instead of silently losing to it.
    headers[canonicalHeaderName(lower)] = value;
  }
  return headers;
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

// Local 502 classification for failures the proxy itself detects (no cookie
// getter configured); provider errors surface their own typed code instead.
class DshHttpProxyLocalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DshHttpProxyLocalError';
    this.code = code;
  }
}

// createDshAuthProvider().getCookie is async and rejects with a data-free
// DshAuthError carrying `DSH_COOKIE_MISSING`/`DSH_AUTH_EXCHANGE_FAILED`;
// synchronous getters (tests, pre-resolved caches) pass straight through.
function resolveUpstreamCookie(options) {
  if (typeof options.getUpstreamCookie !== 'function') {
    return Promise.reject(
      new DshHttpProxyLocalError(
        DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE,
        'Dsh proxy requires options.getUpstreamCookie to inject the upstream auth cookie',
      ),
    );
  }
  try {
    return Promise.resolve(options.getUpstreamCookie());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Streams one dsh web REST request/response over the bridge.
 *
 * The local `/dsh/` prefix is rewritten onto dsh's loopback `/api` fence, the
 * Authority cookie from `options.getUpstreamCookie()` is injected per
 * authority, the bridge's own CORS headers are layered over the upstream
 * content headers, and both bodies are piped byte-for-byte (multipart
 * `Uint8Array` attachments included). Status codes and dsh's
 * `{ok:true|false}` envelopes are never interpreted here.
 */
export function proxyDshHttp(request, response, options = {}) {
  const target = rewriteUpstreamTarget(request.url);
  if (!target) {
    writeLocalError(
      response,
      404,
      DSH_HTTP_PROXY_PATH,
      `Dsh proxy only serves ${DSH_HTTP_PROXY_PREFIX}`,
    );
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(
      `${target.path}${target.search}`,
      options.upstreamOrigin ?? DSH_HTTP_UPSTREAM_ORIGIN,
    );
  } catch (error) {
    writeLocalError(
      response,
      502,
      DSH_HTTP_UPSTREAM_UNREACHABLE,
      `Invalid dsh upstream origin: ${errorMessage(error)}`,
    );
    return;
  }
  if (upstreamUrl.protocol !== 'http:') {
    writeLocalError(
      response,
      502,
      DSH_HTTP_UPSTREAM_UNREACHABLE,
      `Unsupported dsh upstream protocol: ${upstreamUrl.protocol}`,
    );
    return;
  }

  resolveUpstreamCookie(options).then(
    (cookie) => {
      if (typeof cookie !== 'string' || !cookie.trim()) {
        writeLocalError(
          response,
          502,
          DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE,
          'Dsh upstream auth cookie is unavailable',
        );
        return;
      }
      streamUpstream(request, response, options, upstreamUrl, cookie);
    },
    (error) => {
      writeLocalError(
        response,
        502,
        errorCode(error) ?? DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE,
        `Dsh upstream auth cookie unavailable: ${errorMessage(error)}`,
      );
    },
  );
}

function streamUpstream(request, response, options, upstreamUrl, cookie) {
  const upstreamRequest = httpRequest({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 80,
    method: request.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: buildUpstreamHeaders(request.headers, cookie),
  });

  // `responseStarted` also doubles as the "single settle" latch for the
  // upstream request, so a late error after headers cannot write a 502 over
  // an already-started body.
  let responseStarted = false;
  let timedOut = false;

  // Bounds only the wait for upstream response headers. Once the body is
  // streaming there is deliberately no idle timeout, so long uploads and
  // large multipart downloads are not severed between chunks.
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    timedOut = true;
    upstreamRequest.destroy(new Error('Dsh upstream did not respond in time.'));
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
      timedOut ? DSH_HTTP_UPSTREAM_TIMEOUT : DSH_HTTP_UPSTREAM_UNREACHABLE,
      `Dsh upstream request failed: ${errorMessage(error)}`,
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
