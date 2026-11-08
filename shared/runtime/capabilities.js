import { parseHarnessInstanceId } from './identity.js';

export const ERROR_CODES = Object.freeze(['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required']);
export const METHODS = Object.freeze({
  'runtime.inspect': 'read', 'runtime.snapshot': 'read', 'runtime.replay': 'read',
  'session.list': 'read', 'session.get': 'read', 'session.history': 'read',
  'session.create': 'mutation', 'session.send': 'mutation', 'session.cancel': 'mutation',
  'interaction.respond': 'mutation', 'session.subscribe': 'read', 'session.close': 'mutation',
  'session.rename': 'mutation', 'session.archive': 'mutation', 'session.delete': 'mutation',
  'session.fork': 'mutation', 'session.revert': 'mutation', 'session.compact': 'mutation',
  'harness.models': 'read', 'harness.providers': 'read', 'harness.auth': 'mutation',
  'harness.settings': 'mutation', 'harness.skills': 'read', 'harness.mcp': 'read',
  'harness.commands': 'read', 'harness.usage': 'read', 'native.extension': 'mutation',
});
export class ProtocolError extends TypeError {
  constructor(code, field) {
    super(`${code}: ${field}`);
    this.name = 'ProtocolError';
    this.code = code;
    this.field = field;
  }
}
export function requireValue(condition, field, code = 'invalid_request') {
  if (!condition) throw new ProtocolError(code, field);
}
export function objectFields(value, required, optional = []) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'object');
  requireValue(required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), 'fields');
  return value;
}
export function textValue(value, field) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0'), field);
  return value;
}
export function integerValue(value, field, max = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= 0 && value <= max, field);
  return value;
}
export function jsonValue(value, depth = 0) {
  requireValue(depth <= 64, 'json.depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value), 'json.number');
    return value;
  }
  requireValue(typeof value === 'object', 'json.value');
  if (Array.isArray(value)) return Object.freeze(Array.from(value, (item) => jsonValue(item, depth + 1)));
  requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'json.object');
  requireValue(Reflect.ownKeys(value).length === Object.keys(value).length, 'json.keys');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1)])));
}
export function parseCapabilities(input) {
  const value = objectFields(jsonValue(input), ['methods', 'extensions']);
  requireValue(Array.isArray(value.methods) && Array.isArray(value.extensions), 'capabilities');
  requireValue(value.methods.every((method) => typeof method === 'string' && Object.hasOwn(METHODS, method))
    && new Set(value.methods).size === value.methods.length, 'methods', 'unsupported');
  const owners = new Set();
  for (const extension of value.extensions) {
    objectFields(extension, ['owner', 'name', 'permission', 'schemaVersion', 'metadata']);
    try { requireValue(parseHarnessInstanceId(extension.owner) === extension.owner, 'owner'); }
    catch (error) { if (error instanceof TypeError) throw new ProtocolError('invalid_request', 'owner'); throw error; }
    textValue(extension.name, 'extension.name');
    textValue(extension.permission, 'extension.permission');
    integerValue(extension.schemaVersion, 'extension.schemaVersion');
    const key = JSON.stringify([extension.owner, extension.name]);
    requireValue(!owners.has(key), 'extension.duplicate');
    owners.add(key);
  }
  return value;
}
export function authorizeExtension(input, authorization) {
  const capabilities = parseCapabilities(input);
  const extension = capabilities.extensions.find((entry) => entry.owner === authorization.owner && entry.name === authorization.name);
  requireValue(extension !== undefined, 'extension', 'unsupported');
  requireValue(Array.isArray(authorization.permissions) && authorization.permissions.includes(extension.permission), 'extension.permission', 'unauthorized');
  return extension;
}
