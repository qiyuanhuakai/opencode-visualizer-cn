import { randomUUID, createHash } from 'node:crypto';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseInstanceId,
  parseSessionRef,
  encodeSessionKey,
} from '../../../shared/runtime/identity.js';
import { StoreError } from '../storage/storeProtocol.js';
import {
  fingerprint,
  preparePayload,
  writePayload,
  readPayload,
  readRecord,
  compareRecord,
  isRevisionConflict,
} from '../operationJournal.js';
import { text } from '../../../shared/runtime/native/acp/capabilities.js';

export async function createAcpMutations({
  store,
  target,
  harnessInstanceId,
  epoch,
  processGeneration,
  assertCurrent,
}) {
  const binding = Object.freeze({
    target: parseEnvironmentId(target),
    harnessInstanceId: parseHarnessInstanceId(harnessInstanceId),
    epoch: parseInstanceId(epoch),
    processGeneration,
  });
  const inspection = await store.ready;
  if (inspection.environment !== binding.target || inspection.epoch !== binding.epoch)
    throw new StoreError('conflict', 'store_target');
  if (!Number.isSafeInteger(processGeneration) || processGeneration < 1)
    throw new StoreError('invalid_request', 'process_generation');
  const processKey = `acp-process:${fingerprint([target, harnessInstanceId])}`;
  const prior = await readRecord(store, 'operations', processKey);
  if (prior?.value?.epoch === epoch && prior.value.processGeneration >= processGeneration)
    throw new StoreError('conflict', 'stale_generation');
  assertCurrent();
  const process = await compareRecord(store, 'operations', processKey, prior, {
    ...binding,
    alive: true,
  });
  const owner = randomUUID();
  const scopeFor = (session) => {
    if (!session) return binding;
    const parsed = parseSessionRef(session);
    if (parsed.environmentId !== target || parsed.harnessInstanceId !== harnessInstanceId)
      throw new StoreError('conflict', 'scope_fence');
    return Object.freeze({ ...binding, session: parsed });
  };
  const leaseKey = (scope) =>
    scope.session
      ? `lease:${fingerprint(encodeSessionKey(scope.session))}`
      : `acp-instance-lease:${fingerprint([target, harnessInstanceId])}`;
  async function authority() {
    assertCurrent();
    const current = await readRecord(store, 'operations', processKey);
    if (!current?.value.alive || fingerprint(current.value) !== fingerprint(process.value))
      throw new StoreError('reconcile_required', 'stale_generation');
    return {
      collection: 'operations',
      key: processKey,
      expectedRevision: current.revision,
      value: current.value,
    };
  }
  function same(record, scope) {
    if (!record || fingerprint(record.value.scope) !== fingerprint(scope))
      throw new StoreError('conflict', 'scope_fence');
  }
  async function resultFor(ref, control) {
    if (!ref) return null;
    if (!control) return readPayload(store, 'operations', ref);
    const chunks = [];
    for (let index = 0; index < ref.chunks; index++) {
      const item = await store.getControl({ collection: 'operations', key: `${ref.key}:${index}` });
      if (!item || item.chunked || typeof item.value !== 'string')
        throw new StoreError('reconcile_required', 'payload_missing');
      chunks.push(Buffer.from(item.value, 'base64'));
    }
    const body = Buffer.concat(chunks);
    if (body.length !== ref.bytes || createHash('sha256').update(body).digest('hex') !== ref.digest)
      throw new StoreError('reconcile_required', 'payload_corrupt');
    return JSON.parse(body.toString('utf8'));
  }
  async function get(id) {
    return readRecord(store, 'operations', text(id));
  }
  async function reconcile(id) {
    const record = await get(id);
    if (record && ['sent', 'observed'].includes(record.value.phase))
      await compareRecord(store, 'operations', id, record, {
        ...record.value,
        phase: 'reconciling',
      });
  }
  async function run(input, enqueue) {
    const scope = scopeFor(input.session);
    const key = `acp-operation:${fingerprint([target, harnessInstanceId, input.session ? encodeSessionKey(scope.session) : 'instance', text(input.idempotencyKey)])}`;
    const method = text(input.method);
    const digest = fingerprint({
      scope,
      method,
      payload: input.payload,
      parent: input.parent ?? null,
    });
    const prepared = preparePayload(input.payload, `body:${key}:${digest}`);
    const control = !!input.parent;
    let record = await get(key);
    if (record && record.value.digest !== digest)
      throw new StoreError('conflict', 'idempotency_mismatch');
    if (record?.value.phase === 'terminal')
      return {
        operationId: key,
        phase: 'already-completed',
        result: await resultFor(record.value.resultRef, control),
      };
    if (record && ['sent', 'observed', 'reconciling'].includes(record.value.phase))
      throw new StoreError('reconcile_required', 'operation_phase');
    await authority();
    if (!record)
      record = await compareRecord(
        store,
        'operations',
        key,
        null,
        {
          kind: 'acp-operation',
          scope,
          method,
          digest,
          payloadRef: prepared.ref,
          phase: 'intent',
          parent: input.parent ?? null,
        },
        [],
        control,
      );
    await writePayload(store, 'operations', prepared, control, new AbortController().signal);
    if (record.value.phase === 'intent')
      record = await compareRecord(
        store,
        'operations',
        key,
        record,
        { ...record.value, phase: 'accepted' },
        [],
        control,
      );
    const leaseId = leaseKey(scope);
    let leaseValue;
    let claimed = false;
    for (let attempt = 0; attempt < 4 && !claimed; attempt++) {
      const lease = await readRecord(store, 'operations', leaseId);
      const guards = [await authority()];
      if (control) {
        const parent = await get(input.parent);
        same(parent, scope);
        if (
          !['sent', 'observed'].includes(parent.value.phase) ||
          lease?.value?.operationId !== input.parent ||
          lease.value.runtimeOwner !== owner
        )
          throw new StoreError('conflict', 'original_lease');
        leaseValue = lease.value;
        guards.push({
          collection: 'operations',
          key: input.parent,
          expectedRevision: parent.revision,
          value: parent.value,
        });
      } else {
        if (lease?.value) {
          const previousScope = lease.value.scope;
          const previous = await get(lease.value.operationId);
          const superseded =
            previousScope?.target === target &&
            previousScope.harnessInstanceId === harnessInstanceId &&
            previousScope.epoch === epoch &&
            Number.isSafeInteger(previousScope.processGeneration) &&
            previousScope.processGeneration < processGeneration &&
            fingerprint(previousScope.session ?? null) === fingerprint(scope.session ?? null);
          if (
            !superseded ||
            !previous ||
            fingerprint(previous.value.scope) !== fingerprint(previousScope) ||
            !['sent', 'observed', 'reconciling', 'terminal'].includes(previous.value.phase)
          )
            throw new StoreError('conflict', 'session_busy');
          guards.push({
            collection: 'operations',
            key: lease.value.operationId,
            expectedRevision: previous.revision,
            value:
              previous.value.phase === 'terminal'
                ? previous.value
                : { ...previous.value, phase: 'reconciling' },
          });
        }
        leaseValue = { operationId: key, runtimeOwner: owner, scope };
      }
      if (input.interaction) {
        const interaction = await readRecord(store, 'interactions', input.interaction);
        same(interaction, scope);
        if (interaction.value.phase !== 'pending' || interaction.value.parent !== input.parent)
          throw new StoreError('conflict', 'interaction_claimed');
        guards.push({
          collection: 'interactions',
          key: input.interaction,
          expectedRevision: interaction.revision,
          value: { ...interaction.value, phase: 'replying', operationId: key },
        });
      }
      guards.push({
        collection: 'operations',
        key: leaseId,
        expectedRevision: lease?.revision ?? 0,
        value: leaseValue,
      });
      assertCurrent();
      try {
        record = await compareRecord(
          store,
          'operations',
          key,
          record,
          { ...record.value, phase: 'sent' },
          guards,
          control,
        );
        claimed = true;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
        record = await get(key);
        if (record?.value.phase !== 'accepted')
          throw new StoreError('conflict', 'operation_claimed');
      }
    }
    if (!claimed) throw new StoreError('conflict', 'concurrent_update');
    try {
      // No awaited ownership read separates the final CAS from native enqueue.
      assertCurrent();
      const result = await enqueue({ operationId: key, payload: input.payload });
      await authority();
      const owned = await readRecord(store, 'operations', leaseId);
      if (
        owned?.value?.operationId !== leaseValue.operationId ||
        owned.value.runtimeOwner !== owner
      )
        throw new StoreError('reconcile_required', 'original_lease');
      const resultBody = preparePayload(result ?? null, `result:${key}`);
      await writePayload(store, 'operations', resultBody, control, new AbortController().signal);
      record = await get(key);
      if (record.value.phase !== 'sent')
        throw new StoreError('reconcile_required', 'operation_phase');
      record = await compareRecord(store, 'operations', key, record, {
        ...record.value,
        phase: 'observed',
        resultRef: resultBody.ref,
      });
      const terminalGuards = [
        await authority(),
        {
          collection: 'operations',
          key: leaseId,
          expectedRevision: owned.revision,
          value: control ? owned.value : null,
        },
      ];
      if (input.interaction) {
        const interaction = await readRecord(store, 'interactions', input.interaction);
        if (interaction?.value.operationId !== key)
          throw new StoreError('reconcile_required', 'interaction_claimed');
        terminalGuards.push({
          collection: 'interactions',
          key: input.interaction,
          expectedRevision: interaction.revision,
          value: { ...interaction.value, phase: 'replied' },
        });
      }
      await compareRecord(
        store,
        'operations',
        key,
        record,
        {
          ...record.value,
          phase: 'terminal',
          outcome: result?.stopReason === 'cancelled' ? 'cancelled' : 'completed',
        },
        terminalGuards,
      );
      return { operationId: key, phase: 'native-executed', result };
    } catch (error) {
      await reconcile(key);
      throw error;
    }
  }
  async function close() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await readRecord(store, 'operations', processKey);
      if (!current || fingerprint(current.value) !== fingerprint(process.value)) return;
      try {
        await compareRecord(store, 'operations', processKey, current, {
          ...current.value,
          alive: false,
        });
        return;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    throw new StoreError('conflict', 'process_close');
  }
  return {
    run,
    scopeFor,
    get,
    reconcile,
    close,
    authority,
    binding,
    processKey,
    owner,
    leaseKey,
    readBody: (record) => readPayload(store, 'operations', record.value.payloadRef),
  };
}
