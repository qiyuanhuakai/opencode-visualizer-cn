import { parseConnectionProfileId, resolveEnvironmentId } from './identity.js';
import { ProtocolError, objectFields, requireValue, textValue } from './capabilities.js';

/** Host transports a connection profile can describe. */
export const TRANSPORT_KINDS = Object.freeze(['local', 'direct', 'ssh', 'slurm']);
/** Management vs execution roles. A profile is one role on one host. */
export const CONNECTION_ROLES = Object.freeze(['local', 'manager', 'execution']);
/** A transport reaches exactly one target-binding kind; target is the stable identity. */
export const TRANSPORT_TARGET_KIND = Object.freeze({
  local: 'local',
  direct: 'direct',
  ssh: 'ssh',
  slurm: 'slurm',
});

const STORE_SCHEMA_VERSION = 1;
const SECRET_KEY_TOKENS = Object.freeze([
  'password', 'passphrase', 'secret', 'token', 'apikey', 'authorization', 'cookie',
  'privatekey', 'credential', 'accesstoken', 'refreshtoken', 'otp', 'bearer',
]);
const SECRET_VALUE_MARKER = /(password|passphrase|secret|token|api[_-]?key|private[_-]?key|bearer)/iu;
/** `credentialRef` is the one allowed reference-shaped key; it names a secret, never carries it. */
const SAFE_KEY = 'credentialref';
/**
 * ssh/slurm locators are bare authorities — `host`, `host:port` or `[ipv6]:port`. No scheme, no
 * userinfo, no query, no fragment, no path: authentication travels only through `credentialRef`.
 */
const BRACKETED_LOCATOR = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/u;
const HOST_LOCATOR = /^([^:/@?#\s[\]]+)(?::(\d{1,5}))?$/u;

function isSecretKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (normalized === SAFE_KEY) return false;
  return SECRET_KEY_TOKENS.some((token) => normalized.includes(token));
}

/**
 * Structural guard used on every normal payload before it leaves the bridge. It rejects
 * secret-carrying keys; a `credentialRef` reference is allowed. This is defence in depth on
 * top of the strict per-profile field checks, and is what the HTTP layer runs on responses.
 */
export function assertNoSecretPayload(value, path = 'payload', depth = 0) {
  requireValue(depth <= 32, 'payload.depth');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretPayload(item, path, depth + 1);
    return value;
  }
  for (const [key, item] of Object.entries(value)) {
    requireValue(!isSecretKey(key), `${path}.${key}.secret`);
    assertNoSecretPayload(item, `${path}.${key}`, depth + 1);
  }
  return value;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requireLocatorPort(text) {
  if (text === undefined) return;
  const port = Number(text);
  requireValue(port >= 1 && port <= 65535, 'transport.endpoint');
}

function assertHostLocator(endpoint) {
  const bracketed = BRACKETED_LOCATOR.exec(endpoint);
  if (bracketed !== null) {
    requireLocatorPort(bracketed[2]);
    return;
  }
  const match = HOST_LOCATOR.exec(endpoint);
  requireValue(match !== null, 'transport.endpoint');
  requireLocatorPort(match[2]);
}

function parseEndpoint(kind, input) {
  const endpoint = textValue(input, 'transport.endpoint');
  requireValue(endpoint.length <= 1024 && !hasControlCharacter(endpoint), 'transport.endpoint');
  // A locator must never itself carry a raw secret (e.g. `?token=`). Direct/local endpoints
  // are additionally required to be a userinfo/query/fragment-free ws(s) URL.
  requireValue(!SECRET_VALUE_MARKER.test(endpoint), 'transport.endpoint.secret');
  if (kind === 'direct' || kind === 'local') {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ProtocolError('invalid_request', 'transport.endpoint');
    }
    requireValue(
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
        !url.username && !url.password && !url.search && !url.hash,
      'transport.endpoint',
    );
    return endpoint;
  }
  assertHostLocator(endpoint);
  return endpoint;
}

export function parseTransport(input) {
  const value = objectFields(input, ['kind'], ['endpoint']);
  requireValue(TRANSPORT_KINDS.includes(value.kind), 'transport.kind', 'unsupported');
  const endpoint = value.endpoint === undefined ? undefined : parseEndpoint(value.kind, value.endpoint);
  return Object.freeze({ kind: value.kind, ...(endpoint === undefined ? {} : { endpoint }) });
}

/**
 * Target mapping. Reuses the identity contract so a profile resolves to a persistent
 * environment UUID: local/direct/ssh carry `environmentId`; slurm carries the cluster profile's
 * `clusterEnvironmentId` (never a compute hostname or job id).
 */
