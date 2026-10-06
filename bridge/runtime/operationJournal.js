import { createHash, randomUUID } from 'node:crypto';
import {
  parseSessionRef,
  encodeSessionKey,
  parseEnvironmentId,
  parseInstanceId,
} from '../../shared/runtime/identity.js';
import { jsonValue } from '../../shared/runtime/capabilities.js';
import { StoreError } from './storage/storeProtocol.js';
import { createAdmissionQueue } from './admissionQueue.js';

function canonical(value) {
  const sorted = (item) =>
    Array.isArray(item)
      ? item.map(sorted)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sorted(item[key])]),
          )
        : item;
  return JSON.stringify(sorted(jsonValue(value)));
}
export function fingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function preparePayload(value, key) {
  const bytes = Buffer.from(canonical(value));
  if (bytes.length > 1048576) throw new StoreError('invalid_request', 'payload_size');
  return {
    bytes,
    ref: {
      key,
      bytes: bytes.length,
      chunks: Math.ceil(bytes.length / 32768),
      digest: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
export async function writePayload(store, collection, prepared, reserved, signal) {
  for (let index = 0; index < prepared.ref.chunks; index++) {
    if (signal.aborted) throw new StoreError('timeout', 'deadline');
    const key = `${prepared.ref.key}:${index}`;
    const mutation = {
      intentId: `body:${key}:${prepared.ref.digest}`,
      changes: [
        {
          collection,
          key,
          expectedRevision: 0,
          value: prepared.bytes.subarray(index * 32768, (index + 1) * 32768).toString('base64'),
        },
      ],
    };
    await (reserved ? store.mutateControl(mutation) : store.mutate(mutation));
  }
}
export function parseOperationScope(input) {
  try {
    const session = parseSessionRef(input?.session);
    const target = parseEnvironmentId(input.target);
    const epoch = parseInstanceId(input.epoch);
    if (
      session.environmentId !== target ||
      !Number.isSafeInteger(input.processGeneration) ||
      input.processGeneration < 1
    )
      throw new StoreError('invalid_request', 'scope');
    return Object.freeze({ target, epoch, session, processGeneration: input.processGeneration });
  } catch (error) {
    if (error instanceof TypeError) throw new StoreError('invalid_request', 'scope');
    throw error;
  }
}
export function createStoreScopeFence(store) {
  let binding;
  return async (scope) => {
    binding ??= store.ready.then((inspection) =>
      Object.freeze({ environmentId: parseEnvironmentId(inspection.environment) }),
    );
    const { environmentId } = await binding;
    if (scope.target !== environmentId || scope.session.environmentId !== environmentId)
      throw new StoreError('conflict', 'store_target');
  };
}
function text(value) {
  if (typeof value !== 'string' || !value.length || value.length > 512)
    throw new StoreError('invalid_request', 'text');
  return value;
}
export async function readRecord(store, collection, key, reserved = true) {
  const item = await (reserved
    ? store.getControl({ collection, key })
    : store.get({ collection, key }));
  if (!item) return null;
  if (item.chunked) throw new StoreError('invalid_request', 'record_size');
  return { revision: item.revision, value: item.value };
}
export async function readPayload(store, collection, ref) {
  const chunks = [];
  for (let index = 0; index < ref.chunks; index++) {
    const item = await store.get({ collection, key: `${ref.key}:${index}` });
    if (!item || item.chunked || typeof item.value !== 'string')
      throw new StoreError('reconcile_required', 'payload_missing');
    chunks.push(Buffer.from(item.value, 'base64'));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.digest)
    throw new StoreError('reconcile_required', 'payload_corrupt');
  return JSON.parse(bytes.toString('utf8'));
}
export async function compareRecord(
  store,
  collection,
  key,
  prior,
  value,
  extra = [],
  reserved = true,
) {
  const mutation = {
    intentId: randomUUID(),
    changes: [{ collection, key, expectedRevision: prior?.revision ?? 0, value }, ...extra],
  };
  const ack = await (reserved ? store.mutateControl(mutation) : store.mutate(mutation));
  return { revision: ack.revision - extra.length, value };
}
export function isRevisionConflict(error) {
  return error instanceof StoreError && error.reason === 'entity_revision';
}
export function createOperationJournal({
  store,
  admission = createAdmissionQueue(),
  isProcessCurrent,
}) {
  if (typeof isProcessCurrent !== 'function')
    throw new StoreError('invalid_request', 'process_authority');
  const assertStoreScope = createStoreScopeFence(store);
  const leaseKey = (scope) => `lease:${fingerprint(encodeSessionKey(scope.session))}`;
  async function getRecord(id, reserved = true) {
    const record = await readRecord(store, 'operations', text(id), reserved);
    if (record?.value?.kind !== 'operation')
      throw new StoreError('invalid_request', 'operation_missing');
    await assertStoreScope(record.value.scope);
    return record;
  }
  function fence(value, scope) {
    if (fingerprint(value.scope) !== fingerprint(parseOperationScope(scope)))
      throw new StoreError('conflict', 'scope_fence');
  }
  function assertCurrent(scope) {
    if (isProcessCurrent(scope) !== true)
      throw new StoreError('reconcile_required', 'stale_generation');
  }
  async function transition(id, scope, change, reserved = true, requireCurrent = false) {
    await assertStoreScope(scope);
    for (let attempt = 0; attempt < 4; attempt++) {
      const prior = await getRecord(id, reserved);
      fence(prior.value, scope);
      if (requireCurrent) assertCurrent(scope);
      const value = change(prior.value);
      if (value === prior.value) return value;
      const extra = [];
      if (value.phase === 'terminal') {
        const lease = await readRecord(store, 'operations', leaseKey(scope));
        if (lease?.value?.operationId === id)
          extra.push({
            collection: 'operations',
            key: leaseKey(scope),
            expectedRevision: lease.revision,
            value: null,
          });
      }
      try {
        if (requireCurrent) assertCurrent(scope);
        const committed = await compareRecord(
          store,
          'operations',
          id,
          prior,
          value,
          extra,
          reserved,
        );
        if (requireCurrent) assertCurrent(scope);
        return committed.value;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    throw new StoreError('conflict', 'concurrent_update');
  }
  async function accept(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new StoreError('invalid_request', 'params');
    const scope = parseOperationScope(input.scope);
    const method = text(input.method);
    const idempotencyKey = text(input.idempotencyKey);
    const payload = jsonValue(input.payload);
    const digest = fingerprint({ scope, method, payload });
    const operationId = `op:${fingerprint([encodeSessionKey(scope.session), idempotencyKey])}`;
    const prepared = preparePayload(payload, `payload:${operationId}`);
    return admission.run({ size: Buffer.byteLength(JSON.stringify(input)) }, async (signal) => {
      await assertStoreScope(scope);
      let prior = await readRecord(store, 'operations', operationId, false);
      if (prior && prior.value.digest !== digest)
        throw new StoreError('conflict', 'idempotency_mismatch');
      if (isProcessCurrent(scope) !== true)
        throw new StoreError('reconcile_required', 'stale_generation');
      if (!prior) {
        try {
          prior = await compareRecord(
            store,
            'operations',
            operationId,
            null,
            {
              kind: 'operation',
              operationId,
              scope,
              method,
              payloadRef: prepared.ref,
              digest,
              phase: 'intent',
              cancelRequested: false,
            },
            [],
            false,
          );
        } catch (error) {
          if (!isRevisionConflict(error)) throw error;
          prior = await getRecord(operationId, false);
        }
      }
      if (prior.value.digest !== digest) throw new StoreError('conflict', 'idempotency_mismatch');
      if (prior.value.phase === 'intent')
        await writePayload(store, 'operations', prepared, false, signal);
      if (signal.aborted) throw new StoreError('timeout', 'deadline');
      if (isProcessCurrent(scope) !== true)
        throw new StoreError('reconcile_required', 'stale_generation');
      try {
        await transition(
          operationId,
          scope,
          (value) => (value.phase === 'intent' ? { ...value, phase: 'accepted' } : value),
          false,
          true,
        );
      } catch (error) {
        if (error instanceof StoreError && error.reason === 'stale_generation')
          await transition(operationId, scope, (value) =>
            value.phase === 'accepted' ? { ...value, phase: 'reconciling' } : value,
          );
        throw error;
      }
      return { phase: 'durable-accepted', operationId };
    });
  }
  async function execute(id, scope, send, { deadlineMs = 15000 } = {}) {
    scope = parseOperationScope(scope);
    let claimedByThisCall = false;
    return admission
      .run({ deadlineMs }, async (signal, reservePayload) => {
        await assertStoreScope(scope);
        const prior = await getRecord(id, false);
        fence(prior.value, scope);
        if (isProcessCurrent(prior.value.scope) !== true)
          throw new StoreError('reconcile_required', 'stale_generation');
        if (prior.value.phase !== 'accepted')
          throw new StoreError(
            prior.value.phase === 'sent' || prior.value.phase === 'reconciling'
              ? 'reconcile_required'
              : 'conflict',
            'operation_phase',
          );
        const key = leaseKey(scope);
        const lease = await readRecord(store, 'operations', key, false);
        if (lease?.value) throw new StoreError('conflict', 'session_busy');
        reservePayload(prior.value.payloadRef.bytes);
        const payload = await readPayload(store, 'operations', prior.value.payloadRef);
        if (signal.aborted) throw new StoreError('timeout', 'deadline');
        assertCurrent(scope);
        await compareRecord(
          store,
          'operations',
          id,
          prior,
          { ...prior.value, phase: 'sent' },
          [
            {
              collection: 'operations',
              key,
              expectedRevision: lease?.revision ?? 0,
              value: { operationId: id, runtimeOwner: true },
            },
          ],
          false,
        );
        claimedByThisCall = true;
        // A committed sent marker is the point of no retry, including an exit before the native call.
        try {
          if (signal.aborted) throw new StoreError('timeout', 'deadline');
          if (isProcessCurrent(prior.value.scope) !== true)
            throw new StoreError('reconcile_required', 'stale_generation');
          const result = await send({
            operationId: id,
            scope: prior.value.scope,
            method: prior.value.method,
            payload,
            signal,
          });
          if (signal.aborted) throw new StoreError('timeout', 'deadline');
          if (isProcessCurrent(prior.value.scope) !== true)
            throw new StoreError('reconcile_required', 'stale_generation');
          await transition(
            id,
            scope,
            (value) => (value.phase === 'sent' ? { ...value, phase: 'observed' } : value),
            true,
            true,
          );
          return { phase: 'native-executed', operationId: id, result };
        } catch (error) {
          await transition(id, scope, (value) =>
            value.phase === 'terminal' ? value : { ...value, phase: 'reconciling' },
          );
          throw error;
        }
      })
      .catch(async (error) => {
        if (claimedByThisCall && error instanceof StoreError && error.code === 'timeout')
          await transition(id, scope, (value) =>
            ['sent', 'observed'].includes(value.phase) ? { ...value, phase: 'reconciling' } : value,
          );
        throw error;
      });
  }
  async function cancel(id, scope) {
    scope = parseOperationScope(scope);
    return admission.run({ reserved: true }, () =>
      transition(id, scope, (value) => {
        if (value.phase === 'terminal' || value.cancelRequested) return value;
        return ['intent', 'accepted'].includes(value.phase)
          ? { ...value, cancelRequested: true, phase: 'terminal', outcome: 'cancelled' }
          : { ...value, cancelRequested: true };
      }),
    );
  }
  async function terminal(id, scope, outcome) {
    scope = parseOperationScope(scope);
    if (isProcessCurrent(scope) !== true)
      throw new StoreError('reconcile_required', 'stale_generation');
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(outcome))
      throw new StoreError('invalid_request', 'outcome');
    return admission.run({ reserved: true }, () =>
      transition(
        id,
        scope,
        (value) => {
          if (value.phase === 'terminal') return value;
          if (!['sent', 'observed', 'reconciling'].includes(value.phase))
            throw new StoreError('conflict', 'operation_phase');
          return { ...value, phase: 'terminal', outcome };
        },
        true,
        true,
      ),
    );
  }
  return {
    accept,
    execute,
    cancel,
    terminal,
    get: async (id) => (await getRecord(id, false)).value,
    reconcile: (id, scope) =>
      admission.run({ reserved: true }, () =>
        transition(id, parseOperationScope(scope), (value) =>
          ['sent', 'observed'].includes(value.phase) ? { ...value, phase: 'reconciling' } : value,
        ),
      ),
  };
}
