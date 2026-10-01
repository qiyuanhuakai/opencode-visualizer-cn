import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';

/**
 * dsh (DeepSeek Harness web) credential exchange for vis_bridge.
 *
 * Protocol facts below are from docs/dsh.md 4.1/4.2 and the live capture in
 * `.omo/evidence/dsh-adapt/02-auth-sequence.txt` (dsh@0.2.0-rc.2):
 *
 *   - `GET /?token=<launchToken>` answers 303 See Other and sets a cookie named
 *     `dsh-auth-<base64url(sha256(authority))>` (authority = `host:port`), valid
 *     30 days (Max-Age=2592000) and across process restarts.
 *   - Every `/api` request (and the WS upgrade) needs that cookie; without it
 *     dsh answers 401. Non-browser clients need no Origin, just a loopback Host
 *     plus the cookie.
 *   - The launch token only exists on the dsh process stdout line
 *     (`dsh web: http://127.0.0.1:<port>/?token=<launchToken>`), so it must be
 *     supplied lazily per exchange: a fresh token is available after every
 *     (re)start, and an invalidated/expired cookie must be re-exchangeable.
 *
 * The launch token and the cookie value are credentials: they are never written
 * to logs, never attached to the typed errors (errors stay data-free) and are
 * only handed to the injected `exchange` implementation.
 */

export const DSH_AUTH_EXCHANGE_FAILED = 'DSH_AUTH_EXCHANGE_FAILED';
export const DSH_COOKIE_MISSING = 'DSH_COOKIE_MISSING';

const COOKIE_NAME_PREFIX = 'dsh-auth-';
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10000;

export class DshAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DshAuthError';
    this.code = code;
  }
}

/**
 * Cookie name dsh derives from the authority: `dsh-auth-<base64url(sha256(authority))>`.
 * Verified against the live capture: authority `127.0.0.1:8765` maps to
 * `dsh-auth-jvDF8txFDAfXue6lmQ9tIC2LWapK0vsnXbJ1l-jvKzM`.
 */
export function computeDshAuthCookieName(authority) {
  return `${COOKIE_NAME_PREFIX}${createHash('sha256').update(authority, 'utf8').digest('base64url')}`;
}

function assertAuthority(authority) {
  if (typeof authority !== 'string' || authority.trim() === '') {
    throw new TypeError('Dsh authority must be a non-empty "host:port" string');
  }
  return authority.trim();
}

/**
 * Default exchange: performs the real `GET http://<authority>/?token=<launchToken>`
 * and resolves with the HTTP status and the raw Set-Cookie header values.
 * Throws (rejects) on transport failures.
 */
export function createNodeDshExchange({ timeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS } = {}) {
  return function exchangeLaunchToken({ authority, launchToken }) {
    const url = new URL(`http://${authority}/`);
    url.searchParams.set('token', launchToken);
    return new Promise((resolve, reject) => {
      const request = httpGet(
        url,
        { agent: false, headers: { accept: '*/*' }, timeout: timeoutMs },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              setCookie: response.headers['set-cookie'] ?? [],
            });
          });
          response.on('aborted', () => reject(new Error('Dsh auth exchange response aborted')));
          response.on('error', reject);
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error(`Dsh auth exchange timed out after ${timeoutMs}ms`));
      });
      request.on('error', reject);
    });
  };
}

function parseSetCookieHeader(header, nowMs) {
  if (typeof header !== 'string') return null;
  const attributeSplit = header.indexOf(';');
  const pair = (attributeSplit === -1 ? header : header.slice(0, attributeSplit)).trim();
  const equals = pair.indexOf('=');
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!name || !value) return null;
  // A cookie value carrying control characters would corrupt the Cookie header
  // the proxy forwards upstream; treat it as unusable.
  if (/[\r\n\0]/.test(value)) return null;
  let expiresAt = null;
  if (attributeSplit !== -1) {
    for (const attribute of header.slice(attributeSplit + 1).split(';')) {
      const trimmed = attribute.trim();
      const attributeEquals = trimmed.indexOf('=');
      if (attributeEquals === -1) continue;
      const attributeName = trimmed.slice(0, attributeEquals).trim().toLowerCase();
      const attributeValue = trimmed.slice(attributeEquals + 1).trim();
      if (attributeName === 'max-age') {
        const seconds = Number.parseInt(attributeValue, 10);
        if (Number.isFinite(seconds)) expiresAt = nowMs + seconds * 1000;
      } else if (attributeName === 'expires' && expiresAt === null) {
        // RFC 6265: Max-Age wins over Expires, so only use Expires as fallback.
        const parsed = Date.parse(attributeValue);
        if (!Number.isNaN(parsed)) expiresAt = parsed;
      }
    }
  }
  return { name, value, expiresAt };
}

