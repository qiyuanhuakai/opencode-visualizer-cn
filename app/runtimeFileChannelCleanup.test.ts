// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceService } from '../bridge/runtime/workspaceService.js';

const io = vi.hoisted(() => ({ failures: 0, attempts: 0, failOpen: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      if (io.failOpen && String(args[0]).includes('.vis-upload-')) { io.failOpen = false; throw Object.assign(new Error('controlled open failure'), { code: 'EACCES' }); }
      return fs.open(...args);
    },
    async rm(...args: Parameters<typeof fs.rm>) {
      if (String(args[0]).includes('.vis-upload-')) {
        io.attempts++;
        if (io.failures > 0) { io.failures--; throw Object.assign(new Error('controlled cleanup failure'), { code: 'EBUSY' }); }
      }
      return fs.rm(...args);
    },
  };
});

it.each(['disconnect', 'shutdown', 'failed-open'] as const)('retries owned upload cleanup after a transient failure: %s', async mode => {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-channel-retry-'));
  const target = '11111111-1111-4111-8111-111111111111';
  const service = await createWorkspaceService({ target, epoch: 'one', roots: [{ root, permissions: ['read', 'write'] }] });
  const client = service.connect({ target, epoch: 'one', generation: 1, subscriberId: 'window', assertCurrent() {} });
  const request = { workspaceKey: service.workspaces[0]!.key, path: 'unpublished', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
  io.attempts = 0; io.failures = 1; io.failOpen = mode === 'failed-open';
  try {
    if (mode === 'failed-open') {
      await expect(client.files.open(request)).rejects.toThrow();
    } else {
      await client.files.open(request);
      const close = mode === 'disconnect' ? () => client.disconnect() : () => service.close();
      const results = await Promise.allSettled([close(), close()]);
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    }
    expect(io.attempts).toBe(1);
    const retry = mode === 'disconnect' ? () => client.disconnect() : () => service.close();
    await expect(retry()).resolves.toBeUndefined();
    expect(io.attempts).toBe(2);
    expect(await readdir(root)).toEqual([]);
  } finally {
    io.failures = 0; io.failOpen = false;
    await Promise.allSettled([client.disconnect(), service.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
