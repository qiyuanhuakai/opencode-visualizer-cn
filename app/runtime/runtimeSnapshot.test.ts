// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';

const environmentId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
async function withStore(run: (store: ReturnType<typeof createRuntimeStore>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-snapshot-'));
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId, epoch });
  try { await store.ready; await run(store, directory); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

describe('runtime common-watermark snapshots', () => {
  it('keeps topology and same-key summaries at one revision across concurrent mutations', async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-snapshot-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
    try {
      await store.ready;
      await store.mutate({ intentId: 'initial', changes: [
        { collection: 'workspaces', key: 'same', value: { version: 1 } },
        { collection: 'session_summaries', key: 'same', value: { version: 1 } },
      ] });
      const topology = await store.snapshot({ collection: 'workspaces', collections: ['workspaces', 'session_summaries'] });
      await store.mutate({ intentId: 'concurrent', changes: [
        { collection: 'workspaces', key: 'same', value: { version: 2 } },
        { collection: 'session_summaries', key: 'same', value: null },
      ] });
      const summaries = await store.snapshot({ collection: 'session_summaries', token: topology.token });
      expect(summaries).toMatchObject({ token: topology.token, revision: topology.revision, watermark: topology.watermark });
      expect(topology.items).toEqual([{ key: 'same', revision: 1, value: { version: 1 } }]);
      expect(summaries.items).toEqual([{ key: 'same', revision: 2, value: { version: 1 } }]);
      expect(await store.replay({ epoch, after: topology.watermark })).toMatchObject({ events: [
        { collection: 'workspaces', entityRevision: 3, deleted: false },
        { collection: 'session_summaries', entityRevision: 4, deleted: true },
      ] });
    } finally {
      await store.close();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  it('isolates collection cursors and preserves both windows while writes and deletes continue', async () => {
    await withStore(async (store) => {
      const names = ['a', 'b', 'c'];
      await store.mutate({ intentId: 'seed', changes: names.flatMap((key) => [
        { collection: 'workspaces' as const, key, value: { title: key } },
        { collection: 'session_summaries' as const, key, value: { title: key } },
      ]) });
      const first = await store.snapshot({ collection: 'workspaces', collections: ['workspaces', 'session_summaries'], limit: 1 });
      const second = await store.snapshot({ collection: 'session_summaries', collections: ['session_summaries', 'workspaces'], limit: 1 });
      await store.mutate({ intentId: 'change', changes: [{ collection: 'session_summaries', key: 'b', value: null }] });
      const page = await store.snapshot({ collection: 'session_summaries', token: second.token, cursor: second.cursor, limit: 1 });
      expect(page.items).toEqual([{ key: 'b', revision: 4, value: { title: 'b' } }]);
      expect(page.watermark).toBe(first.watermark);
      await expect(store.snapshot({ collection: 'session_summaries', token: first.token, cursor: first.cursor })).rejects.toMatchObject({ code: 'replay_required', reason: 'snapshot_cursor' });
      await expect(store.snapshot({ collection: 'workspaces', token: second.token, cursor: first.cursor })).rejects.toMatchObject({ code: 'replay_required', reason: 'snapshot_cursor' });
      await expect(store.snapshot({ collection: 'threads', token: first.token })).rejects.toMatchObject({ code: 'replay_required', reason: 'snapshot_collection' });
      await expect(store.snapshot({ collection: 'workspaces', collections: ['workspaces'], token: first.token })).rejects.toMatchObject({ code: 'replay_required', reason: 'snapshot_collections' });
      expect((await store.snapshot({ collection: 'workspaces', collections: ['session_summaries', 'workspaces'], token: first.token })).items).toHaveLength(3);
      await expect(store.snapshot({ collection: 'workspaces', collections: ['workspaces', 'workspaces'] })).rejects.toMatchObject({ code: 'invalid_request', reason: 'snapshot_collections' });
      expect((await store.replay({ epoch, after: first.watermark })).events).toMatchObject([{ key: 'b', deleted: true }]);
    });
  });
  it('keeps legacy snapshots and page/chunk reads unchanged beside compound snapshot keys', async () => {
    await withStore(async (store) => {
      const key = 'quote"slash\\newline\n汉';
      const value = { text: '汉'.repeat(40000) };
      await store.mutate({ intentId: 'big', changes: [
        { collection: 'workspaces', key, value },
        { collection: 'session_summaries', key, value: { text: 'other' } },
      ] });
      const legacy = await store.snapshot({ collection: 'workspaces' });
      const compound = await store.snapshot({ collection: 'workspaces', collections: ['workspaces', 'session_summaries'] });
      expect(compound.items).toEqual(legacy.items);
      expect((await store.page({ collection: 'workspaces' })).items).toEqual(legacy.items);
      for (const token of [undefined, legacy.token, compound.token]) {
        const chunks: Buffer[] = [];
        let offset: number | null = 0;
        do {
          const part = await store.readChunk({ collection: 'workspaces', key, revision: 1, offset, ...(token ? { token } : {}) });
          chunks.push(Buffer.from(part.data, 'base64'));
          expect(Buffer.from(part.data, 'base64').byteLength).toBeLessThanOrEqual(65536);
          offset = part.nextOffset;
        } while (offset !== null);
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(value);
      }
      expect((await store.snapshot({ collection: 'session_summaries', token: compound.token })).items).toEqual([{ key, revision: 2, value: { text: 'other' } }]);
      await expect(store.readChunk({ collection: 'session_summaries', key, revision: 1, offset: 0, token: compound.token })).rejects.toMatchObject({ code: 'conflict', reason: 'chunk_revision' });
    });
  });
  it('shares the three-token budget, expires materializations and preserves approvals after replay trimming', async () => {
    await withStore(async (store, directory) => {
      await store.mutateControl({ intentId: 'approval', changes: [{ collection: 'interactions', key: 'pending', value: { status: 'pending' } }] });
      const compound = await store.snapshot({ collection: 'workspaces', collections: ['workspaces', 'session_summaries'] });
      await store.snapshot({ collection: 'threads' });
      await store.snapshot({ collection: 'session_summaries', collections: ['session_summaries', 'workspaces'] });
      await expect(store.snapshot({ collection: 'workspaces' })).rejects.toMatchObject({ code: 'conflict', reason: 'snapshot_limit' });
      const database = new DatabaseSync(path.join(directory, 'runtime/runtime.db'));
      try {
        expect(database.prepare('SELECT count(*) AS count FROM runtime_snapshots').get()).toMatchObject({ count: 3 });
        database.prepare('UPDATE runtime_snapshots SET expires=0 WHERE token=?').run(compound.token);
        database.prepare('UPDATE runtime_events SET created=0').run();
      } finally { database.close(); }
      await expect(store.snapshot({ collection: 'workspaces', token: compound.token })).rejects.toMatchObject({ code: 'replay_required', reason: 'snapshot_expired' });
      await expect(store.replay({ epoch, after: 0 })).rejects.toMatchObject({ code: 'replay_required' });
      await store.mutate({ intentId: 'trim', changes: [{ collection: 'workspaces', key: 'new', value: {} }] });
      expect(await store.getControl({ collection: 'interactions', key: 'pending' })).toMatchObject({ value: { status: 'pending' } });
      await expect(store.replay({ epoch: 'old', after: 1 })).rejects.toMatchObject({ code: 'replay_required' });
      await expect(store.replay({ epoch, after: 999 })).rejects.toMatchObject({ code: 'replay_required' });
      expect((await store.snapshot({ collection: 'workspaces' })).items).toHaveLength(1);
    });
  });
  it('bounds materialized page bytes and roundtrips maximum-length keys', async () => {
    await withStore(async (store) => {
      const largeKey = '界'.repeat(4096);
      await store.mutate({ intentId: 'keys', changes: [
        { collection: 'workspaces', key: largeKey, value: { title: 'first' } },
        { collection: 'workspaces', key: `${'界'.repeat(4095)}龟`, value: { title: 'second' } },
      ] });
      const first = await store.snapshot({ collection: 'workspaces', collections: ['workspaces'], limit: 1 });
      const second = await store.snapshot({ collection: 'workspaces', token: first.token, cursor: first.cursor, limit: 1 });
      expect(first.items[0]?.key).toBe(largeKey);
      expect(second.items[0]?.value).toEqual({ title: 'second' });
      expect(second.cursor).toBeNull();
      for (let offset = 0; offset < 20; offset += 10) await store.mutate({ intentId: `bytes-${offset}`, changes: Array.from({ length: 10 }, (_, index) => ({ collection: 'session_summaries', key: String(offset + index).padStart(3, '0'), value: 'x'.repeat(60000) })) });
      const page = await store.snapshot({ collection: 'session_summaries', collections: ['session_summaries', 'workspaces'], limit: 200 });
      expect(page.items).toHaveLength(8);
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(512 * 1024);
      expect(page.cursor).not.toBeNull();
    });
  });
});
