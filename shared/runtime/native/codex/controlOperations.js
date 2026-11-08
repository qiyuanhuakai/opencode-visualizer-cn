import { encodeSessionKey } from '../../identity.js';
import { requireValue } from '../../capabilities.js';

/** Steering is a child intent of the existing turn owner, not a competing session lease. */
export function createCodexControls({
  store,
  journal,
  instanceFactory,
  fingerprint,
  request,
  assertCurrent,
  activeFor,
  scopeFor,
}) {
  return async function steer({ session, expectedTurnId, input, idempotencyKey }) {
    requireValue(
      typeof idempotencyKey === 'string' && idempotencyKey.length > 0,
      'codex.steer.idempotency',
    );
    requireValue(
      Array.isArray(input) &&
        input.every((item) => item?.type === 'text' && typeof item.text === 'string'),
      'codex.steer.input',
    );
    const owner = activeFor(session);
    requireValue(owner && owner.turnId === expectedTurnId, 'codex.steer.turn', 'conflict');
    const scope = scopeFor(session);
    const parentOperationId = owner.operationId;
    const authorize = async () => {
      assertCurrent();
      const active = activeFor(session);
      requireValue(
        active?.operationId === parentOperationId && active.turnId === expectedTurnId,
        'codex.steer.owner',
        'reconcile_required',
      );
      const operation = await journal.get(parentOperationId);
      requireValue(
        fingerprint(operation.scope) === fingerprint(scope) &&
          ['sent', 'observed'].includes(operation.phase),
        'codex.steer.operation',
        'reconcile_required',
      );
      const lease = await store.getControl({
        collection: 'operations',
        key: `lease:${fingerprint(encodeSessionKey(session))}`,
      });
      assertCurrent();
      requireValue(
        lease?.value?.operationId === parentOperationId && activeFor(session) === owner,
        'codex.steer.lease',
        'reconcile_required',
      );
    };
    await authorize();
    const controls = instanceFactory(authorize);
    const accepted = await controls.accept({
      method: 'turn/steer',
      idempotencyKey: `${encodeSessionKey(session)}:${idempotencyKey}`,
      payload: { session, parentOperationId, expectedTurnId, input },
    });
    const execution = await controls.execute(accepted.operationId, async ({ payload }) => {
      requireValue(
        payload.parentOperationId === parentOperationId &&
          payload.expectedTurnId === expectedTurnId &&
          encodeSessionKey(payload.session) === encodeSessionKey(session),
        'codex.steer.payload',
        'unauthorized',
      );
      return request('turn/steer', {
        threadId: session.nativeSessionId,
        expectedTurnId,
        input: payload.input,
      });
    });
    return { accepted, ...execution };
  };
}
