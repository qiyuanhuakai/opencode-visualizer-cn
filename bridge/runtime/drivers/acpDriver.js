import { createAcpRpc } from './acpRpc.js';
import {
  inspectCapabilities,
  record,
  text,
  serialQueue,
} from '../../../shared/runtime/native/acp/capabilities.js';
import { createAcpMutations } from './acpMutations.js';
import { createAcpSubscriptions } from '../../../shared/runtime/native/acp/subscriptions.js';
import { createAcpExtensions } from './acpExtensions.js';
import { createAcpSessions } from './acpSessions.js';
import { createAcpInteractions } from './acpInteractions.js';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseInstanceId,
} from '../../../shared/runtime/identity.js';
import {
  validateHarnessRegistration,
  CORE_OPERATIONS,
} from '../../../shared/runtime/harnessContract.js';
import { BRIDGE_CLIENT_METHODS } from '../../acpProcessState.js';
import { StoreError } from '../storage/storeProtocol.js';

export async function createAcpDriver(options) {
  const target = parseEnvironmentId(options.target);
  const harnessInstanceId = parseHarnessInstanceId(options.harnessInstanceId);
  const epoch = parseInstanceId(options.epoch);
  const inspection = await options.store.ready;
  if (inspection.environment !== target || inspection.epoch !== epoch)
    throw new StoreError('conflict', 'store_target');
  let sessions, interactions, mutations, reverse, subscriptions;
  let exitWork = Promise.resolve();
  let lifecycleError;
  const active = new Map();
  const authTerminals = new Set();
  async function closeAuthTerminals() {
    const results = await Promise.allSettled(
      [...authTerminals].map(async (terminal) => {
        await terminal.close();
        authTerminals.delete(terminal);
      }),
    );
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'ACP auth terminal cleanup failed');
  }
  const rpc = createAcpRpc({
    manager: options.manager,
    agentId: text(options.agentId),
    onRequest: async (message) => {
      if (message.method === 'session/request_permission') return interactions.receive(message);
      if (!BRIDGE_CLIENT_METHODS.has(message.method))
        throw new StoreError('unsupported', 'native_client_method');
      const result = await reverse.handle(message);
      rpc.reply(message.id, result);
    },
    onNotification: (message) => {
      if (message.method === 'session/update') sessions?.update(message.params);
      else subscriptions?.emit({ type: 'native.extension', method: text(message.method) });
    },
    onOutgoing: (message) => {
      if (message.method)
        reverse?.observeClientMessage(
          message.method === 'session/fork' ? { ...message, method: 'session/new' } : message,
        );
    },
    onResult: (message) => reverse?.observeAgentMessage(message),
    onExit: () => {
      subscriptions?.emit({ type: 'process.invalidated' });
      exitWork = Promise.all([mutations?.close(), reverse?.close(), closeAuthTerminals()]).catch(
        (error) => {
          lifecycleError = error;
        },
      );
    },
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
  async function close() {
    await rpc.close();
    await exitWork;
    await closeAuthTerminals();
    subscriptions?.close();
    if (lifecycleError) throw lifecycleError;
  }
  try {
    mutations = await createAcpMutations({
      store: options.store,
      target,
      harnessInstanceId,
      epoch,
      processGeneration: rpc.processGeneration,
      assertCurrent: rpc.assertCurrent,
    });
    subscriptions = createAcpSubscriptions(mutations.binding);
    reverse = options.workspace.reverse.register({
      workspaceKey: options.workspaceKey,
      harnessInstanceId,
      processGeneration: rpc.processGeneration,
      agentId: options.agentId,
      assertProcessCurrent: rpc.assertCurrent,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    });
    const capabilities = inspectCapabilities(
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'vis-runtime', version: '0.9.0' },
      }),
    );
    const queue = serialQueue(() => capabilities.concurrent, rpc.assertCurrent);
    sessions = createAcpSessions({
      rpc,
      mutations,
      capabilities,
      queue,
      cwd: options.cwd,
      emit: subscriptions.emit,
    });
    interactions = createAcpInteractions({
      store: options.store,
      mutations,
      rpc,
      active,
      emit: subscriptions.emit,
      sessionFor: sessions.sessionFor,
    });
    const fence = (context) => {
      record(context);
      if (context.environmentId !== target || context.harnessInstanceId !== harnessInstanceId)
        throw new StoreError('conflict', 'scope_fence');
      const params = record(context.params);
      if (Object.hasOwn(params, 'session'))
        throw new StoreError('invalid_request', 'nested_session');
      if (params.epoch !== epoch || params.processGeneration !== rpc.processGeneration)
        throw new StoreError('reconcile_required', 'stale_generation');
      rpc.assertCurrent();
      if (context.session) mutations.scopeFor(context.session);
      return { ...params, ...(context.session ? { session: context.session } : {}) };
    };
    const requireSession = (input) => {
      if (!input.session) throw new StoreError('invalid_request', 'session_required');
      return sessions.requireSession(input.session);
    };
    const send = (input) => {
      const session = requireSession(input);
      if (!Array.isArray(input.prompt) || input.prompt.length === 0)
        throw new StoreError('invalid_request', 'prompt');
      return queue(() =>
        mutations.run(
          {
            session,
            idempotencyKey: input.idempotencyKey,
            method: 'session/prompt',
            payload: { sessionId: session.nativeSessionId, prompt: input.prompt },
          },
          async ({ operationId, payload }) => {
            active.set(session.nativeSessionId, operationId);
            subscriptions.emit({ type: 'operation.started', session, operationId });
            try {
              const result = await rpc.request('session/prompt', payload);
              await interactions.settled();
              await interactions.settleParent(operationId);
              return result;
            } finally {
              active.delete(session.nativeSessionId);
            }
          },
        ),
      ).then((result) => {
        subscriptions.emit({
          type: 'operation.terminal',
          session,
          operationId: result.operationId,
          result: result.result,
        });
        return result;
      });
    };
    const cancel = (input) => {
      const session = requireSession(input);
      const parent = text(input.operationId);
      return interactions.track(
        mutations.run(
          {
            session,
            parent,
            idempotencyKey: input.idempotencyKey,
            method: 'session/cancel',
            payload: { sessionId: session.nativeSessionId },
          },
          ({ payload }) => rpc.notify('session/cancel', payload),
        ),
      );
    };
    const operations = {
      inspect: () => ({ state: rpc.active ? 'ready' : 'failed', protocolVersion: 1 }),
      listSessionPage: sessions.list,
      getSession: (input) => sessions.get(requireSession(input)),
      readHistoryPage: (input) => {
        requireSession(input);
        return sessions.history(input);
      },
      createSession: sessions.create,
      send,
      cancel,
      respondInteraction: (input) => {
        requireSession(input);
        return interactions.respond(input);
      },
      subscribe: (input) => subscriptions.subscribe(input),
      close,
    };
    const core = Object.fromEntries(
      Object.entries(operations).map(([name, action]) => [
        name,
        (context) => action(fence(context)),
      ]),
    );
    const extensions = createAcpExtensions({
      capabilities,
      rpc,
      mutations,
      sessions,
      interactions,
      queue,
      send,
      active,
      cwd: options.cwd,
      agentId: options.agentId,
      ...(options.createAuthTerminal
        ? {
            createAuthTerminal: async (method) => {
              rpc.assertCurrent();
              const terminal = await options.createAuthTerminal({
                binding: mutations.binding,
                method,
              });
              authTerminals.add(terminal);
              try {
                rpc.assertCurrent();
                return { terminalId: text(terminal.terminalId) };
              } catch (error) {
                await terminal.close();
                authTerminals.delete(terminal);
                throw error;
              }
            },
          }
        : {}),
    });
    const native = Object.fromEntries(
      Object.entries(extensions.methods).map(([name, action]) => [
        name,
        (context) => action(fence(context)),
      ]),
    );
    const supported = { state: 'supported' };
    const registration = validateHarnessRegistration({
      manifest: {
        environmentId: target,
        harnessInstanceId,
        kind: 'acp',
        protocolVersion: 1,
        core: Object.fromEntries(Object.keys(CORE_OPERATIONS).map((name) => [name, supported])),
        extensions: extensions.declarations.map((item) => ({
          ...item,
          owner: harnessInstanceId,
          permission: 'acp.native',
          schemaVersion: 1,
        })),
        capabilities: {
          sessions: supported,
          permissions: supported,
          questions: {
            state: 'unsupported',
            code: 'unsupported',
            reason: 'ACP has no declared question protocol',
          },
        },
      },
      driver: { core, native },
    });
    return { ...registration, binding: mutations.binding, capabilities, pid: rpc.pid, close };
  } catch (error) {
    await close();
    throw error;
  }
}
