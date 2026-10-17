// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeSnapshots } from '../../bridge/runtime/snapshots.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const ownerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
async function withStore(run: (store: ReturnType<typeof createRuntimeStore>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-snapshot-'));
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId, epoch });
  try { await store.ready; await run(store, directory); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

describe('runtime common-watermark snapshots', () => {
  it('waits for an in-flight page on close and releases its late materialization before rejecting the stale page', async () => {
    await withStore(async (store, directory) => {
      let resume = () => {}, started = () => {};
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      const snapshots = createRuntimeSnapshots({ store: { ...store, async snapshot(input) { const result = await store.snapshot(input); started(); await gate; return result; } } });
      const window = await snapshots.connect({ target: environmentId, epoch, generation: 1 }, () => true);
      const page = window.page({ collection: 'workspaces' });
      const rejected = expect(page).rejects.toMatchObject({ code: 'reconcile_required' });
      await entered; let closed = false; const closing = window.close(); closing.then(() => { closed = true; });
      expect(window.close()).toBe(closing);
      try {
        await store.inspect(); expect(closed).toBe(false);
        resume(); await rejected; await closing;
        const database = new DatabaseSync(path.join(directory, 'runtime/runtime.db'), { readOnly: true });
        try { expect(database.prepare('SELECT count(*) AS count FROM runtime_snapshots').get()).toMatchObject({ count: 0 }); expect(database.prepare('SELECT count(*) AS count FROM runtime_snapshot_rows').get()).toMatchObject({ count: 0 }); } finally { database.close(); }
        expect((await store.snapshot({ collection: 'workspaces' })).token).toBeTypeOf('string');
      } finally { resume(); await closing; }
    });
  });
  it('fences internal snapshot release by environment and epoch, validates its shape and keeps double release idempotent', async () => {
    await withStore(async (store, directory) => {
      const before = await store.inspect(), page = await store.snapshot({ collection: 'workspaces' });
      const other = createRuntimeStore({ stateDirectory: directory, environmentId: '44444444-4444-4444-8444-444444444444', ownerId, epoch });
      try { await other.ready; expect(await other.releaseSnapshot({ token: page.token, epoch })).toEqual({ released: false }); } finally { await other.close(); }
      expect(await store.releaseSnapshot({ token: page.token, epoch: ownerId })).toEqual({ released: false });
      for (const params of [{ token: '', epoch }, { token: page.token, epoch: 'bad' }, { token: page.token, epoch, environment: environmentId }]) await expect(store.releaseSnapshot(params)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(await store.snapshot({ collection: 'workspaces', token: page.token })).toMatchObject({ token: page.token, expiresAt: page.expiresAt });
      expect(await store.releaseSnapshot({ token: page.token, epoch })).toEqual({ released: true });
      expect(await store.releaseSnapshot({ token: page.token, epoch })).toEqual({ released: false });
      await expect(store.snapshot({ collection: 'workspaces', token: page.token })).rejects.toMatchObject({ code: 'replay_required' });
      expect(await store.inspect()).toMatchObject({ seq: before.seq, revision: before.revision });
    });
  });
  it('refuses snapshot cleanup by a replaced store owner without deleting the current materialization', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'runtime-snapshot-owner-'));
    const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId, epoch });
    let replacement: ReturnType<typeof createRuntimeStore> | undefined;
    try {
      const initial = await store.ready; const page = await store.snapshot({ collection: 'workspaces' });
      replacement = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId, epoch, takeover: { expectedFence: initial.fence } }); await replacement.ready;
      await expect(store.releaseSnapshot({ token: page.token, epoch })).rejects.toMatchObject({ code: 'conflict', reason: 'stale_owner' });
      expect(await replacement.snapshot({ collection: 'workspaces', token: page.token })).toMatchObject({ token: page.token });
      expect(await replacement.releaseSnapshot({ token: page.token, epoch })).toEqual({ released: true });
    } finally { await store.terminate(); await replacement?.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('reclaims only a disconnected subscriber token while preserving two other windows and the global three-token cap', async () => {
    await withStore(async (store, directory) => {
      await store.mutate({ intentId: 'seed-close', changes: [{ collection: 'workspaces', key: 'large', value: 'x'.repeat(70000) }] });
      const snapshots = createRuntimeSnapshots({ store });
      const windows = await Promise.all([1, 2, 3].map(generation => snapshots.connect({ target: environmentId, epoch, generation }, () => true)));
      try {
        const pages = await Promise.all(windows.map(window => window.page({ collection: 'workspaces' })));
        const before = await store.inspect();
        await expect(windows[0].page({ collection: 'workspaces' })).rejects.toMatchObject({ code: 'conflict', reason: 'snapshot_limit' });
        await windows[0].close(); await windows[0].close();
        const database = new DatabaseSync(path.join(directory, 'runtime/runtime.db'), { readOnly: true });
        try { expect(database.prepare('SELECT token FROM runtime_snapshots ORDER BY token').all().map(row => row.token)).toEqual(pages.slice(1).map(page => page.token).sort()); expect(database.prepare('SELECT count(*) AS count FROM runtime_snapshot_rows WHERE token=?').get(pages[0].token)).toMatchObject({ count: 0 }); } finally { database.close(); }
        for (const index of [1, 2]) expect(await windows[index].readChunk({ collection: 'workspaces', key: 'large', revision: 1, offset: 0, token: pages[index].token })).toMatchObject({ revision: 1, nextOffset: 65536 });
        const replacement = await snapshots.connect({ target: environmentId, epoch, generation: 4 }, () => true);
        try { expect(await replacement.page({ collection: 'workspaces' })).toMatchObject({ revision: before.revision, watermark: before.seq }); await expect(replacement.page({ collection: 'workspaces' })).rejects.toMatchObject({ code: 'conflict', reason: 'snapshot_limit' }); } finally { await replacement.close(); }
        expect(await store.inspect()).toMatchObject({ seq: before.seq, revision: before.revision });
      } finally { await Promise.all(windows.map(window => window.close())); }
    });
  });
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
