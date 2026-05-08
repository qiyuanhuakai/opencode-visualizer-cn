import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function readHttpBody(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
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
    request.end();
  });
}

async function requestJson(
  port: number,
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function sendUpgrade(port: number, path: string, authorization?: string, origin?: string) {
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
  if (origin) headers.push(`Origin: ${origin}`);
  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  const [chunk] = await once(socket, 'data') as [Buffer];
  socket.destroy();
  return chunk.toString('utf8');
}

function encodeMaskedWebSocketFrame(data: string | Buffer, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const mask = randomBytes(4);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4];
  }
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | length]), mask, maskedPayload]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, mask, maskedPayload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, mask, maskedPayload]);
}

function decodeServerFrames(buffer: Buffer) {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const frameLength = headerLength + length;
    if (buffer.length - offset < frameLength) break;
    const payload = buffer.subarray(offset + headerLength, offset + frameLength);
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

async function openWebSocket(port: number, path: string) {
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
  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  const [chunk] = await once(socket, 'data') as [Buffer];
  const marker = Buffer.from('\r\n\r\n');
  const index = chunk.indexOf(marker);
  if (index < 0) throw new Error('Expected WebSocket upgrade response.');
  return {
    socket,
    initialData: chunk.subarray(index + marker.length),
  };
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

  it('requires bridge auth for HTTP metadata endpoints when configured', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      bridgeToken: 'secret-token',
    });
    const port = await listen(server);

    await expect(readHttpBody(port, '/homedir')).resolves.toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    await expect(readHttpBody(port, '/healthz')).resolves.toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    await expect(readHttpBody(port, '/readyz?token=secret-token')).resolves.toEqual({
      status: 200,
      body: { ok: true, service: 'vis_bridge' },
    });

    const homedir = await readHttpBody(port, '/homedir', { Authorization: 'Bearer secret-token' });
    expect(homedir.status).toBe(200);
    expect(homedir.body).toEqual({ home: expect.any(String) });
  });

  it('rejects non-loopback browser origins for HTTP metadata endpoints', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
    });
    const port = await listen(server);

    await expect(readHttpBody(port, '/homedir', { Origin: 'https://example.com' })).resolves.toEqual({
      status: 403,
      body: { error: 'Forbidden origin' },
    });
  });

  it('rejects non-loopback browser origins before contacting upstream', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
    });
    const port = await listen(server);

    const rejected = await sendUpgrade(port, '/codex', undefined, 'https://example.com');
    expect(rejected).toContain('HTTP/1.1 403 Forbidden');

    const loopbackButNoUpstream = await sendUpgrade(port, '/codex', undefined, 'http://localhost:5173');
    expect(loopbackButNoUpstream).toContain('HTTP/1.1 502 Bad Gateway');
  });

  it('serves OpenCode-compatible PTY REST endpoints through a PTY module', async () => {
    const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown>; killed: boolean; resized?: [number, number] }> = [];
    const ptyModule = {
      spawn(command: string, args: string[], options: Record<string, unknown>) {
        const item = { command, args, options, killed: false, resized: undefined as [number, number] | undefined };
        spawned.push(item);
        return {
          onData: () => ({ dispose: () => {} }),
          onExit: () => ({ dispose: () => {} }),
          write: () => {},
          resize: (cols: number, rows: number) => { item.resized = [cols, rows]; },
          kill: () => { item.killed = true; },
        };
      },
    };
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      ptyModule,
    });
    const port = await listen(server);

    const created = await requestJson(port, '/pty', 'POST', { cwd: '/repo', command: 'bash', args: ['-l'], title: 'Shell' });
    expect(created.status).toBe(200);
    const id = (created.body as { id: string }).id;
    expect(id).toEqual(expect.any(String));
    expect(spawned[0]).toMatchObject({ command: 'bash', args: ['-l'], options: { cwd: '/repo' } });

    await expect(readHttpBody(port, '/pty')).resolves.toEqual({
      status: 200,
      body: [expect.objectContaining({ id, cwd: '/repo', title: 'Shell' })],
    });

    await expect(requestJson(port, `/pty/${id}`, 'PUT', { size: { rows: 40, cols: 120 } })).resolves.toEqual({
      status: 200,
      body: {},
    });
    expect(spawned[0]?.resized).toEqual([120, 40]);

    await expect(requestJson(port, `/pty/${id}`, 'DELETE')).resolves.toEqual({
      status: 200,
      body: {},
    });
    expect(spawned[0]?.killed).toBe(true);
  });

  it('retains exited PTY briefly for replay and emits exit meta', async () => {
    let exitHandler: ((event?: { exitCode?: number }) => void) | undefined;
    let dataHandler: ((data: string) => void) | undefined;
    const ptyModule = {
      spawn() {
        return {
          onData(callback: (data: string) => void) {
            dataHandler = callback;
            return { dispose: () => { dataHandler = undefined; } };
          },
          onExit(callback: (event?: { exitCode?: number }) => void) {
            exitHandler = callback;
            return { dispose: () => { exitHandler = undefined; } };
          },
          write: () => {},
          resize: () => {},
          kill: () => {},
        };
      },
    };
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      ptyModule,
    });
    const port = await listen(server);

    const created = await requestJson(port, '/pty', 'POST', { cwd: '/repo', command: 'bash', args: ['-lc', 'echo hi'], title: 'One-shot PTY' });
    expect(created.status).toBe(200);
    const id = (created.body as { id: string }).id;

    dataHandler?.('editor-output\n');
    exitHandler?.({ exitCode: 0 });

    await expect(readHttpBody(port, '/pty')).resolves.toEqual({
      status: 200,
      body: [expect.objectContaining({ id, status: 'exited', exitCode: 0 })],
    });

    const { socket, initialData } = await openWebSocket(port, `/pty/${id}/connect`);
    socket.write(encodeMaskedWebSocketFrame('ping', 9));
    const chunks: Buffer[] = initialData.length > 0 ? [initialData] : [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    socket.on('data', onData);
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.off('data', onData);
    socket.destroy();

    const decoded = decodeServerFrames(Buffer.concat(chunks));
    const textPayloads = decoded.frames
      .filter((frame) => frame.opcode === 1)
      .map((frame) => frame.payload.toString('utf8'));
    const binaryPayloads = decoded.frames.filter((frame) => frame.opcode === 2).map((frame) => frame.payload);
    const closeFrame = decoded.frames.find((frame) => frame.opcode === 8);

    expect(textPayloads.join('')).toContain('editor-output');
    expect(binaryPayloads.some((payload) => payload[0] === 0 && payload.subarray(1).toString('utf8').includes('"exitCode":0'))).toBe(true);
    expect(closeFrame).toBeTruthy();
  });

  it('rejects PTY endpoints on non-loopback hosts without bridge auth', async () => {
    const server = createVisBridgeServer({
      host: '0.0.0.0',
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      ptyModule: {
        spawn: () => {
          throw new Error('should not spawn');
        },
      },
    });
    const port = await listen(server);

    await expect(requestJson(port, '/pty', 'POST', { cwd: '/repo' })).resolves.toEqual({
      status: 403,
      body: { error: 'PTY requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.' },
    });
  });

  it('serves bridge-backed fs read and write endpoints', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
    });
    const port = await listen(server);
    const dir = await mkdtemp(path.join(tmpdir(), 'vis-bridge-fs-'));
    const filePath = path.join(dir, 'note.txt');
    await writeFile(filePath, 'hello bridge', 'utf8');

    await expect(readHttpBody(port, `/fs/readFile?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(dir)}`)).resolves.toEqual({
      status: 200,
      body: {
        path: filePath,
        content: 'hello bridge',
        dataBase64: Buffer.from('hello bridge', 'utf8').toString('base64'),
        encoding: 'utf-8',
        type: 'text',
      },
    });

    await expect(requestJson(port, '/fs/writeFile', 'POST', { path: filePath, root: dir, content: 'updated bridge' })).resolves.toEqual({
      status: 200,
      body: { path: filePath },
    });
    await expect(readFile(filePath, 'utf8')).resolves.toBe('updated bridge');
    await expect(readHttpBody(port, `/fs/capabilities?root=${encodeURIComponent(dir)}`)).resolves.toEqual({
      status: 200,
      body: { root: dir, writable: true },
    });
  });

  it('rejects fs access outside declared root', async () => {
    const server = createVisBridgeServer({
      path: '/codex',
      target: 'ws://127.0.0.1:1',
    });
    const port = await listen(server);
    const dir = await mkdtemp(path.join(tmpdir(), 'vis-bridge-fs-root-'));
    const sibling = await mkdtemp(path.join(tmpdir(), 'vis-bridge-fs-sibling-'));
    const outsideFile = path.join(sibling, 'outside.txt');
    await writeFile(outsideFile, 'outside', 'utf8');

    await expect(readHttpBody(port, `/fs/readFile?path=${encodeURIComponent(outsideFile)}&root=${encodeURIComponent(dir)}`)).resolves.toEqual({
      status: 500,
      body: { error: 'File path is outside the allowed root.' },
    });
  });

  it('rejects unprotected fs endpoints on non-loopback hosts without bridge auth', async () => {
    const server = createVisBridgeServer({
      host: '0.0.0.0',
      path: '/codex',
      target: 'ws://127.0.0.1:1',
    });
    const port = await listen(server);
    await expect(requestJson(port, '/fs/writeFile', 'POST', { path: '/tmp/file.txt', root: '/tmp', content: 'x' })).resolves.toEqual({
      status: 403,
      body: { error: 'FS requires VIS_BRIDGE_TOKEN when vis_bridge listens on a non-loopback host.' },
    });
  });

  it('allows fs endpoints on non-loopback hosts when bridge auth is configured', async () => {
    const server = createVisBridgeServer({
      host: '0.0.0.0',
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      bridgeToken: 'secret-token',
    });
    const port = await listen(server);
    const dir = await mkdtemp(path.join(tmpdir(), 'vis-bridge-fs-auth-'));
    const filePath = path.join(dir, 'token.txt');
    await writeFile(filePath, 'authorized', 'utf8');

    await expect(readHttpBody(
      port,
      `/fs/readFile?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(dir)}&token=secret-token`,
    )).resolves.toEqual({
      status: 200,
      body: {
        path: filePath,
        content: 'authorized',
        dataBase64: Buffer.from('authorized', 'utf8').toString('base64'),
        encoding: 'utf-8',
        type: 'text',
      },
    });
  });
});
