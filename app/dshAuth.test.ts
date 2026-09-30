import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DSH_AUTH_EXCHANGE_FAILED,
  DSH_COOKIE_MISSING,
  DshAuthError,
  computeDshAuthCookieName,
  createDshAuthProvider,
  createNodeDshExchange,
} from '../bridge/dshAuth.js';

/**
 * Wire anchors (`.omo/evidence/dsh-adapt/02-auth-sequence.txt`, real dsh@0.2.0-rc.2 capture):
 *   GET /?token=<launchToken> → 303 See Other
 *   Set-Cookie: dsh-auth-jvDF8txFDAfXue6lmQ9tIC2LWapK0vsnXbJ1l-jvKzM=v1.<payload>.<sig>;
 *               Max-Age=2592000; Path=/; Expires=...; HttpOnly; SameSite=Strict
 *   cookie name = `dsh-auth-<base64url(sha256(authority))>`, authority = `host:port`.
 */
const AUTHORITY = '127.0.0.1:3080';
const OTHER_AUTHORITY = '127.0.0.1:3081';
const CAPTURED_HASH_AUTHORITY = '127.0.0.1:8765';
const CAPTURED_HASH_NAME =
  'dsh-auth-jvDF8txFDAfXue6lmQ9tIC2LWapK0vsnXbJ1l-jvKzM';

// Real-shaped values from the same capture; they are expired dev-session data, not live secrets.
const LAUNCH_TOKEN = 'ZZ_FxX3LiKz3Nccfi6ZShKhCVL6fTQklxQlNNPFJ4PQ';
const ROTATED_LAUNCH_TOKEN = 'YY_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xy';
const COOKIE_VALUE =
  'v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6ODc2NSIsImlzc3VlZEF0IjoxNzkwNjkyODE2MzA0LCJleHBpcmVzQXQiOjE3OTMyODQ4MTYzMDR9.SN9yR12_5MLBgzBcLgnriVIISeVz4pNX07bICXoGLWw';
const ROTATED_COOKIE_VALUE =
  'v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6ODc2NSIsImlzc3VlZEF0IjoxNzkxMDAwMDAwMDAwLCJleHBpcmVzQXQiOjE3OTM2MDAwMDAwMDAwfQ.rOtAtEd-CoOkIe-VaLuE-rotated0000';
const THIRTY_DAYS_IN_SECONDS = 2592000;
const TEST_EPOCH_MS = 1_700_000_000_000;

type ExchangeCall = { authority: string; launchToken: string };
type ExchangeResult = { status: number; setCookie: string[] };
type DshAuthProviderLike = {
  getCookie(authority: string): Promise<string>;
  invalidate(authority: string): boolean;
};

// Independent re-computation of the protocol's cookie name so the module cannot
// self-certify a wrong hash scheme.
function expectedCookieName(authority: string): string {
  return `dsh-auth-${createHash('sha256').update(authority, 'utf8').digest('base64url')}`;
}

function buildSetCookie(authority: string, value: string, maxAgeSeconds = THIRTY_DAYS_IN_SECONDS): string {
  return `${expectedCookieName(authority)}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`;
}

