import { createNativeServiceDefinitions } from '../processSupervisor.js';
import { createKimiWebTokenProvider } from '../kimiWebToken.js';
import { createOpenCodeDriver } from './drivers/openCodeDriver.js';
import { createCodexDriver } from './drivers/codexDriver.js';
import { createAcpDriver } from './drivers/acpDriver.js';
import { createKimiWebDriver } from './drivers/kimiWebDriver.js';
import { createDshDriver } from './drivers/dshDriver.js';
import { CORE_OPERATIONS, createHarnessRegistry, unsupported, validateHarnessRegistration } from '../../shared/runtime/harnessContract.js';
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { createResourceOwnership } from './resourceOwnership.js';

export function unavailableRegistration(identity, state) {
  return validateHarnessRegistration({
    manifest: { ...identity, protocolVersion: 1, core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map(name => [name, name === 'inspect' ? { state: 'supported' } : unsupported(state)])), extensions: [], capabilities: {} },
    driver: { core: { inspect: () => ({ state, protocolVersion: 1 }) }, native: {} },
  });
}
export function createRuntimeDriverFactories(options) {
  const definitions = createNativeServiceDefinitions();
  const token = createKimiWebTokenProvider();
  const resources = createResourceOwnership();
  const runtime = { ...options.runtime, resources };
  const firstRoot = options.workspace.workspaces[0];
  const slots = new Map();
  let registry = createHarnessRegistry();
  let active = true;
  function replace(key, registration) {
    slots.get(key).registration = registration;
    const next = createHarnessRegistry();
    for (const slot of slots.values()) next.register(slot.registration);
    registry = next;
  }
  function endpoint(kind) {
    const definition = definitions.find(item => item.id === kind);
    requireValue(definition?.probe.type === 'http', 'factory.endpoint', 'unsupported');
    return new URL(definition.probe.url).origin;
  }
  function status(kind) { return options.nativeSupervisor.getStatus().find(item => item.id === kind); }
  const descriptions = ['opencode', 'codex', 'kimi-web', 'dsh'].map(kind => ({ kind, key: kind, enabled: options.config.nativeServices?.[kind] === true }));
  const agents = options.config.acpAgents;
  descriptions.push(...(agents.length ? agents.map(agent => ({ kind: 'acp', key: 'acp:' + agent.id, enabled: agent.enabled, agent })) : [{ kind: 'acp', key: 'acp:unconfigured', enabled: false }]));
  for (const item of descriptions) {
    const identity = { environmentId: options.environmentId, harnessInstanceId: options.registrations.get(item.key), kind: item.kind };
    const authority = { epoch: options.epoch, processGeneration: 1 };
    slots.set(item.key, { ...item, identity, authority, isCurrent: () => true, registration: unavailableRegistration(identity, item.enabled ? 'starting' : 'disabled'), close: async () => {} });
  }
  for (const slot of slots.values()) registry.register(slot.registration);
  async function defaultFactory(slot, context) {
    const { identity } = slot;
    const common = { environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, store: options.store, epoch: options.epoch };
    const current = () => active && options.isCurrent() && slot.isCurrent();
    switch (slot.kind) {
      case 'opencode':
        return createOpenCodeDriver({ ...common, processGeneration: slot.authority.processGeneration, currentProcess: () => { requireValue(current(), 'factory.closed', 'reconcile_required'); return slot.authority; }, endpoint: endpoint(slot.kind), runtime });
      case 'codex':
        requireValue(firstRoot, 'factory.workspace', 'unsupported');
        return createCodexDriver({ ...common, processGeneration: slot.authority.processGeneration, runtime, workspace: options.workspace, allowedWorkspaces: options.workspace.workspaces.map(root => root.key), process: { cwd: firstRoot.root }, isProcessCurrent: current });
      case 'kimi-web':
        return createKimiWebDriver({ ...common, endpoint: endpoint(slot.kind), ownership: 'borrowed', getAuthorization: token.getAuthorization, getAuthority: () => { requireValue(current(), 'factory.closed', 'reconcile_required'); return slot.authority; }, authorizeWorkspace: input => options.authorizeDirectory(input.directory) });
      case 'dsh': {
        const auth = options.nativeSupervisor.getDshAuthProvider?.();
        requireValue(auth, 'factory.dsh_auth', 'unsupported');
        return createDshDriver({ ...common, auth, onEvent: context.onEvent, getOwnedEndpoint: () => {
          const item = status('dsh');
          return item && { state: current() && item.state === 'running' && item.owned ? 'ready' : item.state === 'disabled' ? 'disabled' : 'failed', origin: endpoint('dsh'), nativeVersion: item.version, ownership: item.owned ? 'owned' : 'borrowed', generation: slot.authority.processGeneration };
        } });
      }
      case 'acp': {
        requireValue(firstRoot && slot.agent, 'factory.workspace', 'unsupported');
        const connection = options.workspace.connect({ target: options.environmentId, epoch: options.epoch, generation: 1, subscriberId: 'native:' + identity.harnessInstanceId, assertCurrent: () => requireValue(current(), 'factory.closed', 'reconcile_required') });
        try {
          const native = await createAcpDriver({ ...common, target: options.environmentId, manager: options.acpManager, agentId: slot.agent.id, workspace: connection, workspaceKey: firstRoot.key, cwd: firstRoot.root });
          slot.authority = { epoch: native.binding.epoch, processGeneration: native.binding.processGeneration };
          return { ...native, close: async () => { await native.close(); await connection.disconnect(); } };
        } catch (error) { await connection.disconnect(); throw error; }
      }
      default: throw new ProtocolError('unsupported', 'factory.kind');
    }
  }
  return {
    registry: { register(input) {
      const slot = [...slots.values()].find(item => item.identity.harnessInstanceId === input.manifest.harnessInstanceId);
      requireValue(slot && slot.kind === 'dsh', 'factory.registration', 'conflict');
      replace(slot.key, validateHarnessRegistration(input)); return slot.registration.manifest;
    }, list: () => registry.list(), invoke: input => registry.invoke(input) },
    authority(harnessInstanceId) {
      const slot = [...slots.values()].find(item => item.identity.harnessInstanceId === harnessInstanceId);
      requireValue(active && slot && options.isCurrent() && slot.isCurrent(), 'factory.authority', 'reconcile_required');
      return { ...slot.authority };
    },
    async start(index) {
      await Promise.all([...slots.values()].map(async slot => {
        if (!slot.enabled) return;
        const factory = options.factories?.[slot.key] ?? options.factories?.[slot.kind];
        try {
          if (!factory && slot.kind !== 'codex' && slot.kind !== 'acp') {
            const item = status(slot.kind);
            requireValue(item && ['running', 'adopted'].includes(item.state), 'factory.unavailable', 'source_unavailable');
            const captured = { pid: item.pid, owned: item.owned };
            slot.isCurrent = () => { const next = status(slot.kind); return next && ['running', 'adopted'].includes(next.state) && next.pid === captured.pid && next.owned === captured.owned; };
          }
          const create = async ({ onEvent } = {}) => {
            const context = { ...slot.identity, epoch: options.epoch, store: options.store, workspace: options.workspace, runtime, authority: () => ({ ...slot.authority }), onEvent };
            const native = await (factory ? factory(context) : defaultFactory(slot, context));
            requireValue(active, 'factory.closed', 'cancelled');
            slot.close = () => native.close();
            if (native.authority) slot.authority = native.authority();
            const registration = native.registration ?? { manifest: native.manifest, driver: native.driver };
            requireValue(registration.manifest.harnessInstanceId === slot.identity.harnessInstanceId && registration.manifest.environmentId === options.environmentId, 'factory.identity', 'unauthorized');
            if (slot.kind !== 'dsh') replace(slot.key, validateHarnessRegistration(registration));
            return { ...registration, close: slot.close };
          };
          if (slot.kind === 'dsh') {
            const { source } = await index.createDshSource({ create, authority: () => slot.authority });
            await source.discover();
          } else {
            await create();
            const source = await index.attach({ harnessInstanceId: slot.identity.harnessInstanceId, authority: () => slot.authority });
            await source.discover();
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await slot.close();
          replace(slot.key, unavailableRegistration(slot.identity, error.code === 'ENOENT' ? 'missing' : error.code === 'unauthorized' ? 'auth-required' : 'failed'));
        }
      }));
    },
    async close() {
      active = false;
      const results = await Promise.allSettled([...slots.values()].map(slot => slot.close()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      try { await resources.release(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Runtime driver shutdown failed');
    },
  };
}

