// @vitest-environment node
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
  it.each([false, true])('releases the lease after daemon IPC closes (reply in flight: %s)', async (inFlight) => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-store-disconnect-'));
    const workerFile = fileURLToPath(new URL('../bridge/runtime/storage/runtimeDatabaseWorker.mjs', import.meta.url));
    const worker = fork(workerFile, [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(worker, 'exit');
    try {
      const reply = once(worker, 'message');
      worker.send({ id: 1, method: 'initialize', params: { stateDirectory, environmentId, ownerId, epoch } });
      expect((await reply)[0]).toMatchObject({ ok: true });
      if (inFlight) {
        const locker = new DatabaseSync(path.join(stateDirectory, 'runtime', 'runtime.db'));
        locker.exec('BEGIN EXCLUSIVE');
        try {
          worker.send({ id: 2, method: 'inspect', params: {} });
          await delay(75);
          worker.disconnect();
          await delay(75);
        } finally { locker.exec('ROLLBACK'); locker.close(); }
      } else {
        worker.disconnect();
      }
      expect((await exited)[0]).toBe(0);
      const reopened = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch });
      try { await expect(reopened.ready).resolves.toMatchObject({ fence: 2 }); }
      finally { await reopened.close(); }
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
      await exited;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('recovers only a verified dead owner on daemon restart', async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-store-dead-owner-'));
    const options = { stateDirectory, environmentId, ownerId, epoch, recoverDeadOwner: true };
    const old = createRuntimeStore(options);
    try {
      await old.ready;
      await old.mutate({ intentId: 'before-crash', changes: [{ collection: 'threads', key: 'thread', value: { title: 'preserved' } }] });
      const competitor = createRuntimeStore(options);
      try { await expect(competitor.ready).rejects.toMatchObject({ reason: 'owner_conflict' }); }
      finally { await competitor.terminate(); }
      await old.terminate();
      const recovered = createRuntimeStore(options);
      try {
        await expect(recovered.ready).resolves.toMatchObject({ fence: 2 });
        expect(await recovered.get({ collection: 'threads', key: 'thread' })).toMatchObject({ value: { title: 'preserved' } });
      } finally { await recovered.close(); }
    } finally { await old.terminate(); await rm(stateDirectory, { recursive: true, force: true }); }
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
  it('failure ends the lifecycle when the store worker cannot spawn', async () => {
    // Given an install root whose packaged runtime binary is missing.
    const stateDirectory = await mkdtemp(path.join(tmpdir(), 'runtime-store-test-'));
    const installRoot = await mkdtemp(path.join(tmpdir(), 'runtime-store-root-'));
    const store = createRuntimeStore({ stateDirectory, environmentId, ownerId, epoch, installRoot });
    try {
      await expect(store.ready).rejects.toMatchObject({ code: 'source_unavailable', reason: 'worker_exit' });
      await expect(store.close()).resolves.toMatchObject({ code: null, signal: null });
      await expect(store.terminate()).resolves.toMatchObject({ code: null, signal: null });
      await expect(store.close()).resolves.toMatchObject({ code: null, signal: null });
    } finally { await rm(stateDirectory, { recursive: true, force: true }); await rm(installRoot, { recursive: true, force: true }); }
  }, 3000);
});
