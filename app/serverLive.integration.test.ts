import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  get as httpGet,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest';

const serverScript = join(process.cwd(), 'server.js');
const distDir = join(process.cwd(), 'dist');
const listeningLine = /Listening on http:\/\/([0-9.]+):(\d+)/;

// server.js serves REAL built artifacts from dist/. On a clean checkout where
// `pnpm test` runs before `pnpm build` (CI validate job order) dist does not
// exist yet — ensure it first (production env, lock-serialized with the
// artifact-budget auto-build) so the live contract measures the same artifact
// CI ships, never a test-env build.
beforeAll(() => {
  const res = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts/qa/ensure-production-dist.mjs')],
    { cwd: process.cwd(), stdio: 'inherit', timeout: 180_000 },
  );
  expect(res.status, 'ensure-production-dist must produce dist/index.html').toBe(0);
}, 190_000);

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type LiveSocketTuple = Readonly<
  Pick<Socket, 'localAddress' | 'localPort' | 'remoteAddress' | 'remotePort'>
>;
type LiveServerObservation = {
  readonly pid: number | null;
  readonly mode: 'static' | 'proxy';
  readonly upstream: { readonly host: string; readonly port: number; readonly path: string } | null;
  readonly listening: { readonly host: string; readonly port: number };
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
};
type LiveFixtureObservation = {
  readonly port: number;
  closed: boolean;
  readonly requests: {
    readonly path: string;
    readonly socket: LiveSocketTuple;
    finish: {
      readonly status: number;
      readonly bodyBytes: number;
      readonly bodySha256: string;
    } | null;
  }[];
};
const liveServers = new Map<number, LiveServerObservation>();
const liveFixtures = new Map<number, LiveFixtureObservation>();

function request(url: string): Promise<HttpResponse> {
  const target = new URL(url);
  const proxy = liveServers.get(Number(target.port)) ?? null;
  let diagnostic:
    | {
        readonly path: string;
        readonly proxy: LiveServerObservation | null;
        readonly fixtureCandidate: LiveFixtureObservation | null;
        readonly fixtureAttribution: string;
        client: LiveSocketTuple | null;
        response: {
          readonly status: number;
          readonly contentType: string | null;
          readonly fixture: 'yes' | null;
          readonly bodyBytes: number;
          readonly bodySha256: string;
          readonly allowlistedPrefix: string | null;
        } | null;
      }
    | undefined = {
    path: target.pathname.slice(0, 256),
    proxy,
    fixtureCandidate: proxy?.upstream ? (liveFixtures.get(proxy.upstream.port) ?? null) : null,
    fixtureAttribution:
      'candidate only; child outbound socket unobserved; fixture fingerprint from known response literal',
    client: null,
    response: null,
  };
  onTestFailed(() => {
    console.error('serverLive.response', JSON.stringify(diagnostic));
    diagnostic = undefined;
  });
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      if (diagnostic)
        diagnostic.client = {
          localAddress: res.socket.localAddress,
          localPort: res.socket.localPort,
          remoteAddress: res.socket.remoteAddress,
          remotePort: res.socket.remotePort,
        };
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers[name] = value;
        }
        const bytes = Buffer.concat(chunks);
        if (diagnostic)
          diagnostic.response = {
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type']?.slice(0, 128) ?? null,
            fixture: res.headers['x-fixture'] === 'yes' ? 'yes' : null,
            bodyBytes: bytes.length,
            bodySha256: createHash('sha256').update(bytes).digest('hex'),
            allowlistedPrefix:
              [
                'fixture 404',
                '404 Not Found',
                '{"items":[1,2,3]}',
                'created',
                'path=/echo',
                '<!DOCTYPE',
                '<!doctype',
              ].find((prefix) => bytes.subarray(0, 32).toString('utf8').startsWith(prefix)) ?? null,
          };
        resolve({ status: res.statusCode ?? 0, headers, body: bytes.toString('utf8') });
      });
    });
    req.on('error', reject);
  });
}

