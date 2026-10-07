import { StoreError } from '../storage/storeProtocol.js';
import {
  fingerprint,
  preparePayload,
  writePayload,
  compareRecord,
  readRecord,
  readPayload,
} from '../operationJournal.js';
import { record, text } from '../../../shared/runtime/native/acp/capabilities.js';

export function createAcpInteractions({ store, mutations, rpc, active, emit, sessionFor }) {
  const pending = new Map();
  const controls = new Set();
  function track(promise) {
    controls.add(promise);
    void promise.then(
      () => controls.delete(promise),
      () => controls.delete(promise),
    );
    return promise;
  }
  async function receive(message) {
    const params = record(message.params);
    const session = sessionFor(text(params.sessionId));
    const parent = active.get(session.nativeSessionId);
    if (!parent) throw new StoreError('conflict', 'interaction_parent');
    if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id)))
      throw new StoreError('invalid_request', 'native_request');
    if (pending.size >= 256) throw new StoreError('source_unavailable', 'interaction_limit');
    const scope = mutations.scopeFor(session);
    const key = `acp-interaction:${fingerprint([scope, parent, message.id])}`;
    const prepared = preparePayload(params, `payload:${key}`);
    const processGuard = await mutations.authority();
    await writePayload(store, 'interactions', prepared, false, new AbortController().signal);
    const previous = await readRecord(store, 'interactions', key);
    if (previous) throw new StoreError('conflict', 'duplicate_native_request');
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
      [processGuard],
      false,
    );
    rpc.assertCurrent();
    pending.set(key, { session, params, parent, nativeRequestId: message.id });
    emit({ type: 'interaction.pending', session, interactionId: key, params });
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
        const item = pending.get(text(input.interactionId));
        if (!item) {
          const persisted = await readRecord(store, 'interactions', input.interactionId);
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
            interaction: input.interactionId,
            idempotencyKey: text(input.idempotencyKey),
            method: 'session/request_permission',
            payload: answer,
          },
          () => rpc.reply(item.nativeRequestId, answer),
        );
        pending.delete(input.interactionId);
        emit({
          type: 'interaction.replied',
          session: item.session,
          interactionId: input.interactionId,
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
          () => rpc.reply(item.nativeRequestId, answer),
        );
        persisted = await readRecord(store, 'interactions', key);
        await compareRecord(store, 'interactions', key, persisted, {
          ...persisted.value,
          phase: 'invalidated',
        });
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
