import { NATIVE_METHODS } from '../../shared/runtime/native/codex/capabilities.js';
import { OPEN_CODE_OPERATIONS } from '../../shared/runtime/native/opencode/operations.js';
import { KIMI_PLUGIN_OPERATIONS } from '../../shared/runtime/native/kimiWeb/pluginOperations.js';
import { KIMI_PROVIDER_OPERATIONS } from '../../shared/runtime/native/kimiWeb/providerOperations.js';
import { KIMI_SESSION_OPERATIONS } from '../../shared/runtime/native/kimiWeb/sessionOperations.js';
import { DSH_UI_OPERATIONS } from '../../shared/runtime/native/dsh/uiOperations.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

const reads = new Set([
  ...Object.entries(KIMI_PLUGIN_OPERATIONS).filter(([, route]) => route.method === 'GET').map(([name]) => name),
  ...Object.entries(KIMI_SESSION_OPERATIONS).filter(([, route]) => route.method === 'GET').map(([name]) => name),
  ...Object.entries(KIMI_PROVIDER_OPERATIONS).filter(([, route]) => route.method === 'GET').map(([name]) => name),
  ...Object.entries(DSH_UI_OPERATIONS).filter(([, route]) => !route.mutation).map(([method]) => `dsh.ui.${method.replace('/', '.')}`),
  ...Object.entries(NATIVE_METHODS)
    .filter(([, spec]) => !spec.mutation)
    .map(([name]) => name),
  ...Object.entries(OPEN_CODE_OPERATIONS)
    .filter(([, spec]) => spec.method === 'GET')
    .map(([name]) => name),
  'acp.getInteraction',
  'listAgentAuthMethods',
  'getSessionConfigOptions',
  'getPluginStatus',
  'kimi.listWorkspacePage',
  'kimi.sessionStatus',
  'kimi.meta',
  'dsh.providers.list',
  'dsh.models.list',
  'dsh.plugins.list',
  'dsh.agentPresets.list',
  'dsh.permissions.catalog',
]);
export function authorizeNativeCall(manifest, params, method, permissions) {
  const declaration = manifest.extensions.find((item) => item.name === params.operation);
  requireValue(
    declaration?.support.state === 'supported',
    'runtime.native_operation',
    'unsupported',
  );
  requireValue(
    permissions.includes(declaration.permission),
    'runtime.native_permission',
    'unauthorized',
  );
  requireValue(
    (method === 'native.query') === reads.has(params.operation),
    'runtime.native_classification',
    'unauthorized',
  );
  requireValue(
    declaration.scope !== 'session' || params.session !== undefined,
    'runtime.native_session',
  );
  return declaration;
}
