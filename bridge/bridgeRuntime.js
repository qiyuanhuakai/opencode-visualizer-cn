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
  const acpManager = options.acpManager ?? createAcpProcessManager({
    handleClientRequest: clientMethodHandler,
  });
  let started = false;
  let stopPromise;
  let acceptingMutations = false;
  let mutations = Promise.resolve();

  async function start() {
    if (started) return getStatus();
    if (stopPromise) throw new Error('Bridge runtime is shutting down.');
    started = true;
    try {
      const config = await configStore.load();
      await Promise.all([
        nativeSupervisor.start(),
        acpManager.reconcile(config.acpAgents),
      ]);
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

  async function listAgents() {
    if (!started) await start();
    return acpManager.getStatus();
  }

  async function reconcileConfig(config) {
    await acpManager.reconcile(config.acpAgents);
    return acpManager.getStatus();
  }

  function enqueueMutation(operation) {
    if (!acceptingMutations) {
      return Promise.reject(new Error('Bridge runtime is shutting down.'));
    }
    const result = mutations.then(operation);
    mutations = result.then(() => undefined, () => undefined);
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
    if (!acceptingMutations) throw new Error('Bridge runtime is shutting down.');
    acpManager.attach(id, client);
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (!started) return undefined;
    started = false;
    acceptingMutations = false;
    stopPromise = mutations
      .then(async () => {
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
      .then(() => undefined);
    await stopPromise;
    stopPromise = undefined;
    return undefined;
  }

  return {
    start,
    stop,
    getStatus,
    getConfig,
    listAgents,
    upsertAgent,
    updateAgent,
    removeAgent,
    attachAgent,
  };
}
