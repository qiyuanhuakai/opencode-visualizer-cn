import { randomUUID } from 'node:crypto';
import { StoreError } from '../storage/storeProtocol.js';
import {
  fingerprint,
  preparePayload,
  writePayload,
  compareRecord,
  readRecord,
  readPayload,
  isRevisionConflict,
} from '../operationJournal.js';
import { record, text } from '../../../shared/runtime/native/acp/capabilities.js';

export function createAcpInteractions({ store, mutations, rpc, active, emit, sessionFor }) {
  const pending = new Map();
  const controls = new Set();
  const receipts = new Map();
  // Occupancy keys whose native reply has been written, mapped to the interaction that
  // wrote it. The RPC layer frees a native ID as it writes the reply, so a receipt
  // answered on the wire no longer occupies the ID even though its durable row is only
  // released after the database finalization. Binding the mark to its receipt keeps one
  // receipt's cleanup from clearing a mark a later receipt on the same reused ID owns.
  const answered = new Map();
  const occupancyKey = (scope, parent, nativeRequestId) =>
    `acp-interaction-native:${fingerprint([scope, parent, nativeRequestId])}`;
  function track(promise) {
    controls.add(promise);
    void promise.then(
      () => controls.delete(promise),
      () => controls.delete(promise),
    );
    return promise;
  }
  // The RPC layer frees a native ID once answered, so identity is per receipt and the ID only guards the outstanding request.
  async function receive(message) {
    const params = record(message.params);
    const session = sessionFor(text(params.sessionId));
    const parent = active.get(session.nativeSessionId);
    if (!parent) throw new StoreError('conflict', 'interaction_parent');
    if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id)))
      throw new StoreError('invalid_request', 'native_request');
    if (pending.size >= 256) throw new StoreError('source_unavailable', 'interaction_limit');
    const scope = mutations.scopeFor(session);
    const key = `acp-interaction:${fingerprint([scope, parent, message.id, randomUUID()])}`;
    const prepared = preparePayload(params, `payload:${key}`);
    let processGuard = await mutations.authority();
    await writePayload(store, 'interactions', prepared, false, new AbortController().signal);
    const occupancy = occupancyKey(scope, parent, message.id);
    // The previous receipt's release() may be sweeping this very occupancy row while this
    // claim is in flight, so the claim can lose that race. An occupancy that the sweep has
    // already emptied is the state in which re-use is allowed, so the claim is retried
    // rather than surfaced to the peer as an internal revision conflict.
    for (let attempt = 0; ; attempt++) {
      const claimed = await readRecord(store, 'interactions', occupancy);
      // Only a request that is still outstanding rejects a same-ID receipt. Once the reply
      // is on the wire the RPC layer has freed the ID, so the peer may re-use it inside the
      // same prompt while the durable row is still being finalized.
      if (claimed?.value && answered.get(occupancy) !== record(claimed.value).interactionId)
        throw new StoreError('conflict', 'duplicate_native_request');
      answered.delete(occupancy);
      try {
        await compareRecord(
          store,
          'interactions',
          key,
          null,
          {
            kind: 'acp-interaction',
            scope,
            parent,
            nativeRequestId: message.id,
            method: message.method,
            phase: 'pending',
            payloadRef: prepared.ref,
          },
          [
            processGuard,
            {
              collection: 'interactions',
              key: occupancy,
              expectedRevision: claimed?.revision ?? 0,
              value: {
                kind: 'acp-interaction-native',
                interactionId: key,
                parent,
                nativeRequestId: message.id,
              },
            },
          ],
          false,
        );
        break;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        if ((await readRecord(store, 'interactions', occupancy))?.value)
          throw new StoreError('conflict', 'duplicate_native_request');
        if (attempt === 3) throw new StoreError('conflict', 'concurrent_update');
        processGuard = await mutations.authority();
      }
    }
    rpc.assertCurrent();
    pending.set(key, { session, params, parent, nativeRequestId: message.id });
    receipts.set(key, { occupancy, nativeRequestId: message.id, parent });
    emit({ type: 'interaction.pending', session, interactionId: key, params });
  }
  async function release(key) {
    const receipt = receipts.get(key);
    if (!receipt) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await readRecord(store, 'interactions', receipt.occupancy);
      // The occupancy may already belong to a later receipt on the same reused ID: that
      // receipt's answered mark is not ours to clear, so only delete our own.
      const own = answered.get(receipt.occupancy) === key;
      if (!current || current.value === null || record(current.value).interactionId !== key) {
        receipts.delete(key);
        if (own) answered.delete(receipt.occupancy);
        return;
      }
      try {
        await compareRecord(store, 'interactions', receipt.occupancy, current, null);
        receipts.delete(key);
        if (own) answered.delete(receipt.occupancy);
        return;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    throw new StoreError('conflict', 'concurrent_update');
  }
  async function list() {
    const result = [];
    for (const [key, item] of pending) {
      const persisted = await readRecord(store, 'interactions', key);
      if (persisted?.value.phase === 'pending')
        result.push({ interactionId: key, ...item, phase: rpc.active ? 'pending' : 'invalidated' });
    }
    return result;
  }
  function respond(input) {
    return track(
      (async () => {
        const interactionId = text(input.interactionId);
        const item = pending.get(interactionId);
        if (!item) {
          const persisted = await readRecord(store, 'interactions', interactionId);
          if (persisted?.value.phase === 'replied')
            throw new StoreError('conflict', 'interaction_claimed');
          throw new StoreError('reconcile_required', 'interaction_expired');
        }
        if (fingerprint(item.session) !== fingerprint(input.session))
          throw new StoreError('conflict', 'scope_fence');
        const answer = record(input.answer);
        const outcome = record(answer.outcome);
        if (
          outcome.outcome !== 'cancelled' &&
          (outcome.outcome !== 'selected' ||
            !item.params.options?.some((option) => option.optionId === outcome.optionId))
        )
          throw new StoreError('invalid_request', 'permission_option');
        const result = await mutations.run(
          {
            session: item.session,
            parent: item.parent,
            interaction: interactionId,
            idempotencyKey: text(input.idempotencyKey),
            method: 'session/request_permission',
            payload: answer,
          },
          () => {
            rpc.reply(item.nativeRequestId, answer);
            // The reply itself frees the native ID, so the occupancy ends here rather
            // than after the database finalization this run still has to perform.
            answered.set(
              occupancyKey(
                mutations.scopeFor(item.session),
                item.parent,
                item.nativeRequestId,
              ),
              interactionId,
            );
          },
        );
        await release(interactionId);
        pending.delete(interactionId);
        emit({
          type: 'interaction.replied',
          session: item.session,
          interactionId,
        });
        return result;
      })(),
    );
  }
  async function settleParent(parent) {
    for (const [key, item] of pending) {
      if (item.parent !== parent) continue;
      let persisted = await readRecord(store, 'interactions', key);
      if (persisted?.value.phase === 'pending') {
        const answer = { outcome: { outcome: 'cancelled' } };
        await mutations.run(
          {
            session: item.session,
            parent,
            interaction: key,
            idempotencyKey: `settle:${key}`,
            method: 'session/request_permission',
            payload: answer,
          },
          () => {
            rpc.reply(item.nativeRequestId, answer);
            answered.set(
              occupancyKey(mutations.scopeFor(item.session), item.parent, item.nativeRequestId),
              key,
            );
          },
        );
        persisted = await readRecord(store, 'interactions', key);
        await compareRecord(store, 'interactions', key, persisted, {
          ...persisted.value,
          phase: 'invalidated',
        });
        await release(key);
      }
      pending.delete(key);
      emit({ type: 'interaction.invalidated', session: item.session, interactionId: key });
    }
  }
  return {
    receive,
    respond,
    list,
    track,
    settleParent,
    async settled() {
      await Promise.allSettled(controls);
    },
    async get(key) {
      const persisted = await readRecord(store, 'interactions', text(key));
      if (
        !persisted ||
        persisted.value.scope.target !== mutations.binding.target ||
        persisted.value.scope.harnessInstanceId !== mutations.binding.harnessInstanceId
      )
        throw new StoreError('conflict', 'scope_fence');
      const params = await readPayload(store, 'interactions', persisted.value.payloadRef);
      return {
        ...persisted.value,
        params,
        phase:
          rpc.active &&
          persisted.value.scope.epoch === mutations.binding.epoch &&
          persisted.value.scope.processGeneration === mutations.binding.processGeneration &&
          persisted.value.phase === 'pending'
            ? 'pending'
            : persisted.value.phase === 'replied'
              ? 'replied'
              : 'invalidated',
      };
    },
  };
}
