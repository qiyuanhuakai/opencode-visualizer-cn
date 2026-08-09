import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { stageNodePtyRuntime } from '../scripts/vis-bridge-node-pty.mjs';

describe('vis_bridge node-pty runtime packaging', () => {
  it('stages only the requested native prebuild with the runtime JavaScript', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vis-node-pty-package-'));
    const source = path.join(root, 'node_modules', 'node-pty');
    const destination = path.join(root, 'payload', 'node-pty');
    await mkdir(path.join(source, 'lib'), { recursive: true });
    await mkdir(path.join(source, 'prebuilds', 'linux-x64'), { recursive: true });
    await mkdir(path.join(source, 'prebuilds', 'linux-arm64'), { recursive: true });
    await writeFile(path.join(source, 'lib', 'index.js'), 'module.exports = {};\n');
    await writeFile(path.join(source, 'package.json'), '{"main":"lib/index.js"}\n');
    await writeFile(path.join(source, 'LICENSE'), 'MIT\n');
    await writeFile(path.join(source, 'prebuilds', 'linux-x64', 'pty.node'), 'x64');
    await writeFile(path.join(source, 'prebuilds', 'linux-arm64', 'pty.node'), 'arm64');

    try {
      await stageNodePtyRuntime(root, destination, 'linux', 'x64');

      await expect(readFile(path.join(destination, 'lib', 'index.js'), 'utf8')).resolves.toContain(
        'module.exports',
      );
      await expect(
        readFile(path.join(destination, 'prebuilds', 'linux-x64', 'pty.node'), 'utf8'),
      ).resolves.toBe('x64');
      await expect(
        readFile(path.join(destination, 'prebuilds', 'linux-arm64', 'pty.node'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
