import { createCodexDriver } from '../../../bridge/runtime/drivers/codexDriver.js';
import { createCodexProcess } from '../../../bridge/runtime/drivers/codexProcess.js';
import { createWorkspaceService } from '../../../bridge/runtime/workspaceService.js';
import { createRuntimeHost } from '../../../bridge/runtime/runtimeHost.js';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { createInstanceOperations } from '../../../shared/runtime/native/codex/instanceOperations.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';
export async function instanceFaults(context) {
  const directory = await mkdtemp(path.join(context.temporaryRoot, 'instance-'));
  const environmentId = '11111111-1111-4111-8111-111111111111';
  const harnessInstanceId = '22222222-2222-4222-8222-222222222222';
  const epoch = '33333333-3333-4333-8333-333333333333';
  const options = { stateDirectory: directory, environmentId, ownerId: harnessInstanceId, epoch };
  let store = createRuntimeStore(options);
  let current = true;
  let submissions = 0;
  const make = (scope = { environmentId, harnessInstanceId, epoch, processGeneration: 1 }) =>
    createInstanceOperations({
      store,
      scope,
      isCurrent: () => current,
      fingerprint,
      newId: randomUUID,
    });
  const scenarios = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] });
  };
  try {
    let operations = make();
    const input = { method: 'thread/start', payload: { cwd: '/qa' }, idempotencyKey: 'accepted' };
    const accepted = await operations.accept(input);
    check(
      'duplicate accepted instance intent shares durable identity',
      (await operations.accept(input)).operationId,
      accepted.operationId,
    );
    await store.close();
    store = createRuntimeStore(options);
    operations = make();
    await operations.execute(accepted.operationId, async () => {
      submissions++;
      return { thread: { id: 'real-id' } };
    });
    check(
      'accepted instance intent survives actual worker restart',
      (await operations.get(accepted.operationId)).phase,
      'terminal',
    );
    const ambiguous = await operations.accept({ ...input, idempotencyKey: 'ambiguous' });
    await assert.rejects(() =>
      operations.execute(ambiguous.operationId, async () => {
        submissions++;
        throw Error('native died after submission');
      }),
    );
    await store.close();
    store = createRuntimeStore(options);
    operations = make();
    await assert.rejects(() =>
      operations.execute(ambiguous.operationId, async () => {
        submissions++;
      }),
    );
    check('ambiguous sent instance intent never replays after worker restart', submissions, 2);
    const foreign = make({
      environmentId,
      harnessInstanceId: environmentId,
      epoch,
      processGeneration: 1,
    });
    await assert.rejects(() =>
      foreign.execute(ambiguous.operationId, async () => {
        submissions++;
      }),
    );
    check('foreign instance cannot execute durable intent', submissions, 2);
    const loss = await foreign.accept({ ...input, idempotencyKey: 'loss-after-send' });
    await assert.rejects(() =>
      foreign.execute(loss.operationId, async () => {
        submissions++;
        current = false;
        return { thread: { id: 'lost-authority' } };
      }),
    );
    current = true;
    check(
      'authority loss after native submission retains sent fence',
      (await foreign.get(loss.operationId)).phase,
      'sent',
    );
    await assert.rejects(() =>
      foreign.execute(loss.operationId, async () => {
        submissions++;
      }),
    );
    check('restored observer cannot replay authority-lost submission', submissions, 3);
    current = false;
    await assert.rejects(() => operations.accept({ ...input, idempotencyKey: 'stale' }));
    check('authority loss rejects fresh intent', true, true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
  const evidence = path.join(context.outDir, `instance-${context.case}.json`);
  writeJson(evidence, { scenarios, submissions, actualWorkerRestart: true });
  return { scenarios, artifacts: [artifact(evidence, 'worker-restart')] };
}

export async function startupCancellation({ context, root, home, modelStarted }) {
  const environmentId = '11111111-1111-4111-8111-111111111111';
  const harnessInstanceId = '22222222-2222-4222-8222-222222222222';
  const epoch = '33333333-3333-4333-8333-333333333333';
  const store = createRuntimeStore({
    stateDirectory: path.join(home, 'driver-state'),
    environmentId,
    ownerId: harnessInstanceId,
    epoch,
  });
  const workspace = await createWorkspaceService({
    target: environmentId,
    epoch,
    roots: [{ root, permissions: ['read'] }],
  });
  const runtime = createRuntimeHost({ environmentId, role: 'execution' });
  runtime.start();
  const transport = createCodexProcess({ cwd: root, env: { ...process.env, CODEX_HOME: home } });
  const wire = [];
  const send = transport.send;
  transport.send = (raw) => {
    wire.push({ direction: 'client', message: JSON.parse(raw) });
    send(raw);
  };
  const off = transport.subscribe(
    (raw) => wire.push({ direction: 'native', message: JSON.parse(raw) }),
    () => {},
  );
  const driver = await createCodexDriver({
    environmentId,
    harnessInstanceId,
    epoch,
    processGeneration: 1,
    runtime,
    store,
    workspace,
    allowedWorkspaces: [workspace.workspaces[0].key],
    transport,
    isProcessCurrent: () => true,
  });
  const base = { environmentId, harnessInstanceId };
  const core = driver.registration.driver.core;
  const snapshots = [];
  let restarted;
  let restartedTransport;
  try {
    const created = await core.createSession({
      ...base,
      params: {
        workspaceKey: workspace.workspaces[0].key,
        idempotencyKey: 'real-create',
        native: {
          model: 'gpt-5.4',
          modelProvider: 'custom',
          sandbox: 'read-only',
          approvalPolicy: 'never',
        },
      },
    });
    const session = created.result.session.session;
    const result = await core.send({
      ...base,
      session,
      params: {
        idempotencyKey: 'early-send',
        native: { input: [{ type: 'text', text: 'native hello' }] },
      },
    });
    const before = await driver.journal.get(result.operationId);
    const modelHadStarted = modelStarted();
    let cancellation;
    try {
      cancellation = await core.cancel({
        ...base,
        session,
        params: { operationId: result.operationId },
      });
    } catch (error) {
      cancellation = { code: error.code, field: error.field, nativeCode: error.nativeCode ?? null };
    }
    const deadline = Date.now() + 15000;
    let terminal;
    for (;;) {
      terminal = await driver.journal.get(result.operationId);
      if (terminal.phase === 'terminal') break;
      assert(Date.now() < deadline, 'early cancellation must not strand pending operation');
      await delay(10);
    }
    assert(['completed', 'interrupted'].includes(terminal.outcome));
    const sends = wire.filter(
      (entry) => entry.direction === 'client' && entry.message.method === 'turn/start',
    );
    assert.equal(sends.length, 1, 'no replay on early cancellation');
    if (cancellation.code) assert(['invalid_request', 'conflict'].includes(cancellation.code));
    snapshots.push({
      before,
      modelHadStarted,
      cancellation,
      terminal,
      nativeSendCount: sends.length,
    });
    const forked = await driver.registration.driver.native.forkSession({
      ...base,
      session,
      params: { idempotencyKey: 'real-fork', native: {} },
    });
    const forkSession = forked.result.session.session;
    const forkSent = await core.send({
      ...base,
      session: forkSession,
      params: {
        idempotencyKey: 'fork-send',
        native: { input: [{ type: 'text', text: 'native fork hello' }] },
      },
    });
    const waitOperation = async (owner, id) => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const row = await owner.journal.get(id);
        if (row.phase === 'terminal') return row;
        assert(Date.now() < deadline, 'native driver terminal deadline');
        await delay(10);
      }
    };
    assert.equal((await waitOperation(driver, forkSent.operationId)).outcome, 'completed');
    assert.equal(
      wire.filter(
        (entry) => entry.direction === 'client' && entry.message.method === 'thread/resume',
      ).length,
      0,
      'created and forked threads are already loaded in this generation',
    );
    await driver.close();
    await transport.exited;
    await assert.rejects(async () => core.inspect(base));
    restartedTransport = createCodexProcess({
      cwd: root,
      env: { ...process.env, CODEX_HOME: home },
    });
    const restartedSend = restartedTransport.send;
    restartedTransport.send = (raw) => {
      wire.push({ direction: 'restarted-client', message: JSON.parse(raw) });
      restartedSend(raw);
    };
    restarted = await createCodexDriver({
      environmentId,
      harnessInstanceId,
      epoch,
      processGeneration: 2,
      runtime,
      store,
      workspace,
      allowedWorkspaces: [workspace.workspaces[0].key],
      transport: restartedTransport,
      isProcessCurrent: () => true,
    });
    const afterRestart = await restarted.registration.driver.core.send({
      ...base,
      session,
      params: {
        idempotencyKey: 'restart-send',
        native: { input: [{ type: 'text', text: 'native restart hello' }] },
      },
    });
    assert.equal((await waitOperation(restarted, afterRestart.operationId)).outcome, 'completed');
    assert.equal(
      wire.filter(
        (entry) =>
          entry.direction === 'restarted-client' && entry.message.method === 'thread/resume',
      ).length,
      1,
      'new generation resumes persisted thread',
    );
    snapshots.push({
      forkCompleted: true,
      createdAndForkedResumeCount: 0,
      restartedResumeCount: 1,
      oldDriverRejected: true,
    });
    const file = path.join(context.outDir, `live-startup-cancel-${context.case}.json`);
    writeJson(file, { snapshots, wire });
    return {
      scenarios: [
        {
          name: 'actual driver early cancellation retains truthful terminal outcome without replay',
          assertions: [
            {
              name: 'bounded terminal and exactly one native send',
              observed: [terminal.phase, sends.length],
              expected: ['terminal', 1],
              passed: true,
            },
          ],
        },
      ],
      artifacts: [artifact(file, 'real-driver-startup-cancel')],
    };
  } finally {
    writeJson(path.join(context.outDir, `driver-startup-wire-${context.case}.json`), {
      snapshots,
      wire,
    });
    off();
    if (restarted) await restarted.close();
    if (restartedTransport) await restartedTransport.close();
    await driver.close();
    await transport.exited;
    await workspace.close();
    await store.close();
    await runtime.stop();
  }
}
