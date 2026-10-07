import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAcpEnvironment } from './task-15-fixture.mjs';
import { fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { StoreError } from '../../../bridge/runtime/storage/storeProtocol.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';

export async function runAcpFaults(context) {
  const scenarios = [],
    artifacts = [];
  const check = (name, observed, expected) => {
    assert.deepEqual(observed, expected, name);
    scenarios.push({
      name: `failure ${name}`,
      assertions: [{ name, observed, expected, passed: true }],
    });
  };
  for (const fault of ['accepted-lease', 'sent-lease', 'cancel-reply-ack']) {
    const env = await openAcpEnvironment({
      temporaryRoot: context.temporaryRoot,
      agents: [{ id: 'fault-agent' }],
    });
    let snapshot;
    try {
      const driver = env.drivers[0];
      const created = await driver.driver.core.createSession(
        driver.context({ idempotencyKey: 'fault-session' }),
      );
      const session = created.session;
      const parent = driver.driver.core.send(
        driver.context(
          { idempotencyKey: 'fault-parent', prompt: [{ type: 'text', text: 'permission' }] },
          session,
        ),
      );
      const parentOutcome = parent.then(
        () => null,
        (error) => error.reason,
      );
      const deadline = Date.now() + 5000;
      let pending;
      while (!pending && Date.now() < deadline) {
        [pending] = await driver.driver.native.listPendingPermissions(driver.context());
        if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(pending, 'real permission request must exist before fault');
      const leaseKey = `lease:${fingerprint(encodeSessionKey(session))}`;
      const mutate = env.store.mutateControl;
      let injected = false;
      env.store.mutateControl = async (input) => {
        const result = await mutate(input);
        const change = input.changes.find(
          (item) =>
            item.value?.kind === 'acp-operation' &&
            item.value.method ===
              (fault === 'cancel-reply-ack' ? 'session/request_permission' : 'session/cancel') &&
            item.value.phase ===
              (fault === 'accepted-lease'
                ? 'accepted'
                : fault === 'sent-lease'
                  ? 'sent'
                  : 'observed'),
        );
        if (!injected && change) {
          injected = true;
          if (fault === 'cancel-reply-ack')
            throw new StoreError('reconcile_required', 'qa_lost_observed_ack');
          const lease = await env.store.getControl({ collection: 'operations', key: leaseKey });
          await mutate({
            intentId: `fault:${fault}`,
            changes: [
              {
                collection: 'operations',
                key: leaseKey,
                expectedRevision: lease.revision,
                value: { ...lease.value, runtimeOwner: 'foreign-owner' },
              },
            ],
          });
        }
        return result;
      };
      const cancelInput = { idempotencyKey: 'fault-cancel', operationId: pending.parent };
      let cancelError;
      try {
        await driver.driver.core.cancel(driver.context(cancelInput, session));
      } catch (error) {
        cancelError = error.reason;
      }
      if (fault === 'accepted-lease') {
        check('preSENT foreign lease rejects cancellation', cancelError, 'original_lease');
        process.kill(driver.pid, 'SIGTERM');
      }
      const parentError = await parentOutcome;
      check(`${fault} reached actual injected boundary`, injected, true);
      const trace = await driver.trace();
      check(
        `${fault} native cancellation count`,
        trace.filter((item) => item.method === 'session/cancel').length,
        fault === 'accepted-lease' ? 0 : 1,
      );
      const database = new DatabaseSync(
        path.join(env.temporary, 'state', 'runtime', 'runtime.db'),
        { readOnly: true },
      );
      try {
        snapshot = {
          operations: database
            .prepare('SELECT key, revision, value FROM operations')
            .all()
            .map((row) => ({ ...row, value: JSON.parse(row.value) }))
            .filter((row) => row.value?.kind === 'acp-operation'),
          interactions: database
            .prepare('SELECT key, revision, value FROM interactions')
            .all()
            .map((row) => ({ ...row, value: JSON.parse(row.value) }))
            .filter((row) => row.value?.kind === 'acp-interaction'),
          events: database
            .prepare('SELECT seq,payload FROM runtime_events ORDER BY seq')
            .all()
            .map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload) })),
        };
      } finally {
        database.close();
      }
      const cancelRecord = snapshot.operations.find((row) => row.value.method === 'session/cancel');
      check(
        `${fault} SQL cancellation phase`,
        cancelRecord.value.phase,
        fault === 'accepted-lease'
          ? 'accepted'
          : fault === 'sent-lease'
            ? 'reconciling'
            : 'terminal',
      );
      check(`${fault} parent reports uncertain completion`, typeof parentError, 'string');
      if (fault === 'cancel-reply-ack') {
        const child = snapshot.operations.find(
          (row) => row.value.method === 'session/request_permission',
        );
        check(
          'lost acknowledgement of native cancelled response preserves reconciling child',
          [parentError, child.value.phase, child.value.parent, child.value.scope.session],
          ['qa_lost_observed_ack', 'reconciling', pending.parent, session],
        );
        const replies = trace.filter((item) => !item.method && item.id === pending.nativeRequestId);
        check(
          'native cancellation outcome is distinct from denial or selected permission',
          replies.map((item) => item.result),
          [{ outcome: { outcome: 'cancelled' } }],
        );
        process.kill(driver.pid, 'SIGTERM');
        const stopDeadline = Date.now() + 5000;
        while (env.manager.getStatus()[0].state !== 'error' && Date.now() < stopDeadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const replacement = await env.restart(0);
        await driver.close();
        await replacement.driver.native['acp.loadSession'](
          replacement.context({ idempotencyKey: 'fault-load' }, session),
        );
        let duplicate;
        try {
          await replacement.driver.core.cancel(replacement.context(cancelInput, session));
        } catch (error) {
          duplicate = error.reason;
        }
        check(
          'restart duplicate cancellation cannot replay old generation',
          duplicate,
          'idempotency_mismatch',
        );
        const newWire = env.wire
          .filter(
            (item) =>
              item.pid === replacement.pid && item.direction === 'runtime-to-installed-process',
          )
          .flatMap((item) =>
            item.text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line)),
          );
        check(
          'restart sends no old cancellation or reply to new native process',
          newWire.filter((item) => item.method === 'session/cancel' || !item.method).length,
          0,
        );
      }
    } finally {
      const file = path.join(context.outDir, `failure-${fault}.json`);
      const cleanup = await env.close();
      writeJson(file, {
        snapshot,
        wire: env.wire,
        cleanup,
        scenarios: scenarios.filter((item) => item.name.includes(fault)),
      });
      artifacts.push(artifact(file, 'actual-worker-native-fault'));
    }
  }
  for (const fault of ['invalid-json', 'oversized-frame', 'concurrent-native-id']) {
    const env = await openAcpEnvironment({
      temporaryRoot: context.temporaryRoot,
      agents: [
        {
          id: 'malformed-frame',
          env:
            fault === 'concurrent-native-id'
              ? { ACP_CONCURRENT: '1', ACP_REUSE_REQUEST_ID: '1' }
              : {},
        },
      ],
    });
    try {
      const driver = env.drivers[0];
      const created = await driver.driver.core.createSession(
        driver.context({ idempotencyKey: 'frame-new' }),
      );
      if (fault === 'concurrent-native-id') {
        const second = { ...created.session, nativeSessionId: 'second-collision-session' };
        await driver.driver.native['acp.loadSession'](
          driver.context({ idempotencyKey: 'collision-load' }, second),
        );
        const outcomes = [];
        const start = (session, id) =>
          driver.driver.core
            .send(
              driver.context(
                { idempotencyKey: id, prompt: [{ type: 'text', text: 'permission' }] },
                session,
              ),
            )
            .then(
              () => outcomes.push('unexpected-success'),
              (error) => outcomes.push(error.reason),
            );
        const firstPrompt = start(created.session, 'collision-first');
        const deadline = Date.now() + 5000;
        while (
          !(await driver.driver.native.listPendingPermissions(driver.context())).length &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        check(
          'concurrent-native-id first pending request exists',
          (await driver.driver.native.listPendingPermissions(driver.context())).length,
          1,
        );
        const secondPrompt = start(second, 'collision-second');
        while (outcomes.length < 2 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        check('concurrent-native-id invalidates both parents', outcomes, [
          'stale_generation',
          'stale_generation',
        ]);
        await Promise.all([firstPrompt, secondPrompt]);
        check(
          'concurrent-native-id emits no ambiguous native response',
          (await driver.trace()).filter((item) => !item.method && item.id === 7).length,
          0,
        );
        continue;
      }
      let rejected;
      try {
        await driver.driver.core.send(
          driver.context(
            { idempotencyKey: 'frame-send', prompt: [{ type: 'text', text: fault }] },
            created.session,
          ),
        );
      } catch (error) {
        rejected = error.reason;
      }
      check(
        `${fault} closes native source with explicit reconciliation`,
        rejected,
        'stale_generation',
      );
    } finally {
      const file = path.join(context.outDir, `failure-${fault}.json`);
      writeJson(file, { wire: env.wire, cleanup: await env.close() });
      artifacts.push(artifact(file, 'malformed-native-frame'));
    }
  }
  return { scenarios, artifacts };
}
