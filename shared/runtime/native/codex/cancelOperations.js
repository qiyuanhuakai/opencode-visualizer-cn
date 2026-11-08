import { encodeSessionKey } from '../../identity.js';
import { requireValue } from '../../capabilities.js';

export function createCodexCancellation({ store, fingerprint, newId, request, assertCurrent }) {
  return async function cancel({ scope, parentOperationId, expectedTurnId, assertActive }) {
    const session = scope.session;
    const idempotencyKey = fingerprint([
      encodeSessionKey(session),
      parentOperationId,
      expectedTurnId,
    ]);
    const operationId = `codex-cancel:${idempotencyKey}`;
    const leaseKey = `lease:${fingerprint(encodeSessionKey(session))}`;
    const intent = {
      scope,
      parentOperationId,
      expectedTurnId,
      idempotencyKey,
      method: 'turn/interrupt',
      payload: { threadId: session.nativeSessionId, turnId: expectedTurnId },
    };
    const digest = fingerprint(intent);
    function fenceChild(row) {
      requireValue(
        !row?.chunked &&
          row?.value?.kind === 'codex-cancel-operation' &&
          row.value.operationId === operationId &&
          row.value.digest === digest &&
          fingerprint(
            Object.fromEntries(Object.keys(intent).map((key) => [key, row.value[key]])),
          ) === digest,
        'codex.cancel.intent',
        'reconcile_required',
      );
    }
    function current() {
      assertCurrent();
      assertActive();
    }
    async function ownership(allowTerminal = false) {
      assertCurrent();
      const trusted = await store.ready;
      assertCurrent();
      requireValue(
        trusted.environment === scope.target && trusted.epoch === scope.epoch,
        'codex.cancel.store_scope',
        'reconcile_required',
      );
      const parent = await store.getControl({ collection: 'operations', key: parentOperationId });
      assertCurrent();
      requireValue(
        !parent?.chunked &&
          parent?.value?.kind === 'operation' &&
          parent.value.operationId === parentOperationId &&
          fingerprint(parent.value.scope) === fingerprint(scope),
        'codex.cancel.operation',
        'reconcile_required',
      );
      const lease = await store.getControl({ collection: 'operations', key: leaseKey });
      assertCurrent();
      const terminal = allowTerminal && parent.value.phase === 'terminal';
      if (!terminal) current();
      requireValue(
        !lease?.chunked &&
          ((terminal && !lease?.value) ||
            (lease?.value?.operationId === parentOperationId &&
              lease.value.runtimeOwner === true)) &&
          (terminal || ['sent', 'observed'].includes(parent.value.phase)),
        'codex.cancel.lease',
        'reconcile_required',
      );
      return { parent, lease };
    }
    async function change(row, value, extra = []) {
      current();
      const ack = await store.mutateControl({
        intentId: newId(),
        changes: [
          {
            collection: 'operations',
            key: operationId,
            expectedRevision: row?.revision ?? 0,
            value,
          },
          ...extra,
        ],
      });
      return { revision: ack.revision - extra.length, value };
    }
    async function reconcile() {
      try {
        const row = await store.getControl({ collection: 'operations', key: operationId });
        fenceChild(row);
        if (['sent', 'observed'].includes(row.value.phase))
          await store.mutateControl({
            intentId: newId(),
            changes: [
              {
                collection: 'operations',
                key: operationId,
                expectedRevision: row.revision,
                value: { ...row.value, phase: 'reconciling' },
              },
            ],
          });
      } catch {
        // A lost store fence leaves SENT durable; neither path permits another native attempt.
      }
    }
    const initial = await ownership();
    requireValue(
      !initial.parent.value.cancelRequested,
      'codex.cancel.already_requested',
      'reconcile_required',
    );
    let child = await store.getControl({ collection: 'operations', key: operationId });
    current();
    if (!child) {
      try {
        child = await change(null, {
          kind: 'codex-cancel-operation',
          operationId,
          ...intent,
          digest,
          phase: 'intent',
        });
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
        child = await store.getControl({ collection: 'operations', key: operationId });
        current();
        if (!child) throw error;
      }
    }
    fenceChild(child);
    if (child.value.phase === 'intent') {
      try {
        child = await change(child, { ...child.value, phase: 'accepted' });
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
        child = await store.getControl({ collection: 'operations', key: operationId });
        current();
        fenceChild(child);
      }
    }
    requireValue(child.value.phase === 'accepted', 'codex.cancel.phase', 'reconcile_required');
    const { parent, lease } = await ownership();
    requireValue(
      !parent.value.cancelRequested,
      'codex.cancel.already_requested',
      'reconcile_required',
    );
    child = await change(child, { ...child.value, phase: 'sent' }, [
      {
        collection: 'operations',
        key: parentOperationId,
        expectedRevision: parent.revision,
        value: { ...parent.value, cancelRequested: true },
      },
      {
        collection: 'operations',
        key: leaseKey,
        expectedRevision: lease.revision,
        value: lease.value,
      },
    ]);
    try {
      // SENT is the dispatch commitment: no awaited authority read may separate it from enqueue.
      current();
      await request(intent.method, intent.payload);
      const after = await ownership(true);
      assertCurrent();
      const ack = await store.mutateControl({
        intentId: newId(),
        changes: [
          {
            collection: 'operations',
            key: operationId,
            expectedRevision: child.revision,
            value: { ...child.value, phase: 'observed' },
          },
          {
            collection: 'operations',
            key: parentOperationId,
            expectedRevision: after.parent.revision,
            value: after.parent.value,
          },
          {
            collection: 'operations',
            key: leaseKey,
            expectedRevision: after.lease?.revision ?? 0,
            value: after.lease?.value ?? null,
          },
        ],
      });
      assertCurrent();
      await store.mutateControl({
        intentId: newId(),
        changes: [
          {
            collection: 'operations',
            key: operationId,
            expectedRevision: ack.revision - 2,
            value: { ...child.value, phase: 'terminal', outcome: 'completed' },
          },
        ],
      });
      assertCurrent();
      return {
        phase: 'native-executed',
        operationId: parentOperationId,
        cancelOperationId: operationId,
        terminal: false,
      };
    } catch (error) {
      await reconcile();
      throw error;
    }
  };
}
