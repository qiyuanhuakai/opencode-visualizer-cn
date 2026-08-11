import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { get as httpGet, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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
});

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function request(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers[name] = value;
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
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
        resolve({ child, host: match[1], port: Number(match[2]) });
      }
    });
    child.on('exit', (code) => {
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

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const cleanup = () => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.destroy();
    };
    const onConnect = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(false);
    };
    const onTimeout = () => {
      // Could not prove the port is closed; report as listening.
      cleanup();
      resolve(true);
    };
    socket.setTimeout(2_000);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

async function expectPortReleased(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await probePort(port)).toBe(false);
}

function startFixture(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error(`unexpected fixture address ${String(address)}`);
      }
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
      expect(await probePort(port)).toBe(true);

      await stopServer(child);
      await expectPortReleased(port);
    });

    it('reclaims the proxy and fixture ports after shutdown', async () => {
      const fixture = await startTrackedFixture();
      const { child, port } = await startTrackedServer([
        'proxy',
        `http://127.0.0.1:${fixture.port}`,
      ]);

      expect(await probePort(port)).toBe(true);
      expect(await probePort(fixture.port)).toBe(true);

      await stopServer(child);
      await expectPortReleased(port);

      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
      await expectPortReleased(fixture.port);
    });
  });
});
