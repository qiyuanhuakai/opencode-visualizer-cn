import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KIMI_TOKEN_MISSING,
  KIMI_TOKEN_UNREADABLE,
  createKimiWebTokenProvider,
} from '../bridge/kimiWebToken.js';
import {
  KIMI_WEB_PROXY_PATH,
  KIMI_WEB_TOKEN_UNAVAILABLE,
  KIMI_WEB_UPSTREAM_ORIGIN,
  KIMI_WEB_UPSTREAM_TIMEOUT,
  KIMI_WEB_UPSTREAM_UNREACHABLE,
  proxyKimiWebHttp,
  type KimiWebProxyOptions,
} from '../bridge/kimiWebHttpProxy.js';

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
const tempDirectories: string[] = [];
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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

async function createProxy(options: KimiWebProxyOptions): Promise<number> {
  const server = createServer((request, response) => proxyKimiWebHttp(request, response, options));
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

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kimi-web-proxy-'));
  tempDirectories.push(directory);
  return directory;
}

function createTokenPath(): string {
  return path.join(tempDirectory(), 'server.token');
}

function writeToken(tokenPath: string, content: string): void {
  writeFileSync(tokenPath, content, { mode: 0o600 });
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
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('proxyKimiWebHttp boundaries', () => {
  it('targets the kimi web loopback origin by default', () => {
    expect(KIMI_WEB_UPSTREAM_ORIGIN).toBe('http://127.0.0.1:58627');
  });

  it('rewrites the /kimi-web prefix to the upstream root and passes JSON through unchanged', async () => {
    const envelope = { code: 0, msg: 'success', data: { ok: true }, request_id: 'req_1' };
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-upstream-marker': 'kept',
      });
      response.end(JSON.stringify(envelope));
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(port, {
      path: '/kimi-web/api/v1/meta?verbose=1',
      method: 'GET',
    });
    await clientRequest(port, { path: '/kimi-web', method: 'GET' });

    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0]?.url).toBe('/api/v1/meta?verbose=1');
    expect(upstream.requests[0]?.method).toBe('GET');
    expect(upstream.requests[1]?.url).toBe('/');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(result.headers['x-upstream-marker']).toBe('kept');
    expect(JSON.parse(result.body.toString())).toEqual(envelope);
  });

  it('strips origin/authorization/host and injects a fresh upstream bearer per request', async () => {
    const tokenPath = createTokenPath();
    writeToken(tokenPath, 'upstream-token-1');
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"code":0,"msg":"success","data":null,"request_id":"req_2"}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      tokenProvider: createKimiWebTokenProvider({ tokenPath }),
    });

    const headers = {
      origin: 'https://qiyuanhuakai.github.io',
      authorization: 'Bearer bridge-client-token',
      'x-kept-header': 'kept',
    };
    await clientRequest(port, { path: '/kimi-web/api/v1/meta', method: 'GET', headers });
    writeToken(tokenPath, 'upstream-token-2');
    await clientRequest(port, { path: '/kimi-web/api/v1/meta', method: 'GET', headers });

    expect(upstream.requests).toHaveLength(2);
    const [first, second] = upstream.requests;
    expect(first?.headers.origin).toBeUndefined();
    expect(first?.headers.authorization).toBe('Bearer upstream-token-1');
    expect(second?.headers.authorization).toBe('Bearer upstream-token-2');
    expect(first?.headers['x-kept-header']).toBe('kept');
    expect(first?.headers.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it('streams a chunked binary request body upstream and a 206 binary response downstream byte-identically', async () => {
    const payload = randomBytes(2 * 1024 * 1024 + 12345);
    const upstream = await createUpstream((captured, response) => {
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(captured.body.length),
        'content-range': `bytes 0-${captured.body.length - 1}/${captured.body.length}`,
      });
      response.end(captured.body);
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(
      port,
      {
        path: '/kimi-web/api/v1/files/upload?session_id=s1',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      },
      [payload.subarray(0, 1_100_000), payload.subarray(1_100_000)],
      15_000,
    );

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.body.equals(payload)).toBe(true);
    expect(result.status).toBe(206);
    expect(result.body.equals(payload)).toBe(true);
    expect(result.headers['content-type']).toBe('application/octet-stream');
    expect(result.headers['content-length']).toBe(String(payload.length));
    expect(result.headers['content-range']).toBe(`bytes 0-${payload.length - 1}/${payload.length}`);
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
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const client = startStreamingClient(port, {
      path: '/kimi-web/api/v1/sessions/s1/transcript',
      method: 'GET',
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

  it('passes a code!=0 HTTP 200 business-error envelope through verbatim', async () => {
    const envelope = { code: 40401, msg: 'session not found', data: null, request_id: 'req_missing' };
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(envelope));
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(port, {
      path: '/kimi-web/api/v1/sessions/missing',
      method: 'GET',
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString())).toEqual(envelope);
  });

  it('passes a 204 empty response through with the upstream status', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(204);
      response.end();
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(port, {
      path: '/kimi-web/api/v1/sessions/s1:delete',
      method: 'POST',
    });

    expect(result.status).toBe(204);
    expect(result.body).toHaveLength(0);
  });

  it('drops upstream hop-by-hop and Access-Control headers while adding bridge CORS headers', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': 'http://127.0.0.1:58627',
        'access-control-allow-credentials': 'true',
        'proxy-authenticate': 'Basic realm="upstream"',
        'keep-alive': 'timeout=5',
      });
      response.end('{"code":0}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(port, { path: '/kimi-web/api/v1/meta', method: 'GET' });

    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(result.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(result.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    expect(result.headers['access-control-allow-credentials']).toBeUndefined();
    expect(result.headers['proxy-authenticate']).toBeUndefined();
    expect(result.headers['keep-alive']).toBeUndefined();
    expect(result.body.toString()).toBe('{"code":0}');
  });

  it('answers 502 with a stable JSON code and bridge CORS headers when the upstream refuses the connection', async () => {
    const port = await closedPort();
    const proxyPort = await createProxy({
      upstreamOrigin: `http://127.0.0.1:${port}`,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(proxyPort, { path: '/kimi-web/api/v1/meta', method: 'GET' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(result.headers['content-type']).toContain('application/json');
    const body = parseBody(result.body);
    expect(body.code).toBe(KIMI_WEB_UPSTREAM_UNREACHABLE);
    expect(typeof body.error).toBe('string');
  });

  it('answers 502 with the provider code when the token file is missing', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const tokenPath = path.join(tempDirectory(), 'server.token');
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      tokenProvider: createKimiWebTokenProvider({ tokenPath }),
    });

    const result = await clientRequest(port, { path: '/kimi-web/api/v1/meta', method: 'GET' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(KIMI_TOKEN_MISSING);
    expect(upstream.requests).toHaveLength(0);
  });

  it.skipIf(isRoot)(
    'answers 502 with KIMI_TOKEN_UNREADABLE when the token file is not readable',
    async () => {
      const upstream = await createUpstream((_captured, response) => {
        response.writeHead(200);
        response.end('{}');
      });
      const tokenPath = createTokenPath();
      writeToken(tokenPath, 'unreadable-upstream-token');
      chmodSync(tokenPath, 0o000);
      const port = await createProxy({
        upstreamOrigin: upstream.origin,
        tokenProvider: createKimiWebTokenProvider({ tokenPath }),
      });

      const result = await clientRequest(port, { path: '/kimi-web/api/v1/meta', method: 'GET' });

      expect(result.status).toBe(502);
      expect(result.headers['access-control-allow-origin']).toBe('*');
      expect(parseBody(result.body).code).toBe(KIMI_TOKEN_UNREADABLE);
      expect(upstream.requests).toHaveLength(0);
    },
  );

  it('answers 502 with KIMI_WEB_TOKEN_UNAVAILABLE when the provider throws without a code', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => {
        throw new Error('token provider failed');
      },
    });

    const result = await clientRequest(port, { path: '/kimi-web/api/v1/meta', method: 'GET' });

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(KIMI_WEB_TOKEN_UNAVAILABLE);
    expect(upstream.requests).toHaveLength(0);
  });

  it('does not hang when the upstream accepts but never responds', async () => {
    const upstream = await createUpstream(() => {
      // Accept the connection and never write a response.
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
      upstreamTimeoutMs: 60,
    });

    const startedAt = Date.now();
    const result = await clientRequest(
      port,
      { path: '/kimi-web/api/v1/sessions', method: 'GET' },
      [],
      3_000,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(502);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(KIMI_WEB_UPSTREAM_TIMEOUT);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('rejects a non-/kimi-web/ path with a local 404 and bridge CORS headers', async () => {
    const upstream = await createUpstream((_captured, response) => {
      response.writeHead(200);
      response.end('{}');
    });
    const port = await createProxy({
      upstreamOrigin: upstream.origin,
      getUpstreamAuthorization: () => 'Bearer unit-token',
    });

    const result = await clientRequest(port, { path: '/api/v1/meta', method: 'GET' });

    expect(result.status).toBe(404);
    expect(result.headers['access-control-allow-origin']).toBe('*');
    expect(parseBody(result.body).code).toBe(KIMI_WEB_PROXY_PATH);
    expect(upstream.requests).toHaveLength(0);
  });
});
