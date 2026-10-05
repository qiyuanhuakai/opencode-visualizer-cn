import { randomUUID } from 'node:crypto';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';
import { ProtocolError, validateFrame } from '../../shared/runtime/protocol.js';
import { createConnectionScope } from './connectionScope.js';
import { createResourceOwnership } from './resourceOwnership.js';

export function createRuntimeHost({ environmentId, role, sources = [], cachedTopology = [] }) {
  const target = parseEnvironmentId(environmentId);
  if (!['local', 'manager', 'execution'].includes(role))
    throw new ProtocolError('invalid_request', 'role');
  if (role === 'manager' && sources.length)
    throw new ProtocolError('invalid_request', 'manager.sources');
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    throw new ProtocolError('conflict', 'source.id');
  const instanceId = randomUUID();
  const epoch = randomUUID();
  const connections = createConnectionScope();
  const resources = createResourceOwnership();
  const states = sources.map(({ id }) => ({ id, state: 'starting' }));
  let state = 'idle';
  let sourcesReady = Promise.resolve();
  let mutations = Promise.resolve();
  let stopPromise;
  const startupFailures = [];
  const startupController = new AbortController();
  function inspect() {
    return {
      role,
      state,
      subscribers: connections.size,
      topology: structuredClone(cachedTopology),
      sources: states.map((source) => ({ ...source })),
    };
  }
  function start() {
    if (state === 'ready') return;
    if (state !== 'idle') throw new ProtocolError('cancelled', 'runtime.stopped');
    state = 'ready';
    sourcesReady = Promise.all(
      sources.map(async (source, index) => {
        resources.register(source.id, source.ownership ?? 'owned', source.stop);
        try {
          await source.start({ signal: startupController.signal });
          if (state === 'ready') states[index].state = 'ready';
        } catch (error) {
          startupFailures.push(error);
          if (state === 'ready') states[index].state = 'failed';
        }
      }),
    ).then(() => undefined);
  }
  function connect(id) {
    if (state !== 'ready') throw new ProtocolError('cancelled', 'runtime.closed');
    const scope = connections.connect(id);
    return {
      ...scope,
      hello() {
        scope.assertCurrent();
        return validateFrame({
          version: 1,
          kind: 'hello',
          target,
          epoch,
          instanceId,
          generation: scope.generation,
          capabilities: { methods: ['runtime.inspect'], extensions: [] },
        });
      },
      inspect() {
        scope.assertCurrent();
        return inspect();
      },
    };
  }
  function mutate(operation) {
    if (state !== 'ready') return Promise.reject(new ProtocolError('cancelled', 'runtime.closed'));
    const result = mutations.then(operation);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function closeAdmission() {
    if (state !== 'stopped') state = 'stopping';
    startupController.abort();
    connections.close();
  }
  function stop() {
    if (stopPromise) return stopPromise;
    closeAdmission();
    stopPromise = (async () => {
      await mutations;
      await sourcesReady;
      try {
        await resources.release();
      } finally {
        state = 'stopped';
      }
    })();
    return stopPromise;
  }
  return {
    start,
    stop,
    closeAdmission,
    connect,
    inspect,
    mutate,
    resources,
    get sourcesReady() {
      return sourcesReady;
    },
    get startupFailures() {
      return [...startupFailures];
    },
  };
}
