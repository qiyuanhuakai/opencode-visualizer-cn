// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRuntimeStore } from '../bridge/runtime/storage/runtimeStore.js';

const environmentId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
describe('runtime durable store', () => {
  it('reads committed intent after worker termination and explicit fenced recovery', async () => {
    // Given an isolated target store.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-store-test-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
    try {
      await store.ready;
      const ack = await store.mutate({ intentId: 'intent-1', changes: [{ collection: 'threads', key: 'thread-1', value: { title: 'retained' } }] });
      const previousOwner = await store.inspect();
      // When the worker exits after its durable acknowledgement.
      await store.terminate();
      const restarted = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch, takeover: { expectedFence: previousOwner.fence } });
      try {
        await restarted.ready;
        // Then committed content and the idempotent acknowledgement survive.
        expect(await restarted.get({ collection: 'threads', key: 'thread-1' })).toMatchObject({ value: { title: 'retained' }, revision: ack.revision });
        expect(await restarted.mutate({ intentId: 'intent-1', changes: [{ collection: 'threads', key: 'thread-1', value: { title: 'retained' } }] })).toEqual(ack);
      } finally { await restarted.close(); }
    } finally { await store.terminate(); await rm(stateDirectory, { recursive: true, force: true }); }
  });
  it('failure rejects another owner without implicit takeover', async () => {
    // Given an active owner.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-store-test-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
    try {
      await store.ready;
      // When another writer starts without a trusted takeover.
      const competitor = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
      try {
        // Then it cannot acquire write admission.
        await expect(competitor.ready).rejects.toMatchObject({ code: 'conflict', reason: 'owner_conflict' });
      } finally { await competitor.terminate(); }
    } finally { await store.close(); await rm(stateDirectory, { recursive: true, force: true }); }
  });
  it('failure rolls back every entity and intent when a batch revision conflicts', async () => {
    // Given a committed revision and a batch that conflicts after its first write.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-store-test-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
    try {
      await store.ready;
      await store.mutate({ intentId: 'first', changes: [{ collection: 'threads', key: 'existing', value: { title: 'original' } }] });
      // When the second change has a stale expected revision.
      await expect(store.mutate({ intentId: 'atomic', changes: [
        { collection: 'threads', key: 'new', value: {} },
        { collection: 'threads', key: 'existing', value: {}, expectedRevision: 0 },
      ] })).rejects.toMatchObject({ code: 'conflict', reason: 'entity_revision' });
      // Then neither a partial entity nor a durable acknowledgement exists.
      expect(await store.get({ collection: 'threads', key: 'new' })).toBeNull();
      expect(await store.readIntent({ intentId: 'atomic' })).toBeNull();
    } finally { await store.close(); await rm(stateDirectory, { recursive: true, force: true }); }
  });

});
