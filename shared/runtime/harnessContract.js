import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from './identity.js';
import { ProtocolError, requireValue, objectFields, jsonValue, textValue } from './capabilities.js';
import { WORKSPACE_OPERATIONS, NATIVE_EXTENSIONS, LEGACY_CAPABILITIES } from './nativeExtensions.js';

export const HARNESS_KINDS = Object.freeze(['opencode', 'codex', 'acp', 'kimi-web', 'dsh']);
export const CORE_OPERATIONS = Object.freeze({ inspect: 'instance', listSessionPage: 'instance', getSession: 'session', readHistoryPage: 'session', createSession: 'instance', send: 'session', cancel: 'session', respondInteraction: 'session', subscribe: 'optional-session', close: 'instance' });
export const INSPECTION_STATES = Object.freeze(['supported', 'disabled', 'missing', 'auth-required', 'starting', 'ready', 'failed']);

export function unsupported(reason) {
  return Object.freeze({ state: 'unsupported', code: 'unsupported', reason: textValue(reason, 'unsupported.reason') });
}
function declaration(input) {
  requireValue(input !== null && typeof input === 'object', 'declaration');
  switch (input.state) {
    case 'supported': objectFields(input, ['state']); return Object.freeze({ state: 'supported' });
    case 'unsupported':
      objectFields(input, ['state', 'code', 'reason']);
      requireValue(input.code === 'unsupported', 'declaration.code');
      return unsupported(input.reason);
    default: throw new ProtocolError('invalid_request', 'declaration.state');
  }
}
function identity(input) {
  return { environmentId: parseEnvironmentId(input.environmentId), harnessInstanceId: parseHarnessInstanceId(input.harnessInstanceId) };
}
const instanceKey = (scope) => JSON.stringify([scope.environmentId, scope.harnessInstanceId]);

/** Structural validation only. No support claim is inferred from a kind or version. */
export function validateHarnessManifest(input) {
  const value = objectFields(jsonValue(input), ['kind', 'environmentId', 'harnessInstanceId', 'protocolVersion', 'core', 'extensions', 'capabilities']);
  requireValue(HARNESS_KINDS.includes(value.kind), 'kind', 'unsupported');
  requireValue(value.protocolVersion === 1, 'protocolVersion', 'version_mismatch');
  const scope = identity(value);
  objectFields(value.core, Object.keys(CORE_OPERATIONS));
  const core = Object.fromEntries(Object.entries(value.core).map(([name, state]) => [name, declaration(state)]));
  requireValue(Array.isArray(value.extensions), 'extensions');
  const names = new Set();
  const extensions = value.extensions.map((entry) => {
    objectFields(entry, ['name', 'owner', 'scope', 'permission', 'schemaVersion', 'support']);
    textValue(entry.name, 'extension.name');
    requireValue(!Object.hasOwn(WORKSPACE_OPERATIONS, entry.name) && !Object.hasOwn(CORE_OPERATIONS, entry.name), 'extension.name');
    requireValue(!names.has(entry.name), 'extension.duplicate');
    names.add(entry.name);
    requireValue(parseHarnessInstanceId(entry.owner) === scope.harnessInstanceId, 'extension.owner', 'unauthorized');
    requireValue(['instance', 'session', 'optional-session'].includes(entry.scope), 'extension.scope');
    if (Object.hasOwn(NATIVE_EXTENSIONS, entry.name)) requireValue(entry.scope === NATIVE_EXTENSIONS[entry.name].scope, 'extension.scope');
    textValue(entry.permission, 'extension.permission');
    requireValue(Number.isSafeInteger(entry.schemaVersion) && entry.schemaVersion >= 1, 'extension.schemaVersion');
    return Object.freeze({ ...entry, owner: scope.harnessInstanceId, support: declaration(entry.support) });
  });
  objectFields(value.capabilities, [], Object.keys(LEGACY_CAPABILITIES).filter((name) => ['core', 'native'].includes(LEGACY_CAPABILITIES[name].owner)));
  const capabilities = Object.fromEntries(Object.entries(value.capabilities).map(([name, state]) => {
    const support = declaration(state);
    const mapping = LEGACY_CAPABILITIES[name];
    const operation = mapping.owner === 'core' ? core[mapping.operation] : extensions.find((entry) => entry.name === mapping.operation)?.support;
    requireValue(support.state !== 'supported' || operation?.state === 'supported', `capability.${name}`);
    return [name, support];
  }));
  return Object.freeze({ ...scope, kind: value.kind, protocolVersion: 1, core: Object.freeze(core), extensions: Object.freeze(extensions), capabilities: Object.freeze(capabilities) });
}
function bindMethods(declarations, methods) {
  objectFields(methods, [], Object.keys(declarations));
  return Object.freeze(Object.fromEntries(Object.entries(declarations).map(([name, support]) => {
    const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
    requireValue(support.state !== 'supported' || typeof method === 'function', `method.${name}`);
    requireValue(support.state !== 'unsupported' || method === undefined, `unsupported.${name}`);
    return [name, method];
  })));
}
export function validateHarnessRegistration(input) {
  const value = objectFields(input, ['manifest', 'driver']);
  const manifest = validateHarnessManifest(value.manifest);
  objectFields(value.driver, ['core', 'native']);
  return Object.freeze({ manifest, driver: Object.freeze({
    core: bindMethods(manifest.core, value.driver.core),
    native: bindMethods(Object.fromEntries(manifest.extensions.map((entry) => [entry.name, entry.support])), value.driver.native),
  }) });
}

