import { jsonValue, requireValue } from '../../shared/runtime/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import { DSH_UI_OPERATIONS } from '../../shared/runtime/native/dsh/uiOperations.js';
import type { DshRpcClient } from '../utils/dshRpc';
import type { RuntimeClient } from './client';
import { createNativeFacade } from './nativeFacade';

export function createNativeDshRpc(client: RuntimeClient, manifest: HarnessManifest, session?: SessionRef): DshRpcClient {
  const facade = createNativeFacade(client, manifest, session);
  return {
    nextRpcId: () => crypto.randomUUID(),
    async call(namespace, method, args = {}, options) {
      const path = `${namespace}/${method}`;
      const operation = DSH_UI_OPERATIONS[path];
      requireValue(operation !== undefined, 'dsh.ui_operation', 'unsupported');
      requireValue(!options?.signal?.aborted, 'dsh.ui_cancelled', 'cancelled');
      const body = { ...args };
      if (operation.identity) {
        requireValue(session !== undefined, 'dsh.ui_session', 'unauthorized');
        if (operation.identity === 'agentId') {
          requireValue(body.agentId === session.nativeSessionId, 'dsh.ui_session', 'unauthorized');
          delete body.agentId;
        } else {
          const request = body.request;
          requireValue(request !== null && typeof request === 'object' && !Array.isArray(request), 'dsh.ui_session', 'unauthorized');
          const clean = Object.fromEntries(Object.entries(request));
          requireValue(clean.sessionId === session.nativeSessionId, 'dsh.ui_session', 'unauthorized');
          delete clean.sessionId;
          body.request = clean;
        }
      }
      const params = { request: jsonValue(body) };
      const name = `dsh.ui.${path.replace('/', '.')}`;
      if (!operation.mutation) return facade.query(name, params);
      const mutation = facade.mutate(name, params);
      void mutation.accepted.catch(() => undefined);
      return (await mutation.executed).value;
    },
    async callMultipart() { throw new Error('runtime.dsh: binary files use the workspace channel'); },
  };
}
