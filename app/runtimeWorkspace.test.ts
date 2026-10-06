import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceService } from '../bridge/runtime/workspaceService.js';

const target = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'runtime-workspace-test-'));
  temporary.push(root);
  const service = await createWorkspaceService({ target, epoch: 'one', roots: [{ root, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }] });
  const context = { target, epoch: 'one', generation: 1, subscriberId: 'window', assertCurrent() {} };
  const client = service.connect(context);
  const workspace = service.workspaces[0];
  if (!workspace) throw new Error('Missing test workspace');
  return { root, service, client, context, workspaceKey: workspace.key };
}
describe('runtime target workspace', () => {
  it('writes and reads only the captured canonical workspace', async () => {
    // Given an authorized target workspace.
    const f = await fixture();
    try {
      // When a target-scoped write completes.
      await f.client.write({ workspaceKey: f.workspaceKey, path: 'hello.txt', content: 'target content' });
      // Then the production read returns the bytes.
      expect((await f.client.read({ workspaceKey: f.workspaceKey, path: 'hello.txt' })).content).toBe('target content');
    } finally { await f.service.close(); }
  });
  it('failure rejects foreign targets before interpreting their opaque POSIX paths', async () => {
    // Given a target that has a local workspace.
    const f = await fixture();
    try {
      // When a request belongs to another target.
      // Then no local path operation can be obtained.
      expect(() => f.service.connect({ ...f.context, target: foreign })).toThrow('unauthorized');
      expect(() => f.service.connect({ ...f.context, epoch: 'stale' })).toThrow('reconcile_required');
    } finally { await f.service.close(); }
  });
  it('failure preserves files behind escaping symlinks', async () => {
    // Given an existing caller file outside the granted root.
    const f = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'runtime-outside-'));
    temporary.push(outside);
    await writeFile(path.join(outside, 'data'), 'untouched');
    await symlink(path.join(outside, 'data'), path.join(f.root, 'link'));
    try {
      // When a write follows the escaping link.
      await expect(f.client.write({ workspaceKey: f.workspaceKey, path: 'link', content: 'changed' })).rejects.toThrow();
      // Then the outside bytes remain untouched.
      expect(await readFile(path.join(outside, 'data'), 'utf8')).toBe('untouched');
    } finally { await f.service.close(); }
  });
});

describe('runtime attachment lifetime', () => {
  it('failure removes staging when shutdown races an opening channel', async () => {
    // Given an upload opening on the target.
    const f = await fixture();
    const opening = f.client.files.open({ workspaceKey: f.workspaceKey, path: 'cancelled', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    const rejected = expect(opening).rejects.toThrow();
    // When shutdown closes admission while the channel is opening.
    await f.service.close();
    await rejected;
    // Then all staging has been removed when shutdown resolves.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(f.root)).toEqual([]);
  });
  it('failure refuses an acknowledgement before a chunk reaches disk', async () => {
    // Given one outstanding write.
    const f = await fixture();
    try {
      const channel = await f.client.files.open({ workspaceKey: f.workspaceKey, path: 'chunk', size: 1, sha256: '0'.repeat(64) });
      const append = f.client.files.append({ channelId: channel.channelId, offset: 0, data: Buffer.from('a') });
      // When a caller fabricates an early acknowledgement.
      // Then it cannot free the credit before the write completes.
      expect(() => f.client.files.acknowledge({ channelId: channel.channelId, offset: 0, length: 1 })).toThrow('ack');
      await append;
      await f.client.files.cancel(channel.channelId);
    } finally { await f.service.close(); }
  });
  it('failure cleans a wrong-hash upload without publishing bytes', async () => {
    // Given a deliberately incorrect digest.
    const f = await fixture();
    try {
      const channel = await f.client.files.open({ workspaceKey: f.workspaceKey, path: 'invalid', size: 1, sha256: '0'.repeat(64) });
      const ack = await f.client.files.append({ channelId: channel.channelId, offset: 0, data: Buffer.from('a') });
      f.client.files.acknowledge(ack);
      // When the target finalizes the upload.
      await expect(f.client.files.finish(channel.channelId)).rejects.toThrow('hash');
      // Then neither a destination nor temporary upload remains.
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.service.close(); }
  });
  it('failure enforces permissions above the writable filesystem primitive', async () => {
    // Given a read-only grant on a physically writable directory.
    const f = await fixture();
    await f.service.close();
    const readonly = await createWorkspaceService({ target, epoch: 'one', roots: [{ root: f.root, permissions: ['read'] }] });
    try {
      const client = readonly.connect(f.context);
      // When a client attempts a write through its valid identity.
      // Then permission rejection happens before disk mutation.
      await expect(client.write({ workspaceKey: f.workspaceKey, path: 'forbidden', content: 'bad' })).rejects.toThrow('permission');
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(f.root)).toEqual([]);
    } finally { await readonly.close(); }
  });
  it('failure fences a captured generation even when caller mutates its context', async () => {
    // Given a context whose host generation expires.
    const f = await fixture();
    let current = true;
    const context = { ...f.context, assertCurrent() { if (!current) throw new Error('stale generation'); } };
    const stale = f.service.connect(context);
    context.assertCurrent = () => {};
    current = false;
    try {
      // When the stale caller attempts another request.
      // Then the originally captured fence remains authoritative.
      await expect(stale.read({ workspaceKey: f.workspaceKey, path: 'anything' })).rejects.toThrow('stale generation');
    } finally { await f.service.close(); }
  });
});

describe('runtime repeated interruption', () => {
  it('failure shares cleanup across repeated disconnect and shutdown', async () => {
    // Given an owned attachment with no published destination.
    const f = await fixture();
    await f.client.files.open({ workspaceKey: f.workspaceKey, path: 'cancelled', size: 1, sha256: '0'.repeat(64) });
    // When multiple connection and target interruptions arrive together.
    await Promise.all([f.client.disconnect(), f.client.disconnect(), f.service.close(), f.service.close()]);
    // Then they settle only after the same staging ownership is released.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(f.root)).toEqual([]);
  });
});