function createScriptedExchange(script: Array<ExchangeResult | Error>) {
  const calls: ExchangeCall[] = [];
  let served = 0;
  const exchange = async ({ authority, launchToken }: ExchangeCall): Promise<ExchangeResult> => {
    calls.push({ authority, launchToken });
    const step = script[Math.min(served, script.length - 1)];
    served += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  return { exchange, calls };
}

function createHarness(options: { exchange: (call: ExchangeCall) => Promise<ExchangeResult> }) {
  let launchToken: string | null = LAUNCH_TOKEN;
  let clock = TEST_EPOCH_MS;
  const provider = createDshAuthProvider({
    exchange: options.exchange,
    getLaunchToken: () => launchToken,
    now: () => clock,
  });
  return {
    provider: provider as DshAuthProviderLike,
    setLaunchToken(next: string | null): void {
      launchToken = next;
    },
    advanceClock(milliseconds: number): void {
      clock += milliseconds;
    },
  };
}

async function captureError(run: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

async function expectDshAuthError(
  run: () => Promise<unknown>,
  code: string,
): Promise<Error & { code?: string }> {
  const error = await captureError(run);
  expect(error).toBeInstanceOf(DshAuthError);
  expect(error.code).toBe(code);
  return error;
}

function expectNoSecretLeak(error: Error & { code?: string }): void {
  for (const secret of [LAUNCH_TOKEN, ROTATED_LAUNCH_TOKEN, COOKIE_VALUE, ROTATED_COOKIE_VALUE]) {
    expect(error.message).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.stack ?? '').not.toContain(secret);
  }
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('createDshAuthProvider', () => {
  it('derives the same dsh-auth cookie name hash as the live dsh capture', () => {
    expect(computeDshAuthCookieName(CAPTURED_HASH_AUTHORITY)).toBe(CAPTURED_HASH_NAME);
    expect(computeDshAuthCookieName(AUTHORITY)).toBe(expectedCookieName(AUTHORITY));
  });

  it('exchanges a launch token and returns the Cookie header value', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    const header = await harness.provider.getCookie(AUTHORITY);

    expect(header).toBe(`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}`);
    expect(header).not.toContain('Max-Age');
    expect(header).not.toContain('Path=');
    expect(recorder.calls).toEqual([{ authority: AUTHORITY, launchToken: LAUNCH_TOKEN }]);
  });

  it('serves the second getCookie call from the authority cache without re-exchanging', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    const first = await harness.provider.getCookie(AUTHORITY);
    const second = await harness.provider.getCookie(AUTHORITY);
    const third = await harness.provider.getCookie(AUTHORITY);

    expect(second).toBe(first);
    expect(third).toBe(first);
    // Misleading-success guard: the cache path is only proven by the call count.
    expect(recorder.calls).toHaveLength(1);
  });

  it('re-exchanges with the rotated launch token after the cookie is invalidated (upstream 401/403)', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, ROTATED_COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    const first = await harness.provider.getCookie(AUTHORITY);
    expect(first).toBe(`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}`);

    // dsh restarted: the startup line carries a brand new launch token.
    harness.setLaunchToken(ROTATED_LAUNCH_TOKEN);
    // Upstream answered 401/403 with the stale cookie: the caller drops it.
    expect(harness.provider.invalidate(AUTHORITY)).toBe(true);

    const second = await harness.provider.getCookie(AUTHORITY);
    expect(second).toBe(`${expectedCookieName(AUTHORITY)}=${ROTATED_COOKIE_VALUE}`);
    expect(recorder.calls).toEqual([
      { authority: AUTHORITY, launchToken: LAUNCH_TOKEN },
      { authority: AUTHORITY, launchToken: ROTATED_LAUNCH_TOKEN },
    ]);
  });

  it('fails with DSH_AUTH_EXCHANGE_FAILED when the exchange function throws', async () => {
    const recorder = createScriptedExchange([
      new Error('socket hang up'),
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    const error = await expectDshAuthError(
      () => harness.provider.getCookie(AUTHORITY),
      DSH_AUTH_EXCHANGE_FAILED,
    );
    expectNoSecretLeak(error);
    expect(recorder.calls).toHaveLength(1);

    // A failed exchange must not poison the cache: the retry succeeds.
    const header = await harness.provider.getCookie(AUTHORITY);
    expect(header).toBe(`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}`);
    expect(recorder.calls).toHaveLength(2);
  });

  it.each([
    ['an empty string', ''],
    ['a whitespace-only string', '   \n\t '],
    ['null', null],
    ['undefined', undefined],
  ])('fails with DSH_COOKIE_MISSING when the launch token is %s and nothing is cached', async (
    _label,
    token,
  ) => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });
    harness.setLaunchToken(token as string | null);

    const error = await expectDshAuthError(
      () => harness.provider.getCookie(AUTHORITY),
      DSH_COOKIE_MISSING,
    );
    expectNoSecretLeak(error);
    // Credential-unavailable must not even touch the upstream.
    expect(recorder.calls).toHaveLength(0);
  });

  it('caches cookies per authority and never crosses authorities', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
      { status: 303, setCookie: [buildSetCookie(OTHER_AUTHORITY, COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    const first = await harness.provider.getCookie(AUTHORITY);
    const second = await harness.provider.getCookie(OTHER_AUTHORITY);
    const firstAgain = await harness.provider.getCookie(AUTHORITY);

    expect(first).toBe(`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}`);
    expect(second).toBe(`${expectedCookieName(OTHER_AUTHORITY)}=${COOKIE_VALUE}`);
    expect(firstAgain).toBe(first);
    expect(expectedCookieName(AUTHORITY)).not.toBe(expectedCookieName(OTHER_AUTHORITY));
    expect(recorder.calls).toHaveLength(2);
  });

  it('keeps serving the cached cookie before Max-Age elapses', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE, 60)] },
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, ROTATED_COOKIE_VALUE, 60)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    await harness.provider.getCookie(AUTHORITY);
    harness.advanceClock(59_999);

    const header = await harness.provider.getCookie(AUTHORITY);
    expect(header).toBe(`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}`);
    expect(recorder.calls).toHaveLength(1);
  });

  it('re-exchanges once the injected clock passes the cookie Max-Age', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE, 60)] },
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, ROTATED_COOKIE_VALUE, 60)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    await harness.provider.getCookie(AUTHORITY);
    harness.setLaunchToken(ROTATED_LAUNCH_TOKEN);
    harness.advanceClock(60_001);

    const header = await harness.provider.getCookie(AUTHORITY);
    expect(header).toBe(`${expectedCookieName(AUTHORITY)}=${ROTATED_COOKIE_VALUE}`);
    expect(recorder.calls).toEqual([
      { authority: AUTHORITY, launchToken: LAUNCH_TOKEN },
      { authority: AUTHORITY, launchToken: ROTATED_LAUNCH_TOKEN },
    ]);
  });

  it.each<[string, ExchangeResult]>([
    ['a Set-Cookie for an unrelated cookie name', { status: 303, setCookie: ['other-cookie=abc; Path=/'] }],
    ['an empty Set-Cookie list', { status: 303, setCookie: [] }],
    ['a Set-Cookie without a name=value pair', { status: 303, setCookie: ['; Path=/'] }],
    ['a 401 response carrying no cookie', { status: 401, setCookie: [] }],
    [
      'an auth cookie with Max-Age=0',
      {
        status: 303,
        setCookie: [`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}; Max-Age=0; Path=/`],
      },
    ],
    [
      'an auth cookie with a CRLF-injected value',
      {
        status: 303,
        setCookie: [`${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}\r\nX-Injected: 1; Max-Age=60`],
      },
    ],
  ])('fails with DSH_AUTH_EXCHANGE_FAILED when the exchange returns %s', async (_label, result) => {
    const recorder = createScriptedExchange([result]);
    const harness = createHarness({ exchange: recorder.exchange });

    const error = await expectDshAuthError(
      () => harness.provider.getCookie(AUTHORITY),
      DSH_AUTH_EXCHANGE_FAILED,
    );
    expectNoSecretLeak(error);
    expect(recorder.calls).toHaveLength(1);
  });

  it('picks the dsh-auth cookie out of multiple Set-Cookie headers', async () => {
    const recorder = createScriptedExchange([
      {
        status: 303,
        setCookie: [
          'unrelated=1; Path=/',
          buildSetCookie(AUTHORITY, COOKIE_VALUE),
          'session=2; Path=/; HttpOnly',
        ],
      },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    await expect(harness.provider.getCookie(AUTHORITY)).resolves.toBe(
      `${expectedCookieName(AUTHORITY)}=${COOKIE_VALUE}`,
    );
  });

  it('rejects an empty authority with a TypeError before any exchange', async () => {
    const recorder = createScriptedExchange([
      { status: 303, setCookie: [buildSetCookie(AUTHORITY, COOKIE_VALUE)] },
    ]);
    const harness = createHarness({ exchange: recorder.exchange });

    await expect(harness.provider.getCookie('  ')).rejects.toThrow(TypeError);
    expect(() => harness.provider.invalidate('')).toThrow(TypeError);
    expect(recorder.calls).toHaveLength(0);
  });

  it('requires a launch token source at construction', () => {
    const exchange = async (): Promise<ExchangeResult> => ({ status: 303, setCookie: [] });
    expect(() =>
      createDshAuthProvider({ exchange } as never),
    ).toThrow(TypeError);
    expect(() =>
      createDshAuthProvider({ getLaunchToken: () => LAUNCH_TOKEN, exchange: 'nope' } as never),
    ).toThrow(TypeError);
  });
});

describe('createNodeDshExchange', () => {
  it('performs the real GET token swap against a loopback server and caches the result', async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(303, {
        location: './',
        'set-cookie': buildSetCookie(`127.0.0.1:${(server.address() as AddressInfo).port}`, COOKIE_VALUE),
      });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const authority = `127.0.0.1:${port}`;

    const provider = createDshAuthProvider({
      exchange: createNodeDshExchange(),
      getLaunchToken: () => LAUNCH_TOKEN,
    });

    const header = await provider.getCookie(authority);
    expect(header).toBe(`${expectedCookieName(authority)}=${COOKIE_VALUE}`);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    const requestUrl = new URL(requests[0].url ?? '/', `http://${authority}`);
    expect(requestUrl.pathname).toBe('/');
    expect(requestUrl.searchParams.get('token')).toBe(LAUNCH_TOKEN);

    // Cache hit: the upstream sees no second request.
    await provider.getCookie(authority);
    expect(requests).toHaveLength(1);

    // Invalidation forces a fresh round trip.
    provider.invalidate(authority);
    await provider.getCookie(authority);
    expect(requests).toHaveLength(2);
  });
});
