import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { ProtocolError, jsonValue } from '../../../shared/runtime/capabilities.js';
import { nativeText, record } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import { createOperationJournal, fingerprint, readRecord, compareRecord } from '../operationJournal.js';
import { createInteractionStore } from '../interactionStore.js';
import { createAdmissionQueue } from '../admissionQueue.js';

function clean(value) { return JSON.parse(JSON.stringify(jsonValue(value))); }
function fail(code, reason) { throw new ProtocolError(code, reason); }
export function createKimiWebOperations({ store, transport, isCurrent, admission = createAdmissionQueue() }) {
  const journal = createOperationJournal({ store, admission, isProcessCurrent: isCurrent });
  const interactions = createInteractionStore({ store, admission });
  const bound = new Map();
  const leaseKey = (scope) => `lease:${fingerprint(encodeSessionKey(scope.session))}`;
  function fence(scope) { if (!isCurrent(scope)) fail('reconcile_required', 'stale_generation'); }
  async function instance(scope, method, payload, idempotencyKey, pathname) {
    scope = clean(scope); payload = clean(payload);
    nativeText(idempotencyKey, 'idempotency_key', 512);
    const digest = fingerprint({ scope, method, payload });
    const key = `kimi-instance:${fingerprint([scope.target, scope.harnessInstanceId, idempotencyKey])}`;
    const prepared = await transport.prepare('POST', pathname, payload);
    return admission.run({ size: Buffer.byteLength(JSON.stringify(payload)) }, async (signal) => {
      const ready = await store.ready;
      if (ready.environment !== scope.target) fail('conflict', 'store_target');
      fence(scope);
      let prior = await readRecord(store, 'operations', key, false);
      if (prior && prior.value.digest !== digest) fail('conflict', 'idempotency_mismatch');
      if (!prior) prior = await compareRecord(store, 'operations', key, null, { kind: 'kimi-instance', operationId: key, scope, method, digest, payload, phase: 'intent' }, [], false);
      if (prior.value.phase === 'intent') prior = await compareRecord(store, 'operations', key, prior, { ...prior.value, phase: 'accepted' }, [], false);
      if (prior.value.phase !== 'accepted') fail('reconcile_required', 'instance_operation_phase');
      fence(scope);
      if (signal.aborted) fail('timeout', 'deadline');
      const sent = await compareRecord(store, 'operations', key, prior, { ...prior.value, phase: 'sent' }, [], false);
      try {
        fence(scope);
        if (signal.aborted) fail('timeout', 'deadline');
        const result = await prepared.send(signal);
        fence(scope);
        const nativeSessionId = nativeText(record(result).id, 'created_session_id', 512);
        await compareRecord(store, 'operations', key, sent, { ...sent.value, phase: 'terminal', outcome: 'completed', nativeSessionId });
        return { phase: 'native-executed', operationId: key, result };
      } catch (error) {
        const current = await readRecord(store, 'operations', key);
        if (current?.value.phase === 'sent') await compareRecord(store, 'operations', key, current, { ...current.value, phase: 'reconciling' });
        throw error;
      }
    });
  }
  async function bind(scope) {
    const key = fingerprint(scope);
    if (bound.has(key)) return bound.get(key).promise;
    const promise = interactions.bindProcess(scope);
    bound.set(key, { scope, promise });
    try { await promise; } catch (error) { bound.delete(key); throw error; }
  }
  async function send(scope, payload, idempotencyKey) {
    scope = clean(scope); payload = clean(payload);
    nativeText(idempotencyKey, 'idempotency_key', 512);
    const promptId = `vis-${fingerprint([scope, idempotencyKey])}`;
    payload = { ...payload, prompt_id: promptId };
    fence(scope);
    const prepared = await transport.prepare('POST', `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}/prompts`, payload);
    await bind(scope);
    const accepted = await journal.accept({ scope, method: 'send', payload, idempotencyKey });
    const bindingKey = `kimi-native:${accepted.operationId}`;
    const existing = await readRecord(store, 'operations', bindingKey);
    if (!existing) await compareRecord(store, 'operations', bindingKey, null, { scope, operationId: accepted.operationId, promptId });
    const executed = await journal.execute(accepted.operationId, scope, ({ signal }) => {
      fence(scope); return prepared.send(signal);
    });
    const result = record(executed.result);
    if (nativeText(result.prompt_id ?? result.id, 'native_prompt_id', 512) !== promptId) {
      await journal.reconcile(accepted.operationId, scope);
      fail('reconcile_required', 'native_prompt_identity');
    }
    return { ...executed, promptId };
  }
  async function started(scope, payload) {
    if ((payload.agentId ?? payload.agent_id ?? 'main') !== 'main') return;
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) return;
    const key = `kimi-native:${lease.value.operationId}`;
    const binding = await readRecord(store, 'operations', key);
    if (!binding || fingerprint(binding.value.scope) !== fingerprint(scope) || binding.value.promptId !== payload.promptId) return;
    if (typeof payload.turnId !== 'string' && !Number.isSafeInteger(payload.turnId)) fail('invalid_request', 'native_turn_id');
    fence(scope);
    await compareRecord(store, 'operations', key, binding, { ...binding.value, turnId: payload.turnId });
  }
  async function parent(scope, operationId) {
    nativeText(operationId, 'parent_operation', 512);
    const prior = await readRecord(store, 'operations', operationId);
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!prior || fingerprint(prior.value.scope) !== fingerprint(scope)) fail('conflict', 'parent_scope');
    if (!['sent', 'observed', 'reconciling'].includes(prior.value.phase) || prior.value.method !== 'send' || lease?.value?.operationId !== operationId)
      fail('conflict', 'parent_lease');
    fence(scope);
    return { prior, lease };
  }
  async function control(scope, operationId, method, payload, idempotencyKey, prepared, submit) {
    scope = clean(scope); payload = clean(payload);
    nativeText(idempotencyKey, 'idempotency_key', 512);
    const key = `kimi-control:${fingerprint([scope, operationId, method, idempotencyKey])}`;
    const digest = fingerprint({ scope, operationId, method, payload });
    return admission.run({ reserved: true, size: Buffer.byteLength(JSON.stringify(payload)) }, async (signal) => {
      await parent(scope, operationId);
      let prior = await readRecord(store, 'operations', key);
      if (prior && prior.value.digest !== digest) fail('conflict', 'idempotency_mismatch');
      if (!prior) prior = await compareRecord(store, 'operations', key, null, { kind: 'kimi-control', operationId: key, parentOperationId: operationId, scope, method, payload, digest, phase: 'intent' });
      if (prior.value.phase === 'intent') prior = await compareRecord(store, 'operations', key, prior, { ...prior.value, phase: 'accepted' });
      if (prior.value.phase !== 'accepted') fail('reconcile_required', 'control_operation_phase');
      let sent;
      const enqueue = async (nativeSignal = signal) => {
        const owner = await parent(scope, operationId);
        fence(scope);
        if (signal.aborted || nativeSignal.aborted) fail('timeout', 'deadline');
        sent = await compareRecord(store, 'operations', key, prior, { ...prior.value, phase: 'sent' }, [
          { collection: 'operations', key: operationId, expectedRevision: owner.prior.revision, value: owner.prior.value },
          { collection: 'operations', key: leaseKey(scope), expectedRevision: owner.lease.revision, value: owner.lease.value },
        ]);
        // The same parent/lease CAS is the last asynchronous step before native enqueue.
        fence(scope);
        if (signal.aborted || nativeSignal.aborted) fail('timeout', 'deadline');
        return prepared.send(nativeSignal);
      };
      try {
        const result = submit ? await submit(enqueue) : await enqueue();
        fence(scope);
        await compareRecord(store, 'operations', key, sent, { ...sent.value, phase: 'terminal', outcome: 'completed' });
        return { phase: 'native-executed', operationId: key, parentOperationId: operationId, result: result ?? null };
      } catch (error) {
        const current = await readRecord(store, 'operations', key);
        if (current?.value.phase === 'sent') await compareRecord(store, 'operations', key, current, { ...current.value, phase: 'reconciling' });
        throw error;
      }
    });
  }
  async function cancel(scope, operationId, idempotencyKey) {
    scope = clean(scope);
    const prepared = await transport.prepare('POST', `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}:abort`);
    return control(scope, operationId, 'cancel', {}, idempotencyKey, prepared);
  }
  async function pending(scope, kind, nativeRequestId, payload) {
    scope = clean(scope); payload = clean(payload);
    await bind(scope);
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) fail('reconcile_required', 'interaction_parent_unknown');
    await parent(scope, lease.value.operationId);
    const binding = await readRecord(store, 'operations', `kimi-native:${lease.value.operationId}`);
    if (!binding || binding.value.turnId === undefined || binding.value.turnId !== (payload.turn_id ?? payload.turnId))
      fail('reconcile_required', 'interaction_turn_unknown');
    const key = await interactions.pending({ scope, nativeRequestId, payload: { kind, nativeRequestId, details: payload } });
    const metadataKey = `kimi-interaction:${key}`;
    const prior = await readRecord(store, 'operations', metadataKey);
    const value = { scope, kind, nativeRequestId, parentOperationId: lease.value.operationId };
    if (prior && fingerprint(prior.value) !== fingerprint(value)) fail('conflict', 'interaction_parent_changed');
    if (!prior) await compareRecord(store, 'operations', metadataKey, null, value);
    return key;
  }
  async function reply(scope, interactionId, answer, idempotencyKey) {
    scope = clean(scope); answer = clean(answer);
    const metadata = await readRecord(store, 'operations', `kimi-interaction:${nativeText(interactionId, 'interaction_id', 512)}`);
    if (!metadata || fingerprint(metadata.value.scope) !== fingerprint(scope)) fail('conflict', 'interaction_scope');
    const { kind, nativeRequestId, parentOperationId } = metadata.value;
    if (kind !== 'approval' && kind !== 'question') fail('invalid_request', 'interaction_kind');
    const prepared = await transport.prepare('POST', `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}/${kind === 'approval' ? 'approvals' : 'questions'}/${encodeURIComponent(nativeRequestId)}`, answer);
    return control(scope, parentOperationId, 'respondInteraction', { interactionId, answer }, idempotencyKey, prepared,
      (enqueue) => interactions.reply(interactionId, scope, answer, ({ signal }) => enqueue(signal)));
  }
  async function terminal(scope, payload) {
    if ((payload.agentId ?? payload.agent_id ?? 'main') !== 'main') return;
    if (!['completed', 'failed', 'cancelled'].includes(payload.reason)) fail('invalid_request', 'native_terminal_reason');
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) return;
    const operation = await journal.get(lease.value.operationId);
    if (fingerprint(operation.scope) !== fingerprint(scope)) fail('reconcile_required', 'terminal_scope');
    const binding = await readRecord(store, 'operations', `kimi-native:${lease.value.operationId}`);
    if (!binding || binding.value.turnId === undefined || binding.value.turnId !== payload.turnId) return;
    await journal.terminal(lease.value.operationId, scope, payload.reason);
  }
  async function close() {
    for (const { scope, promise } of bound.values()) {
      await promise;
      await interactions.processExited(scope);
    }
    bound.clear();
  }
  return { instance, send, started, cancel, pending, reply, terminal, journal, interactions, admission,
    async invalidate(scope) { await interactions.processExited(scope); },
    close,
  };
}
