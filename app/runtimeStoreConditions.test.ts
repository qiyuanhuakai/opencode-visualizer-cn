// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';
import type { RuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';

async function withStore(run: (store: RuntimeStore) => Promise<void>) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'vis-store-conditions-'));
  const store = createRuntimeStore({ stateDirectory, environmentId: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222', epoch: '33333333-3333-4333-8333-333333333333' });
  try { await store.ready; await run(store); }
  finally { await store.terminate(); await rm(stateDirectory, { recursive: true, force: true }); }
}

describe('transactional read-only revision conditions', () => {
  it('allows independent claims against one unchanged process without revising or replaying that process', () => withStore(async store => {
    const seed = await store.mutate({ intentId: 'process', changes: [{ collection: 'operations', key: 'process', value: { alive: true } }] });
    const check = { collection: 'operations' as const, key: 'process', checkOnly: true as const, expectedRevision: seed.revision };
    await Promise.all(['a', 'b'].map(key => store.mutateControl({ intentId: key, changes: [{ collection: 'interactions', key, value: { phase: 'replying' }, expectedRevision: 0 }, check] })));
    expect(await store.getControl({ collection: 'operations', key: 'process' })).toMatchObject({ revision: seed.revision, value: { alive: true } });
    expect((await store.inspect()).revision).toBe(seed.revision + 2);
    const replay = await store.replay({ epoch: '33333333-3333-4333-8333-333333333333', after: 0 });
    expect(replay.events.filter(value => typeof value === 'object' && value !== null && 'key' in value && value.key === 'process')).toHaveLength(1);
  }));
  it('rolls back all writes and events when a process or parent condition is stale', () => withStore(async store => {
    await store.mutate({ intentId: 'parent', changes: [{ collection: 'operations', key: 'parent', value: { phase: 'terminal' } }] });
    const before = await store.inspect();
    await expect(store.mutateControl({ intentId: 'late-claim', changes: [
      { collection: 'interactions', key: 'late', value: { phase: 'replying' }, expectedRevision: 0 },
      { collection: 'operations', key: 'parent', checkOnly: true, expectedRevision: 0 },
    ] })).rejects.toMatchObject({ code: 'conflict', reason: 'entity_precondition' });
    expect(await store.getControl({ collection: 'interactions', key: 'late' })).toBeNull();
    const after = await store.inspect(); expect([after.revision, after.seq]).toEqual([before.revision, before.seq]);
    expect(await store.readIntent({ intentId: 'late-claim' })).toBeNull();
  }));
  it('includes conditions in intent identity while replaying the original acknowledgement', () => withStore(async store => {
    const changes = [
      { collection: 'interactions' as const, key: 'one', value: 'answer', expectedRevision: 0 },
      { collection: 'operations' as const, key: 'missing', checkOnly: true as const, expectedRevision: 0 },
    ];
    const first = await store.mutateControl({ intentId: 'same', changes });
    expect(await store.mutateControl({ intentId: 'same', changes })).toEqual(first);
    await expect(store.mutateControl({ intentId: 'same', changes: [changes[0]!, { ...changes[1]!, expectedRevision: 1 }] })).rejects.toMatchObject({ code: 'conflict', reason: 'intent_mismatch' });
  }));
  it('refuses malformed read conditions and reserved access to unrelated collections before mutation', () => withStore(async store => {
    const write = { collection: 'interactions' as const, key: 'must-not-exist', value: 'answer' };
    for (const check of [
      { collection: 'operations', key: 'p', checkOnly: true },
      { collection: 'operations', key: 'p', checkOnly: true, expectedRevision: -1 },
      { collection: 'operations', key: 'p', checkOnly: true, expectedRevision: 0, value: null },
      { collection: 'operations', key: 'p', checkOnly: true, expectedRevision: 0, ignored: 'unexpected' },
    ]) await expect(store.mutateControl(JSON.parse(JSON.stringify({ intentId: 'bad', changes: [write, check] })))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(store.mutateControl({ intentId: 'foreign-control', changes: [write, { collection: 'threads', key: 't', checkOnly: true, expectedRevision: 0 }] })).rejects.toMatchObject({ code: 'invalid_request', reason: 'control_collection' });
    expect((await store.inspect()).revision).toBe(0);
  }));
});
