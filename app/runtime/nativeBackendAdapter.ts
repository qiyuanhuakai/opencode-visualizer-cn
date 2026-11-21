import { jsonValue, requireValue } from '../../shared/runtime/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { BackendAdapter } from '../backends/types';
import { dshModelSurface, normalizeDshModelCatalog } from '../backends/dsh/modelCatalog';
import { createAcpAgentList, createAcpProviderResponse, parseAcpSelectOptions } from '../backends/acp/configOptions';
import { modelResponse } from '../backends/kimiWeb/kimiWebAdapter';
import type { KimiWebModel } from '../utils/kimiWeb';
import type { RuntimeClient } from './client';
import { createNativeFacade } from './nativeFacade';
import { createNativeCodexAdapter } from './nativeCodexAdapter';
import { createNativeDshRpc } from './nativeDshRpc';

export function createNativeBackendAdapter(client: RuntimeClient, manifest: HarnessManifest, session?: SessionRef): Partial<BackendAdapter> {
  if (manifest.kind === 'codex') return createNativeCodexAdapter(client, manifest, session);
  const facade = createNativeFacade(client, manifest, session);
  const supported = (name: string) => manifest.extensions.some(entry => entry.name === name && entry.support.state === 'supported');
  const query = (name: string) => () => facade.query(name);
  const mutate = (name: string) => async (payload: Record<string, unknown>) => {
    const body = jsonValue(payload);
    const operation = facade.mutate(name, manifest.kind === 'opencode' ? { body } : { request: body });
    void operation.accepted.catch(() => undefined);
    return (await operation.executed).value;
  };
  const adapter: Partial<BackendAdapter> = { kind: manifest.kind, label: manifest.kind };
  async function nativeWrite(name: string, args: Record<string, unknown>) {
    const operation = facade.mutate(name, Object.fromEntries(Object.entries(args).map(([key, value]) => [key, jsonValue(value)])));
    void operation.accepted.catch(() => undefined);
    return (await operation.executed).value;
  }
  function ownSession(sessionId: string) {
    requireValue(session?.nativeSessionId === sessionId, 'native.session_scope', 'unauthorized');
  }
  if (manifest.kind === 'opencode') {
    if (supported('forkSession')) adapter.forkSession = async (sessionId, messageId) => { ownSession(sessionId); return nativeWrite('forkSession', { body: { messageID: messageId } }); };
    if (supported('updateSession')) adapter.updateSession = async (sessionId, payload) => { ownSession(sessionId); return nativeWrite('updateSession', { body: payload }); };
    if (supported('deleteSession')) adapter.deleteSession = async sessionId => { ownSession(sessionId); return nativeWrite('deleteSession', {}); };
    if (supported('revertSession')) adapter.revertSession = async (sessionId, messageId) => { ownSession(sessionId); return nativeWrite('revertSession', { body: { messageID: messageId } }); };
    if (supported('unrevertSession')) adapter.unrevertSession = async sessionId => { ownSession(sessionId); return nativeWrite('unrevertSession', {}); };
    if (supported('getSessionDiff')) adapter.getSessionDiff = async payload => { ownSession(payload.sessionID); return facade.query('getSessionDiff'); };
    if (supported('getSessionChildren')) adapter.getSessionChildren = async sessionId => { ownSession(sessionId); return facade.query('getSessionChildren'); };
    if (supported('getSessionMessage')) adapter.getSessionMessage = async (sessionId, messageId) => { ownSession(sessionId); return facade.query('getSessionMessage', { messageID: messageId }); };
    if (supported('sendCommand')) adapter.sendCommand = async (sessionId, payload) => {
      ownSession(sessionId);
      const { directory: _directory, ...body } = payload;
      await nativeWrite('sendCommand', { body });
    };
    if (supported('patchMessagePart')) adapter.patchMessagePart = async payload => {
      ownSession(payload.sessionID);
      return nativeWrite('patchMessagePart', { messageID: payload.messageID, partID: payload.partID, body: payload.part });
    };
    if (supported('authorizeProviderOAuth')) adapter.authorizeProviderOAuth = (providerId, payload) => {
      const { directory: _directory, workspace: _workspace, ...body } = payload;
      return nativeWrite('authorizeProviderOAuth', { providerID: providerId, body });
    };
    if (supported('completeProviderOAuth')) adapter.completeProviderOAuth = (providerId, payload) => {
      const { directory: _directory, workspace: _workspace, ...body } = payload;
      return nativeWrite('completeProviderOAuth', { providerID: providerId, body });
    };
    if (supported('setProviderAuth')) adapter.setProviderAuth = (providerId, body) => nativeWrite('setProviderAuth', { providerID: providerId, body });
    if (supported('deleteProviderAuth')) adapter.deleteProviderAuth = providerId => nativeWrite('deleteProviderAuth', { providerID: providerId });
  }
  if (supported('listProviders')) adapter.listProviders = query('listProviders');
  if (manifest.kind === 'kimi-web' && supported('listProviders')) adapter.listProviders = async () => {
    const result = await facade.query('listProviders');
    requireValue(result !== null && typeof result === 'object' && !Array.isArray(result) && 'items' in result && Array.isArray(result.items), 'kimi.models');
    const models: KimiWebModel[] = result.items.map(value => {
      requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'kimi.model');
      const row = Object.fromEntries(Object.entries(value));
      requireValue(typeof row.model === 'string' && typeof row.provider === 'string' && typeof row.display_name === 'string', 'kimi.model_fields');
      return { model: row.model, provider: row.provider, display_name: row.display_name,
        ...(typeof row.max_context_size === 'number' ? { max_context_size: row.max_context_size } : {}),
        ...(Array.isArray(row.capabilities) ? { capabilities: row.capabilities.filter((value): value is string => typeof value === 'string') } : {}),
        ...(Array.isArray(row.support_efforts) ? { support_efforts: row.support_efforts.filter((value): value is string => typeof value === 'string') } : {}),
        ...(typeof row.default_effort === 'string' ? { default_effort: row.default_effort } : {}),
      };
    });
    return modelResponse(models);
  };
  if (manifest.kind === 'dsh') {
    if (supported('forkSession')) adapter.forkSession = async (sessionId, messageId) => { ownSession(sessionId); return nativeWrite('forkSession', messageId ? { messageId } : {}); };
    if (supported('updateSession')) adapter.updateSession = async (sessionId, payload) => { ownSession(sessionId); return nativeWrite('updateSession', payload); };
    const rpc = createNativeDshRpc(client, manifest, session);
    if (supported('dsh.ui.pluginManager.listPlugins')) {
      adapter.getPluginManagementEntries = async () => {
        const value = await rpc.call('pluginManager', 'listPlugins');
        requireValue(Array.isArray(value), 'dsh.plugins');
        return value.map(item => {
          requireValue(item !== null && typeof item === 'object' && !Array.isArray(item), 'dsh.plugin');
          const entry = Object.fromEntries(Object.entries(item));
          requireValue(typeof entry.entryId === 'string' && typeof entry.moduleName === 'string' && typeof entry.enabled === 'boolean' && (entry.fiberPhase === null || typeof entry.fiberPhase === 'string'), 'dsh.plugin_fields');
          const meta = entry.meta && typeof entry.meta === 'object' ? Object.fromEntries(Object.entries(entry.meta)) : {};
          const base = { id: entry.entryId, moduleName: entry.moduleName, name: typeof meta.title === 'string' ? meta.title : entry.moduleName, enabled: entry.enabled, phase: entry.fiberPhase, ...(typeof meta.description === 'string' ? { description: meta.description } : {}) };
          if (entry.readOnlyReason === 'management-required' || entry.readOnlyReason === 'unaddressable') return { ...base, writable: false as const, readOnlyReason: entry.readOnlyReason };
          requireValue(typeof entry.patchId === 'string' && entry.patchId.trim().length > 0, 'dsh.plugin_writable');
          return { ...base, writable: true as const };
        });
      };
      adapter.getPluginStatus = async () => (await adapter.getPluginManagementEntries!()).map(entry => ({ id: entry.id, name: entry.name, enabled: entry.enabled, installed: true, accessible: true }));
    }
    if (supported('dsh.ui.pluginManager.setPluginEnabled')) adapter.setPluginEnabled = async (id, enabled) => {
      const entry = (await adapter.getPluginManagementEntries?.())?.find(item => item.id === id);
      requireValue(entry?.writable === true, 'dsh.plugin_read_only', 'unsupported');
      const value = await rpc.call('pluginManager', 'setPluginEnabled', { id, enabled });
      requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'dsh.plugin_change');
      const result = Object.fromEntries(Object.entries(value));
      requireValue(typeof result.changed === 'boolean' && result.stage === 'enable' && typeof result.target === 'string', 'dsh.plugin_change');
      requireValue(result.application === 'applied' || result.application === 'restart-required' || result.application === 'overridden', 'dsh.plugin_change_failed', 'source_unavailable');
      return { changed: result.changed, application: result.application };
    };
    if (session && supported('dsh.ui.commands.list')) adapter.listCommands = async () => rpc.call('commands', 'list', { agentId: session.nativeSessionId });
    if (session && supported('dsh.ui.skills.list')) adapter.getSkillStatus = async () => rpc.call('skills', 'list', { request: { sessionId: session.nativeSessionId } });
    if (supported('dsh.permissions.catalog')) adapter.getPermissionPresetOptions = async (sessionId) => {
      requireValue(session?.nativeSessionId === sessionId, 'dsh.permission_session', 'unauthorized');
      const result = await facade.query('dsh.permissions.catalog');
      requireValue(result !== null && typeof result === 'object' && !Array.isArray(result) && 'options' in result && Array.isArray(result.options), 'dsh.permissions');
      return result.options.map(value => {
        requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'dsh.permission');
        const option = Object.fromEntries(Object.entries(value));
        requireValue(typeof option.value === 'string' && typeof option.name === 'string', 'dsh.permission_fields');
        return { value: option.value, name: option.name, ...(typeof option.description === 'string' ? { description: option.description } : {}) };
      });
    };
    if (supported('dsh.permissions.select')) adapter.selectPermissionPreset = async (sessionId, preset) => {
      requireValue(session?.nativeSessionId === sessionId, 'dsh.permission_session', 'unauthorized');
      const operation = facade.mutate('dsh.permissions.select', { preset });
      void operation.accepted.catch(() => undefined);
      await operation.executed;
    };

    if (supported('dsh.models.list')) adapter.listProviders = async () => dshModelSurface(normalizeDshModelCatalog(await facade.query('dsh.models.list')));
    if (supported('dsh.agentPresets.list')) adapter.listAgents = async () => {
      const result = await facade.query('dsh.agentPresets.list');
      requireValue(result !== null && typeof result === 'object' && !Array.isArray(result) && 'presets' in result && Array.isArray(result.presets), 'dsh.presets');
      return result.presets.flatMap(value => {
        requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'dsh.preset');
        const preset = Object.fromEntries(Object.entries(value));
        if (typeof preset.id !== 'string' || preset.broken) return [];
        return [{ name: preset.id, label: typeof preset.name === 'string' ? preset.name : preset.id, description: typeof preset.description === 'string' ? preset.description : '', mode: 'primary', isDefault: preset.isDefault === true }];
      });
    };
  }
  if (supported('listAgents')) adapter.listAgents = query('listAgents');
  if (manifest.kind === 'acp' && session) {
    let configOptions: unknown[] = [];
    const loadConfigOptions = async () => {
      const result = await facade.query('getSessionConfigOptions');
      requireValue(Array.isArray(result), 'acp.config_options');
      configOptions = result;
      return configOptions;
    };
    adapter.listProviders = async () => createAcpProviderResponse(await loadConfigOptions(), adapter.label ?? 'ACP');
    adapter.listAgents = async () => createAcpAgentList(await loadConfigOptions(), adapter.label ?? 'ACP');
    adapter.getSessionConfigOptions = () => configOptions;
    adapter.syncSessionConfig = async (sessionId, selection) => {
      requireValue(session.nativeSessionId === sessionId, 'acp.session_scope', 'unauthorized');
      const options = parseAcpSelectOptions(await loadConfigOptions());
      for (const [category, value] of [['model', selection.model], ['mode', selection.mode], ['thought_level', selection.thoughtLevel]]) {
        if (!value) continue;
        const option = options.find(entry => entry.category === category || entry.id === category || category === 'thought_level' && entry.id === 'thinking');
        if (!option && value === 'default') continue;
        requireValue(option !== undefined && option.options.some(entry => entry.value === value), 'acp.config_option', 'unsupported');
        if (option.currentValue === value) continue;
        const operation = facade.mutate('syncSessionConfig', { configId: option.id, value });
        void operation.accepted.catch(() => undefined);
        await operation.executed;
      }
    };
  }

  if (supported('listCommands')) adapter.listCommands = query('listCommands');
  if (supported('getGlobalConfig')) adapter.getGlobalConfig = query('getGlobalConfig');
  if (supported('listProviderAuthMethods')) adapter.listProviderAuthMethods = query('listProviderAuthMethods');
  if (supported('getMcpStatus')) adapter.getMcpStatus = query('getMcpStatus');
  if (supported('getLspStatus')) adapter.getLspStatus = query('getLspStatus');
  if (supported('getGlobalHealth')) adapter.getGlobalHealth = async () => {
    const value = await facade.query('getGlobalHealth');
    const health = value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
    requireValue(typeof health.healthy === 'boolean' && typeof health.version === 'string', 'runtime.health');
    return { healthy: health.healthy, version: health.version };
  };
  if (supported('getSkillStatus')) adapter.getSkillStatus = query('getSkillStatus');
  if (supported('getSessionStatusMap')) adapter.getSessionStatusMap = query('getSessionStatusMap');
  if (supported('getPluginStatus')) adapter.getPluginStatus = query('getPluginStatus');
  if (supported('updateGlobalConfig')) adapter.updateGlobalConfig = mutate('updateGlobalConfig');
  if (supported('updateMcp')) adapter.updateMcp = mutate('updateMcp');
  if (supported('updateSkill')) adapter.updateSkill = mutate('updateSkill');
  if (supported('getSessionTodos')) adapter.getSessionTodos = (sessionId) => {
    requireValue(session?.nativeSessionId === sessionId, 'native.session_scope', 'unauthorized');
    return facade.query('getSessionTodos');
  };
  return adapter;
}