function normalizeSetCookieHeaders(exchangeResult) {
  if (typeof exchangeResult === 'string') return [exchangeResult];
  if (!exchangeResult || typeof exchangeResult !== 'object') return [];
  const raw = exchangeResult.setCookie;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((header) => typeof header === 'string');
  return [];
}

function pickAuthCookie(setCookieHeaders, authority, nowMs) {
  const expectedName = computeDshAuthCookieName(authority);
  for (const header of setCookieHeaders) {
    const parsed = parseSetCookieHeader(header, nowMs);
    if (!parsed || parsed.name !== expectedName) continue;
    if (parsed.expiresAt !== null && parsed.expiresAt <= nowMs) return null;
    return { name: parsed.name, value: parsed.value, expiresAt: parsed.expiresAt };
  }
  return null;
}

function isExpired(entry, nowMs) {
  return entry.expiresAt !== null && entry.expiresAt <= nowMs;
}

/**
 * Builds the dsh credential provider used by the bridge.
 *
 * Options:
 *   - `exchange`: async `({ authority, launchToken }) => { status, setCookie }`
 *     performing the token swap. Defaults to a real `node:http` GET. Injected in
 *     tests to stay deterministic and offline.
 *   - `getLaunchToken`: lazy source of the CURRENT launch token (re-read per
 *     exchange, mirroring bridge/kimiWebToken.js, so token rotation takes effect
 *     without rebuilding the provider). Returns null/undefined/'' when dsh has
 *     not printed a token yet.
 *   - `now`: injectable clock in epoch ms (defaults to Date.now).
 *
 * Returns:
 *   - `getCookie(authority)`: resolves to the `Cookie` header value
 *     (`dsh-auth-<hash>=<value>`) for that authority, exchanging lazily and
 *     caching per authority until expiry. Rejects with a data-free DshAuthError:
 *     `DSH_COOKIE_MISSING` (nothing cached and no launch token to exchange with)
 *     or `DSH_AUTH_EXCHANGE_FAILED` (exchange threw or yielded no usable cookie).
 *   - `invalidate(authority)`: drops the cached cookie (call on upstream
 *     401/403) so the next getCookie re-exchanges with a fresh launch token.
 */
export function createDshAuthProvider({
  exchange = createNodeDshExchange(),
  getLaunchToken,
  now = () => Date.now(),
} = {}) {
  if (typeof exchange !== 'function') {
    throw new TypeError('createDshAuthProvider requires an exchange function');
  }
  if (typeof getLaunchToken !== 'function') {
    throw new TypeError('createDshAuthProvider requires a getLaunchToken function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('createDshAuthProvider requires now to be a function');
  }

  const cookieCache = new Map();

  function readLaunchToken() {
    const token = getLaunchToken();
    return typeof token === 'string' ? token.trim() : '';
  }

  async function exchangeCookie(authority) {
    const launchToken = readLaunchToken();
    if (!launchToken) {
      throw new DshAuthError(
        DSH_COOKIE_MISSING,
        `No dsh launch token is available for ${authority}; cannot exchange for an auth cookie`,
      );
    }
    let exchangeResult;
    try {
      exchangeResult = await exchange({ authority, launchToken });
    } catch {
      throw new DshAuthError(
        DSH_AUTH_EXCHANGE_FAILED,
        `Dsh auth exchange request failed for ${authority}`,
      );
    }
    const cookie = pickAuthCookie(normalizeSetCookieHeaders(exchangeResult), authority, now());
    if (!cookie) {
      throw new DshAuthError(
        DSH_AUTH_EXCHANGE_FAILED,
        `Dsh auth exchange returned no usable auth cookie for ${authority}`,
      );
    }
    return { header: `${cookie.name}=${cookie.value}`, expiresAt: cookie.expiresAt };
  }

  return {
    async getCookie(authority) {
      const key = assertAuthority(authority);
      const cached = cookieCache.get(key);
      if (cached && !isExpired(cached, now())) {
        return cached.header;
      }
      cookieCache.delete(key);
      const fresh = await exchangeCookie(key);
      cookieCache.set(key, fresh);
      return fresh.header;
    },
    invalidate(authority) {
      return cookieCache.delete(assertAuthority(authority));
    },
  };
}