export function parseConnectionTarget(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError('invalid_request', 'target');
  }
  requireValue(TRANSPORT_KINDS.includes(input.kind), 'target.kind', 'unsupported');
  let environmentId;
  try {
    environmentId = resolveEnvironmentId(input);
  } catch (error) {
    if (error instanceof Error) throw new ProtocolError('invalid_request', 'target');
    throw error;
  }
  return input.kind === 'slurm'
    ? Object.freeze({ kind: 'slurm', clusterEnvironmentId: environmentId })
    : Object.freeze({ kind: input.kind, environmentId });
}

export function parseCredentialRef(input) {
  const ref = textValue(input, 'credentialRef');
  requireValue(ref.length <= 256 && !/\s/u.test(ref), 'credentialRef');
  return ref;
}

export function parseConnectionRole(input) {
  requireValue(CONNECTION_ROLES.includes(input), 'role', 'unsupported');
  return input;
}

function mergeDraft(value) {
  const transport = parseTransport(value.transport);
  const target = parseConnectionTarget(value.target);
  requireValue(target.kind === TRANSPORT_TARGET_KIND[transport.kind], 'profile.target', 'invalid_request');
  return { name: textValue(value.name, 'name'), transport, target, role: parseConnectionRole(value.role), credentialRef: parseCredentialRef(value.credentialRef) };
}

/** Full persisted profile: stable UUID, non-secret credentialRef, stable target mapping, explicit role. */
export function parseConnectionProfile(input) {
  const value = objectFields(input, ['profileId', 'name', 'transport', 'target', 'role', 'credentialRef', 'enabled']);
  assertNoSecretPayload(value);
  requireValue(typeof value.enabled === 'boolean', 'enabled');
  return Object.freeze({
    profileId: parseConnectionProfileId(value.profileId),
    ...mergeDraft(value),
    enabled: value.enabled,
  });
}

/** Creation input; the store assigns the stable UUID. `enabled` defaults to false (opt-in). */
export function parseNewConnectionProfile(input) {
  const value = objectFields(input, ['name', 'transport', 'target', 'role', 'credentialRef'], ['enabled']);
  assertNoSecretPayload(value);
  const enabled = value.enabled === undefined ? false : value.enabled;
  requireValue(typeof enabled === 'boolean', 'enabled');
  return Object.freeze({ ...mergeDraft(value), enabled });
}

/** Public view: identical shape to the strict profile (already secret-free), re-validated. */
export function publicConnectionProfile(profile) {
  const parsed = parseConnectionProfile(profile);
  assertNoSecretPayload(parsed);
  return parsed;
}

/** The stable environment identity this profile maps to; independent of mutable fields. */
export function resolveProfileEnvironment(profile) {
  return resolveEnvironmentId(parseConnectionTarget(profile.target));
}

/**
 * Identity-preserving edit. Mutable: name, credentialRef, and a same-kind transport endpoint.
 * `profileId`, `target`, `role` and `enabled` are immutable here: changing identity is a conflict,
 * and enabling is an explicit separate action (a disabled source is never auto-enabled).
 */
export function updateConnectionProfile(current, patch) {
  const profile = parseConnectionProfile(current);
  const value = objectFields(patch, [], ['name', 'credentialRef', 'transport']);
  assertNoSecretPayload(value);
  let transport = profile.transport;
  if (Object.hasOwn(value, 'transport')) {
    transport = parseTransport(value.transport);
    requireValue(transport.kind === profile.transport.kind, 'transport.kind', 'conflict');
  }
  return Object.freeze({
    ...profile,
    name: Object.hasOwn(value, 'name') ? textValue(value.name, 'name') : profile.name,
    credentialRef: Object.hasOwn(value, 'credentialRef') ? parseCredentialRef(value.credentialRef) : profile.credentialRef,
    transport,
  });
}

export function createProfileDocument(profiles) {
  return Object.freeze({ version: STORE_SCHEMA_VERSION, profiles: Object.freeze([...profiles]) });
}

export function parseProfileDocument(input) {
  const value = objectFields(input, ['version', 'profiles']);
  requireValue(value.version === STORE_SCHEMA_VERSION, 'profiles.version', 'version_mismatch');
  requireValue(Array.isArray(value.profiles), 'profiles');
  const profiles = value.profiles.map(parseConnectionProfile);
  const ids = new Set(profiles.map((profile) => profile.profileId));
  requireValue(ids.size === profiles.length, 'profiles.profileId', 'conflict');
  return profiles;
}
