import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVisBridgeServer } from '../vis_bridge.js';

function listen(server: Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('vis_bridge workspace surface', () => {
  let root = '';
  let outside = '';
  let server: Server;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vis-bridge-workspace-'));
    outside = await mkdtemp(path.join(tmpdir(), 'vis-bridge-outside-'));
    server = createVisBridgeServer({
      host: '127.0.0.1',
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      bridgeToken: 'secret',
    });
  });

  afterEach(async () => {
    await close(server);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('lists directories and executes one-shot commands behind bridge authentication', async () => {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'main.ts'), 'export {}');
    const port = await listen(server);
    const headers = { Authorization: 'Bearer secret' };

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/fs/list?${new URLSearchParams({ root, path: 'src', token: 'secret' })}`,
    );
    await expect(listResponse.json()).resolves.toEqual([
      { name: 'main.ts', path: 'src/main.ts', type: 'file' },
    ]);
    const execResponse = await fetch(`http://127.0.0.1:${port}/command/exec?token=secret`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        directory: root,
        command: process.execPath,
        args: ['-e', "process.stdout.write('ok')"],
      }),
    });
    await expect(execResponse.json()).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('does not follow a writable leaf symlink outside the workspace root', async () => {
    const outsideFile = path.join(outside, 'secret.txt');
    await writeFile(outsideFile, 'safe');
    await symlink(outsideFile, path.join(root, 'linked.txt'));
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/fs/writeFile?token=secret`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: path.join(root, 'linked.txt'), content: 'escaped' }),
    });

    expect(response.ok).toBe(false);
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('safe');
  });
});
