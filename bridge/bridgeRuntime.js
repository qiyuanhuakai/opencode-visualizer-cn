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

  async function start() {
    if (started) return getStatus();
    started = true;
    const config = await configStore.load();
    await Promise.all([
      nativeSupervisor.start(),
      acpManager.reconcile(config.acpAgents),
    ]);
    return getStatus();
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

  async function upsertAgent(input) {
    if (!isRecord(input)) throw new Error('ACP agent payload must be an object.');
    const config = await configStore.upsertAgent(input);
    await reconcileConfig(config);
    return acpManager.getStatus().find((agent) => agent.id === input.id);
  }

  async function updateAgent(id, patch) {
    if (!isRecord(patch)) throw new Error('ACP agent patch must be an object.');
    const config = await configStore.getConfig();
    const current = config.acpAgents.find((agent) => agent.id === id);
    if (!current) return undefined;
    return upsertAgent({ ...current, ...patch, id });
  }

  async function removeAgent(id) {
    const config = await configStore.getConfig();
    if (!config.acpAgents.some((agent) => agent.id === id)) return false;
    const next = await configStore.removeAgent(id);
    await reconcileConfig(next);
    return true;
  }

  function attachAgent(id, client) {
    acpManager.attach(id, client);
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (!started) return undefined;
    started = false;
    stopPromise = Promise.all([
      nativeSupervisor.stop(),
      acpManager.stopAll(),
      clientMethodHandler.stopAll(),
    ]).then(() => undefined);
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
