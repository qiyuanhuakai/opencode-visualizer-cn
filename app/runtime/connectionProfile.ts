import { parseConnectionProfileId, parseEnvironmentId } from '../../shared/runtime/identity.js';
import { objectFields, ProtocolError } from '../../shared/runtime/capabilities.js';
import type { Hello } from '../../shared/runtime/protocol.js';
import type { ManagementConnectionCandidate, PublicConnectionReference, RuntimeInspection } from '../../shared/runtime/runtimeWire.js';
import { normalizeManagementUrl, RuntimeConnectionError } from './connectionUrl';

export { managementCandidate, normalizeManagementUrl, RuntimeConnectionError } from './connectionUrl';

export type ConnectionReference = PublicConnectionReference | ManagementConnectionCandidate;
export type RuntimeAuthentication = Readonly<{ bridgeToken?: string }>;
export function connectionError(error: unknown): RuntimeConnectionError {
  return new RuntimeConnectionError(error instanceof RuntimeConnectionError || error instanceof ProtocolError ? error.code : 'source_unavailable');
}

export function parseConnectionReference(input: unknown): ConnectionReference {
  const object = objectFields(input, ['url'], ['profileId', 'expectedEnvironmentId']);
  if (typeof object.url !== 'string') throw new RuntimeConnectionError('invalid_request');
  return Object.freeze({
    url: normalizeManagementUrl(object.url),
    ...(object.profileId === undefined ? {} : { profileId: parseConnectionProfileId(object.profileId) }),
    ...(object.expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId: parseEnvironmentId(object.expectedEnvironmentId) }),
  });
}

export function adoptConnectionReference(reference: ConnectionReference, hello: Hello, inspection: RuntimeInspection): PublicConnectionReference {
  const selected = parseConnectionReference(reference);
  const profileId = parseConnectionProfileId(inspection.connectionProfileId);
  if ((selected.expectedEnvironmentId && selected.expectedEnvironmentId !== hello.target)
    || ('profileId' in selected && selected.profileId !== profileId)) throw new RuntimeConnectionError('conflict');
  return Object.freeze({ profileId, url: selected.url, expectedEnvironmentId: parseEnvironmentId(hello.target) });
}
