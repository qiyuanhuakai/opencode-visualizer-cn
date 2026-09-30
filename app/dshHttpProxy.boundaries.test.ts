import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DSH_HTTP_PROXY_PATH,
  DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE,
  DSH_HTTP_UPSTREAM_ORIGIN,
  DSH_HTTP_UPSTREAM_TIMEOUT,
  DSH_HTTP_UPSTREAM_UNREACHABLE,
  proxyDshHttp,
  type DshHttpProxyOptions,
} from '../bridge/dshHttpProxy.js';

// Mirrors bridge/dshAuth.js:26-27 so the proxy's "surface the typed code"
// contract can be pinned without importing the module (its declaration file
// does not exist yet, matching the Task 1 baseline).
const DSH_COOKIE_MISSING = 'DSH_COOKIE_MISSING';
const DSH_AUTH_EXCHANGE_FAILED = 'DSH_AUTH_EXCHANGE_FAILED';

// Minimal stand-in for bridge/dshAuth.js DshAuthError: an Error carrying a
// stable `code`, which is the contract proxyDshHttp surfaces on 502s.
class DshAuthCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DshAuthCodeError';
    this.code = code;
  }
}

type CapturedRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type UpstreamHandler = (captured: CapturedRequest, response: ServerResponse) => void;

type FakeUpstream = {
  origin: string;
  port: number;
  requests: CapturedRequest[];
};

type ClientResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

type StreamingClient = {
  firstChunk: Promise<Buffer>;
  ended: Promise<Buffer>;
  close: () => void;
};

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server address unavailable.');
      }
      resolve(address.port);
    });
  });
}

async function createUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  servers.push(server);
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, port, requests };
}

