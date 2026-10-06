import { encodeSessionKey } from '../../shared/runtime/identity.js';
import { jsonValue } from '../../shared/runtime/capabilities.js';
import { StoreError } from './storage/storeProtocol.js';
import {
  fingerprint,
  createStoreScopeFence,
  parseOperationScope,
  readRecord,
  readPayload,
  preparePayload,
  writePayload,
  compareRecord,
  isRevisionConflict,
} from './operationJournal.js';
import { createAdmissionQueue } from './admissionQueue.js';

/** Runtime owns native RPC handles; window disconnects deliberately do not change pending state. */
export function createInteractionStore({ store, admission = createAdmissionQueue() }) {
  const live = new Map();
  const assertStoreScope = createStoreScopeFence(store);
  const processKey = (scope) => `process:${fingerprint(encodeSessionKey(scope.session))}`;
  const keyFor = (scope, nativeRequestId) =>
    `interaction:${fingerprint([encodeSessionKey(scope.session), scope.epoch, scope.processGeneration, nativeRequestId])}`;
  async function bindProcess(input) {
    const scope = parseOperationScope(input);
    await assertStoreScope(scope);
    const key = processKey(scope);
    const prior = await readRecord(store, 'operations', key);
    if (
      prior?.value &&
      prior.value.epoch === scope.epoch &&
      prior.value.generation >= scope.processGeneration
    )
      throw new StoreError('conflict', 'stale_generation');
    const token = { scope, active: true };
    await compareRecord(store, 'operations', key, prior, {
      epoch: scope.epoch,
      generation: scope.processGeneration,
      alive: true,
    });
    const previous = live.get(key);
    if (previous) previous.active = false;
    live.set(key, token);
  }
  async function authority(scope, reserved = true) {
    await assertStoreScope(scope);
    const token = live.get(processKey(scope));
    if (
      !token?.active ||
      token.scope.epoch !== scope.epoch ||
      token.scope.processGeneration !== scope.processGeneration
    )
      throw new StoreError('reconcile_required', 'stale_generation');
    const record = await readRecord(store, 'operations', processKey(scope), reserved);
    if (
      !record?.value.alive ||
      record.value.epoch !== scope.epoch ||
      record.value.generation !== scope.processGeneration ||
      !token.active
    )
      throw new StoreError('reconcile_required', 'stale_generation');
    return { token, record };
  }
  async function processExited(input) {
    const scope = parseOperationScope(input);
    const key = processKey(scope);
    const token = live.get(key);
    if (
      token?.scope.epoch === scope.epoch &&
      token.scope.processGeneration === scope.processGeneration
    ) {
      token.active = false;
      live.delete(key);
    }
    await assertStoreScope(scope);
    for (let attempt = 0; attempt < 4; attempt++) {
      const prior = await readRecord(store, 'operations', key);
      if (
        !prior ||
        prior.value.epoch !== scope.epoch ||
        prior.value.generation !== scope.processGeneration ||
        !prior.value.alive
      )
        return;
      try {
        await compareRecord(store, 'operations', key, prior, { ...prior.value, alive: false });
        return;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    throw new StoreError('conflict', 'concurrent_update');
  }
  async function pending({ scope: input, nativeRequestId, payload }) {
    const scope = parseOperationScope(input);
    if (
      !(
        typeof nativeRequestId === 'string' &&
        nativeRequestId.length > 0 &&
        nativeRequestId.length <= 512
      ) &&
      !Number.isSafeInteger(nativeRequestId)
    )
      throw new StoreError('invalid_request', 'native_request');
    const clean = jsonValue(payload);
    const key = keyFor(scope, nativeRequestId);
    const prepared = preparePayload(clean, `payload:${key}:${fingerprint(clean)}`);
    return admission.run({ size: prepared.ref.bytes }, async (signal) => {
      const { token, record } = await authority(scope, false);
      const value = {
        kind: 'interaction',
        scope,
        nativeRequestId,
        payloadRef: prepared.ref,
        digest: fingerprint(clean),
        phase: 'pending',
      };
      const prior = await readRecord(store, 'interactions', key, false);
      if (prior) {
        if (prior.value.digest !== value.digest)
          throw new StoreError('conflict', 'interaction_mismatch');
        if (!token.active) throw new StoreError('reconcile_required', 'stale_generation');
        return key;
      }
      await writePayload(store, 'interactions', prepared, false, signal);
      if (!token.active || signal.aborted)
        throw new StoreError('reconcile_required', 'stale_generation');
      try {
        await compareRecord(
          store,
          'interactions',
          key,
          null,
          value,
          [
            {
              collection: 'operations',
              key: processKey(scope),
              expectedRevision: record.revision,
              value: record.value,
            },
          ],
          false,
        );
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        const duplicate = await readRecord(store, 'interactions', key);
        if (!duplicate || duplicate.value.digest !== value.digest) throw error;
      }
      if (!token.active) throw new StoreError('reconcile_required', 'stale_generation');
      return key;
    });
  }
  async function get(key) {
    const record = await readRecord(store, 'interactions', key, false);
    if (record?.value?.kind !== 'interaction')
      throw new StoreError('invalid_request', 'interaction_missing');
    const scope = record.value.scope;
    await assertStoreScope(scope);
    const token = live.get(processKey(scope));
    const process = await readRecord(store, 'operations', processKey(scope), false);
    const valid =
      token?.active &&
      token.scope.processGeneration === scope.processGeneration &&
      token.scope.epoch === scope.epoch &&
      process?.value.alive &&
      process.value.generation === scope.processGeneration &&
      process.value.epoch === scope.epoch;
    return admission.run({ size: record.value.payloadRef.bytes }, async () => {
      const payload = await readPayload(store, 'interactions', record.value.payloadRef);
      return (!valid || !token?.active) && record.value.phase !== 'replied'
        ? { ...record.value, payload, phase: 'invalidated' }
        : { ...record.value, payload };
    });
  }
  async function markReconciling(key) {
    const current = await readRecord(store, 'interactions', key);
    if (['replying', 'replied'].includes(current?.value.phase)) {
      try {
        await compareRecord(store, 'interactions', key, current, {
          ...current.value,
          phase: 'reconciling',
        });
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
  }
  async function reply(key, input, answer, submit, { deadlineMs = 15000 } = {}) {
    const scope = parseOperationScope(input);
    const response = jsonValue(answer);
    const prepared = preparePayload(response, `answer:${key}:${fingerprint(response)}`);
    let claimedByThisCall = false;
    return admission
      .run({ reserved: true, deadlineMs, size: prepared.ref.bytes }, async (signal) => {
        const { token, record: process } = await authority(scope);
        const prior = await readRecord(store, 'interactions', key);
        if (!prior || fingerprint(prior.value.scope) !== fingerprint(scope))
          throw new StoreError('conflict', 'scope_fence');
        if (prior.value.phase !== 'pending')
          throw new StoreError('conflict', 'interaction_claimed');
        if (!token.active || signal.aborted)
          throw new StoreError('reconcile_required', 'stale_generation');
        await writePayload(store, 'interactions', prepared, true, signal);
        if (!token.active || signal.aborted)
          throw new StoreError('reconcile_required', 'stale_generation');
        const claimed = await compareRecord(
          store,
          'interactions',
          key,
          prior,
          { ...prior.value, phase: 'replying', answerRef: prepared.ref },
          [
            {
              collection: 'operations',
              key: processKey(scope),
              expectedRevision: process.revision,
              value: process.value,
            },
          ],
        );
        claimedByThisCall = true;
        try {
          if (!token.active || signal.aborted)
            throw new StoreError('reconcile_required', 'stale_generation');
          await submit({
            scope,
            nativeRequestId: prior.value.nativeRequestId,
            answer: response,
            signal,
          });
          if (!token.active || signal.aborted)
            throw new StoreError('reconcile_required', 'stale_generation');
          await compareRecord(store, 'interactions', key, claimed, {
            ...claimed.value,
            phase: 'replied',
          });
          if (!token.active || signal.aborted)
            throw new StoreError('reconcile_required', 'stale_generation');
          return { phase: 'native-executed', interactionId: key };
        } catch (error) {
          await markReconciling(key);
          throw error;
        }
      })
      .catch(async (error) => {
        if (claimedByThisCall && error instanceof StoreError && error.code === 'timeout')
          await markReconciling(key);
        throw error;
      });
  }
  return { bindProcess, processExited, pending, get, reply };
}
