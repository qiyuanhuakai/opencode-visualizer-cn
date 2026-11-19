import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkspaceService } from '../../bridge/runtime/workspaceService.js';
import { parseRuntimeParams, parseRuntimeResult } from '../../shared/runtime/runtimeWire.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-app-workspace-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = randomUUID(), epoch = randomUUID();
  const service = await createWorkspaceService({ target, epoch, roots: [{ root, permissions: ['read', 'write', 'pty'] }] });
  cleanups.push(() => service.close());
  const workspaceKey = service.workspaces[0]!.key;
  const client = service.connect({ target, epoch, generation: 1, subscriberId: randomUUID(), assertCurrent() {} });
  return { root, workspaceKey, client };
}

describe('Bridge workspace surfaces', () => {
  it('uses the Bridge default shell and terminates its owned process on remove', async () => {
    const { root } = await setup();
    const serviceUrl = pathToFileURL(path.resolve('bridge/runtime/workspaceService.js')).href;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { createWorkspaceService } from ${JSON.stringify(serviceUrl)};
      import { randomUUID } from 'node:crypto';
      import { setTimeout as delay } from 'node:timers/promises';
      import assert from 'node:assert/strict';
      const target = randomUUID(), epoch = randomUUID();
      const service = await createWorkspaceService({ target, epoch, roots: [{ root: ${JSON.stringify(root)}, permissions: ['read', 'write', 'pty'] }] });
      try {
        const workspaceKey = service.workspaces[0].key;
        const client = service.connect({ target, epoch, generation: 1, subscriberId: randomUUID(), assertCurrent() {} });
        const pty = await client.ptys.create({ workspaceKey });
        client.ptys.subscribe(pty.ptyId);
        client.ptys.write(pty.ptyId, "printf 'NATIVE_%s\\n' DEFAULT_SHELL_OK\\n");
        let output = '';
        const deadline = Date.now() + 5000;
        while (!output.includes('NATIVE_DEFAULT_SHELL_OK') && Date.now() < deadline) {
          for (const chunk of client.ptys.read(pty.ptyId).chunks) {
            output += Buffer.from(chunk.data).toString('utf8');
            client.ptys.acknowledge(pty.ptyId, chunk);
          }
          await delay(20);
        }
        assert.ok(output.includes('NATIVE_DEFAULT_SHELL_OK'));
        await client.ptys.remove(pty.ptyId);
        assert.throws(() => process.kill(pty.pid, 0));
        console.log('DEFAULT_SHELL_AND_PROCESS_REMOVAL_PASS');
      } finally { await service.close(); }
    `], { timeout: 15000 });
    expect(stdout).toContain('DEFAULT_SHELL_AND_PROCESS_REMOVAL_PASS');
  }, 20_000); // The child has a separate 15-second timeout covering PTY startup and teardown.
  it('pages directory entries and file bytes, rejecting changes and escaped symlinks', async () => {
    const { root, workspaceKey, client } = await setup();
    await mkdir(path.join(root, 'dir'));
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(root, 'dir', `${index}.txt`), String(index))));
    const first = await client.reads.list({ workspaceKey, path: 'dir', limit: 200 });
    expect(first.items).toHaveLength(200);
    const next = await client.reads.list({ workspaceKey, path: 'dir', offset: first.nextOffset!, version: first.version });
    expect(next.items).toHaveLength(5);
    expect(next.nextOffset).toBeNull();
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(70000));
    const head = await client.reads.read({ workspaceKey, path: 'large.txt' });
    expect(Buffer.from(head.dataBase64, 'base64')).toHaveLength(65536);
    const tail = await client.reads.read({ workspaceKey, path: 'large.txt', offset: head.nextOffset!, version: head.version });
    expect(Buffer.from(tail.dataBase64, 'base64')).toHaveLength(4464);
    expect(tail.nextOffset).toBeNull();
    await writeFile(path.join(root, 'large.txt'), 'changed');
    await expect(client.reads.read({ workspaceKey, path: 'large.txt', offset: 0, version: head.version })).rejects.toThrow('workspace.file_changed');
    await symlink(tmpdir(), path.join(root, 'outside'));
    await expect(client.reads.list({ workspaceKey, path: 'outside' })).rejects.toThrow('outside the allowed root');
  });

  it('preserves existing-file protection unless explicit edit replacement is requested', async () => {
    const { root, workspaceKey, client } = await setup();
    const file = path.join(root, 'script.sh');
    await writeFile(file, 'before', { mode: 0o755 });
    const bytes = Buffer.from('after');
    async function upload(replace: boolean) {
      const channel = await client.files.open({ workspaceKey, path: 'script.sh', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), replace });
      const chunk = await client.files.append({ channelId: channel.channelId, offset: 0, data: bytes });
      client.files.acknowledge(chunk);
      return client.files.finish(channel.channelId);
    }
    await expect(upload(false)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('before');
    await upload(true);
    expect(await readFile(file, 'utf8')).toBe('after');
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it('validates optional server shell and bounded workspace wire results', async () => {
    const { workspaceKey, client } = await setup();
    expect(parseRuntimeParams('runtime.pty.create', { workspaceKey })).toEqual({ workspaceKey });
    const info = await client.reads.info({ workspaceKey });
    expect(parseRuntimeResult('runtime.workspace.info', info)).toMatchObject({ directory: info.directory });
    expect(() => parseRuntimeParams('runtime.workspace.list', { workspaceKey, path: '.', limit: 201 })).toThrow();
    expect(() => parseRuntimeResult('runtime.workspace.read', { path: '/file', version: '1', size: 1, offset: 0, dataBase64: '!!', nextOffset: null })).toThrow();
    expect(parseRuntimeResult('runtime.pty.remove', { removed: true })).toEqual({ removed: true });
  });
});
