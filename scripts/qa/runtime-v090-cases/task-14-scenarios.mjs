import { fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeHost } from '../../../bridge/runtime/runtimeHost.js';
import { createWorkspaceService } from '../../../bridge/runtime/workspaceService.js';
import { createCodexDriver } from '../../../bridge/runtime/drivers/codexDriver.js';
import { createCodexProcess } from '../../../bridge/runtime/drivers/codexProcess.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';
const environmentId = '11111111-1111-4111-8111-111111111111';
const harnessInstanceId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
export async function until(read, test) {
  const end = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (test(value)) return value;
    assert(Date.now() < end, 'observation timeout');
    await delay(10);
  }
}
export async function controlled(context) {
  const temporary = await mkdtemp(path.join(context.temporaryRoot, 'codex-'));
  const root = path.join(temporary, 'repo');
  await mkdir(root);
  const wire = path.join(path.dirname(context.out), `controlled-${context.case}.jsonl`);
  await writeFile(wire, '');
  const store = createRuntimeStore({
    stateDirectory: path.join(temporary, 'state'),
    environmentId,
    ownerId: harnessInstanceId,
    epoch,
  });
  const workspace = await createWorkspaceService({
    target: environmentId,
    epoch,
    roots: [{ root, permissions: ['read', 'write'] }],
  });
  const runtime = createRuntimeHost({ environmentId, role: 'execution' });
  runtime.start();
  const transport = createCodexProcess({
    executable: process.execPath,
    args: [path.resolve('scripts/qa/runtime-v090-cases/task-14-fixture.mjs')],
    env: { ...process.env, VIS_QA_ROOT: root, VIS_QA_WIRE: wire },
  });
  let current = true;
  const errors = [];
  const driver = await createCodexDriver({
    environmentId,
    harnessInstanceId,
    epoch,
    processGeneration: 1,
    store,
    workspace,
    runtime,
    allowedWorkspaces: [workspace.workspaces[0].key],
    transport,
    isProcessCurrent: () => current,
    onError: (e) => errors.push(String(e)),
  });
  const { core, native } = driver.registration.driver;
  const base = { environmentId, harnessInstanceId };
  const session = (id) => ({ ...base, nativeSessionId: id });
  const ctx = (id, params) => ({ ...base, session: session(id), params });
  const scenarios = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const events = [];
  const subscription = core.subscribe(base);
  const consume = (async () => {
    for await (const e of subscription) events.push(e);
  })();
  const send = (id, text, key, queue = false) =>
    core.send(ctx(id, { native: { input: [{ type: 'text', text }] }, idempotencyKey: key, queue }));
  try {
    const inventory = [];
    let cursor = null;
    let page;
    do {
      page = await core.listSessionPage({ ...base, params: { cursor, limit: 13 } });
      inventory.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    check(
      '65 independently expected IDs include 58 active, archived and custom provider',
      inventory.map((v) => v.session.nativeSessionId).sort(),
      Array.from({ length: 65 }, (_, i) => `native-${i}`).sort(),
    );
    check(
      'archive mappings retain seven archived threads',
      inventory.filter((v) => v.archived).length,
      7,
    );
    const history = [];
    cursor = null;
    do {
      page = await core.readHistoryPage(ctx('native-1', { cursor }));
      history.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    check(
      'continuation tool has preceding explicit user parent',
      history[2].canonical[0].info.parentID,
      't1:user:u1',
    );
    const other = await send('native-2', 'hold', 'other');
    if (context.case === 'happy') {
      const sent = await send('native-1', 'interactions', 'interactive');
      const approval = await until(
        () =>
          events.find(
            (e) => e.type === 'interaction.pending' && e.payload.method.endsWith('requestApproval'),
          ),
        Boolean,
      );
      await core.respondInteraction(
        ctx('native-1', {
          interactionId: approval.payload.interactionId,
          answer: { decision: 'accept' },
        }),
      );
      const elicitation = await until(
        () =>
          events.find(
            (e) =>
              e.type === 'interaction.pending' &&
              e.payload.method === 'mcpServer/elicitation/request',
          ),
        Boolean,
      );
      await core.respondInteraction(
        ctx('native-1', {
          interactionId: elicitation.payload.interactionId,
          answer: { action: 'accept', content: { choice: 'yes' } },
        }),
      );
      const completed = await until(
        () => driver.journal.get(sent.operationId),
        (r) => r.phase === 'terminal',
      );
      check(
        'permissions and elicitation round trip finishes original operation',
        completed.outcome,
        'completed',
      );
      check(
        'second concurrent session remains active',
        (await driver.journal.get(other.operationId)).phase,
        'observed',
      );
      await native['codex.steer'](
        ctx('native-2', {
          idempotencyKey: 'steer',
          native: {
            expectedTurnId: other.result.turn.id,
            input: [{ type: 'text', text: 'steer' }],
          },
        }),
      );
      check(
        'steering preserves pending parent turn ownership',
        (await driver.journal.get(other.operationId)).phase,
        'observed',
      );
      await assert.rejects(() =>
        native['codex.steer'](
          ctx('native-2', {
            idempotencyKey: 'stale-steer',
            native: { expectedTurnId: 'stale', input: [{ type: 'text', text: 'bad' }] },
          }),
        ),
      );
      check('stale steering turn rejected', true, true);
      const queued = await send('native-2', 'queued', 'queued', true);
      check(
        'queued mutation stays accepted until native terminal',
        (await driver.journal.get(queued.operationId)).phase,
        'accepted',
      );
      await core.cancel(ctx('native-2', { operationId: queued.operationId }));
      check(
        'queued cancellation never dispatches native turn',
        (await driver.journal.get(queued.operationId)).outcome,
        'cancelled',
      );
      const created = await core.createSession({
        ...base,
        params: { workspaceKey: workspace.workspaces[0].key, idempotencyKey: 'create' },
      });
      check(
        'native create returns real SessionRef',
        created.result.session.session.nativeSessionId.startsWith('created-'),
        true,
      );
      const createdId = created.result.session.session.nativeSessionId;
      const createdSend = await send(createdId, 'created message', 'created-send');
      check(
        'created thread sends without redundant native resume',
        (
          await until(
            () => driver.journal.get(createdSend.operationId),
            (row) => row.phase === 'terminal',
          )
        ).outcome,
        'completed',
      );
      const forked = await native.forkSession(
        ctx('native-1', { idempotencyKey: 'fork', native: {} }),
      );
      const forkSend = await send(
        forked.result.session.session.nativeSessionId,
        'fork message',
        'fork-send',
      );
      check(
        'forked thread sends without redundant native resume',
        (
          await until(
            () => driver.journal.get(forkSend.operationId),
            (row) => row.phase === 'terminal',
          )
        ).outcome,
        'completed',
      );
    } else {
      const leaseKey = `lease:${fingerprint(encodeSessionKey(session('native-2')))}`;
      const lease = await store.getControl({ collection: 'operations', key: leaseKey });
      const changed = await store.mutateControl({
        intentId: 'foreign-lease',
        changes: [
          {
            collection: 'operations',
            key: leaseKey,
            expectedRevision: lease.revision,
            value: { operationId: 'foreign-owner' },
          },
        ],
      });
      await assert.rejects(() =>
        native['codex.steer'](
          ctx('native-2', {
            idempotencyKey: 'foreign-steer',
            native: {
              expectedTurnId: other.result.turn.id,
              input: [{ type: 'text', text: 'bad' }],
            },
          }),
        ),
      );
      await store.mutateControl({
        intentId: 'restore-owned-lease',
        changes: [
          {
            collection: 'operations',
            key: leaseKey,
            expectedRevision: changed.revision,
            value: lease.value,
          },
        ],
      });
      check(
        'steering refuses a foreign actual worker lease without completing its parent',
        (await driver.journal.get(other.operationId)).phase,
        'observed',
      );
      const sent = await send('native-1', 'error', 'failure');
      const failed = await until(
        () => driver.journal.get(sent.operationId),
        (r) => r.phase === 'terminal',
      );
      check('acknowledged send waits for native failure outcome', failed.outcome, 'failed');
      await store.mutate({
        intentId: 'aux-fragment',
        changes: [
          {
            collection: 'artifacts',
            key: 'aux-native-3',
            expectedRevision: 0,
            value: { content: 'caller fragment' },
          },
        ],
      });
      const scan = await core.listSessionPage({ ...base, params: { limit: 5 } });
      await native.updateSession(
        ctx('native-3', { idempotencyKey: 'archive', native: { archived: true } }),
      );
      const raced = await core.listSessionPage({
        ...base,
        params: { cursor: scan.cursor, limit: 5 },
      });
      check(
        'archive invalidates in-flight inventory without false complete',
        raced.completeness,
        'partial',
      );
      await native.deleteSession(ctx('native-3', { idempotencyKey: 'delete', native: {} }));
      check(
        'native deletion preserves unrelated auxiliary fragments',
        (await store.get({ collection: 'artifacts', key: 'aux-native-3' })).value.content,
        'caller fragment',
      );
      await assert.rejects(() =>
        core.send({
          ...ctx('native-1', { native: { input: [] }, idempotencyKey: 'foreign' }),
          session: { ...session('native-1'), harnessInstanceId: environmentId },
        }),
      );
      check('foreign harness rejected', true, true);
    }
    await core.cancel(ctx('native-2', { operationId: other.operationId }));
    check(
      'cancel finishes only its owned native turn',
      (
        await until(
          () => driver.journal.get(other.operationId),
          (r) => r.phase === 'terminal',
        )
      ).outcome,
      'interrupted',
    );
    await assert.rejects(() => core.cancel(ctx('native-2', { operationId: other.operationId })));
    check(
      'repeated cancellation after terminal cannot reopen or replay operation',
      (await driver.journal.get(other.operationId)).outcome,
      'interrupted',
    );
    const messages = (await readFile(wire, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    check(
      'history never eagerly reads all native turns',
      messages
        .filter((v) => v.direction === 'client')
        .every(
          (v) => v.message.method !== 'thread/read' || v.message.params.includeTurns === false,
        ),
      true,
    );
    current = false;
    await assert.rejects(async () => core.inspect(base));
    check('old generation rejected', true, true);
  } finally {
    await subscription.return();
    await consume;
    await driver.close();
    await workspace.close();
    await store.close();
    await runtime.stop();
    await transport.exited;
    await rm(temporary, { recursive: true, force: true });
  }
  const evidence = path.join(path.dirname(context.out), `controlled-${context.case}.json`);
  writeJson(evidence, { scenarios, errors, process: transport.inspection() });
  return {
    scenarios,
    artifacts: [artifact(wire, 'controlled-native-protocol'), artifact(evidence, 'assertions')],
  };
}
