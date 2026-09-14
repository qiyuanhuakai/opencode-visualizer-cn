import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCodexAdapter } from './codexAdapter';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vis-ignored-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function workspaceAdapter() {
  const adapter = createCodexAdapter({ url: 'ws://localhost:4500' });
  vi.spyOn(adapter, 'readDirectory').mockImplementation(async ({ path: directory }) => ({
    entries: (await readdir(directory, { withFileTypes: true })).map((entry) => ({
      fileName: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })),
  }));
  vi.spyOn(adapter, 'commandExec').mockImplementation(async ({ command, cwd }) => {
    const [executable, ...args] = command;
    if (!executable) throw new Error('Missing executable');
    try {
      return {
        stdout: execFileSync(executable, args, { cwd, encoding: 'utf8', stdio: 'pipe' }),
        stderr: '',
        exitCode: 0,
      };
    } catch {
      return { stdout: '', stderr: 'Git command failed', exitCode: 1 };
    }
  });
  return adapter;
}

it('marks ignored files and directories, including nested entries and unusual names', async () => {
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), 'cache/\n*.log\n!keep.log\n');
  await mkdir(path.join(root, 'cache'));
  for (const name of [
    'normal.txt',
    'keep.log',
    'tracked.log',
    '中文.log',
    'line\nquote"\\.log',
    '-option.log',
  ]) {
    await writeFile(path.join(root, name), 'test');
  }
  await writeFile(path.join(root, 'cache', 'nested.txt'), 'test');
  execFileSync('git', ['add', '-f', 'tracked.log'], { cwd: root });
  const adapter = workspaceAdapter();
  const entries = await adapter.listFiles({ directory: root });
  expect(
    entries
      .filter((entry) => 'ignored' in entry && entry.ignored)
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(['cache', '中文.log', 'line\nquote"\\.log', '-option.log'].sort());
  expect(await adapter.listFiles({ directory: root, path: 'cache' })).toEqual([
    { name: 'nested.txt', path: 'cache/nested.txt', type: 'file', ignored: true },
  ]);
});

it('keeps non-Git directories browsable and skips Git for empty directories', async () => {
  const adapter = workspaceAdapter();
  expect(await adapter.listFiles({ directory: root })).toEqual([]);
  expect(adapter.commandExec).not.toHaveBeenCalled();
  await writeFile(path.join(root, 'plain.txt'), 'test');
  expect(await adapter.listFiles({ directory: root })).toEqual([
    { name: 'plain.txt', path: 'plain.txt', type: 'file' },
  ]);
});