export function createHarnessRegistry() {
  const registrations = new Map();
  return Object.freeze({
    register(input) {
      const registration = validateHarnessRegistration(input);
      const key = instanceKey(registration.manifest);
      requireValue(!registrations.has(key), 'instance.duplicate', 'conflict');
      registrations.set(key, registration);
      return registration.manifest;
    },
    list() { return Object.freeze([...registrations.values()].map((entry) => entry.manifest)); },
    async invoke(input) {
      const value = objectFields(input, ['environmentId', 'harnessInstanceId', 'channel', 'operation', 'params'], ['session', 'permissions']);
      const scope = identity(value);
      const registration = registrations.get(instanceKey(scope));
      requireValue(registration !== undefined, 'instance', 'source_unavailable');
      const session = value.session === undefined ? undefined : parseSessionRef(value.session);
      requireValue(!session || (session.environmentId === scope.environmentId && session.harnessInstanceId === scope.harnessInstanceId), 'session.scope', 'unauthorized');
      let support, method, requiredScope;
      switch (value.channel) {
        case 'core':
          requireValue(Object.hasOwn(CORE_OPERATIONS, value.operation), 'operation', 'unsupported');
          support = registration.manifest.core[value.operation];
          method = registration.driver.core[value.operation];
          requiredScope = CORE_OPERATIONS[value.operation];
          break;
        case 'native': {
          const extension = registration.manifest.extensions.find((entry) => entry.name === value.operation);
          requireValue(extension !== undefined, 'extension', 'unsupported');
          requireValue(Array.isArray(value.permissions) && value.permissions.includes(extension.permission), 'extension.permission', 'unauthorized');
          support = extension.support;
          method = registration.driver.native[value.operation];
          requiredScope = extension.scope;
          break;
        }
        default: throw new ProtocolError('unsupported', 'channel');
      }
      requireValue(requiredScope !== 'session' || session !== undefined, 'session.required');
      if (support.state === 'unsupported') throw new ProtocolError('unsupported', support.reason);
      const context = Object.freeze({ ...scope, ...(session ? { session } : {}), params: jsonValue(value.params) });
      const result = await method(context);
      if (value.channel === 'core' && value.operation === 'inspect') {
        const inspection = objectFields(jsonValue(result), ['state', 'protocolVersion']);
        requireValue(INSPECTION_STATES.includes(inspection.state), 'inspect.state');
        requireValue(inspection.protocolVersion === 1, 'inspect.protocolVersion', 'version_mismatch');
        return inspection;
      }
      return result;
    },
  });
}
