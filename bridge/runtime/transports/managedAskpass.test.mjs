import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { protectFile } from './protectedFile.js';

const execute = promisify(execFile);
test('shipped SEA askpass executable uses gated protected one-shot IPC without CLI output', async () => {
  const binary = process.env.VIS_ASKPASS_TEST_BINARY ?? path.resolve('dist-bridge', process.platform === 'win32' ? 'vis_bridge.exe' : 'vis_bridge');
  const root = await mkdtemp(path.join(tmpdir(), 'askpass-entry-'));
  const file = path.join(root, 'secret');
  const secret = randomBytes(32).toString('hex');
  const env = { ...process.env, VIS_SSH_ASKPASS_MODE: 'one-shot-v1', VIS_SSH_ASKPASS_FILE: file };
  try {
    await writeFile(file, secret, { mode: 0o600 });
    await protectFile(file);
    const answer = await execute(binary, ['passphrase prompt from OpenSSH'], { env });
    assert.equal(answer.stdout, secret + '\n');
    assert.equal(answer.stderr, '');
    assert.equal(await readFile(file, 'utf8'), '');
    await assert.rejects(execute(binary, ['second prompt'], { env }), error => error.code === 1 && error.stdout === '' && error.stderr === '');
    if (process.platform !== 'win32') {
      await writeFile(file, secret);
      await chmod(file, 0o644);
      await assert.rejects(execute(binary, ['insecure file'], { env }), error => error.code === 1 && error.stdout === '');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
