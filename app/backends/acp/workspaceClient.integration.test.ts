// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVisBridgeServer } from '../../../vis_bridge.js';
import { AcpWorkspaceClient } from './workspaceClient';

describe('ACP workspace over real bridge HTTP', () => {
  let root = '';
  let server: Server;
  let client: AcpWorkspaceClient;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vis-acp-git-'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'main.ts'), 'original\n');
    server = createVisBridgeServer({
      host: '127.0.0.1',
      path: '/codex',
      target: 'ws://127.0.0.1:1',
      bridgeToken: 'test-secret',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing bridge port');
    client = new AcpWorkspaceClient({
      bridgeUrl: `ws://127.0.0.1:${address.port}`,
      bridgeToken: 'test-secret',
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });

  function initializeGit() {
    git('init', '--initial-branch=main');
    git('add', '.');
    git('-c', 'user.name=ACP Test', '-c', 'user.email=acp@example.test', 'commit', '-m', 'initial');
  }

  it('returns an absolute common root when opened inside a Git subdirectory', async () => {
    initializeGit();
    await expect(client.getVcsInfo(path.join(root, 'src'))).resolves.toMatchObject({
      root,
      commonRoot: root,
      branch: 'main',
    });
    expect(await client.getVcsInfo(path.join(root, 'src'))).not.toHaveProperty('worktreeRoot');
  });

  it('lists a non-Git directory and reports no Git repository', async () => {
    await expect(client.listFiles({ directory: root, path: 'src' })).resolves.toEqual([
      { name: 'main.ts', path: 'src/main.ts', type: 'file' },
    ]);
    await expect(client.getVcsInfo(root)).resolves.toEqual({ root: '', branch: '' });
  });

  it('lists Git files, status and branches and switches branches through command exec', async () => {
    initializeGit();
    await writeFile(path.join(root, 'src', 'main.ts'), 'changed\n');
    const command = (...args: string[]) =>
      client.runOneShotCommand({ directory: root, command: 'git', args });
    await expect(command('status', '--porcelain=v1', '-z')).resolves.toBe(' M src/main.ts\0');
    await expect(command('ls-files', '-z')).resolves.toBe('src/main.ts\0');
    await command('switch', '-c', 'feature/acp');
    await expect(client.getVcsInfo(root)).resolves.toMatchObject({ branch: 'feature/acp' });
    await expect(command('branch', '--format=%(refname:short)')).resolves.toContain('feature/acp');
    await command('switch', 'main');
    await command('branch', '-d', 'feature/acp');
    await expect(command('branch', '--format=%(refname:short)')).resolves.toBe('main\n');
    await command('switch', '--detach');
    await expect(client.getVcsInfo(root)).resolves.toMatchObject({
      root,
      branch: '',
      commonRoot: root,
    });
  });

  it('distinguishes the worktree root from its shared repository root', async () => {
    initializeGit();
    const worktree = path.join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', worktree);
    await expect(client.getVcsInfo(worktree)).resolves.toMatchObject({
      root: worktree,
      commonRoot: root,
      worktreeRoot: worktree,
      branch: 'linked',
    });
  });
});
