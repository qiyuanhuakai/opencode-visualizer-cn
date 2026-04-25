import { once } from 'node:events';
import { get } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createVisBridgeServer } from '../vis_bridge';

type TestServer = ReturnType<typeof createVisBridgeServer>;

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

async function listen(server: TestServer) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
  return address.port;
}

async function readHttpBody(port: number, path: string) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}${path}`, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
      });
    });
    request.on('error', reject);
  });
}

async function sendUpgrade(port: number, path: string, authorization?: string) {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
  ];
  if (authorization) headers.push(`Authorization: ${authorization}`);
  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  const [chunk] = await once(socket, 'data') as [Buffer];
  socket.destroy();
  return chunk.toString('utf8');
}

describe('vis_bridge', () => {
  it('serves health checks', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:4500',
    });
    const port = await listen(server);

    await expect(readHttpBody(port, '/healthz')).resolves.toEqual({
      status: 200,
      body: { ok: true, service: 'vis_bridge' },
    });
  });

  it('rejects WebSocket upgrades on the wrong path before contacting upstream', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
    });
    const port = await listen(server);

    const response = await sendUpgrade(port, '/wrong');

    expect(response).toContain('HTTP/1.1 404 Not Found');
    expect(response).toContain('Use WebSocket path /codex');
  });

  it('requires bridge auth when configured', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      bridgeToken: 'secret-token',
    });
    const port = await listen(server);

    const rejected = await sendUpgrade(port, '/codex');
    expect(rejected).toContain('HTTP/1.1 401 Unauthorized');

    const authorizedButNoUpstream = await sendUpgrade(port, '/codex', 'Bearer secret-token');
    expect(authorizedButNoUpstream).toContain('HTTP/1.1 502 Bad Gateway');
  });
});
