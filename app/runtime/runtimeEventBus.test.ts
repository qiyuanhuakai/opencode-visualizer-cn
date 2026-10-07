// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeEventBus } from '../../bridge/runtime/eventBus.js';
import { createRuntimeSnapshots } from '../../bridge/runtime/snapshots.js';
import { createEventObserver } from '../../bridge/runtime/eventObservers.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const epoch = '33333333-3333-4333-8333-333333333333';
const binding = { target: environmentId, epoch, generation: 1 };
async function fixture(run: (store: ReturnType<typeof createRuntimeStore>, bus: ReturnType<typeof createRuntimeEventBus>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-events-'));
  const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch });
  const bus = createRuntimeEventBus({ store });
  try { await store.ready; await run(store, bus); }
  finally { await bus.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
}

describe('durable runtime event bus', () => {
  it('caps simultaneous observer admissions at64 and rejects ahead-of-store cursors', async () => {
    await fixture(async (_store, bus) => {
      await expect(bus.connect(binding, { after: 1, isCurrent: () => true })).rejects.toMatchObject({ code: 'replay_required' });
      const results = await Promise.allSettled(Array.from({ length: 65 }, (_, index) => bus.connect({ ...binding, generation: index + 1 }, { after: 0, isCurrent: () => true })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(64);
      expect(results.filter((result) => result.status === 'rejected')).toMatchObject([{ reason: { code: 'source_unavailable' } }]);
      expect(bus.state.observers).toBe(64);
    });
  });
  it('keeps control hints independent from ordered sequence and isolates a slow observer', async () => {
    await fixture(async (store, bus) => {
      const slow = await bus.connect(binding, { after: 0, isCurrent: () => true });
      const fast = await bus.connect({ ...binding, generation: 2 }, { after: 0, isCurrent: () => true });
      for (let index = 0; index < 3; index++) {
        await store.mutate({ intentId: `summary-${index}`, changes: [{ collection: 'session_summaries', key: 'session', value: { title: String(index) } }] });
        await bus.nudge();
        expect(fast.read()).toMatchObject({ kind: 'event', frame: { seq: index + 1 } });
      }
      await store.mutateControl({ intentId: 'approval', changes: [{ collection: 'interactions', key: 'pending', value: { status: 'pending' } }] });
      await bus.nudge();
      expect(slow.read()).toMatchObject({ kind: 'control', frame: { seq: 4, payload: { collection: 'interactions' } } });
      expect(slow.state.consumed).toBe(0);
      expect(slow.read()).toMatchObject({ kind: 'replay_required', after: 0, through: 4, reason: 'summary_coalesced' });
      expect(fast.read()).toMatchObject({ kind: 'control', frame: { seq: 4 } });
      expect(fast.read()).toMatchObject({ kind: 'event', frame: { seq: 4 } });
      const replay = await bus.log.frame(binding, { after: 0 });
      expect(replay.events.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
      slow.resume(replay.through);
      expect(slow.read()).toBeNull();
      expect(await store.getControl({ collection: 'interactions', key: 'pending' })).toMatchObject({ value: { status: 'pending' } });
    });
  });
  it('returns actual canonical revision for older identity-only patches and preserves deletions', async () => {
    await fixture(async (store, bus) => {
      await store.mutate({ intentId: 'old', changes: [{ collection: 'session_summaries', key: 'row', value: { title: 'old' } }] });
      const first = (await bus.log.read({ epoch, after: 0 })).events[0]!;
      await store.mutate({ intentId: 'new', changes: [{ collection: 'session_summaries', key: 'row', value: { title: 'new' } }] });
      expect(await bus.log.resolve(first)).toMatchObject({ revision: 2, value: { title: 'new' } });
      await store.mutate({ intentId: 'deleted', changes: [{ collection: 'session_summaries', key: 'row', value: null }] });
      expect(await bus.log.resolve(first)).toMatchObject({ revision: 3, value: null });
      await expect(bus.log.resolve({ ...first, epoch: 'old' })).rejects.toMatchObject({ code: 'replay_required' });
    });
  });
  it('bounds all bulk credits and keeps permission delivery ahead of saturated PTY chunks', () => {
    const observer = createEventObserver({ binding, after: 0, isCurrent: () => true, onClose: () => {} });
    try {
      for (let channel = 1; channel <= 4; channel++) {
        observer.openChannel(channel);
        for (let offset = 0; offset < 4 * 65536; offset += 65536) observer.sendBinary({ channelId: channel, offset, data: new Uint8Array(65536) });
      }
      expect(observer.state).toMatchObject({ inflight: 16, bulk: 16 });
      expect(observer.state.bytes).toBe(16 * (65536 + 24));
      expect(() => observer.openChannel(5)).toThrow();
      expect(() => observer.sendBinary({ channelId: 1, offset: 4 * 65536, data: new Uint8Array(1) })).toThrow();
      observer.push({ kind: 'event', version: 1, ...binding, seq: 1, entityRevision: 1, scope: 'approval', type: 'entity.patch', payload: { collection: 'interactions', key: 'pending', deleted: false } }, true);
      expect(observer.read()).toMatchObject({ kind: 'control' });
      expect(observer.state.consumed).toBe(0);
      expect(observer.read()).toMatchObject({ kind: 'event' });
      expect(() => observer.acknowledgeChunk({ channelId: 1, offset: 0, length: 65536 })).toThrow();
      const delivery = observer.read();
      expect(delivery).toMatchObject({ kind: 'binary', channelId: 1, offset: 0 });
      observer.acknowledgeChunk({ channelId: 1, offset: 0, length: 65536 });
      expect(observer.state.inflight).toBe(15);
      expect(observer.state.bytes).toBeLessThanOrEqual(8388608);
    } finally { observer.close(); }
    expect(observer.state.bytes).toBe(0);
  });
  it('shares a common snapshot across collections and rejects foreign cursors and generations', async () => {
    await fixture(async (store) => {
      await store.mutate({ intentId: 'seed', changes: [
        { collection: 'workspaces', key: 'a', value: { title: 'a' } },
        { collection: 'workspaces', key: 'b', value: { title: 'b' } },
        { collection: 'session_summaries', key: 'a', value: { title: 'old' } },
      ] });
      const snapshots = createRuntimeSnapshots({ store });
      let current = true;
      const first = await snapshots.connect(binding, () => current);
      const second = await snapshots.connect({ ...binding, generation: 2 }, () => true);
      const page = await first.page({ collection: 'workspaces', limit: 1 });
      expect(page.cursor?.length).toBeLessThan(1024);
      await store.mutate({ intentId: 'during', changes: [{ collection: 'session_summaries', key: 'a', value: null }] });
      const summaries = await first.page({ collection: 'session_summaries', token: page.token });
      expect(summaries).toMatchObject({ watermark: page.watermark, revision: page.revision, items: [{ collection: 'session_summaries', value: { title: 'old' } }] });
      await expect(first.page({ collection: 'session_summaries', token: page.token, cursor: page.cursor })).rejects.toMatchObject({ code: 'replay_required' });
      await expect(second.page({ collection: 'workspaces', token: page.token })).rejects.toMatchObject({ code: 'replay_required' });
      expect((await first.replay({ after: page.watermark })).events).toMatchObject([{ seq: 4, payload: { deleted: true } }]);
      current = false;
      await expect(first.page()).rejects.toMatchObject({ code: 'reconcile_required' });
      first.close(); second.close();
    });
  });
  it('recovers explicitly when 257 distinct summaries overflow the observer queue', () => {
    const observer = createEventObserver({ binding, after: 0, isCurrent: () => true, onClose: () => {} });
    try {
      for (let seq = 1; seq <= 257; seq++) observer.push({ kind: 'event', version: 1, ...binding, seq, entityRevision: seq, scope: String(seq), type: 'entity.patch', payload: { collection: 'session_summaries', key: String(seq), deleted: false } });
      expect(observer.read()).toMatchObject({ kind: 'replay_required', after: 0, through: 257, reason: 'observer_overflow' });
      expect(observer.state.bytes).toBe(0);
      expect(() => observer.resume(256)).toThrow();
    } finally { observer.close(); }
  });
});
