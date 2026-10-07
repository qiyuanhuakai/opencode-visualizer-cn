import { CORE_OPERATIONS, unsupported } from '../../harnessContract.js';

// Profile is bound to the locally verified 0.160.0 App Server schema, not inferred for future versions.
export const CODEX_PROFILE = '0.160.0';
export const NATIVE_METHODS = Object.freeze({
  forkSession: {
    method: 'thread/fork',
    scope: 'session',
    mutation: true,
    fields: [
      'lastTurnId',
      'ephemeral',
      'model',
      'modelProvider',
      'approvalPolicy',
      'sandbox',
      'serviceTier',
    ],
  },
  deleteSession: { method: 'thread/delete', scope: 'session', mutation: true, fields: [] },
  revertSession: {
    method: 'thread/revert',
    scope: 'session',
    mutation: true,
    fields: ['beforeTurnId'],
  },
  compactSession: { method: 'thread/compact/start', scope: 'session', mutation: true, fields: [] },
  'codex.review': {
    method: 'review/start',
    scope: 'session',
    mutation: true,
    fields: ['target', 'delivery'],
  },
  'codex.goal.get': { method: 'thread/goal/get', scope: 'session', fields: [] },
  'codex.goal.set': {
    method: 'thread/goal/set',
    scope: 'session',
    mutation: true,
    fields: ['objective', 'status', 'tokenBudget'],
  },
  'codex.goal.clear': { method: 'thread/goal/clear', scope: 'session', mutation: true, fields: [] },
  'codex.models': {
    method: 'model/list',
    scope: 'instance',
    fields: ['cursor', 'limit', 'includeHidden'],
  },
  'codex.providerCapabilities': {
    method: 'modelProvider/capabilities/read',
    scope: 'instance',
    fields: [],
  },
  'codex.usage': { method: 'account/usage/read', scope: 'instance', fields: [] },
  'codex.rateLimits': { method: 'account/rateLimits/read', scope: 'instance', fields: [] },
  'codex.account': { method: 'account/read', scope: 'instance', fields: ['refreshToken'] },
  'codex.auth.login': {
    method: 'account/login/start',
    scope: 'instance',
    mutation: true,
    fields: ['type'],
  },
  'codex.auth.cancel': {
    method: 'account/login/cancel',
    scope: 'instance',
    mutation: true,
    fields: ['loginId'],
  },
  'codex.auth.logout': { method: 'account/logout', scope: 'instance', mutation: true, fields: [] },
  getGlobalConfig: { method: 'config/read', scope: 'instance', fields: ['includeLayers'] },
  writeConfigValue: {
    method: 'config/value/write',
    scope: 'instance',
    mutation: true,
    fields: [
      'keyPath',
      'value',
      'mergeStrategy',
      'filePath',
      'expectedVersion',
      'reloadUserConfig',
    ],
  },
  batchWriteConfig: {
    method: 'config/batchWrite',
    scope: 'instance',
    mutation: true,
    fields: ['edits', 'filePath', 'expectedVersion', 'reloadUserConfig'],
  },
  'codex.requirements': { method: 'configRequirements/read', scope: 'instance', fields: [] },
  getPermissionPresetOptions: {
    method: 'permissionProfile/list',
    scope: 'session',
    fields: ['cursor', 'limit'],
  },
  getSkillStatus: { method: 'skills/list', scope: 'instance', fields: ['cwds', 'forceReload'] },
  updateSkill: {
    method: 'skills/config/write',
    scope: 'instance',
    mutation: true,
    fields: ['path', 'enabled'],
  },
  getMcpStatus: { method: 'mcpServerStatus/list', scope: 'instance', fields: ['cursor', 'limit'] },
  'codex.mcp.reload': {
    method: 'config/mcpServer/reload',
    scope: 'instance',
    mutation: true,
    fields: [],
  },
  'codex.mcp.oauth': {
    method: 'mcpServer/oauth/login',
    scope: 'instance',
    mutation: true,
    fields: ['name', 'scopes', 'timeoutSecs'],
  },
  getPluginStatus: { method: 'plugin/list', scope: 'instance', fields: ['marketplacePaths'] },
  'codex.plugin.install': {
    method: 'plugin/install',
    scope: 'instance',
    mutation: true,
    fields: ['installAttemptId', 'marketplacePath', 'pluginName', 'remoteMarketplaceName'],
  },
  'codex.plugin.uninstall': {
    method: 'plugin/uninstall',
    scope: 'instance',
    mutation: true,
    fields: ['pluginId'],
  },
});
export const COMMANDS = Object.freeze([
  { name: 'compact', operation: 'compactSession' },
  { name: 'review', operation: 'codex.review' },
  { name: 'fork', operation: 'forkSession' },
  { name: 'side', operation: 'forkSession', ephemeral: true },
  { name: 'btw', operation: 'forkSession', ephemeral: true },
  { name: 'rename', operation: 'updateSession' },
  { name: 'archive', operation: 'updateSession' },
  { name: 'goal', operation: 'codex.goal.set' },
  { name: 'fast', operation: 'writeConfigValue' },
]);
export function codexManifest(scope, native) {
  const support = { state: 'supported' };
  const extensions = Object.keys(native).map((name) => ({
    name,
    owner: scope.harnessInstanceId,
    scope:
      NATIVE_METHODS[name]?.scope ??
      (['updateSession', 'sendCommand', 'codex.steer'].includes(name) ? 'session' : 'instance'),
    permission: `codex:${name}`,
    schemaVersion: 1,
    support,
  }));
  return {
    ...scope,
    kind: 'codex',
    protocolVersion: 1,
    core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, support])),
    extensions,
    capabilities: {
      sessions: support,
      permissions: support,
      questions: support,
      sessionFork: support,
      sessionRevert: support,
      sessionRename: support,
      sessionArchive: support,
      sessionUnarchive: support,
      sessionDelete: support,
      sessionCompact: support,
      providerConfig: support,
      sessionPin: unsupported('Host metadata owns pinning'),
      sessionUnpin: unsupported('Host metadata owns pinning'),
      todos: unsupported('No native todos method'),
    },
  };
}
