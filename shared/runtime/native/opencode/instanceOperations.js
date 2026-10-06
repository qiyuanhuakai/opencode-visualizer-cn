import { parseEnvironmentId, parseHarnessInstanceId, parseInstanceId, parseSessionRef } from '../../identity.js';
import { ProtocolError, requireValue, textValue, jsonValue } from '../../capabilities.js';

/** Durable instance intents before a native session exists. Store, clock identity and hashes are injected by the target Runtime. */
export function createInstanceOperations({ store, scope: input, current, fingerprint, randomUUID }) {
  const scope = Object.freeze({ environmentId: parseEnvironmentId(input.environmentId), harnessInstanceId: parseHarnessInstanceId(input.harnessInstanceId), epoch: parseInstanceId(input.epoch), processGeneration: input.processGeneration });
  requireValue(Number.isSafeInteger(scope.processGeneration) && scope.processGeneration > 0, 'opencode.process_generation');
  const processKey = `opencode-process:${fingerprint([scope.environmentId, scope.harnessInstanceId])}`;
  const encoder = new TextEncoder();
  let active = true;
  const matching = (value) => value?.epoch === scope.epoch && value?.processGeneration === scope.processGeneration;
  async function target() {
    const state = await store.ready;
    requireValue(state.environment === scope.environmentId, 'opencode.store_target', 'unauthorized');
    requireValue(state.epoch === scope.epoch, 'opencode.store_epoch', 'reconcile_required');
  }
  function local() { requireValue(active && matching(current()), 'opencode.process_current', 'reconcile_required'); }
  async function read(key) { const item = await store.getControl({ collection: 'operations', key }); requireValue(!item?.chunked, 'opencode.operation_record', 'reconcile_required'); return item; }
  async function change(key, prior, value, process) {
    return store.mutateControl({ intentId: randomUUID(), changes: [
      { collection: 'operations', key, expectedRevision: prior?.revision ?? 0, value },
      ...(process ? [{ collection: 'operations', key: processKey, expectedRevision: process.revision, value: process.value }] : []),
    ] });
  }
  async function authority() {
    await target(); local();
    const process = await read(processKey);
    local(); requireValue(process?.value?.alive === true && matching(process.value), 'opencode.process_fence', 'reconcile_required');
    return process;
  }
  const ready = (async () => {
    await target(); local();
    const prior = await read(processKey); local();
    requireValue(!prior?.value || prior.value.epoch !== scope.epoch || prior.value.processGeneration < scope.processGeneration, 'opencode.duplicate_upstream', 'conflict');
    await change(processKey, prior, { ...scope, alive: true }); local();
  })();
  // Consumers await ready; the attached handler also makes construction safe before their first call.
  let startupError;
  ready.catch((error) => { startupError = error; });
  async function operation(id) {
    await target(); const prior = await read(textValue(id, 'opencode.operation_id'));
    requireValue(prior?.value?.kind === 'opencode-instance-operation', 'opencode.operation_missing');
    requireValue(prior.value.scope.environmentId === scope.environmentId && prior.value.scope.harnessInstanceId === scope.harnessInstanceId, 'opencode.operation_scope', 'unauthorized');
    return prior;
  }
  async function reconcile(id) {
    const prior = await operation(id);
    if (['accepted', 'sent', 'observed'].includes(prior.value.phase)) await change(id, prior, { ...prior.value, phase: 'reconciling' });
  }
  const revisionConflict = (error) => error instanceof Error && error.code === 'conflict' && error.reason === 'entity_revision';
  return {
    ready,
    async assertCurrent() { if (startupError) throw startupError; await ready; const process = await authority(); return { collection: 'operations', key: processKey, expectedRevision: process.revision, value: process.value }; },
    async accept({ idempotencyKey, method, payload: inputPayload }) {
      await ready;
      textValue(idempotencyKey, 'opencode.idempotency'); textValue(method, 'opencode.method');
      const payload = jsonValue(inputPayload);
      const serialized = JSON.stringify(payload); const bytes = encoder.encode(serialized).byteLength;
      requireValue(bytes <= 1048576, 'opencode.instance_payload');
      const id = `opencode-instance:${fingerprint([scope.environmentId, scope.harnessInstanceId, idempotencyKey])}`;
      const digest = fingerprint({ scope, method, payload });
      let process = await authority();
      let prior = await read(id); local();
      const ref = { key: `opencode-body:${id}:${digest}`, chunks: Math.ceil(serialized.length / 8192), digest: fingerprint(payload), bytes };
      if (!prior) {
        try { await change(id, null, { kind: 'opencode-instance-operation', scope, method, digest, phase: 'intent', payloadRef: ref }, process); }
        catch (error) { if (!revisionConflict(error)) throw error; }
        prior = await operation(id); local();
      }
      requireValue(prior.value.digest === digest, 'opencode.instance_idempotency', 'conflict');
      if (prior.value.phase === 'intent') {
        for (let index = 0; index < ref.chunks; index++) {
          await authority();
          await store.mutate({ intentId: `${ref.key}:${index}`, changes: [{ collection: 'operations', key: `${ref.key}:${index}`, expectedRevision: 0, value: serialized.slice(index * 8192, (index + 1) * 8192) }] });
          local();
        }
        process = await authority(); prior = await operation(id); local();
        if (prior.value.phase === 'intent') {
          try { await change(id, prior, { ...prior.value, phase: 'accepted' }, process); }
          catch (error) { if (!revisionConflict(error)) throw error; const duplicate = await operation(id); requireValue(duplicate.value.phase === 'accepted' && duplicate.value.digest === digest, 'opencode.instance_accept_race', 'conflict'); }
        }
      }
      try { await authority(); }
      catch (error) { await reconcile(id); throw error; }
      return { phase: 'durable-accepted', operationId: id };
    },
    async execute(id, send) {
      await ready; let process = await authority();
      let prior = await operation(id); local();
      requireValue(matching(prior.value.scope), 'opencode.instance_generation', 'reconcile_required');
      requireValue(prior.value.phase === 'accepted', 'opencode.instance_execution', ['sent', 'reconciling'].includes(prior.value.phase) ? 'reconcile_required' : 'conflict');
      let serialized = '';
      for (let index = 0; index < prior.value.payloadRef.chunks; index++) {
        const body = await read(`${prior.value.payloadRef.key}:${index}`); local();
        requireValue(typeof body?.value === 'string', 'opencode.instance_body', 'reconcile_required'); serialized += body.value;
      }
      let payload;
      try { payload = JSON.parse(serialized); }
      catch (error) { if (error instanceof SyntaxError) throw new ProtocolError('reconcile_required', 'opencode.instance_body'); throw error; }
      requireValue(encoder.encode(serialized).byteLength === prior.value.payloadRef.bytes && fingerprint(payload) === prior.value.payloadRef.digest, 'opencode.instance_body_hash', 'reconcile_required');
      process = await authority(); local();
      await change(id, prior, { ...prior.value, phase: 'sent' }, process);
      try {
        await authority();
        const result = await send({ payload, method: prior.value.method, scope });
        process = await authority(); prior = await operation(id); local();
        await change(id, prior, { ...prior.value, phase: 'observed' }, process);
        await authority();
        return { phase: 'native-executed', operationId: id, result };
      } catch (error) { await reconcile(id); throw error; }
    },
    async bindResult(id, inputSession) {
      const session = parseSessionRef(inputSession);
      requireValue(session.environmentId === scope.environmentId && session.harnessInstanceId === scope.harnessInstanceId, 'opencode.created_session_scope', 'unauthorized');
      const process = await authority(); const prior = await operation(id); local();
      requireValue(prior.value.phase === 'observed', 'opencode.create_not_observed', 'reconcile_required');
      await change(id, prior, { ...prior.value, session }, process); await authority();
    },
    async get(id) {
      let prior = await operation(id);
      if (!matching(prior.value.scope) && ['accepted','sent','observed'].includes(prior.value.phase)) { await reconcile(id); prior = await operation(id); }
      return prior.value;
    },
    reconcile,
    async close() {
      active = false;
      try { await ready; } catch (error) { if (error instanceof Error) return; throw error; }
      await target();
      const prior = await read(processKey);
      if (prior?.value?.alive && matching(prior.value)) await change(processKey, prior, { ...prior.value, alive: false });
    },
  };
}