async function createProxy(options: DshHttpProxyOptions): Promise<number> {
  const server = createServer((request, response) => proxyDshHttp(request, response, options));
  servers.push(server);
  return listen(server);
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address unavailable.');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function clientRequest(
  port: number,
  requestOptions: RequestOptions,
  bodyChunks: Buffer[] = [],
  timeoutMs = 5_000,
): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Test client timed out after ${timeoutMs}ms.`));
      request.destroy();
    }, timeoutMs);
    const request = httpRequest(
      { host: '127.0.0.1', port, agent: false, ...requestOptions },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', fail);
      },
    );
    request.on('error', fail);
    for (const chunk of bodyChunks) request.write(chunk);
    request.end();
  });
}

function startStreamingClient(port: number, requestOptions: RequestOptions): StreamingClient {
  const chunks: Buffer[] = [];
  let resolveFirst!: (chunk: Buffer) => void;
  let resolveEnded!: (body: Buffer) => void;
  const firstChunk = new Promise<Buffer>((resolve) => {
    resolveFirst = resolve;
  });
  const ended = new Promise<Buffer>((resolve) => {
    resolveEnded = resolve;
  });
  const request = httpRequest(
    { host: '127.0.0.1', port, agent: false, ...requestOptions },
    (response) => {
      response.on('data', (chunk: Buffer) => {
        if (chunks.length === 0) resolveFirst(chunk);
        chunks.push(chunk);
      });
      response.on('end', () => resolveEnded(Buffer.concat(chunks)));
      response.on('error', () => resolveEnded(Buffer.concat(chunks)));
    },
  );
  request.on('error', () => resolveEnded(Buffer.concat(chunks)));
  request.end();
  return { firstChunk, ended, close: () => request.destroy() };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseBody(body: Buffer): { error?: string; code?: string } {
  return JSON.parse(body.toString()) as { error?: string; code?: string };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('proxyDshHttp boundaries', () => {
  it('targets the dsh loopback origin by default', () => {
    expect(DSH_HTTP_UPSTREAM_ORIGIN).toBe('http://127.0.0.1:3080');
  });

  it('rewrites the /dsh prefix onto the upstream /api fence and passes the envelope through unchanged', async () => {
    const envelope = {
      type: 'server-response',
      rpcId: 'rpc_1',
      result: { ok: true, value: { sessions: [] } },
    };
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-upstream-marker': 'kept',
      });
      response.end(JSON.stringify(envelope));
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(port, {
      path: '/dsh/session/list?verbose=1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    await clientRequest(port, {
      path: '/dsh',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0]?.url).toBe('/api/session/list?verbose=1');
    expect(upstream.requests[0]?.method).toBe('POST');
    expect(upstream.requests[1]?.url).toBe('/api/');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(result.headers['x-upstream-marker']).toBe('kept');
    expect(JSON.parse(result.body.toString())).toEqual(envelope);
  });

  it('passes a {ok:false} HTTP 200 business envelope through verbatim without parsing', async () => {
    const envelope = {
      type: 'server-response',
      rpcId: 'rpc_2',
      result: {
        ok: false,
        error: {
          code: 'gateway/arguments-invalid',
          message: 'typert gateway: session/list: args fields do not match the descriptor',
          details: { endpoint: 'session/list' },
        },
      },
    };
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(envelope));
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(port, {
      path: '/dsh/session/list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString())).toEqual(envelope);
  });

  it('replaces the client Host with the loopback Host the HTTP client generates for the upstream target', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    await clientRequest(port, {
      path: '/dsh/session/list',
      method: 'POST',
      // A browser downlink Host must never reach dsh; the upstream request must
      // carry the Host of the loopback target (docs/dsh.md:128 authority check).
      headers: { host: 'vis.example.com' },
    });

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.headers.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(upstream.requests[0]?.headers.host).not.toBe('vis.example.com');
  });

  it('strips fetch metadata, origin, authorization, the bridge token and the client cookie from the upstream request', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    await clientRequest(port, {
      path: '/dsh/session/list?token=bridge-secret&verbose=1',
      method: 'POST',
      headers: {
        origin: 'https://qiyuanhuakai.github.io',
        authorization: 'Bearer bridge-secret',
        cookie: 'dsh-auth-client-sniff=attacker-cookie',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-fetch-user': '?1',
        'x-kept-header': 'kept',
      },
    });

    expect(upstream.requests).toHaveLength(1);
    const captured = upstream.requests[0];
    expect(captured?.headers.origin).toBeUndefined();
    expect(captured?.headers.authorization).toBeUndefined();
    expect(captured?.headers['sec-fetch-site']).toBeUndefined();
    expect(captured?.headers['sec-fetch-mode']).toBeUndefined();
    expect(captured?.headers['sec-fetch-dest']).toBeUndefined();
    expect(captured?.headers['sec-fetch-user']).toBeUndefined();
    // Only the injected authority cookie may reach dsh (Todo 1 provider value).
    expect(captured?.headers.cookie).toBe('dsh-auth-hash=injected-secret');
    expect(captured?.headers['x-kept-header']).toBe('kept');
    const upstreamQuery = new URL(captured?.url ?? '/', 'http://localhost');
    expect(upstreamQuery.searchParams.has('token')).toBe(false);
    expect(upstreamQuery.searchParams.get('verbose')).toBe('1');
  });

  it('streams a multipart binary response byte-identically', async () => {
    const payload = randomBytes(2 * 1024 * 1024 + 12345);
    const upstream = await createUpstream((captured, response) => {
      response.writeHead(200, {
        'content-type': 'multipart/form-data; boundary=dshbytes',
        'content-length': String(captured.body.length),
      });
      response.end(captured.body);
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(
      port,
      {
        path: '/dsh/workspaceFiles/readBytes?path=big.bin',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      },
      [payload.subarray(0, 1_100_000), payload.subarray(1_100_000)],
      15_000,
    );

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.body.equals(payload)).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body.equals(payload)).toBe(true);
    expect(result.headers['content-type']).toBe('multipart/form-data; boundary=dshbytes');
    expect(result.headers['content-length']).toBe(String(payload.length));
    expect(result.headers['access-control-allow-origin']).toBe('*');
  });

  it('forwards response bytes before the upstream response completes (no full buffering)', async () => {
    let releaseUpstream!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    let upstreamEnded = false;
    const upstream = await createUpstream(async (_captured, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.write('first-chunk|');
      await release;
      upstreamEnded = true;
      response.end('second-chunk');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const client = startStreamingClient(port, {
      path: '/dsh/session/follow',
      method: 'POST',
    });
    try {
      const first = await withDeadline(client.firstChunk, 2_000, 'first downstream chunk');
      expect(first.toString()).toBe('first-chunk|');
      expect(upstreamEnded).toBe(false);

      releaseUpstream();
      const body = await withDeadline(client.ended, 2_000, 'downstream response end');
      expect(body.toString()).toBe('first-chunk|second-chunk');
    } finally {
      client.close();
    }
  });

  it('passes a 204 empty response through with the upstream status and without content-length', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(204, { 'content-length': '0' });
      response.end();
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(port, { path: '/dsh/session/close', method: 'POST' });

    expect(result.status).toBe(204);
    expect(result.body).toHaveLength(0);
    expect(result.headers['content-length']).toBeUndefined();
  });

  it('drops the upstream Set-Cookie, hop-by-hop and Access-Control headers while layering bridge CORS', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': ['dsh-auth-hash=rotated-secret; Path=/; HttpOnly', 'other=1'],
        'access-control-allow-origin': 'http://127.0.0.1:3080',
        'access-control-allow-credentials': 'true',
        'proxy-authenticate': 'Basic realm="upstream"',
        'keep-alive': 'timeout=5',
      });
      response.end('{"ok":true}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(port, { path: '/dsh/session/list', method: 'POST' });

    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(result.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(result.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    expect(result.headers['access-control-allow-credentials']).toBeUndefined();
    expect(result.headers['proxy-authenticate']).toBeUndefined();
    expect(result.headers['keep-alive']).toBeUndefined();
    expect(result.body.toString()).toBe('{"ok":true}');
  });

  it('answers 502 with a stable JSON code and bridge CORS headers when the upstream refuses the connection', async () => {
    const port = await closedPort();
    const proxyPort = await createProxy({
      upstreamOrigin: `http://127.0.0.1:${port}`,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(proxyPort, { path: '/dsh/session/list', method: 'POST' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(result.headers['content-type']).toContain('application/json');
    const body = parseBody(result.body);
    expect(body.code).toBe(DSH_HTTP_UPSTREAM_UNREACHABLE);
    expect(typeof body.error).toBe('string');
  });

  it('answers 502 with DSH_HTTP_UPSTREAM_TIMEOUT when the upstream accepts but never responds', async () => {
    const upstream = await createUpstream(() => {
      // Accept the connection and never write a response.
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
      upstreamTimeoutMs: 60,
    });

    const startedAt = Date.now();
    const result = await clientRequest(port, { path: '/dsh/session/list', method: 'POST' }, [], 3_000);
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(DSH_HTTP_UPSTREAM_TIMEOUT);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('answers 502 classified as cookie-unavailable when no upstream cookie getter is configured', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const port = await createProxy({ upstreamOrigin: upstream.origin });

    const result = await clientRequest(port, { path: '/dsh/session/list', method: 'POST' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE);
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers 502 with the typed provider code when the cookie getter throws synchronously', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => {
        throw new DshAuthCodeError(DSH_COOKIE_MISSING, 'No dsh launch token is available');
      },
    });

    const result = await clientRequest(port, { path: '/dsh/session/list', method: 'POST' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(DSH_COOKIE_MISSING);
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers 502 with the typed provider code when the async cookie getter rejects', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      // createDshAuthProvider().getCookie is async (Todo 1); the proxy must
      // surface its typed code instead of hanging or contacting dsh.
      getUpstreamCookie: () =>
        Promise.reject(new DshAuthCodeError(DSH_AUTH_EXCHANGE_FAILED, 'exchange failed')),
    });

    const result = await clientRequest(port, { path: '/dsh/session/list', method: 'POST' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(DSH_AUTH_EXCHANGE_FAILED);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a non-/dsh path with a local 404 and bridge CORS headers', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamCookie: () => 'dsh-auth-hash=injected-secret',
    });

    const result = await clientRequest(port, { path: '/api/v1/meta', method: 'POST' });

    expect(result.status).toBe(404);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(DSH_HTTP_PROXY_PATH);
    expect(upstream.requests).toHaveLength(0);
  });
});
