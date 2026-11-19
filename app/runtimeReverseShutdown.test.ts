// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { constants, openSync, writeSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../bridge/runtime/workspaceService.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-reverse-shutdown-')); roots.push(root);
  const target = '11111111-1111-4111-8111-111111111111';
  const service = await createWorkspaceService({ target, epoch: 'one', roots: [{ root, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }] });
  const client = service.connect({ target, epoch: 'one', generation: 1, subscriberId: 'window', assertCurrent() {} });
  const owner = client.reverse.register({ workspaceKey: service.workspaces[0]!.key, harnessInstanceId: '22222222-2222-4222-8222-222222222222', processGeneration: 1, agentId: 'kimi-code', assertProcessCurrent() {} });
  owner.observeClientMessage({ id: 1, method: 'session/new', params: { cwd: root } });
  owner.observeAgentMessage({ id: 1, result: { sessionId: 'owned-session' } });
  return { root, service, owner };
}

it.each([1, 2])('refuses a late reverse terminal and physically drains its owner on shutdown (%i)', async round => {
  const f = await fixture();
  const marker = `vis-reverse-owned-${process.pid}-${round}`;
  const creating = f.owner.handle({ method: 'terminal/create', params: { sessionId: 'owned-session', cwd: f.root, command: process.execPath, args: ['-e', `setInterval(()=>{},1000) // ${marker}`] } });
  const outcome = Promise.resolve(creating).then(() => 'resolved', error => String(error));
  try {
    await f.service.close();
    expect(await outcome).toMatch(/not active/);
    if (process.platform === 'linux') {
      const found = readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker); } catch { return false; } });
      expect(found).toEqual([]);
    }
  } finally {
    // Also reclaim the deliberately exposed old-code orphan during RED runs.
    await outcome;
    await f.owner.close();
    await f.service.close();
  }
});

it.skipIf(process.platform === 'win32')('refuses a FIFO read and drains shutdown without a caller supplying EOF', async () => {
  const f = await fixture(), fifo = path.join(f.root, 'owned.fifo');
  execFileSync('mkfifo', [fifo]);
  const reading = f.owner.handle({ method: 'fs/read_text_file', params: { sessionId: 'owned-session', path: fifo } });
  const outcome = Promise.resolve(reading).then(() => 'resolved', error => String(error));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observed: string | undefined;
  try {
    observed = await Promise.race([outcome, new Promise<string>(resolve => { timer = setTimeout(() => resolve('pending'), 1000); })]);
    expect(observed).toMatch(/not a regular file/);
    await f.service.close();
  } finally {
    clearTimeout(timer);
    if (observed === 'pending') {
      // A nonblocking writer only drains the old implementation after RED has
      // already been recorded; it never helps the passing assertion succeed.
      let descriptor: number | undefined;
      try { descriptor = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); writeSync(descriptor, 'RED cleanup'); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENXIO') throw error; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    await outcome;
    await f.owner.close();
    await f.service.close();
  }
});
