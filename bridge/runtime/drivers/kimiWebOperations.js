import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { ProtocolError, jsonValue } from '../../../shared/runtime/capabilities.js';
import { nativeText, record } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import { createOperationJournal, fingerprint, readRecord, compareRecord } from '../operationJournal.js';
import { createInteractionStore } from '../interactionStore.js';
import { createAdmissionQueue } from '../admissionQueue.js';

function clean(value) { return JSON.parse(JSON.stringify(jsonValue(value))); }
function fail(code, reason) { throw new ProtocolError(code, reason); }
export function createKimiWebOperations({ store, transport, isCurrent, promptAbort = () => false, admission = createAdmissionQueue() }) {
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
    fence(scope);
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
    if (binding.value.turnId !== payload.turnId) await compareRecord(store, 'operations', key, binding, { ...binding.value, turnId: payload.turnId });
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
    let pathname = `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}:abort`;
    if (promptAbort()) {
      await parent(scope, operationId);
      const binding = await readRecord(store, 'operations', `kimi-native:${operationId}`);
      if (!binding || fingerprint(binding.value.scope) !== fingerprint(scope)) fail('conflict', 'cancel_prompt_scope');
      const promptId = nativeText(binding.value.promptId, 'native_prompt_id', 512);
      pathname = `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}/prompts/${encodeURIComponent(promptId)}:abort`;
    }
    const prepared = await transport.prepare('POST', pathname);
    return control(scope, operationId, 'cancel', {}, idempotencyKey, prepared);
  }
  async function pending(scope, kind, nativeRequestId, payload, modern = false) {
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
    const value = { scope, kind, nativeRequestId, parentOperationId: lease.value.operationId, ...(modern ? { modern: true } : {}) };
    if (prior && fingerprint(prior.value) !== fingerprint(value)) fail('conflict', 'interaction_parent_changed');
    if (!prior) await compareRecord(store, 'operations', metadataKey, null, value);
    return key;
  }
  async function modernInteraction(scope, frame) {
    scope = clean(scope);
    fence(scope);
    if (frame.agent_id !== 'main' || !['question', 'approval'].includes(frame.kind) || !['pending', 'ended'].includes(frame.status)) return null;
    const kind = frame.kind;
    const nativeRequestId = nativeText(frame.interaction_id, 'native_request_id', 512);
    const toolCallId = nativeText(frame.tool_call_id, 'native_tool_call_id', 512);
    const page = record(await transport.request('GET', `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}/transcript?agent_id=main&page_size=100`));
    fence(scope);
    const item = page.interactions?.find(item => item.interactionId === nativeRequestId && item.interactionKind === kind && item.toolCallId === toolCallId);
    if (!item) return null;
    if ((kind === 'question' ? ['answered', 'dismissed', 'cancelled'] : ['approved', 'rejected', 'cancelled']).includes(item.state)) {
      await interactions.invalidatePending(scope, nativeRequestId);
      return null;
    }
    if (item.state !== 'pending' || frame.status !== 'pending') return null;
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) fail('reconcile_required', 'interaction_parent_unknown');
    const binding = await readRecord(store, 'operations', `kimi-native:${lease.value.operationId}`);
    if (!binding || fingerprint(binding.value.scope) !== fingerprint(scope)) fail('reconcile_required', 'interaction_parent_unknown');
    const turns = (page.items ?? []).filter(turn => turn.kind === 'turn' && turn.triggerPromptId === binding.value.promptId);
    await syncTranscript(scope, turns);
    const request = record(item.request);
    const toolName = kind === 'question' ? 'AskUserQuestion' : nativeText(request.tool_name ?? request.toolName, 'native_tool_name', 512);
    const turn = turns.find(turn => turn.state === 'running' && turn.steps?.some(step => step.frames?.some(frame => frame.kind === 'tool' && frame.toolCallId === toolCallId && frame.name === toolName)));
    if (!turn || (request.session_id ?? request.sessionId) !== scope.session.nativeSessionId || (request.agent_id ?? request.agentId ?? 'main') !== 'main') fail('reconcile_required', 'interaction_turn_unknown');
    const payload = { ...request, ...(kind === 'approval' ? { tool_name: toolName, ...(request.display ? { tool_input_display: request.display } : {}) } : {}), turnId: turn.turnId, turn_id: turn.turnId };
    const interactionId = await pending(scope, kind, nativeRequestId, payload, true);
    return { interactionId, payload };
  }
  async function reply(scope, interactionId, answer, idempotencyKey) {
    scope = clean(scope); answer = clean(answer);
    const metadata = await readRecord(store, 'operations', `kimi-interaction:${nativeText(interactionId, 'interaction_id', 512)}`);
    if (!metadata || fingerprint(metadata.value.scope) !== fingerprint(scope)) fail('conflict', 'interaction_scope');
    const { kind, nativeRequestId, parentOperationId } = metadata.value;
    if (kind !== 'approval' && kind !== 'question') fail('invalid_request', 'interaction_kind');
    const prepared = metadata.value.modern === true
      ? await transport.prepare('POST', `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}/interactions/${encodeURIComponent(nativeRequestId)}`, answer.dismiss === true ? { kind, dismissed: true } : { ...answer, kind })
      : await transport.prepare('POST', `/api/v1/sessions/${encodeURIComponent(scope.session.nativeSessionId)}/${kind === 'approval' ? 'approvals' : 'questions'}/${encodeURIComponent(nativeRequestId)}`, answer);
    return control(scope, parentOperationId, 'respondInteraction', { interactionId, answer }, idempotencyKey, prepared,
      (enqueue) => interactions.reply(interactionId, scope, answer, ({ signal }) => enqueue(signal)));
  }
  async function terminal(scope, payload) {
    if ((payload.agentId ?? payload.agent_id ?? 'main') !== 'main') return null;
    if (!['completed', 'failed', 'cancelled'].includes(payload.reason)) fail('invalid_request', 'native_terminal_reason');
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) return null;
    const operation = await journal.get(lease.value.operationId);
    if (fingerprint(operation.scope) !== fingerprint(scope)) fail('reconcile_required', 'terminal_scope');
    const binding = await readRecord(store, 'operations', `kimi-native:${lease.value.operationId}`);
    if (!binding || binding.value.turnId === undefined || binding.value.turnId !== payload.turnId) return null;
    await journal.terminal(lease.value.operationId, scope, payload.reason);
    return { operationId: lease.value.operationId, turnId: payload.turnId };
  }
  async function syncTranscript(scope, turns) {
    fence(scope);
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) return null;
    const binding = await readRecord(store, 'operations', `kimi-native:${lease.value.operationId}`);
    if (!binding || fingerprint(binding.value.scope) !== fingerprint(scope)) return null;
    const owned = turns.filter(turn => turn?.kind === 'turn' && turn.triggerPromptId === binding.value.promptId);
    if (!owned.length) return null;
    const identities = new Set(owned.map(turn => nativeText(turn.turnId, 'native_turn_id', 512)));
    if (identities.size !== 1 || binding.value.turnId !== undefined && !identities.has(binding.value.turnId)) fail('reconcile_required', 'native_turn_identity');
    const turn = owned.at(-1);
    await started(scope, { promptId: binding.value.promptId, turnId: turn.turnId, agentId: 'main' });
    if (!['completed', 'failed', 'cancelled'].includes(turn.state)) return null;
    const ended = await terminal(scope, { turnId: turn.turnId, reason: turn.state, agentId: 'main' });
    return ended ? { ...ended, reason: turn.state } : null;
  }
  // The live main-task operation of a session, or null when none has to be reconciled: only a task that reached the durable SENT marker (or whose acknowledgement cannot be accounted for) still owns the session. A failed read throws: the caller must not read an unreadable state as an idle session.
  async function liveTask(scope) {
    scope = clean(scope);
    const lease = await readRecord(store, 'operations', leaseKey(scope));
    if (!lease?.value?.operationId) return null;
    const operation = await journal.get(lease.value.operationId);
    return ['sent', 'observed', 'reconciling'].includes(operation.phase) ? lease.value.operationId : null;
  }
  async function close() {
    let failed;
    for (const [key, entry] of bound) {
      try {
        await entry.promise;
        await interactions.processExited(entry.scope);
        if (bound.get(key) === entry) bound.delete(key);
      } catch (error) { failed ??= { error }; }
    }
    if (failed) throw failed.error;
  }
  return { instance, send, started, cancel, pending, modernInteraction, reply, terminal, syncTranscript, liveTask, journal, interactions, admission,
    async invalidate(scope) { await interactions.processExited(scope); },
    close,
  };
}
