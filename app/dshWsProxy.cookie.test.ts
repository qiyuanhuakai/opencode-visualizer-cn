import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { UpstreamAuthorization } from '../bridge/codexWebSocketProxy.js';
import { connectUpstreamWebSocket } from '../bridge/codexWebSocketProxy.js';
import { createWebSocketAccept } from '../bridge/webSocketFrames.js';

// The hand-maintained bridge/codexWebSocketProxy.d.ts still types the
// authorization parameter as the legacy `string | (() => string)`; the widened
// runtime contract gains the credential object below. The cast keeps this spec
// compiling until the declaration file catches up with the implementation.
type UpstreamCredentials = {
  readonly authorization?: string | (() => string);
  readonly cookie?: string | (() => string);
};

function credentials(value: UpstreamCredentials): UpstreamAuthorization {
  return value as unknown as UpstreamAuthorization;
}

const servers: Server[] = [];
const sockets = new Set<Socket>();
const handshakes: string[] = [];

function headersOf(handshake: string) {
  const headers = new Map<string, string>();
  for (const line of handshake.split('\r\n').slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

async function upstreamTarget(): Promise<string> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let request = '';
    let handshakeSeen = false;
    socket.on('data', (chunk) => {
      request += String(chunk);
      const headerEnd = request.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      if (!handshakeSeen) {
        handshakeSeen = true;
        handshakes.push(request.slice(0, headerEnd));
        const key = /^Sec-WebSocket-Key:\s*(.+)$/imu.exec(request)?.[1]?.trim();
        if (key) {
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
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address unavailable.');
  return `ws://127.0.0.1:${address.port}/api/remote.mux`;
}

async function dialUpstream(target: string, authorization: UpstreamAuthorization | undefined) {
  const before = handshakes.length;
  const upstream = await connectUpstreamWebSocket(target, authorization);
  upstream.socket.destroy();
  const handshake = handshakes[before];
  if (handshake === undefined) throw new Error('Upstream handshake was not captured.');
  return headersOf(handshake);
}

afterEach(async () => {
  handshakes.length = 0;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('dsh upstream WebSocket handshake cookie support', () => {
  it('writes Authorization and Cookie headers from the object form', async () => {
    const target = await upstreamTarget();

    const headers = await dialUpstream(
      target,
      credentials({ authorization: 'Bearer dsh-token-1', cookie: 'authority=abc123' }),
    );

    expect(handshakes).toHaveLength(1);
    expect(headers.get('authorization')).toBe('Bearer dsh-token-1');
    expect(headers.get('cookie')).toBe('authority=abc123');
  });

  it('writes only the Cookie header when authorization is absent', async () => {
    const target = await upstreamTarget();

    const headers = await dialUpstream(target, credentials({ cookie: 'authority=only-cookie' }));

    expect(headers.get('cookie')).toBe('authority=only-cookie');
    expect(headers.has('authorization')).toBe(false);
    expect(handshakes[0]).not.toContain('Authorization:');
  });

  it('omits the Cookie header when the object carries no cookie', async () => {
    const target = await upstreamTarget();

    const headers = await dialUpstream(target, credentials({ authorization: 'Bearer auth-only' }));

    expect(headers.get('authorization')).toBe('Bearer auth-only');
    expect(headers.has('cookie')).toBe(false);
    expect(handshakes[0]).not.toContain('Cookie:');
  });

  it('resolves cookie providers fresh on every dial', async () => {
    const target = await upstreamTarget();
    let cookie = 'authority=first-111';

    const first = await dialUpstream(target, credentials({ cookie: () => cookie }));
    cookie = 'authority=second-222';
    const second = await dialUpstream(target, credentials({ cookie: () => cookie }));

    expect(first.get('cookie')).toBe('authority=first-111');
    expect(second.get('cookie')).toBe('authority=second-222');
  });

  it('resolves authorization providers fresh on every dial inside the object form', async () => {
    const target = await upstreamTarget();
    let authorization = 'Bearer token-first';

    const first = await dialUpstream(
      target,
      credentials({ authorization: () => authorization, cookie: 'authority=static-777' }),
    );
    authorization = 'Bearer token-second';
    const second = await dialUpstream(
      target,
      credentials({ authorization: () => authorization, cookie: 'authority=static-777' }),
    );

    expect(first.get('authorization')).toBe('Bearer token-first');
    expect(first.get('cookie')).toBe('authority=static-777');
    expect(second.get('authorization')).toBe('Bearer token-second');
    expect(second.get('cookie')).toBe('authority=static-777');
  });

  it('keeps the legacy string form writing Authorization without a Cookie header', async () => {
    const target = await upstreamTarget();

    const headers = await dialUpstream(target, 'Bearer legacy-string');

    expect(headers.get('authorization')).toBe('Bearer legacy-string');
    expect(headers.has('cookie')).toBe(false);
  });

  it('keeps the legacy function form writing Authorization without a Cookie header', async () => {
    const target = await upstreamTarget();

    const headers = await dialUpstream(target, () => 'Bearer legacy-function');

    expect(headers.get('authorization')).toBe('Bearer legacy-function');
    expect(headers.has('cookie')).toBe(false);
  });

  it('omits both credential headers when no credentials are configured', async () => {
    const target = await upstreamTarget();

    const headers = await dialUpstream(target, undefined);

    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
  });
});
