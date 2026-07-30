import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createVisBridgeServer } from '../vis_bridge';

type TestServer = ReturnType<typeof createVisBridgeServer>;

const RELEASE_ORIGINS = ['app://index.html', 'https://qiyuanhuakai.github.io'] as const;
const UNTRUSTED_ORIGINS = ['null', 'app://other.html', 'https://example.com'] as const;
const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
});

async function listen(server: TestServer): Promise<number> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  return address.port;
}

async function readHttpStatus(port: number, origin: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/homedir',
        method: 'GET',
        headers: { Origin: origin },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function sendUpgrade(port: number, origin: string): Promise<string> {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write(
    [
      'GET /codex HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Origin: ${origin}`,
      '',
      '',
    ].join('\r\n'),
  );
  const [chunk] = (await once(socket, 'data')) as [Buffer];
  socket.destroy();
  return chunk.toString('utf8');
}

describe('vis_bridge release renderer origins', () => {
  it.each(RELEASE_ORIGINS)('allows HTTP requests from %s', async (origin) => {
    const server = createVisBridgeServer({ path: '/codex', target: 'ws://127.0.0.1:1' });
    const port = await listen(server);

    await expect(readHttpStatus(port, origin)).resolves.toBe(200);
  });

  it.each(RELEASE_ORIGINS)('allows WebSocket upgrades from %s', async (origin) => {
    const server = createVisBridgeServer({ path: '/codex', target: 'ws://127.0.0.1:1' });
    const port = await listen(server);

    await expect(sendUpgrade(port, origin)).resolves.toContain('HTTP/1.1 502 Bad Gateway');
  });

  it.each(UNTRUSTED_ORIGINS)('rejects HTTP requests from %s', async (origin) => {
    const server = createVisBridgeServer({ path: '/codex', target: 'ws://127.0.0.1:1' });
    const port = await listen(server);

    await expect(readHttpStatus(port, origin)).resolves.toBe(403);
  });

  it.each(UNTRUSTED_ORIGINS)('rejects WebSocket upgrades from %s', async (origin) => {
    const server = createVisBridgeServer({ path: '/codex', target: 'ws://127.0.0.1:1' });
    const port = await listen(server);

    await expect(sendUpgrade(port, origin)).resolves.toContain('HTTP/1.1 403 Forbidden');
  });
});
