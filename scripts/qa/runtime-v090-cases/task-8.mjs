import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createOperationJournal } from '../../../bridge/runtime/operationJournal.js';
import { createInteractionStore } from '../../../bridge/runtime/interactionStore.js';
import { createAdmissionQueue } from '../../../bridge/runtime/admissionQueue.js';
import { artifact, digest, writeJson } from '../runtime-v090-evidence.mjs';
export const sourceFiles = [
  'operationJournal.js',
  'operationJournal.d.ts',
  'interactionStore.js',
  'interactionStore.d.ts',
  'admissionQueue.js',
  'admissionQueue.d.ts',
  'storage/runtimeStore.js',
  'storage/runtimeStore.d.ts',
  'storage/storeProtocol.js',
  'storage/runtimeDatabaseWorker.mjs',
  'storage/schema.js',
  'storage/storeQueries.js',
  'storage/localFilesystem.js',
].map((name) => `bridge/runtime/${name}`);
const environmentId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
const scope = {
  target: environmentId,
  epoch,
  processGeneration: 1,
  session: { environmentId, harnessInstanceId: ownerId, nativeSessionId: 'native-1' },
};
export async function run(context) {
  const temporary = await mkdtemp(path.join(context.temporaryRoot, 'operations-'));
  const scenarios = [];
  const stores = [];
  const exits = [];
  const artifacts = [];
  const native = [];
  const deferreds = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] });
  };
  const failure = async (name, action, code, reason) => {
    let observed;
    try {
      await action();
    } catch (error) {
      observed = { code: error.code, reason: error.reason };
    }
    check(name, observed, { code, reason });
  };
  const open = (name, extra = {}) => {
    const store = createRuntimeStore({
      stateDirectory: path.join(temporary, name),
      environmentId,
      ownerId,
      epoch,
      ...extra,
    });
    stores.push(store);
    return store;
  };
  const journalFor = (store, extra = {}) =>
    createOperationJournal({
      store,
      isProcessCurrent: (candidate) =>
        candidate.processGeneration === 1 && candidate.epoch === epoch,
      ...extra,
    });
  const input = (idempotencyKey, extra = {}) => ({
    scope,
    idempotencyKey,
    method: 'send',
    payload: { text: 'hello' },
    ...extra,
  });
  const externallyRead = (directory) => {
    const db = new DatabaseSync(path.join(temporary, directory, 'runtime/runtime.db'), {
      readOnly: true,
    });
    try {
      return {
        operations: db
          .prepare(
            "SELECT key,value FROM operations WHERE json_extract(value,'$.kind')='operation'",
          )
          .all()
          .map((row) => ({ key: row.key, ...JSON.parse(row.value) })),
        intents: db.prepare('SELECT count(*) AS count FROM runtime_intents').get().count,
      };
    } finally {
      db.close();
    }
  };
  try {
    if (context.case === 'happy') {
      const store = open('happy');
      const ready = await store.ready;
      const journal = journalFor(store);
      const interactions = createInteractionStore({ store });
      await interactions.bindProcess(scope);
      const windows = ['window-1', 'window-2'].map((windowId) =>
        vm.createContext({
          windowId,
          request: () => journal.accept(input('same')),
          execute: (id) =>
            journal.execute(id, scope, (request) => {
              native.push({ windowId, type: 'send', operationId: request.operationId });
              return { nativeTurn: 'turn-1' };
            }),
        }),
      );
      const accepted = await Promise.all(
        windows.map((window) => vm.runInContext('request()', window)),
      );
      check('two window contexts receive same durable operation', accepted[0], accepted[1]);
      const committed = externallyRead('happy');
      check(
        'independent SQLite connection sees exactly one committed operation',
        committed.operations.length,
        1,
      );
      check(
        'acceptance is separate from native execution',
        committed.operations[0].phase,
        'accepted',
      );
      check(
        'durable intent committed before native callback',
        committed.intents > 0 && native.length === 0,
        true,
      );
      const results = await Promise.allSettled(
        windows.map((window, index) => {
          window.id = accepted[index].operationId;
          return vm.runInContext('execute(id)', window);
        }),
      );
      check(
        'actual native submission count for two windows',
        native.filter((entry) => entry.type === 'send').length,
        1,
      );
      check(
        'one window owns native execution',
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      check(
        'native execution acknowledgement does not invent terminal success',
        (await journal.get(accepted[0].operationId)).phase,
        'observed',
      );
      const key = await interactions.pending({
        scope,
        nativeRequestId: 7,
        payload: { options: ['approve', 'deny'] },
      });
      check(
        'pending interaction survives absence of window connections',
        (await interactions.get(key)).phase,
        'pending',
      );
      const replies = await Promise.allSettled(
        windows.map((window) => {
          window.reply = () =>
            interactions.reply(key, scope, 'approve', ({ nativeRequestId }) => {
              native.push({ type: 'reply', nativeRequestId, windowId: window.windowId });
            });
          return vm.runInContext('reply()', window);
        }),
      );
      check(
        'two windows submit one upstream permission response',
        native.filter((entry) => entry.type === 'reply').length,
        1,
      );
      check(
        'single successful permission claimant',
        replies.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const largeScope = {
        ...scope,
        session: { ...scope.session, nativeSessionId: 'large-native' },
      };
      const largeText = '汉字🌿"\\\n'.repeat(45000);
      const largeAccepted = await journal.accept(
        input('large', { scope: largeScope, payload: { text: largeText } }),
      );
      exits.push(await store.terminate());
      const restarted = open('happy', { takeover: { expectedFence: ready.fence } });
      await restarted.ready;
      const recovered = journalFor(restarted);
      check(
        'worker restart retains observed operation',
        (await recovered.get(accepted[0].operationId)).phase,
        'observed',
      );
      await recovered.reconcile(accepted[0].operationId, scope);
      await failure(
        'restart cannot resubmit ambiguous native operation',
        () =>
          recovered.execute(accepted[0].operationId, scope, () =>
            native.push({ type: 'duplicate' }),
          ),
        'reconcile_required',
        'operation_phase',
      );
      check('restart leaves one native send and reply', native.length, 2);
      const largeResult = await recovered.execute(
        largeAccepted.operationId,
        largeScope,
        ({ payload }) => digest(payload.text),
      );
      check(
        'large Unicode prompt survives committed chunk storage and worker restart losslessly',
        largeResult.result,
        digest(largeText),
      );
      const dump = path.join(context.outDir, 'happy-sqlite.json');
      writeJson(dump, externallyRead('happy'));
      artifacts.push(artifact(dump, 'independent-sqlite-readback'));
    } else {
      const isolated = open('foreign-target');
      await isolated.ready;
      const foreignScope = {
        ...scope,
        target: ownerId,
        session: { ...scope.session, environmentId: ownerId },
      };
      const isolatedJournal = journalFor(isolated, { isProcessCurrent: () => true });
      const isolatedInteractions = createInteractionStore({ store: isolated });
      await failure(
        'trusted store rejects foreign target despite permissive process predicate',
        () => isolatedJournal.accept(input('foreign', { scope: foreignScope })),
        'conflict',
        'store_target',
      );
      await failure(
        'trusted store rejects foreign interaction process registration',
        () => isolatedInteractions.bindProcess(foreignScope),
        'conflict',
        'store_target',
      );
      const foreignDb = new DatabaseSync(
        path.join(temporary, 'foreign-target/runtime/runtime.db'),
        { readOnly: true },
      );
      try {
        check(
          'foreign requests create zero operation interaction payload and intent rows',
          ['operations', 'interactions', 'runtime_intents'].map(
            (table) => foreignDb.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,
          ),
          [0, 0, 0],
        );
      } finally {
        foreignDb.close();
      }
      const rejectedGeneration = journalFor(isolated, { isProcessCurrent: () => false });
      await failure(
        'inactive generation cannot receive false durable acceptance',
        () => rejectedGeneration.accept(input('inactive-generation')),
        'reconcile_required',
        'stale_generation',
      );
      check(
        'inactive generation creates no durable revision',
        (await isolated.inspect()).revision,
        0,
      );
      const localAccepted = await isolatedJournal.accept(input('local-valid'));
      check(
        'trusted local target remains usable after foreign scope rejection',
        localAccepted.phase,
        'durable-accepted',
      );
      const store = open('failure');
      const ready = await store.ready;
      let journal = journalFor(store);
      const accepted = await journal.accept(input('before-send'));
      exits.push(await store.terminate());
      const restarted = open('failure', { takeover: { expectedFence: ready.fence } });
      const restartedReady = await restarted.ready;
      journal = journalFor(restarted);
      await journal.execute(accepted.operationId, scope, () => {
        native.push({ type: 'send-before-restart' });
      });
      check(
        'worker killed before send permits exactly one first send after recovery',
        native.length,
        1,
      );
      await journal.terminal(accepted.operationId, scope, 'completed');
      const ambiguous = await journal.accept(input('after-send'));
      let failed = false;
      try {
        await journal.execute(ambiguous.operationId, scope, async () => {
          native.push({ type: 'send-after-restart' });
          exits.push(await restarted.terminate());
        });
      } catch (error) {
        failed = error.code === 'source_unavailable' || error.code === 'reconcile_required';
      }
      check('worker kill after native send cannot report native acknowledgement', failed, true);
      check(
        'external SQLite retains sent marker after worker loss',
        externallyRead('failure').operations.find(
          (operation) => operation.operationId === ambiguous.operationId,
        ).phase,
        'sent',
      );
      const successor = open('failure', { takeover: { expectedFence: restartedReady.fence } });
      await successor.ready;
      journal = journalFor(successor);
      await journal.reconcile(ambiguous.operationId, scope);
      await failure(
        'ambiguous send has no automatic retry',
        () =>
          journal.execute(ambiguous.operationId, scope, () => native.push({ type: 'duplicate' })),
        'reconcile_required',
        'operation_phase',
      );
      check('native counter remains two across both worker kills', native.length, 2);
      await failure(
        'payload mismatch rejects existing scoped key',
        () => journal.accept(input('after-send', { payload: { text: 'changed' } })),
        'conflict',
        'idempotency_mismatch',
      );
      await failure(
        'generation mismatch rejects existing scoped key',
        () => journal.accept(input('after-send', { scope: { ...scope, processGeneration: 2 } })),
        'conflict',
        'idempotency_mismatch',
      );
      await failure(
        'malformed target/session rejected before durable intent',
        () => journal.accept(input('invalid', { scope: { ...scope, target: ownerId } })),
        'invalid_request',
        'scope',
      );
      await failure(
        'empty idempotency key rejected',
        () => journal.accept(input('')),
        'invalid_request',
        'text',
      );
      await failure(
        'wrong scope cannot cancel operation',
        () => journal.cancel(ambiguous.operationId, { ...scope, processGeneration: 2 }),
        'conflict',
        'scope_fence',
      );
      const otherScope = {
        ...scope,
        session: { ...scope.session, nativeSessionId: 'another-session' },
      };
      const other = await journal.accept(input('after-send', { scope: otherScope }));
      check(
        'same user key in different session has independent identity',
        other.operationId !== ambiguous.operationId,
        true,
      );
      await failure(
        'session lease held while old send is unresolved',
        async () => {
          const waiting = await journal.accept(input('blocked-by-lease'));
          await journal.execute(waiting.operationId, scope, () =>
            native.push({ type: 'should-not-send' }),
          );
        },
        'conflict',
        'session_busy',
      );
      await journal.terminal(ambiguous.operationId, scope, 'interrupted');
      const timeout = await journal.accept(input('timeout'));
      const deferred = Promise.withResolvers();
      deferreds.push(deferred);
      await failure(
        'native deadline is timeout rather than success',
        () =>
          journal.execute(timeout.operationId, scope, () => deferred.promise, { deadlineMs: 1000 }),
        'timeout',
        'deadline',
      );
      check(
        'deadline leaves durable reconciliation state',
        (await journal.get(timeout.operationId)).phase,
        'reconciling',
      );
      deferred.resolve();
      await journal.terminal(timeout.operationId, scope, 'interrupted');
      const race = await journal.accept(input('race'));
      await journal.execute(race.operationId, scope, () => null);
      await Promise.all([
        journal.cancel(race.operationId, scope),
        journal.terminal(race.operationId, scope, 'completed'),
      ]);
      check(
        'cancel races native terminal without overwriting outcome',
        (await journal.get(race.operationId)).outcome,
        'completed',
      );
      const cancelled = await journal.accept(input('cancelled'));
      await journal.cancel(cancelled.operationId, scope);
      await failure(
        'cancel before send forbids native execution',
        () =>
          journal.execute(cancelled.operationId, scope, () =>
            native.push({ type: 'should-not-send' }),
          ),
        'conflict',
        'operation_phase',
      );
      const stale = await journal.accept(input('stale'));
      const staleJournal = journalFor(successor, { isProcessCurrent: () => false });
      await failure(
        'old native generation cannot send accepted operation',
        () =>
          staleJournal.execute(stale.operationId, scope, () =>
            native.push({ type: 'should-not-send' }),
          ),
        'reconcile_required',
        'stale_generation',
      );
      const interactions = createInteractionStore({ store: successor });
      await interactions.bindProcess(scope);
      const permission = await interactions.pending({ scope, nativeRequestId: 1, payload: null });
      await interactions.processExited(scope);
      await interactions.bindProcess({ ...scope, processGeneration: 2 });
      await failure(
        'exited generation cannot answer old RPC',
        () =>
          interactions.reply(permission, scope, 'approve', () =>
            native.push({ type: 'old-reply' }),
          ),
        'reconcile_required',
        'stale_generation',
      );
      check(
        'pending old RPC is explicitly invalidated',
        (await interactions.get(permission)).phase,
        'invalidated',
      );
      await interactions.bindProcess(otherScope);
      const independentPermission = await interactions.pending({
        scope: otherScope,
        nativeRequestId: 1,
        payload: null,
      });
      check(
        'independent session RPC remains pending after first generation exit',
        (await interactions.get(independentPermission)).phase,
        'pending',
      );
      const liveScope = { ...scope, processGeneration: 2 };
      const uncertainPermission = await interactions.pending({
        scope: liveScope,
        nativeRequestId: 2,
        payload: null,
      });
      const replyDeferred = Promise.withResolvers();
      deferreds.push(replyDeferred);
      let uncertainReplies = 0;
      await failure(
        'permission reply deadline is not upstream success',
        () =>
          interactions.reply(
            uncertainPermission,
            liveScope,
            'approve',
            () => {
              uncertainReplies++;
              return replyDeferred.promise;
            },
            { deadlineMs: 1000 },
          ),
        'timeout',
        'deadline',
      );
      check(
        'permission deadline leaves durable reconciliation state',
        (await interactions.get(uncertainPermission)).phase,
        'reconciling',
      );
      await failure(
        'uncertain permission response is never replayed',
        () =>
          interactions.reply(uncertainPermission, liveScope, 'approve', () => {
            uncertainReplies++;
          }),
        'conflict',
        'interaction_claimed',
      );
      check('uncertain upstream permission submission counted once', uncertainReplies, 1);
      replyDeferred.resolve();
      await failure(
        'old generation native terminal cannot complete operation',
        () => staleJournal.terminal(stale.operationId, scope, 'completed'),
        'reconcile_required',
        'stale_generation',
      );
      for (const [name, changed] of [
        ['epoch', { ...scope, epoch: ownerId }],
        ['harness', { ...scope, session: { ...scope.session, harnessInstanceId: epoch } }],
        ['session', { ...scope, session: { ...scope.session, nativeSessionId: 'wrong' } }],
      ])
        await failure(
          `${name} fence rejects misattributed cancellation`,
          () => journal.cancel(stale.operationId, changed),
          'conflict',
          'scope_fence',
        );
      check('failure paths never submit extra native messages', native.length, 2);
      const queue = createAdmissionQueue();
      const release = Promise.withResolvers();
      deferreds.push(release);
      const normals = Array.from({ length: 256 }, () => queue.run({}, () => release.promise));
      await failure(
        '257th normal admission rejected before work allocation',
        () => queue.run({}, () => null),
        'source_unavailable',
        'queue_full',
      );
      const controls = Array.from({ length: 16 }, () =>
        queue.run({ reserved: true }, () => release.promise),
      );
      await failure(
        'control flood bounded at 16 reserved slots',
        () => queue.run({ reserved: true }, () => null),
        'source_unavailable',
        'queue_full',
      );
      check('full normal queue retains all reserved control work', queue.pending.total, 272);
      release.resolve();
      await Promise.all([...normals, ...controls]);
      const timedQueue = createAdmissionQueue();
      const releaseTimed = Promise.withResolvers();
      deferreds.push(releaseTimed);
      const timedWork = Array.from({ length: 256 }, () =>
        timedQueue.run({ deadlineMs: 1 }, () => releaseTimed.promise).catch((error) => error.code),
      );
      check(
        'all timed-out requests return explicit timeout',
        [...new Set(await Promise.all(timedWork))],
        ['timeout'],
      );
      check(
        'timed-out unfinished tasks remain bounded and accounted',
        timedQueue.pending.total,
        256,
      );
      await failure(
        'timeout churn cannot admit unbounded unfinished promises',
        () => timedQueue.run({}, () => null),
        'source_unavailable',
        'queue_full',
      );
      releaseTimed.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      check('settled timed-out tasks release their slots', timedQueue.pending.total, 0);
      const connection = createAdmissionQueue({ connectionOnly: true });
      const releaseConnection = Promise.withResolvers();
      deferreds.push(releaseConnection);
      const connections = Array.from({ length: 512 }, () =>
        connection.run({}, () => releaseConnection.promise),
      );
      await failure(
        '513th connection request rejected',
        () => connection.run({}, () => null),
        'source_unavailable',
        'queue_full',
      );
      releaseConnection.resolve();
      await Promise.all(connections);
      const byteQueue = createAdmissionQueue();
      const releaseBytes = Promise.withResolvers();
      deferreds.push(releaseBytes);
      const byteWork = byteQueue.run({ size: 15 * 1024 * 1024 }, () => releaseBytes.promise);
      await failure(
        'normal payload budget reserves control bytes',
        () => byteQueue.run({ size: 1 }, () => null),
        'source_unavailable',
        'queue_full',
      );
      const controlBytes = byteQueue.run(
        { size: 1024 * 1024, reserved: true },
        () => releaseBytes.promise,
      );
      await failure(
        'total payload bound rejects control overflow',
        () => byteQueue.run({ size: 1, reserved: true }, () => null),
        'source_unavailable',
        'queue_full',
      );
      releaseBytes.resolve();
      await Promise.all([byteWork, controlBytes]);
      const queued = open('queued');
      await queued.ready;
      process.kill(queued.pid, 'SIGSTOP');
      const pending = Array.from({ length: 256 }, () =>
        queued.page({ collection: 'threads' }).catch((error) => error.reason),
      );
      await failure(
        'actual worker normal queue rejects 257th request',
        () => queued.page({ collection: 'threads' }),
        'source_unavailable',
        'queue_full',
      );
      const control = queued.mutateControl({
        intentId: 'reserved-cancel',
        changes: [
          { collection: 'operations', key: 'cancel-control', value: { cancelRequested: true } },
        ],
      });
      check('actual stopped worker reserves independent control slot', queued.queue.control, 1);
      process.kill(queued.pid, 'SIGCONT');
      await Promise.all(pending);
      check(
        'reserved actual worker control receives durable acknowledgement',
        (await control).phase,
        'durable-accepted',
      );
      await failure(
        'reserved read forbids unrelated collections',
        () => queued.getControl({ collection: 'threads', key: 'escape' }),
        'invalid_request',
        'control_collection',
      );
      await failure(
        'reserved read enforces its request byte budget',
        () =>
          queued.getControl({
            collection: 'operations',
            key: 'oversize',
            ignored: 'x'.repeat(65536),
          }),
        'invalid_request',
        'control_size',
      );
      const controlObservations = [];
      const tracedStore = new Proxy(queued, {
        get(target, property) {
          if (property === 'getControl' || property === 'mutateControl')
            return (params) => {
              controlObservations.push({
                method: property,
                normal: queued.queue.normal,
                collection: params.collection ?? params.changes?.[0]?.collection,
              });
              return target[property](params);
            };
          return target[property];
        },
      });
      const controlJournal = journalFor(tracedStore);
      const cancelUnderFlood = await controlJournal.accept(input('cancel-under-flood'));
      const floodInteractions = createInteractionStore({ store: tracedStore });
      await floodInteractions.bindProcess(scope);
      const largeReply = '答🌿'.repeat(70000);
      const floodPermission = await floodInteractions.pending({
        scope,
        nativeRequestId: 'full-normal',
        payload: { text: largeReply },
      });
      check(
        'large permission request remains lossless',
        digest((await floodInteractions.get(floodPermission)).payload.text),
        digest(largeReply),
      );
      let flooding = true;
      process.kill(queued.pid, 'SIGSTOP');
      const pumps = Array.from({ length: 256 }, async () => {
        while (flooding) await queued.page({ collection: 'threads' });
      });
      const cancelledUnderFlood = controlJournal.cancel(cancelUnderFlood.operationId, scope);
      await new Promise((resolve) => setImmediate(resolve));
      check(
        'control read admitted while256 normal worker requests pending',
        queued.queue.control,
        1,
      );
      process.kill(queued.pid, 'SIGCONT');
      try {
        check(
          'cancel succeeds through real full normal queue',
          (await cancelledUnderFlood).outcome,
          'cancelled',
        );
        let replyCalls = 0;
        let receivedHash;
        await floodInteractions.reply(
          floodPermission,
          scope,
          { text: largeReply },
          ({ answer }) => {
            replyCalls++;
            receivedHash = digest(answer.text);
          },
        );
        check('permission reply bypasses full normal256 queue exactly once', replyCalls, 1);
        check(
          'large reply remains lossless through reserved durable chunks',
          receivedHash,
          digest(largeReply),
        );
      } finally {
        flooding = false;
        await Promise.all(pumps);
      }
      check(
        'both CAS read and mutation use reserved slots at normal256',
        ['getControl', 'mutateControl'].every((method) =>
          controlObservations.some((entry) => entry.method === method && entry.normal === 256),
        ),
        true,
      );
      check(
        'permission control mutation reaches worker while normal256 remain full',
        controlObservations.some(
          (entry) =>
            entry.method === 'mutateControl' &&
            entry.collection === 'interactions' &&
            entry.normal === 256,
        ),
        true,
      );
      await failure(
        'operation JSON payload over wire1MiB bound rejected without truncation',
        () => journal.accept(input('oversize', { payload: 'x'.repeat(1048576) })),
        'invalid_request',
        'payload_size',
      );
      await failure(
        'reply JSON payload over wire1MiB bound rejected without truncation',
        () => floodInteractions.reply(floodPermission, scope, 'x'.repeat(1048576), () => null),
        'invalid_request',
        'payload_size',
      );
      const controlLog = path.join(context.outDir, 'control-flood.json');
      writeJson(controlLog, controlObservations);
      artifacts.push(artifact(controlLog, 'reserved-control-under-flood'));
      const queuedFence = (await queued.inspect()).fence;
      const takeover = open('queued', { takeover: { expectedFence: queuedFence } });
      await takeover.ready;
      await failure(
        'stale worker fence cannot use reserved entity reads',
        () => queued.getControl({ collection: 'operations', key: cancelUnderFlood.operationId }),
        'conflict',
        'stale_owner',
      );
      const paused = open('paused', { requestTimeoutMs: 100 });
      await paused.ready;
      process.kill(paused.pid, 'SIGSTOP');
      await failure(
        'actual worker timeout explicitly requires reconciliation',
        () => paused.inspect(),
        'reconcile_required',
        'worker_timeout',
      );
      const dump = path.join(context.outDir, 'failure-sqlite.json');
      writeJson(dump, externallyRead('failure'));
      artifacts.push(artifact(dump, 'independent-sqlite-readback'));
    }
  } finally {
    for (const deferred of deferreds) deferred.resolve();
    for (const store of stores) exits.push(await store.terminate());
    await rm(temporary, { recursive: true, force: true });
    const liveWorkers = stores
      .filter((store) => {
        try {
          process.kill(store.pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      })
      .map((store) => store.pid);
    const removed = await stat(temporary).then(
      () => false,
      (error) => {
        if (error.code === 'ENOENT') return true;
        throw error;
      },
    );
    assert.equal(liveWorkers.length, 0);
    assert.equal(removed, true);
    const resources = path.join(context.outDir, `${context.case}-resources.json`);
    writeJson(resources, {
      temporary,
      removed,
      exits,
      workerPids: stores.map((store) => store.pid),
      liveWorkers,
    });
    artifacts.push(artifact(resources, 'resource-cleanup'));
    const transcript = path.join(context.outDir, `${context.case}-native.json`);
    writeJson(transcript, native);
    artifacts.push(artifact(transcript, 'native-callback-transcript'));
  }
  return { scenarios, artifacts };
}
