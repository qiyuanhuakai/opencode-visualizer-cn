import path from 'node:path';
import { ProtocolError } from '../shared/runtime/protocol.js';
import { createRuntimeHost } from './runtime/runtimeHost.js';
import { loadEnvironmentIdentity } from './runtime/environmentIdentity.js';
import { createAcpProcessManager } from './acpProcessManager.js';
import { createAcpClientMethodHandler } from './acpClientMethodHandler.js';
import { createBridgeConfigStore } from './bridgeConfig.js';
import { createProcessSupervisor } from './processSupervisor.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createBridgeRuntime(options = {}) {
  const configStore = options.configStore ?? createBridgeConfigStore();
  const nativeSupervisor = options.nativeSupervisor ?? createProcessSupervisor();
  const clientMethodHandler = options.clientMethodHandler ?? createAcpClientMethodHandler();
  const acpManager =
    options.acpManager ??
    createAcpProcessManager({
      handleClientRequest: clientMethodHandler,
    });
  let hostPromise;
  let sourceStart;
  let nativeStart;
  let acpStart;
  let host;
  let closing = false;
  let started = false;

  function startSources() {
    sourceStart ??= configStore.load();
    return sourceStart;
  }

  function startNative() {
    nativeStart ??= startSources().then((config) => nativeSupervisor.start(config.nativeServices));
    return nativeStart;
  }
  function startAcp() {
    acpStart ??= startSources().then((config) => acpManager.reconcile(config.acpAgents));
    return acpStart;
  }
  function getRuntimeHost() {
    if (closing) return Promise.reject(new Error('Bridge runtime is shutting down.'));
    hostPromise ??= (async () => {
      const environmentId =
        options.environmentId ??
        (await loadEnvironmentIdentity(options.stateRoot ?? path.dirname(configStore.configPath)));
      if (closing) throw new Error('Bridge runtime is shutting down.');
      host = createRuntimeHost({
        environmentId,
        role: options.role ?? 'local',
        sources:
          options.role === 'manager'
            ? []
            : [
                { id: 'native', start: startNative, stop: () => nativeSupervisor.stop() },
                { id: 'acp', start: startAcp, stop: () => acpManager.stopAll() },
              ],
      });
      host.resources.register('reverse', 'owned', () => clientMethodHandler.stopAll());
      host.start();
      return host;
    })();
    return hostPromise;
  }

  let stopPromise;
  let acceptingMutations = false;
  let mutations = Promise.resolve();

  async function start() {
    if (stopPromise) throw new Error('Bridge runtime is shutting down.');
    if (started && !acceptingMutations) await stop();
    if (started) return getStatus();
    closing = false;
    started = true;
    try {
      if (hostPromise) {
        const host = await hostPromise;
        await host.sourcesReady;
        if (host.startupFailures.length) throw host.startupFailures[0];
      } else {
        if (options.role !== 'manager') await Promise.all([startNative(), startAcp()]);
      }
      acceptingMutations = true;
      return getStatus();
    } catch (error) {
      acceptingMutations = false;
      throw error;
    }
  }

  function getStatus() {
    return {
      services: nativeSupervisor.getStatus(),
      acpAgents: acpManager.getStatus(),
    };
  }

  async function getConfig() {
    return configStore.getConfig();
  }

  // The dsh session cookie lives behind the supervisor (only its spawned dsh
  // child prints the launch token); optional because supervisor stubs in tests
  // may not implement the accessor.
  function getDshAuthProvider() {
    return nativeSupervisor.getDshAuthProvider?.();
  }

  async function listAgents() {
    if (!started) await start();
    return acpManager.getStatus();
  }

  async function reconcileConfig(config) {
    await acpManager.reconcile(config.acpAgents);
    return acpManager.getStatus();
  }

  function enqueueMutation(operation) {
    if (options.role === 'manager')
      return Promise.reject(new ProtocolError('unsupported', 'manager.execution'));
    if (!acceptingMutations) {
      return Promise.reject(new Error('Bridge runtime is shutting down.'));
    }
    const result = mutations.then(operation);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function upsertAgentNow(input) {
    if (!isRecord(input)) throw new Error('ACP agent payload must be an object.');
    const config = await configStore.upsertAgent(input);
    await reconcileConfig(config);
    return acpManager.getStatus().find((agent) => agent.id === input.id);
  }

  function upsertAgent(input) {
    return enqueueMutation(() => upsertAgentNow(input));
  }

  function updateAgent(id, patch) {
    return enqueueMutation(async () => {
      if (!isRecord(patch)) throw new Error('ACP agent patch must be an object.');
      const config = await configStore.getConfig();
      const current = config.acpAgents.find((agent) => agent.id === id);
      if (!current) return undefined;
      return upsertAgentNow({ ...current, ...patch, id });
    });
  }

  function removeAgent(id) {
    return enqueueMutation(async () => {
      const config = await configStore.getConfig();
      if (!config.acpAgents.some((agent) => agent.id === id)) return false;
      const next = await configStore.removeAgent(id);
      await reconcileConfig(next);
      return true;
    });
  }

  function attachAgent(id, client) {
    if (options.role === 'manager') throw new ProtocolError('unsupported', 'manager.execution');
    if (!acceptingMutations) throw new Error('Bridge runtime is shutting down.');
    acpManager.attach(id, client);
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (!started && !hostPromise) return undefined;
    acceptingMutations = false;
    closing = true;
    host?.closeAdmission();
    stopPromise = mutations
      .then(async () => {
        if (hostPromise) {
          const [initialization] = await Promise.allSettled([hostPromise]);
          if (initialization.status === 'fulfilled') {
            await initialization.value.stop();
            return;
          }
        }
        await Promise.allSettled([nativeStart, acpStart]);
        const supervisorResults = await Promise.allSettled([
          nativeSupervisor.stop(),
          acpManager.stopAll(),
        ]);
        const reverseResourceResults = await Promise.allSettled([clientMethodHandler.stopAll()]);
        const failure = [...supervisorResults, ...reverseResourceResults].find(
          (result) => result.status === 'rejected',
        );
        if (failure?.status === 'rejected') throw failure.reason;
      })
      .then(() => {
        started = false;
        hostPromise = undefined;
        host = undefined;
        sourceStart = undefined;
        nativeStart = undefined;
        acpStart = undefined;
      });
    try {
      await stopPromise;
    } finally {
      stopPromise = undefined;
    }
    return undefined;
  }

  return {
    start,
    stop,
    getStatus,
    getRuntimeHost,
    getConfig,
    getDshAuthProvider,
    listAgents,
    upsertAgent,
    updateAgent,
    removeAgent,
    attachAgent,
  };
}
