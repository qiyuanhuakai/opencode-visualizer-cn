import { requireValue, type JsonValue } from '../../shared/runtime/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { RuntimeClient } from './client';

/** A facade captures one registered instance; changing a UI selector cannot retarget its calls. */
export function createNativeFacade(client: RuntimeClient, manifest: HarnessManifest, session?: SessionRef) {
  if (session) requireValue(session.environmentId === manifest.environmentId && session.harnessInstanceId === manifest.harnessInstanceId, 'native.facade_scope', 'unauthorized');
  const scope = client.scope(manifest.environmentId);
  function call(operation: string, args: Readonly<Record<string, JsonValue>>) {
    const declaration = manifest.extensions.find(entry => entry.name === operation);
    requireValue(declaration?.support.state === 'supported', `native.${operation}`, 'unsupported');
    requireValue(declaration.owner === manifest.harnessInstanceId, 'native.owner', 'unauthorized');
    requireValue(declaration.scope !== 'session' || session !== undefined, 'native.session', 'invalid_request');
    return { harnessInstanceId: manifest.harnessInstanceId, operation, args, ...(declaration.scope !== 'instance' && session ? { session } : {}) };
  }
  return {
    manifest,
    query(operation: string, args: Readonly<Record<string, JsonValue>> = {}) {
      return client.request(manifest.environmentId, 'native.query', call(operation, args), { selectionCurrent: scope.isCurrent });
    },
    mutate(operation: string, args: Readonly<Record<string, JsonValue>> = {}) {
      return client.mutate(manifest.environmentId, 'native.extension', call(operation, args), { idempotencyKey: crypto.randomUUID(), selectionCurrent: scope.isCurrent });
    },
  };
}
