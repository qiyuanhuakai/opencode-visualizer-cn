export const IDENTITY_SCHEMA_VERSION = 1;

export class IdentityError extends TypeError {
  constructor(field, code = 'invalid_identity') {
    super(`${code}: ${field}`);
    this.name = 'IdentityError';
    this.code = code;
    this.field = field;
  }
}

function record(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new IdentityError('fields');
  }
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new IdentityError(field);
  return value;
}

function uuid(value, field) {
  if (typeof value !== 'string'
    || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)) {
    throw new IdentityError(field);
  }
  return value.toLowerCase();
}

export const parseEnvironmentId = (value) => uuid(value, 'environmentId');
export const parseConnectionProfileId = (value) => uuid(value, 'connectionProfileId');
export const parseHarnessInstanceId = (value) => uuid(value, 'harnessInstanceId');
export const parseInstanceId = (value) => uuid(value, 'instanceId');

export function resolveEnvironmentId(value) {
  if (value === null || typeof value !== 'object') throw new IdentityError('environmentBinding');
  switch (value.kind) {
    case 'local':
    case 'direct':
    case 'ssh':
      record(value, ['kind', 'environmentId']);
      return parseEnvironmentId(value.environmentId);
    case 'slurm':
      record(value, ['kind', 'clusterEnvironmentId']);
      return parseEnvironmentId(value.clusterEnvironmentId);
    default:
      throw new IdentityError('environmentBinding.kind');
  }
}

export function parseSessionRef(value) {
  const ref = record(value, ['environmentId', 'harnessInstanceId', 'nativeSessionId']);
  return Object.freeze({
    environmentId: parseEnvironmentId(ref.environmentId),
    harnessInstanceId: parseHarnessInstanceId(ref.harnessInstanceId),
    nativeSessionId: text(ref.nativeSessionId, 'nativeSessionId'),
  });
}

function parsePathPolicy(value) {
  const policy = record(value, ['platform', 'volumeId', 'caseSensitive']);
  if (policy.platform !== 'posix' && policy.platform !== 'windows') throw new IdentityError('platform');
  if (typeof policy.caseSensitive !== 'boolean') throw new IdentityError('caseSensitive');
  return Object.freeze({
    platform: policy.platform,
    volumeId: text(policy.volumeId, 'volumeId'),
    caseSensitive: policy.caseSensitive,
  });
}

function canonicalPath(value, policy) {
  const path = text(value, 'canonicalPath');
  if (path.includes('\0')) throw new IdentityError('canonicalPath');
  let parts;
  switch (policy.platform) {
    case 'posix':
      if (!path.startsWith('/')) throw new IdentityError('canonicalPath');
      parts = path === '/' ? [] : path.slice(1).split('/');
      break;
    case 'windows':
      if (path.includes('/')) throw new IdentityError('canonicalPath');
      if (/^[a-z]:\\/i.test(path)) {
        parts = path.length === 3 ? [] : path.slice(3).split('\\');
      } else if (/^\\\\[^\\]+\\[^\\]+/.test(path)) {
        parts = path.slice(2).split('\\');
      } else {
        throw new IdentityError('canonicalPath');
      }
      break;
    default:
      throw new IdentityError('platform');
  }
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new IdentityError('canonicalPath');
  return path;
}

function parsePathRef(value, pathField) {
  const ref = record(value, ['environmentId', pathField, 'pathPolicy']);
  const pathPolicy = parsePathPolicy(ref.pathPolicy);
  return Object.freeze({
    environmentId: parseEnvironmentId(ref.environmentId),
    [pathField]: canonicalPath(ref[pathField], pathPolicy),
    pathPolicy,
  });
}

export const parseWorkspaceRef = (value) => parsePathRef(value, 'canonicalPath');
export const parseRepoRef = (value) => parsePathRef(value, 'canonicalCommonDir');

function encodeTuple(tuple) {
  const bytes = new TextEncoder().encode(JSON.stringify(tuple));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeTuple(value, scope, length) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) throw new IdentityError('key');
  let tuple;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    tuple = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof Error) throw new IdentityError('key');
    throw error;
  }
  if (!Array.isArray(tuple) || tuple.length === 0) throw new IdentityError('tuple');
  if (tuple[0] !== IDENTITY_SCHEMA_VERSION) throw new IdentityError('schemaVersion', 'unsupported_identity_version');
  if (tuple.length !== length || tuple[1] !== scope || encodeTuple(tuple) !== value) throw new IdentityError('tuple');
  return tuple;
}

export function encodeSessionKey(value) {
  const ref = parseSessionRef(value);
  return encodeTuple([IDENTITY_SCHEMA_VERSION, 'session', ref.environmentId, ref.harnessInstanceId, ref.nativeSessionId]);
}

export function decodeSessionKey(value) {
  const [, , environmentId, harnessInstanceId, nativeSessionId] = decodeTuple(value, 'session', 5);
  const ref = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId });
  if (encodeSessionKey(ref) !== value) throw new IdentityError('key');
  return ref;
}

function encodePathTuple(ref, scope, pathField) {
  const { platform, volumeId, caseSensitive } = ref.pathPolicy;
  return encodeTuple([IDENTITY_SCHEMA_VERSION, scope, ref.environmentId, platform, volumeId, caseSensitive, ref[pathField]]);
}

function decodePathTuple(value, scope, pathField) {
  const [, , environmentId, platform, volumeId, caseSensitive, path] = decodeTuple(value, scope, 7);
  const ref = parsePathRef({ environmentId, [pathField]: path, pathPolicy: { platform, volumeId, caseSensitive } }, pathField);
  if (encodePathTuple(ref, scope, pathField) !== value) throw new IdentityError('key');
  return ref;
}

export const encodeWorkspaceKey = (value) => encodePathTuple(parseWorkspaceRef(value), 'workspace', 'canonicalPath');
export const decodeWorkspaceKey = (value) => decodePathTuple(value, 'workspace', 'canonicalPath');
export const encodeRepoKey = (value) => encodePathTuple(parseRepoRef(value), 'repo', 'canonicalCommonDir');
export const decodeRepoKey = (value) => decodePathTuple(value, 'repo', 'canonicalCommonDir');
