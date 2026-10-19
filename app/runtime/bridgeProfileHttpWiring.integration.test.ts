import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createVisBridgeServer } from '../../vis_bridge';
import type { BridgeRuntime } from '../../bridge/bridgeRuntime.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';

type TestServer = ReturnType<typeof createVisBridgeServer>;

/** Supervisor runtime boundary stub: starts no service and knows nothing about profiles. */
function runtimeStub(): BridgeRuntime {
  return {
    getStatus: () => ({ services: [], acpAgents: [] }),
    stop: async () => {},
  } as unknown as BridgeRuntime;
}

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: TestServer) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  return address.port;
}

function requestJson(
  port: number,
  requestPath: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/** Binds `defaultBridgeConfigPath()` to a per-test directory for the bridge's lifetime. */
async function withConfigHome<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-profile-wiring-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  try {
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const environment = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const profileInput = {
  name: 'Workstation',
  transport: { kind: 'local' },
  target: { kind: 'local', environmentId: environment },
  role: 'local',
  credentialRef: 'cred-1',
};

describe('profile HTTP API reaches the real vis_bridge request listener', () => {
  it('serves GET/POST /api/v1/profiles through the actual server dispatch', async () => {
    await withConfigHome(async (directory) => {
      const server = createVisBridgeServer({
        path: '/codex',
        target: 'ws://127.0.0.1:1',
        runtime: runtimeStub(),
      });
      const port = await listen(server);

      const empty = await requestJson(port, '/api/v1/profiles', 'GET');
      expect(empty).toEqual({ status: 200, body: { profiles: [] } });

      const created = await requestJson(port, '/api/v1/profiles', 'POST', profileInput);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Workstation', enabled: false });

      const listed = await requestJson(port, '/api/v1/profiles', 'GET');
      expect(listed.status).toBe(200);
      expect((listed.body as { profiles: unknown[] }).profiles).toHaveLength(1);

      // The production wiring owns persistence: the profile landed in the document
      // derived from the bridge config location both clients share.
      const persisted = JSON.parse(
        await readFile(path.join(directory, 'vis', 'profiles.json'), 'utf8'),
      ) as { profiles: unknown[] };
      expect(persisted.profiles).toHaveLength(1);

      // With a supervisor runtime present, the profile surface is still routed by
      // its own handler while the supervisor route resolves through its own.
      const supervisor = await requestJson(port, '/api/v1/supervisor', 'GET');
      expect(supervisor).toEqual({ status: 200, body: { services: [], acpAgents: [] } });
    });
  });

  it('keeps the profile routes behind the existing bridge authentication check', async () => {
    await withConfigHome(async () => {
      const server = createVisBridgeServer({
        path: '/codex',
        target: 'ws://127.0.0.1:1',
        bridgeToken: 'secret-token',
      });
      const port = await listen(server);

      const unauthenticated = await requestJson(port, '/api/v1/profiles', 'GET');
      expect(unauthenticated).toEqual({ status: 401, body: { error: 'Unauthorized' } });

      const authenticated = await requestJson(port, '/api/v1/profiles', 'GET', undefined, {
        Authorization: 'Bearer secret-token',
      });
      expect(authenticated).toEqual({ status: 200, body: { profiles: [] } });
    });
  });
});
