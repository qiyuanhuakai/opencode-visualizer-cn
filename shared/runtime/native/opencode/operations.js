import { requireValue, textValue } from '../../capabilities.js';
import { encodeSessionKey } from '../../identity.js';

const sessionRead = (suffix) => ({ method: 'GET', scope: 'session', suffix });
const sessionWrite = (method, suffix) => ({ method, scope: 'session', suffix });
const instance = (method, path, redact = false) => ({ method, scope: 'instance', path, redact });
export const OPEN_CODE_OPERATIONS = Object.freeze({
  forkSession: sessionWrite('POST', '/fork'),
  updateSession: sessionWrite('PATCH', ''),
  deleteSession: sessionWrite('DELETE', ''),
  revertSession: sessionWrite('POST', '/revert'),
  unrevertSession: sessionWrite('POST', '/unrevert'),
  getSessionDiff: sessionRead('/diff'),
  getSessionChildren: sessionRead('/children'),
  getSessionMessage: sessionRead('/message/{messageID}'),
  getSessionTodos: sessionRead('/todo'),
  sendCommand: sessionWrite('POST', '/command'),
  patchMessagePart: sessionWrite('PATCH', '/message/{messageID}/part/{partID}'),
  getGlobalConfig: instance('GET', '/global/config', true),
  updateGlobalConfig: instance('PATCH', '/global/config', true),
  listProviders: instance('GET', '/provider', true),
  listProviderAuthMethods: instance('GET', '/provider/auth', true),
  authorizeProviderOAuth: instance('POST', '/provider/{providerID}/oauth/authorize', true),
  completeProviderOAuth: instance('POST', '/provider/{providerID}/oauth/callback', true),
  setProviderAuth: instance('PUT', '/auth/{providerID}', true),
  deleteProviderAuth: instance('DELETE', '/auth/{providerID}', true),
  listAgents: instance('GET', '/agent'),
  listCommands: instance('GET', '/command'),
  getSessionStatusMap: instance('GET', '/session/status'),
  listPendingPermissions: instance('GET', '/permission'),
  listPendingQuestions: instance('GET', '/question'),
  getMcpStatus: instance('GET', '/mcp', true),
  getLspStatus: instance('GET', '/lsp'),
  updateMcp: instance('POST', '/mcp', true),
  getSkillStatus: instance('GET', '/skill'),
});
export function nativeRoute(name, session, params) {
  const operation = OPEN_CODE_OPERATIONS[name];
  requireValue(operation !== undefined, 'opencode.native_operation', 'unsupported');
  let path = operation.path ?? `/session/${encodeURIComponent(textValue(session?.nativeSessionId, 'opencode.native_session'))}${operation.suffix}`;
  path = path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(textValue(params[key], `opencode.${key}`)));
  return { ...operation, path };
}
export function supportsNativeRoute(document, name) {
  const operation = OPEN_CODE_OPERATIONS[name];
  const path = operation.path ?? `/session/{sessionID}${operation.suffix}`;
  return document?.paths?.[path]?.[operation.method.toLowerCase()] !== undefined;
}

