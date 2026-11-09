import { randomUUID } from 'node:crypto';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { ProtocolError } from '../../../shared/runtime/capabilities.js';
import { fingerprint, parseOperationScope, readRecord, readPayload } from '../operationJournal.js';

const fail = reason => { throw new ProtocolError('reconcile_required', reason); };
const same = (left, right) => fingerprint(left) === fingerprint(right);

/** Reconcile a borrowed native task after the Runtime store has acquired a new epoch.
 * Never sends a native mutation. The old operation and its payload remain the audit trail.
 */
export function createKimiWebRecovery({ store, isCurrent }) {
  function fence(scope) { if (!isCurrent(scope)) fail('stale_generation'); }
  async function adopt(scope, page) {
    scope = parseOperationScope(scope);
    fence(scope);
    const ready = await store.ready;
    if (ready.environment !== scope.target || ready.epoch !== scope.epoch) fail('recovery_store_epoch');
    const leaseKey = `lease:${fingerprint(encodeSessionKey(scope.session))}`;
    const lease = await readRecord(store, 'operations', leaseKey);
    if (!lease?.value?.operationId || lease.value.runtimeOwner !== true) return null;
    const id = lease.value.operationId;
    const operation = await readRecord(store, 'operations', id);
    const bindingKey = `kimi-native:${id}`;
    const binding = await readRecord(store, 'operations', bindingKey);
    if (!operation?.value || !binding?.value) return null;
    if (same(operation.value.scope, scope)) return binding.value.recoveredFrom ?? null;
    const previous = parseOperationScope(operation.value.scope);
    // Generation changes within one Runtime are not evidence that its native process survived.
    if (previous.epoch === scope.epoch || previous.target !== scope.target || !same(previous.session, scope.session)) return null;
    if (operation.value.kind !== 'operation' || operation.value.method !== 'send' || !['sent', 'observed', 'reconciling'].includes(operation.value.phase)) return null;
    if (!same(binding.value.scope, previous) || binding.value.operationId !== id) fail('recovery_operation_identity');
    const processKey = `process:${fingerprint(encodeSessionKey(scope.session))}`;
    const process = await readRecord(store, 'operations', processKey);
    if (!process?.value || typeof process.value.epoch !== 'string' || !Number.isSafeInteger(process.value.generation) || process.value.generation < 1) fail('recovery_process_changed');
    // A denied send in an older Runtime may have left a newer process claim without
    // changing the task. Its store owner is fenced by the current store epoch. A
    // contradictory generation in THIS Runtime is never evidence of ownership.
    if (process.value.epoch === scope.epoch && (process.value.generation !== scope.processGeneration || !process.value.alive)) fail('recovery_process_changed');
    const processAuthority = { epoch: process.value.epoch, processGeneration: process.value.generation };
    const payload = await readPayload(store, 'operations', operation.value.payloadRef);
    if (payload.prompt_id !== binding.value.promptId) fail('recovery_prompt_identity');
    const turns = page.items.filter(turn => turn.kind === 'turn' && turn.triggerPromptId === binding.value.promptId);
    if (!turns.length) return null;
    const identities = new Set(turns.map(turn => turn.turnId));
    if (identities.size !== 1 || typeof turns[0].turnId !== 'string' || binding.value.turnId !== undefined && !identities.has(binding.value.turnId)) fail('native_turn_identity');
    if (!['running', 'completed', 'failed', 'cancelled'].includes(turns.at(-1).state)) fail('recovery_turn_state');
    const tools = new Set(turns.flatMap(turn => (turn.steps ?? []).flatMap(step => (step.frames ?? []).filter(frame => frame.kind === 'tool').map(frame => frame.toolCallId))));
    for (const item of page.interactions ?? []) {
      if (!tools.has(item.toolCallId)) continue;
      const key = `interaction:${fingerprint([encodeSessionKey(scope.session), previous.epoch, previous.processGeneration, item.interactionId])}`;
      const prior = await readRecord(store, 'interactions', key, false);
      // A reply that crossed SENT before shutdown is uncertain, even if this snapshot is pending.
      if (item.state === 'pending' && prior && !['pending', 'invalidated'].includes(prior.value.phase)) fail('recovery_interaction_uncertain');
    }
    // Finish any previous partial interaction migration BEFORE changing task ownership.
    // A crash here leaves operation/process in their consistent old epoch; the next
    // Runtime can repeat invalidation without retaining an unbounded epoch ancestry.
    for (const item of page.interactions ?? []) {
      if (!tools.has(item.toolCallId)) continue;
      if (binding.value.recoveredFrom && !same(binding.value.recoveredFrom, previous))
        await retire(scope, binding.value.recoveredFrom, item.interactionId, id, item.state, previous, processAuthority);
      await retire(scope, previous, item.interactionId, id, item.state, previous, processAuthority);
    }
    const latestOperation = await readRecord(store, 'operations', id);
    const latestBinding = await readRecord(store, 'operations', bindingKey);
    const latestLease = await readRecord(store, 'operations', leaseKey);
    const latestProcess = await readRecord(store, 'operations', processKey);
    if (!latestOperation || !latestBinding || !latestLease || !latestProcess ||
        !same(latestOperation.value, operation.value) || !same(latestBinding.value, binding.value) ||
        !same(latestLease.value, lease.value) || !same(latestProcess.value, process.value)) fail('recovery_owner_changed');
    fence(scope);
    await store.mutateControl({ intentId: randomUUID(), changes: [
      { collection: 'operations', key: id, expectedRevision: latestOperation.revision, value: { ...operation.value, scope, initialScope: operation.value.initialScope ?? previous, recoveredFrom: previous } },
      { collection: 'operations', key: bindingKey, expectedRevision: latestBinding.revision, value: { ...binding.value, scope, turnId: turns[0].turnId, recoveredFrom: previous } },
      { collection: 'operations', key: leaseKey, expectedRevision: latestLease.revision, value: lease.value },
      { collection: 'operations', key: processKey, expectedRevision: latestProcess.revision, value: { ...process.value, epoch: scope.epoch, generation: scope.processGeneration, alive: true } },
    ] });
    fence(scope);
    return previous;
  }
  async function retire(scope, previous, nativeRequestId, operationId, nativeState = 'pending', parentScope = scope, processAuthority = parentScope) {
    fence(scope);
    const key = `interaction:${fingerprint([encodeSessionKey(scope.session), previous.epoch, previous.processGeneration, nativeRequestId])}`;
    const row = await readRecord(store, 'interactions', key, false);
    if (!row?.value || row.value.phase === 'invalidated') return;
    if (row.value.phase !== 'pending') {
      if (nativeState !== 'pending') return;
      fail('recovery_interaction_uncertain');
    }
    if (!same(row.value.scope, previous)) fail('recovery_interaction_identity');
    let metadata;
    if (row.value.parentOperationId === undefined) {
      // Earlier stores kept the parent proof in the driver's companion metadata.
      metadata = await readRecord(store, 'operations', `kimi-interaction:${key}`);
      if (!metadata?.value || !same(metadata.value.scope, previous) || metadata.value.parentOperationId !== operationId) fail('recovery_interaction_identity');
    } else if (row.value.parentOperationId !== operationId) fail('recovery_interaction_identity');
    const parent = await readRecord(store, 'operations', operationId);
    if (!parent?.value || !same(parent.value.scope, parentScope)) fail('recovery_parent_changed');
    const leaseKey = `lease:${fingerprint(encodeSessionKey(scope.session))}`;
    const lease = await readRecord(store, 'operations', leaseKey);
    const processKey = `process:${fingerprint(encodeSessionKey(scope.session))}`;
    const process = await readRecord(store, 'operations', processKey);
    if (lease?.value?.operationId !== operationId || process?.value?.epoch !== processAuthority.epoch || process.value.generation !== processAuthority.processGeneration) fail('recovery_owner_changed');
    fence(scope);
    await store.mutateControl({ intentId: randomUUID(), changes: [
      { collection: 'interactions', key, expectedRevision: row.revision, value: { ...row.value, phase: 'invalidated' } },
      { collection: 'operations', key: operationId, expectedRevision: parent.revision, value: parent.value },
      { collection: 'operations', key: leaseKey, expectedRevision: lease.revision, value: lease.value },
      { collection: 'operations', key: processKey, expectedRevision: process.revision, value: process.value },
      ...(metadata ? [{ collection: 'operations', key: `kimi-interaction:${key}`, expectedRevision: metadata.revision, value: metadata.value }] : []),
    ] });
  }
  return { adopt, retire };
}
