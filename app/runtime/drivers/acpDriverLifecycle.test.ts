// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createWorkspaceService } from '../../../bridge/runtime/workspaceService.js';
import { createAcpProcessManager } from '../../../bridge/acpProcessManager.js';
import { createAcpDriver } from '../../../bridge/runtime/drivers/acpDriver.js';

test('driver close retries a failed durable process invalidation after native exit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'acp-close-retry-'));
  const target = '11111111-1111-4111-8111-111111111111';
  const epoch = '33333333-3333-4333-8333-333333333333';
  const store = createRuntimeStore({
    stateDirectory: directory,
    environmentId: target,
    epoch,
    ownerId: '22222222-2222-4222-8222-222222222222',
  });
  const workspace = await createWorkspaceService({
    target,
    epoch,
    roots: [{ root: directory, permissions: ['read', 'reverse'] }],
  });
  const manager = createAcpProcessManager();
  const mutate = store.mutateControl.bind(store);
  let fail = true;
  try {
    await manager.reconcile([
      {
        id: 'owned',
        name: 'owned',
        enabled: true,
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL('../../../scripts/qa/runtime-v090-cases/task-15-fixture.mjs', import.meta.url),
          ),
          '--server',
        ],
      },
    ]);
    const driver = await createAcpDriver({
      store,
      manager,
      agentId: 'owned',
      target,
      epoch,
      harnessInstanceId: '44444444-4444-4444-8444-444444444444',
      cwd: directory,
      workspaceKey: workspace.workspaces[0].key,
      workspace: workspace.connect({
        target,
        epoch,
        generation: 1,
        subscriberId: 'owned',
        assertCurrent() {},
      }),
    });
    store.mutateControl = async (input) => {
      if (
        fail &&
        input.changes.some(
          (change) =>
            change.key.startsWith('acp-process:') &&
            change.value !== null &&
            typeof change.value === 'object' &&
            !Array.isArray(change.value) &&
            'alive' in change.value &&
            change.value.alive === false,
        )
      ) {
        fail = false;
        throw new Error('controlled durable cleanup failure');
      }
      return mutate(input);
    };
    await expect(driver.close()).rejects.toThrow();
    await expect(driver.close()).resolves.toBeUndefined();
    const rows = await store.page({ collection: 'operations' });
    const processRow = rows.items.find((row) => row.key.startsWith('acp-process:'));
    expect(processRow?.value).toMatchObject({ alive: false });
    expect(() => process.kill(driver.pid, 0)).toThrow();
  } finally {
    store.mutateControl = mutate;
    await manager.stopAll();
    await workspace.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

for (const failFirstRelease of [false, true]) {
  test(`close drains pending authentication terminal creation (release failure: ${failFirstRelease})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'acp-close-retry-'));
    const target = '11111111-1111-4111-8111-111111111111';
    const epoch = '33333333-3333-4333-8333-333333333333';
    const store = createRuntimeStore({
      stateDirectory: directory,
      environmentId: target,
      epoch,
      ownerId: '22222222-2222-4222-8222-222222222222',
    });
    const workspace = await createWorkspaceService({
      target,
      epoch,
      roots: [{ root: directory, permissions: ['read', 'reverse'] }],
    });
    const manager = createAcpProcessManager();
    const mutate = store.mutateControl.bind(store);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let releaseAttempts = 0;
    try {
      await manager.reconcile([
        {
          id: 'owned',
          name: 'owned',
          enabled: true,
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL(
                '../../../scripts/qa/runtime-v090-cases/task-15-fixture.mjs',
                import.meta.url,
              ),
            ),
            '--server',
          ],
        },
      ]);
      const driver = await createAcpDriver({
        store,
        manager,
        agentId: 'owned',
        target,
        epoch,
        harnessInstanceId: '44444444-4444-4444-8444-444444444444',
        cwd: directory,
        async createAuthTerminal() {
          entered.resolve();
          await gate.promise;
          return {
            terminalId: 'late-auth',
            async close() {
              if (++releaseAttempts === 1 && failFirstRelease)
                throw new Error('controlled terminal release failure');
            },
          };
        },
        workspaceKey: workspace.workspaces[0].key,
        workspace: workspace.connect({
          target,
          epoch,
          generation: 1,
          subscriberId: 'owned',
          assertCurrent() {},
        }),
      });
      const outcome = Promise.resolve(
        driver.driver.native.createAgentAuthPty({
          environmentId: driver.binding.target,
          harnessInstanceId: driver.binding.harnessInstanceId,
          params: {
            epoch,
            processGeneration: driver.binding.processGeneration,
            methodId: 'qa-auth',
            idempotencyKey: 'late-auth',
          },
        }),
      ).then(
        () => 'completed',
        () => 'rejected',
      );
      await entered.promise;
      let finished = false;
      const closing = driver.close().then(() => {
        finished = true;
      });
      let nativeAndDurableClosed = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        const rows = await store.page({ collection: 'operations' });
        const row = rows.items.find((item) => item.key.startsWith('acp-process:'));
        const value = row?.value;
        if (
          !manager.getStatus()[0].owned &&
          value &&
          typeof value === 'object' &&
          'alive' in value &&
          value.alive === false
        ) {
          nativeAndDurableClosed = true;
          break;
        }
        await delay(10);
      }
      expect(nativeAndDurableClosed).toBe(true);
      await setImmediate();
      await setImmediate();
      const closedBeforeCreationSettled = finished;
      gate.resolve();
      expect(await outcome).toBe('rejected');
      await closing;
      await driver.close();
      expect(closedBeforeCreationSettled).toBe(false);
      expect(releaseAttempts).toBe(failFirstRelease ? 2 : 1);
    } finally {
      gate.resolve();
      store.mutateControl = mutate;
      await manager.stopAll();
      await workspace.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}