/** A cancellation consumes the original owner's lease; it never acquires a second session owner. */
export async function cancelOwnedOperation({ store, scope, operationId, idempotencyKey, authority, current, fingerprint, randomUUID, send, reconcile }) {
  textValue(idempotencyKey, 'opencode.cancel_idempotency');
  const leaseKey = `lease:${fingerprint(encodeSessionKey(scope.session))}`;
  const cancelKey = `op:${fingerprint([encodeSessionKey(scope.session), idempotencyKey])}`;
  requireValue(cancelKey !== operationId, 'opencode.cancel_idempotency', 'conflict');
  const intentId = randomUUID();
  const local = () => requireValue(current() === true, 'opencode.cancel_generation', 'reconcile_required');
  const sameScope = (value) => value?.kind === 'operation' && value.operationId === operationId && fingerprint(value.scope) === fingerprint(scope);
  async function read(key) {
    const record = await store.getControl({ collection: 'operations', key }); local();
    requireValue(record && !record.chunked, 'opencode.cancel_record', 'reconcile_required');
    return record;
  }
  async function owned(dispatching, completed = false) {
    const process = await authority(); local();
    requireValue(process.value?.environmentId === scope.target && process.value?.harnessInstanceId === scope.session.harnessInstanceId && process.value?.epoch === scope.epoch && process.value?.processGeneration === scope.processGeneration && process.value?.alive === true, 'opencode.cancel_process', 'unauthorized');
    let operation = await read(operationId);
    requireValue(sameScope(operation.value), 'opencode.cancel_scope', 'unauthorized');
    requireValue(dispatching ? operation.value.cancelDispatch?.intentId === intentId : !operation.value.cancelRequested, 'opencode.cancel_no_replay', 'reconcile_required');
    const cancellation = dispatching ? await read(cancelKey) : null;
    requireValue(!dispatching || (cancellation.value?.kind === 'opencode-cancellation' && cancellation.value.intentId === intentId && cancellation.value.operationId === operationId && fingerprint(cancellation.value.scope) === fingerprint(scope) && cancellation.value.phase === (completed ? 'sent' : 'accepted')), 'opencode.cancel_intent', 'reconcile_required');
    const lease = await read(leaseKey);
    if (completed && lease.value === null && operation.value.phase !== 'terminal') {
      operation = await read(operationId);
      requireValue(sameScope(operation.value) && operation.value.cancelDispatch?.intentId === intentId, 'opencode.cancel_scope', 'unauthorized');
    }
    const terminal = completed && operation.value.phase === 'terminal';
    requireValue(terminal || ['sent', 'observed', 'reconciling'].includes(operation.value.phase), 'opencode.cancel_phase', 'reconcile_required');
    requireValue((terminal && lease.value === null) || (lease.value?.operationId === operationId && lease.value?.runtimeOwner === true), 'opencode.cancel_owner', 'conflict');
    return { process, operation, cancellation, lease };
  }
  const { process, operation, lease } = await owned(false);
  try {
    local();
    // The unchanged lease and process participate in the same CAS as the durable no-retry marker.
    await store.mutateControl({ intentId, changes: [
      { collection: 'operations', key: operationId, expectedRevision: operation.revision, value: { ...operation.value, cancelRequested: true, cancelDispatch: { intentId, idempotencyKey } } },
      { collection: 'operations', key: cancelKey, expectedRevision: 0, value: { kind: 'opencode-cancellation', scope, operationId, intentId, idempotencyKey, phase: 'accepted', digest: fingerprint({ scope, operationId, method: 'cancel', idempotencyKey }) } },
      { collection: 'operations', key: leaseKey, expectedRevision: lease.revision, value: lease.value },
      process,
    ] });
    const dispatch = await owned(true); local();
    await store.mutateControl({ intentId: randomUUID(), changes: [
      { collection: 'operations', key: operationId, expectedRevision: dispatch.operation.revision, value: dispatch.operation.value },
      { collection: 'operations', key: cancelKey, expectedRevision: dispatch.cancellation.revision, value: { ...dispatch.cancellation.value, phase: 'sent' } },
      { collection: 'operations', key: leaseKey, expectedRevision: dispatch.lease.revision, value: dispatch.lease.value },
      dispatch.process,
    ] });
    local();
    await send();
    for (let attempt = 0; attempt < 4; attempt++) {
      const observed = await owned(true, true); local();
      try {
        await store.mutateControl({ intentId: randomUUID(), changes: [
          { collection: 'operations', key: operationId, expectedRevision: observed.operation.revision, value: observed.operation.value },
          { collection: 'operations', key: cancelKey, expectedRevision: observed.cancellation.revision, value: { ...observed.cancellation.value, phase: 'observed' } },
          { collection: 'operations', key: leaseKey, expectedRevision: observed.lease.revision, value: observed.lease.value },
          observed.process,
        ] });
        local(); return { phase: 'native-executed', operationId, cancelRequested: true };
      } catch (error) { if (!(error instanceof Error && error.code === 'conflict' && error.reason === 'entity_revision' && attempt < 3)) throw error; }
    }
  } catch (error) {
    const persisted = await store.getControl({ collection: 'operations', key: operationId });
    if (sameScope(persisted?.value) && persisted.value.cancelDispatch?.intentId === intentId) {
      await reconcile();
      const cancellation = await store.getControl({ collection: 'operations', key: cancelKey });
      if (cancellation?.value?.intentId === intentId && fingerprint(cancellation.value.scope) === fingerprint(scope)) await store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key: cancelKey, expectedRevision: cancellation.revision, value: { ...cancellation.value, phase: 'reconciling' } }] });
    }
    throw error;
  }
}