interface RunningServer {
  child: ChildProcess;
  port: number;
  host: string;
}

function startServer(extraArgs: string[] = []): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverScript, ...extraArgs], {
      env: { ...process.env, VIS_PORT: '0', VIS_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out = child.stdout;
    const err = child.stderr;
    if (!out || !err) {
      reject(new Error('server child has no stdout/stderr pipe'));
      return;
    }

    let observation: LiveServerObservation | undefined;
    child.once('close', () => {
      if (observation && liveServers.get(observation.listening.port) === observation) {
        liveServers.delete(observation.listening.port);
      }
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not report listening; stdout: ${output}`));
    }, 10_000);

    out.setEncoding('utf8');
    out.on('data', (chunk: string) => {
      output += chunk;
      const match = listeningLine.exec(output);
      if (match) {
        clearTimeout(timer);
        if (!observation) {
          const upstream = extraArgs[0] === 'proxy' && extraArgs[1] ? new URL(extraArgs[1]) : null;
          observation = {
            pid: child.pid ?? null,
            mode: extraArgs[0] === 'proxy' ? 'proxy' : 'static',
            upstream:
              upstream && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
                ? {
                    host: upstream.hostname,
                    port: Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)),
                    path: upstream.pathname.slice(0, 256),
                  }
                : null,
            listening: { host: match[1], port: Number(match[2]) },
            exit: null,
          };
          liveServers.set(observation.listening.port, observation);
        }
        resolve({ child, host: match[1], port: Number(match[2]) });
      }
    });
    child.on('exit', (code, signal) => {
      if (observation) observation.exit = { code, signal };
      clearTimeout(timer);
      if (!listeningLine.test(output)) {
        reject(new Error(`server exited before listening (code ${code}); stdout: ${output}`));
      }
    });
  });
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // exitCode stays null when the child was killed by a signal; signalCode
    // is set in that case, so either non-null means the child is gone.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

async function expectPortReleased(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await canBindPort(port)).toBe(true);
}

function startFixture(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    let observation: LiveFixtureObservation | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const candidate: LiveFixtureObservation['requests'][number] = {
        path: url.pathname.slice(0, 256),
        socket: {
          localAddress: req.socket.localAddress,
          localPort: req.socket.localPort,
          remoteAddress: req.socket.remoteAddress,
          remotePort: req.socket.remotePort,
        },
        finish: null,
      };
      if (observation && observation.requests.length < 8) observation.requests.push(candidate);
      const literal =
        url.pathname === '/api/items'
          ? '{"items":[1,2,3]}'
          : url.pathname === '/status/201'
            ? 'created'
            : url.pathname === '/echo'
              ? `path=${req.url}`
              : 'fixture 404';
      res.once('finish', () => {
        candidate.finish = {
          status: res.statusCode,
          bodyBytes: Buffer.byteLength(literal),
          bodySha256: createHash('sha256').update(literal).digest('hex'),
        };
      });
      if (url.pathname === '/api/items') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-fixture': 'yes' });
        res.end('{"items":[1,2,3]}');
      } else if (url.pathname === '/status/201') {
        res.writeHead(201, { 'content-type': 'text/plain' });
        res.end('created');
      } else if (url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`path=${req.url}`);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('fixture 404');
      }
    });
    server.once('close', () => {
      if (observation) {
        observation.closed = true;
        if (liveFixtures.get(observation.port) === observation)
          liveFixtures.delete(observation.port);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error(`unexpected fixture address ${String(address)}`);
      }
      observation = { port: address.port, closed: false, requests: [] };
      liveFixtures.set(address.port, observation);
      resolve({ server, port: address.port });
    });
  });
}

describe('server.js live contract', () => {
  const children: ChildProcess[] = [];
  const fixtures: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map((child) => stopServer(child).catch(() => undefined)),
    );
    await Promise.all(
      fixtures.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function startTrackedServer(extraArgs: string[] = []): Promise<RunningServer> {
    const running = await startServer(extraArgs);
    children.push(running.child);
    return running;
  }

  async function startTrackedFixture(): Promise<{ server: Server; port: number }> {
    const fixture = await startFixture();
    fixtures.push(fixture.server);
    return fixture;
  }

  describe('static mode', () => {
    it('serves the built index.html at the static root', async () => {
      const { child, port } = await startTrackedServer();
      const expected = await readFile(join(distDir, 'index.html'), 'utf8');

      const response = await request(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.body).toBe(expected);

      await stopServer(child);
    });

    it('serves a built asset byte-for-byte', async () => {
      const { child, port } = await startTrackedServer();
      const assets = await readdir(join(distDir, 'assets'));
      const assetName = assets.find((name) => name.endsWith('.js'));
      expect(assetName).toBeDefined();
      if (!assetName) throw new Error('no built js asset under dist/assets');
      const expected = await readFile(join(distDir, 'assets', assetName), 'utf8');

      const response = await request(`http://127.0.0.1:${port}/assets/${assetName}`);
      expect(response.status).toBe(200);
      expect(response.body).toBe(expected);

      await stopServer(child);
    });

    it('answers 404 for a missing static path', async () => {
      const { child, port } = await startTrackedServer();

      const response = await request(
        `http://127.0.0.1:${port}/definitely-missing-${Date.now()}`,
      );
      expect(response.status).toBe(404);

      await stopServer(child);
    });
  });

  describe('proxy mode', () => {
    it('forwards the proxy path and passes status, body and headers through', async () => {
      const fixture = await startTrackedFixture();
      const { child, port } = await startTrackedServer([
        'proxy',
        `http://127.0.0.1:${fixture.port}`,
      ]);

      const response = await request(`http://127.0.0.1:${port}/api/items`);
      expect(response.status).toBe(200);
      expect(response.headers['x-fixture']).toBe('yes');
      expect(JSON.parse(response.body)).toEqual({ items: [1, 2, 3] });

      await stopServer(child);
    });

    it('passes through a non-200 upstream status', async () => {
      const fixture = await startTrackedFixture();
      const { child, port } = await startTrackedServer([
        'proxy',
        `http://127.0.0.1:${fixture.port}`,
      ]);

      const response = await request(`http://127.0.0.1:${port}/status/201`);
      expect(response.status).toBe(201);
      expect(response.body).toBe('created');

      await stopServer(child);
    });

    it('preserves the request path and forwards query parameters', async () => {
      const fixture = await startTrackedFixture();
      const { child, port } = await startTrackedServer([
        'proxy',
        `http://127.0.0.1:${fixture.port}`,
      ]);

      const response = await request(`http://127.0.0.1:${port}/echo?a=1&b=two`);
      expect(response.status).toBe(200);
      expect(response.body).toBe('path=/echo?a=1&b=two');

      await stopServer(child);
    });
  });

  describe('bind and shutdown', () => {
    it('binds to 127.0.0.1 on an ephemeral port and reclaims it after shutdown', async () => {
      const { child, host, port } = await startTrackedServer();

      expect(host).toBe('127.0.0.1');
      expect(port).toBeGreaterThan(0);
      expect(await canBindPort(port)).toBe(false);

      await stopServer(child);
      await expectPortReleased(port);
    });

    it('reclaims the proxy and fixture ports after shutdown', async () => {
      const fixture = await startTrackedFixture();
      const { child, port } = await startTrackedServer([
        'proxy',
        `http://127.0.0.1:${fixture.port}`,
      ]);

      expect(await canBindPort(port)).toBe(false);
      expect(await canBindPort(fixture.port)).toBe(false);

      await stopServer(child);
      await expectPortReleased(port);

      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
      await expectPortReleased(fixture.port);
    });
  });
});
