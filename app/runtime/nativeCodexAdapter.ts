import { jsonValue, requireValue } from '../../shared/runtime/capabilities.js';
import { NATIVE_METHODS } from '../../shared/runtime/native/codex/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { CodexAdapter } from '../backends/codex/codexAdapter';
import type { RuntimeClient } from './client';
import { createNativeFacade } from './nativeFacade';

/** Reuse the existing Codex presentation normalizers against the instance's declared API. */
export function createNativeCodexAdapter(client: RuntimeClient, manifest: HarnessManifest, session?: SessionRef) {
  requireValue(manifest.kind === 'codex', 'codex.facade_kind');
  const facade = createNativeFacade(client, manifest, session);
  return new CodexAdapter({
    url: '',
    nativeRequest: async (method, params) => {
      if (method === 'vis/health') return facade.query('getGlobalHealth');
      const declaration = Object.entries(NATIVE_METHODS).find(([, spec]) => spec.method === method);
      requireValue(declaration !== undefined, 'codex.native_method', 'unsupported');
      const [operation, spec] = declaration;
      const parsed = jsonValue(params);
      requireValue(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'codex.native_args');
      const args = Object.fromEntries(Object.entries(parsed));
      if ('threadId' in args) {
        requireValue(session !== undefined && args.threadId === session.nativeSessionId, 'codex.native_thread', 'unauthorized');
        delete args.threadId;
      }
      if (!spec.mutation) return facade.query(operation, { native: args });
      const mutation = facade.mutate(operation, { native: args });
      void mutation.accepted.catch(() => undefined);
      return (await mutation.executed).value;
    },
  });
}
