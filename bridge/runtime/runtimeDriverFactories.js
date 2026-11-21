import { randomUUID } from 'node:crypto';
import { createWriterAcpHarness } from './writerAcpHarness.js';
import { loadRuntimeRegistrations } from './runtimeRegistrations.js';
import { createNativeServiceDefinitions } from '../processSupervisor.js';
import { createKimiWebTokenProvider } from '../kimiWebToken.js';
import { createOpenCodeDriver } from './drivers/openCodeDriver.js';
import { createCodexDriver } from './drivers/codexDriver.js';
import { createAcpDriver } from './drivers/acpDriver.js';
import { createKimiWebDriver } from './drivers/kimiWebDriver.js';
import { createDshDriver } from './drivers/dshDriver.js';
import {
  CORE_OPERATIONS,
  createHarnessRegistry,
  unsupported,
  validateHarnessRegistration,
} from '../../shared/runtime/harnessContract.js';
import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { createResourceOwnership } from './resourceOwnership.js';

export function unavailableRegistration(identity, state, reason = state) {
  return validateHarnessRegistration({
    manifest: {
      ...identity,
      protocolVersion: 1,
      core: Object.fromEntries(
        Object.keys(CORE_OPERATIONS).map((name) => [
          name,
          name === 'inspect' ? { state: 'supported' } : unsupported(reason),
        ]),
      ),
      extensions: [],
      capabilities: {},
    },
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
  let sessionIndex;
  const pendingStarts = new Set();
  const initializations = new Map();
  function replace(key, registration) {
    slots.get(key).registration = registration;
    const next = createHarnessRegistry();
    for (const slot of slots.values()) next.register(slot.registration);
    registry = next;
  }
  function endpoint(kind) {
    const definition = definitions.find((item) => item.id === kind);
    requireValue(definition?.probe.type === 'http', 'factory.endpoint', 'unsupported');
    return new URL(definition.probe.url).origin;
  }
  function status(kind) {
    return options.nativeSupervisor.getStatus().find((item) => item.id === kind);
  }
  const descriptions = ['opencode', 'codex', 'kimi-web', 'dsh'].map((kind) => ({
    kind,
    key: kind,
    enabled: options.config.nativeServices?.[kind] === true,
  }));
  const agents = options.config.acpAgents;
  descriptions.push(
    ...(agents.length
      ? agents.map((agent) => ({
          kind: 'acp',
          key: 'acp:' + agent.id,
          enabled: agent.enabled,
          agent,
        }))
      : [{ kind: 'acp', key: 'acp:unconfigured', enabled: false }]),
  );
  for (const item of descriptions) {
    const identity = {
      environmentId: options.environmentId,
      harnessInstanceId: options.registrations.get(item.key),
      kind: item.kind,
    };
    const authority = { epoch: options.epoch, processGeneration: 1 };
    slots.set(item.key, {
      ...item,
      identity,
      authority,
      isCurrent: () => true,
      registration: item.enabled && options.config.agentStartup === 'on-demand'
        ? unavailableRegistration(identity, 'supported', 'on-demand')
        : unavailableRegistration(identity, item.enabled ? 'starting' : 'disabled'),
      close: async () => {},
    });
  }
  for (const slot of slots.values()) registry.register(slot.registration);
  async function defaultFactory(slot, context) {
    const { identity } = slot;
    const common = {
      environmentId: identity.environmentId,
      harnessInstanceId: identity.harnessInstanceId,
      store: options.store,
      epoch: options.epoch,
    };
    const current = () => active && options.isCurrent() && slot.isCurrent();
    switch (slot.kind) {
      case 'opencode':
        return createOpenCodeDriver({
          ...common,
          processGeneration: slot.authority.processGeneration,
          currentProcess: () => {
            requireValue(current(), 'factory.closed', 'reconcile_required');
            return slot.authority;
          },
          endpoint: endpoint(slot.kind),
          runtime,
        });
      case 'codex':
        requireValue(firstRoot, 'factory.workspace', 'unsupported');
        return createCodexDriver({
          ...common,
          processGeneration: slot.authority.processGeneration,
          runtime,
          workspace: options.workspace,
          authorizeDirectory: options.authorizeDirectory,
          allowedWorkspaces: options.workspace.workspaces.map((root) => root.key),
          process: { cwd: firstRoot.root },
          isProcessCurrent: current,
        });
      case 'kimi-web':
        return createKimiWebDriver({
          ...common,
          endpoint: endpoint(slot.kind),
          ownership: 'borrowed',
          getAuthorization: token.getAuthorization,
          getAuthority: () => {
            requireValue(current(), 'factory.closed', 'reconcile_required');
            return slot.authority;
          },
          authorizeWorkspace: (input) => options.authorizeDirectory(input.directory),
        });
      case 'dsh': {
        const auth = options.nativeSupervisor.getDshAuthProvider?.();
        requireValue(auth, 'factory.dsh_auth', 'unsupported');
        return createDshDriver({
          ...common,
          auth,
          onEvent: context.onEvent,
          getOwnedEndpoint: () => {
            const item = status('dsh');
            return (
              item && {
                state:
                  current() && item.state === 'running' && item.owned
                    ? 'ready'
                    : item.state === 'disabled'
                      ? 'disabled'
                      : 'failed',
                origin: endpoint('dsh'),
                nativeVersion: item.version,
                ownership: item.owned ? 'owned' : 'borrowed',
                generation: slot.authority.processGeneration,
              }
            );
          },
        });
      }
      case 'acp': {
        requireValue(firstRoot && slot.agent, 'factory.workspace', 'unsupported');
        const connection = options.workspace.connect({
          target: options.environmentId,
          epoch: options.epoch,
          generation: 1,
          subscriberId: 'native:' + identity.harnessInstanceId,
          assertCurrent: () => requireValue(current(), 'factory.closed', 'reconcile_required'),
        });
        try {
          const native = await createAcpDriver({
            ...common,
            target: options.environmentId,
            manager: options.acpManager,
            agentId: slot.agent.id,
            workspace: connection,
            workspaceKey: firstRoot.key,
            cwd: firstRoot.root,
          });
          slot.authority = {
            epoch: native.binding.epoch,
            processGeneration: native.binding.processGeneration,
          };
          return {
            ...native,
            close: async () => {
              await native.close();
              await connection.disconnect();
            },
          };
        } catch (error) {
          await connection.disconnect();
          throw error;
        }
      }
      default:
        throw new ProtocolError('unsupported', 'factory.kind');
    }
  }
  const controller = {
    registry: {
      register(input) {
        const slot = [...slots.values()].find(
          (item) => item.identity.harnessInstanceId === input.manifest.harnessInstanceId,
        );
        requireValue(slot && slot.kind === 'dsh', 'factory.registration', 'conflict');
        replace(slot.key, validateHarnessRegistration(input));
        return slot.registration.manifest;
      },
      list: () => registry.list(),
      invoke: (input) => registry.invoke(input),
    },
    authority(harnessInstanceId) {
      const slot = [...slots.values()].find(
        (item) => item.identity.harnessInstanceId === harnessInstanceId,
      );
      requireValue(
        active && slot && options.isCurrent() && slot.isCurrent(),
        'factory.authority',
        'reconcile_required',
      );
      return { ...slot.authority };
    },
    async ensureWriterHarness({ sourceHarnessInstanceId, lease }) {
      requireValue(
        active && options.isCurrent() && lease.state === 'active' && lease.expiresAt > Date.now(),
        'factory.writer_lease',
        'conflict',
      );
      const source = [...slots.values()].find(
        (item) => item.identity.harnessInstanceId === sourceHarnessInstanceId,
      );
      requireValue(
        source?.kind === 'acp' && source.agent?.enabled,
        'factory.writer_source',
        'unsupported',
      );
      const key = `writer:${lease.leaseId}`;
      const prior = slots.get(key);
      if (prior) return prior.registration.manifest;
      const registrations = await loadRuntimeRegistrations(options.stateRoot, [key]);
      const identity = {
        environmentId: options.environmentId,
        harnessInstanceId: registrations.harnesses.get(key),
        kind: 'acp',
      };
      const slot = {
        key,
        identity,
        kind: 'acp',
        enabled: true,
        agent: source.agent,
        authority: { epoch: options.epoch, processGeneration: 1 },
        isCurrent: () => true,
        registration: unavailableRegistration(identity, 'starting'),
        close: async () => {},
      };
      slots.set(key, slot);
      try {
        const native = await createWriterAcpHarness({
          ...identity,
          epoch: options.epoch,
          store: options.store,
          agent: source.agent,
          lease,
        });
        slot.close = () => native.close();
        slot.authority = {
          epoch: native.binding.epoch,
          processGeneration: native.binding.processGeneration,
        };
        replace(
          key,
          validateHarnessRegistration({ manifest: native.manifest, driver: native.driver }),
        );
        const manifest = slot.registration.manifest;
        await options.store.mutate({
          intentId: randomUUID(),
          changes: [
            {
              collection: 'harnesses',
              key: manifest.harnessInstanceId,
              value: {
                environmentId: manifest.environmentId,
                harnessInstanceId: manifest.harnessInstanceId,
                kind: manifest.kind,
                manifest,
                writerLeaseId: lease.leaseId,
              },
            },
          ],
        });
        if (sessionIndex) {
          slot.source = await sessionIndex.attach({
            harnessInstanceId: identity.harnessInstanceId,
            authority: () => slot.authority,
          });
          await slot.source.discover();
        }
        options.onWriterHarness?.(manifest);
        return manifest;
      } catch (error) {
        await slot.source?.close();
        await slot.close();
        slots.delete(key);
        const next = createHarnessRegistry();
        for (const other of slots.values()) next.register(other.registration);
        registry = next;
        throw error;
      }
    },
    async refreshWriterHarness(harnessInstanceId) {
      const slot = [...slots.values()].find(
        (item) => item.identity.harnessInstanceId === harnessInstanceId,
      );
      requireValue(
        slot?.key.startsWith('writer:') && slot.source,
        'factory.writer_source',
        'source_unavailable',
      );
      return slot.source.discover();
    },
    async retry(harnessInstanceId) {
      const slot = [...slots.values()].find(item => item.identity.harnessInstanceId === harnessInstanceId);
      requireValue(active && sessionIndex && slot?.enabled, 'factory.retry_source', 'source_unavailable');
      await controller.start(sessionIndex, harnessInstanceId);
    },
    async start(index, harnessInstanceId) {
      requireValue(active, 'factory.closed', 'cancelled');
      sessionIndex = index;
      const work = Promise.all(
        [...slots.values()].filter(slot => harnessInstanceId === undefined || slot.identity.harnessInstanceId === harnessInstanceId).map(slot => {
          if (!slot.enabled || (harnessInstanceId === undefined && options.config.agentStartup === 'on-demand')) return;
          const prior = initializations.get(slot.identity.harnessInstanceId);
          if (prior) return prior;
          const initialization = (async () => {
            const factory = options.factories?.[slot.key] ?? options.factories?.[slot.kind];
            try {
              if (!factory && options.config.agentStartup === 'on-demand') await options.startRequestedAgent(slot.kind, slot.agent?.id);
              if (!factory && slot.kind !== 'codex' && slot.kind !== 'acp') {
                const item = status(slot.kind);
                requireValue(
                  item && ['running', 'adopted'].includes(item.state),
                  'factory.unavailable',
                  'source_unavailable',
                );
                const captured = { pid: item.pid, owned: item.owned };
                slot.isCurrent = () => {
                  const next = status(slot.kind);
                  return (
                    next &&
                    ['running', 'adopted'].includes(next.state) &&
                    next.pid === captured.pid &&
                    next.owned === captured.owned
                  );
                };
              }
              const create = async ({ onEvent } = {}) => {
                const context = {
                  ...slot.identity,
                  epoch: options.epoch,
                  store: options.store,
                  workspace: options.workspace,
                  runtime,
                  authority: () => ({ ...slot.authority }),
                  onEvent,
                };
                const native = await (factory ? factory(context) : defaultFactory(slot, context));
                slot.close = () => native.close();
                requireValue(active, 'factory.closed', 'cancelled');
                if (native.authority) slot.authority = native.authority();
                const registration = native.registration ?? {
                  manifest: native.manifest,
                  driver: native.driver,
                };
                requireValue(
                  registration.manifest.harnessInstanceId === slot.identity.harnessInstanceId &&
                    registration.manifest.environmentId === options.environmentId,
                  'factory.identity',
                  'unauthorized',
                );
                if (slot.kind !== 'dsh') replace(slot.key, validateHarnessRegistration(registration));
                await options.onHarnessReady?.(registration.manifest);
                return { ...registration, close: slot.close };
              };
              if (slot.kind === 'dsh') {
                const { source } = await index.createDshSource({
                  create,
                  authority: () => slot.authority,
                });
                slot.source = source;
                await source.discover();
              } else {
                await create();
                const source = await index.attach({
                  harnessInstanceId: slot.identity.harnessInstanceId,
                  authority: () => slot.authority,
                });
                slot.source = source;
                await source.discover();
              }
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              await slot.source?.close();
              slot.source = undefined;
              await slot.close();
              slot.close = async () => {};
              replace(
                slot.key,
                unavailableRegistration(
                  slot.identity,
                  error.code === 'ENOENT'
                    ? 'missing'
                    : error.code === 'unauthorized'
                      ? 'auth-required'
                      : 'failed',
                  options.config.agentStartup === 'on-demand' ? 'on-demand' : undefined,
                ),
              );
              const manifest = registry.list().find(item => item.harnessInstanceId === slot.identity.harnessInstanceId);
              if (manifest) await options.onHarnessReady?.(manifest);
            }
          })();
          initializations.set(slot.identity.harnessInstanceId, initialization);
          const retire = () => initializations.delete(slot.identity.harnessInstanceId);
          void initialization.then(retire, retire);
          return initialization;
        }),
      );
      pendingStarts.add(work);
      try { await work; } finally { pendingStarts.delete(work); }
    },
    async close() {
      active = false;
      await Promise.allSettled(pendingStarts);
      const results = await Promise.allSettled([...slots.values()].map((slot) => slot.close()));
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      try {
        await resources.release();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, 'Runtime driver shutdown failed');
    },
  };
  return controller;
}
