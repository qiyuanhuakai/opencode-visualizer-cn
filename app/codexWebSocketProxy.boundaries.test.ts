import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { connectUpstreamWebSocket } from '../bridge/codexWebSocketProxy.js';
import { createWebSocketAccept } from '../bridge/webSocketFrames.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();

async function upstreamTarget(onRequest?: (socket: Socket, request: string) => void): Promise<string> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let request = '';
    socket.on('data', (chunk) => {
      request += String(chunk);
      if (request.includes('\r\n\r\n')) onRequest?.(socket, request);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address unavailable.');
  return `ws://127.0.0.1:${address.port}/codex`;
}

async function outcome(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: Error) => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'pending' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'pending' }), 100),
    ),
  ]);
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('Codex upstream WebSocket handshake boundaries', () => {
  it('rejects an upstream that stalls before sending HTTP headers', async () => {
    const target = await upstreamTarget();

    const result = await outcome(
      connectUpstreamWebSocket(target, undefined, { handshakeTimeoutMs: 20 }),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.error.message).toContain('timed out');
  });

  it('rejects upstream headers that exceed the configured limit', async () => {
    const target = await upstreamTarget((socket) => socket.write('x'.repeat(2048)));

    const result = await outcome(
      connectUpstreamWebSocket(target, undefined, {
        handshakeTimeoutMs: 80,
        maxHeaderBytes: 1024,
      }),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.error.message).toContain('headers exceeded');
  });

  it('rejects a 101 response without the required WebSocket headers', async () => {
    const target = await upstreamTarget((socket) =>
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n'),
    );

    const result = await outcome(connectUpstreamWebSocket(target, undefined));

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.error.message).toContain('invalid WebSocket handshake');
  });

  it('accepts a complete RFC 6455 upstream handshake', async () => {
    const target = await upstreamTarget((socket, request) => {
      const key = /^Sec-WebSocket-Key:\s*(.+)$/imu.exec(request)?.[1]?.trim();
      if (!key) throw new Error('Handshake key missing.');
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: keep-alive, Upgrade',
          `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
          '',
          '',
        ].join('\r\n'),
      );
    });

    const result = await connectUpstreamWebSocket(target, undefined);

    result.socket.destroy();
    expect(result.head).toHaveLength(0);
  });
});
