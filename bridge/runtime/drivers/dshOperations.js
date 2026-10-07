import { createOperationJournal, fingerprint, readRecord, compareRecord, preparePayload, writePayload } from '../operationJournal.js';
import { createInteractionStore } from '../interactionStore.js';
import { createAdmissionQueue } from '../admissionQueue.js';
import { parseSessionRef, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { jsonValue } from '../../../shared/runtime/capabilities.js';
import { fail, text, record } from '../../../shared/runtime/native/dsh/protocol.js';

export function createDshOperations({ store, transport, environmentId, harnessInstanceId, epoch }) {
  const identity = Object.freeze({ environmentId: parseEnvironmentId(environmentId), harnessInstanceId: parseHarnessInstanceId(harnessInstanceId) });
  epoch = parseInstanceId(epoch);
  const admission = createAdmissionQueue();
  function capture(session) {
    const lease = transport.capture();
    const scope = { target: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, epoch, processGeneration: lease.generation };
    if (session !== undefined) {
      const ref = parseSessionRef(session);
      if (ref.environmentId !== identity.environmentId || ref.harnessInstanceId !== identity.harnessInstanceId) fail('conflict', 'session_scope');
      return Object.freeze({ target: scope.target, epoch, processGeneration: lease.generation, session: ref });
    }
    return Object.freeze(scope);
  }
  function current(scope) {
    try { return scope.target === identity.environmentId && scope.epoch === epoch && scope.processGeneration === transport.capture().generation; }
    catch { return false; }
  }
  async function authority(scope) {
    const bound = await store.ready;
    if (bound.environment !== scope.target || bound.epoch !== scope.epoch || !current(scope)) fail('reconcile_required', 'store_scope');
  }
  const journal = createOperationJournal({ store, admission, isProcessCurrent: current });
  const interactions = createInteractionStore({ store, admission });
  const bound = new Map();
  async function bind(scope) {
    const key = encodeSessionKey(scope.session), previous = bound.get(key);
    if (previous?.scope.epoch === scope.epoch && previous.scope.processGeneration === scope.processGeneration) return previous.promise;
    const promise = interactions.bindProcess(scope);
    bound.set(key, { scope, promise });
    try { await promise; } catch (error) { if (bound.get(key)?.promise === promise) bound.delete(key); throw error; }
  }
  async function sessionMutation({ session, idempotencyKey, method, args, ongoing = false, capturedScope }) {
    const scope = capturedScope ?? capture(session), payload = jsonValue(args);
    text(idempotencyKey);
    const prepared = await transport.prepare(method, payload);
    if (prepared.lease.generation !== scope.processGeneration) fail('reconcile_required', 'operation_generation');
    const accepted = await journal.accept({ scope, idempotencyKey, method, payload });
    const executed = await journal.execute(accepted.operationId, scope, ({ signal }) => prepared.send(signal).then((result) => {
      if (method === 'session/prompt' && record(result).accepted !== true) fail('reconcile_required', 'prompt_not_accepted');
      if (method === 'session/selectModel') {
        const selected = record(record(result).selected), requested = record(payload.request);
        if (selected.provider !== requested.provider || selected.model !== requested.model) fail('reconcile_required', 'model_selection');
      }
      return result;
    }));
    if (!ongoing) await journal.terminal(accepted.operationId, scope, 'completed');
    return { ...executed, accepted };
  }
  /** Instance intents have their actual harness identity; controls CAS the original session lease. */
  async function durable({ session, parentOperationId, idempotencyKey, method, args, guard = () => {}, capturedScope }) {
    const scope = capturedScope ?? capture(session), payload = jsonValue(args);
    text(idempotencyKey);
    const operationId = `dsh:${fingerprint([scope.target, identity.harnessInstanceId, session ? encodeSessionKey(scope.session) : 'instance', idempotencyKey])}`;
    const digest = fingerprint({ scope, method, payload, parentOperationId: parentOperationId ?? null });
    const reserved = !!session || method === '$events/result';
    return admission.run({ reserved, size: Buffer.byteLength(JSON.stringify(payload)) }, async (signal) => {
      await authority(scope);
      const prepared = await transport.prepare(method, payload, { signal });
      if (prepared.lease.generation !== scope.processGeneration) fail('reconcile_required', 'operation_generation');
      const existing = await readRecord(store, 'operations', operationId, reserved);
      if (existing) {
        if (existing.value.digest !== digest) fail('conflict', 'idempotency_mismatch');
        if (existing.value.phase === 'terminal') return { phase: 'native-executed', operationId, accepted: { phase: 'durable-accepted', operationId }, result: existing.value.result };
        if (!['intent', 'accepted'].includes(existing.value.phase)) fail('reconcile_required', 'operation_not_replayed');
      }
      const body = preparePayload(payload, `payload:${operationId}`);
      let row = existing ?? await compareRecord(store, 'operations', operationId, null, { kind: 'dsh-operation', operationId, scope, method,
        parentOperationId: parentOperationId ?? null, digest, payloadRef: body.ref, phase: 'intent' }, [], reserved);
      if (row.value.phase === 'intent') {
        await writePayload(store, 'operations', body, reserved, signal);
        row = await compareRecord(store, 'operations', operationId, row, { ...row.value, phase: 'accepted' }, [], reserved);
      }
      const extra = [];
      if (session) {
        text(parentOperationId);
        const key = `lease:${fingerprint(encodeSessionKey(scope.session))}`;
        const lease = await readRecord(store, 'operations', key);
        const parent = (await readRecord(store, 'operations', parentOperationId))?.value;
        if (!lease || lease.value?.operationId !== parentOperationId || !parent || fingerprint(parent.scope) !== fingerprint(scope)
          || !['sent', 'observed', 'reconciling'].includes(parent.phase)) fail('conflict', 'original_lease');
        extra.push({ collection: 'operations', key, expectedRevision: lease.revision, value: lease.value });
      }
      if (signal.aborted || !current(scope)) fail('reconcile_required', 'operation_generation');
      guard();
      row = await compareRecord(store, 'operations', operationId, row, { ...row.value, phase: 'sent' }, extra, reserved);
      try {
        if (signal.aborted || !current(scope)) fail('reconcile_required', 'operation_generation');
        guard();
        const result = await prepared.send(signal);
        if (method === 'session/cancel' && record(result).accepted !== true) fail('reconcile_required', 'cancel_not_accepted');
        if (method === 'session/create') text(record(result).sessionId);
        if (Buffer.byteLength(JSON.stringify(result)) > 16384) fail('reconcile_required', 'operation_result_size');
        if (!current(scope) || signal.aborted) fail('reconcile_required', 'operation_generation');
        row = await compareRecord(store, 'operations', operationId, row, { ...row.value, phase: 'observed', result }, [], true);
        await compareRecord(store, 'operations', operationId, row, { ...row.value, phase: 'terminal', outcome: 'completed' }, [], true);
        return { phase: 'native-executed', operationId, accepted: { phase: 'durable-accepted', operationId }, result };
      } catch (error) {
        const latest = await readRecord(store, 'operations', operationId);
        if (latest && latest.value.phase !== 'terminal') await compareRecord(store, 'operations', operationId, latest, { ...latest.value, phase: 'reconciling' });
        throw error;
      }
    });
  }
  async function finish(session, outcome) {
    const scope = capture(session);
    const lease = await readRecord(store, 'operations', `lease:${fingerprint(encodeSessionKey(scope.session))}`);
    if (!lease?.value?.operationId) return;
    const operation = await journal.get(lease.value.operationId);
    if (operation.method !== 'session/prompt' || fingerprint(operation.scope) !== fingerprint(scope)) return;
    if (['sent', 'observed', 'reconciling'].includes(operation.phase)) await journal.terminal(operation.operationId, scope, outcome);
  }
  return { capture, current, authority, bind, journal, interactions, admission, sessionMutation, durable, finish };
}
