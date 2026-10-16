import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  parseSessionRef,
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseInstanceId,
} from '../../../shared/runtime/identity.js';
import { requireValue } from '../../../shared/runtime/capabilities.js';
import { validateHarnessRegistration } from '../../../shared/runtime/harnessContract.js';
import { createAppServerClient } from '../../../shared/runtime/native/codex/appServerClient.js';
import { createCodexDiscovery } from '../../../shared/runtime/native/codex/discovery.js';
import { createCodexSubscriptions } from '../../../shared/runtime/native/codex/subscriptions.js';
import {
  createPrivacy,
  fields,
  nativeArguments,
} from '../../../shared/runtime/native/codex/boundaries.js';
import { createCodexSessionOperations } from '../../../shared/runtime/native/codex/sessionOperations.js';
import { createInstanceOperations } from '../../../shared/runtime/native/codex/instanceOperations.js';
import { createCodexControls } from '../../../shared/runtime/native/codex/controlOperations.js';
import { createCodexEvents } from '../../../shared/runtime/native/codex/events.js';
import { createCodexNativeOperations } from '../../../shared/runtime/native/codex/nativeOperations.js';
import { createCodexCatalog } from '../../../shared/runtime/native/codex/catalog.js';
import { CODEX_PROFILE, codexManifest } from '../../../shared/runtime/native/codex/capabilities.js';
import { createOperationJournal, fingerprint } from '../operationJournal.js';
import { createInteractionStore } from '../interactionStore.js';
import { createCodexHistory } from './codexHistory.js';
import { createCodexProcess } from './codexProcess.js';

export async function createCodexDriver(options) {
  const scope = Object.freeze({
    environmentId: parseEnvironmentId(options.environmentId),
    harnessInstanceId: parseHarnessInstanceId(options.harnessInstanceId),
  });
  const epoch = parseInstanceId(options.epoch),
    processGeneration = options.processGeneration;
  requireValue(
    Number.isSafeInteger(processGeneration) && processGeneration > 0,
    'codex.processGeneration',
  );
  const trusted = await options.store.ready;
  requireValue(trusted.environment === scope.environmentId, 'codex.store_target', 'unauthorized');
  const transport = options.transport ?? createCodexProcess(options.process ?? {});
  let alive = true,
    closing,
    events,
    sessions;
  const subscriptions = createCodexSubscriptions();
  const privacy = createPrivacy(options.credentialValues ?? []);
  function assertCurrent() {
    requireValue(
      alive && options.isProcessCurrent({ ...scope, epoch, processGeneration }),
      'codex.generation',
      'reconcile_required',
    );
  }
  function sessionFor(id) {
    return parseSessionRef({ ...scope, nativeSessionId: id });
  }
  function validateContext(context, sessionRequired = false) {
    assertCurrent();
    requireValue(
      context?.environmentId === scope.environmentId &&
        context.harnessInstanceId === scope.harnessInstanceId,
      'codex.target',
      'unauthorized',
    );
    requireValue(!sessionRequired || context.session, 'codex.session');
    if (context.session) {
      const session = parseSessionRef(context.session);
      requireValue(
        session.environmentId === scope.environmentId &&
          session.harnessInstanceId === scope.harnessInstanceId,
        'codex.session.target',
        'unauthorized',
      );
    }
  }
  const scopeFor = (session) => {
    validateContext({ ...scope, session }, true);
    return { target: scope.environmentId, epoch, processGeneration, session };
  };
  function emit(event) {
    subscriptions.emit({ ...event, epoch, processGeneration, payload: privacy(event.payload) });
  }
  const client = createAppServerClient({
    transport,
    onMessage: (message) => events.onMessage(message),
    onFailure() {
      if (alive) {
        emit({ type: 'source.reconciling', payload: { code: 'source_unavailable' } });
        void close().catch((error) => {
          options.onError?.(error);
        });
      }
    },
  });
  async function request(method, params) {
    assertCurrent();
    const result = await client.request(method, params);
    assertCurrent();
    return privacy(result);
  }
  const workspace = options.workspace.connect({
    target: scope.environmentId,
    epoch,
    generation: processGeneration,
    subscriberId: `codex:${scope.harnessInstanceId}`,
    assertCurrent,
  });
  async function authorizeCwd(cwd, workspaceKey) {
    assertCurrent();
    const canonical = await realpath(cwd);
    const root = options.workspace.workspaces.find(
      (entry) =>
        options.allowedWorkspaces.includes(entry.key) &&
        (!workspaceKey || entry.key === workspaceKey) &&
        (canonical === entry.root ||
          (!path.relative(entry.root, canonical).startsWith('..') &&
            !path.isAbsolute(path.relative(entry.root, canonical)))),
    );
    requireValue(root, 'codex.workspace', 'unauthorized');
    await workspace.list({
      workspaceKey: root.key,
      path: path.relative(root.root, canonical) || '.',
    });
    assertCurrent();
    return canonical;
  }
  async function authorizeSession(session) {
    const result = await request('thread/read', {
      threadId: session.nativeSessionId,
      includeTurns: false,
    });
    requireValue(
      result.thread?.id === session.nativeSessionId && typeof result.thread.cwd === 'string',
      'codex.thread.scope',
    );
    return authorizeCwd(result.thread.cwd);
  }
  const journal = createOperationJournal({
    store: options.store,
    isProcessCurrent: (value) =>
      alive &&
      value.target === scope.environmentId &&
      value.session.harnessInstanceId === scope.harnessInstanceId &&
      value.epoch === epoch &&
      value.processGeneration === processGeneration &&
      options.isProcessCurrent({ ...scope, epoch, processGeneration }),
  });
  const interactions = createInteractionStore({ store: options.store });
  const instanceFactory = (authorize) =>
    createInstanceOperations({
      store: options.store,
      scope: { ...scope, epoch, processGeneration },
      isCurrent: () => alive && options.isProcessCurrent({ ...scope, epoch, processGeneration }),
      fingerprint,
      newId: randomUUID,
      authorize,
    });
  const instance = instanceFactory();
  const catalog = createCodexCatalog({
    store: options.store,
    sessionFor,
    assertCurrent,
    newId: randomUUID,
    privacy,
  });
  sessions = createCodexSessionOperations({
    store: options.store,
    fingerprint,
    newId: randomUUID,
    journal,
    interactions,
    request,
    scopeFor,
    assertCurrent,
    emit,
    authorizeSession,
  });
  const steer = createCodexControls({
    store: options.store,
    journal,
    instanceFactory,
    fingerprint,
    request,
    assertCurrent,
    activeFor: sessions.activeFor,
    scopeFor,
  });
  const resolveCredential = async (ref, context) => {
    requireValue(
      typeof ref === 'string' && options.resolveCredential,
      'codex.credential',
      'unsupported',
    );
    const result = await options.resolveCredential(ref, { ...scope, ...context });
    assertCurrent();
    return result;
  };
  events = createCodexEvents({
    client,
    sessions,
    interactions,
    sessionFor,
    scopeFor,
    assertCurrent,
    emit,
    privacy,
    catalogChanged: catalog.changed,
    resolveCredential,
  });
  const list = createCodexDiscovery({
    request,
    summary: catalog.summary,
    generation: processGeneration,
    revision: () => catalog.revision,
  });
  const history = createCodexHistory({ request, processGeneration, epoch, assertCurrent });
  async function close() {
    if (closing) return closing;
    alive = false;
    closing = (async () => {
      client.close();
      const results = await Promise.allSettled([
        sessions.close(),
        workspace.disconnect(),
        transport.close(),
      ]);
      subscriptions.close();
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Codex shutdown failed');
    })();
    return closing;
  }
  const native = createCodexNativeOperations({
    request,
    sessions,
    instance,
    validateContext,
    catalog,
    summary: catalog.summary,
    steer,
    resolveCredential,
    privacy,
    authorizeSession,
  });
  const core = {
    inspect(context) {
      validateContext(context);
      return { state: 'ready', protocolVersion: 1 };
    },
    listSessionPage(context) {
      validateContext(context);
      return list(fields(context.params ?? {}, ['cursor', 'limit']));
    },
    async getSession(context) {
      validateContext(context, true);
      const result = await request('thread/read', {
        threadId: context.session.nativeSessionId,
        includeTurns: false,
      });
      requireValue(result.thread?.id === context.session.nativeSessionId, 'codex.thread.scope');
      return catalog.summary(result.thread);
    },
    readHistoryPage(context) {
      validateContext(context, true);
      return history({
        session: context.session,
        ...fields(context.params ?? {}, ['cursor', 'limit']),
      });
    },
    async createSession(context) {
      validateContext(context);
      const params = fields(context.params, ['workspaceKey', 'idempotencyKey', 'native']);
      const root = options.workspace.workspaces.find((entry) => entry.key === params.workspaceKey);
      requireValue(root, 'codex.workspace', 'unauthorized');
      const cwd = await authorizeCwd(root.root, params.workspaceKey);
      const payload = nativeArguments(params.native, [
        'model',
        'modelProvider',
        'approvalPolicy',
        'sandbox',
        'serviceTier',
        'ephemeral',
        'baseInstructions',
        'developerInstructions',
      ]);
      const accepted = await instance.accept({
        method: 'thread/start',
        idempotencyKey: params.idempotencyKey,
        payload: { ...payload, cwd },
      });
      const execution = await instance.execute(accepted.operationId, ({ method, payload }) =>
        request(method, payload),
      );
      requireValue(execution.result.thread?.id, 'codex.create.thread', 'reconcile_required');
      await sessions.loaded(sessionFor(execution.result.thread.id));
      return {
        accepted,
        ...execution,
        result: { session: await catalog.summary(execution.result.thread) },
      };
    },
    async send(context) {
      validateContext(context, true);
      const params = fields(context.params, ['idempotencyKey', 'native', 'queue']);
      const payload = nativeArguments(params.native, [
        'input',
        'model',
        'effort',
        'summary',
        'approvalPolicy',
        'sandboxPolicy',
        'serviceTier',
        'serviceTierForTurn',
        'clientUserMessageId',
        'outputSchema',
      ]);
      requireValue(Array.isArray(payload.input), 'codex.send.input');
      const cwd = await authorizeSession(context.session);
      for (const input of payload.input) {
        requireValue(
          ['text', 'image', 'localImage'].includes(input.type),
          'codex.input.type',
          'unsupported',
        );
        if (input.type === 'localImage')
          await authorizeCwd(path.dirname(await realpath(input.path)));
      }
      return sessions.mutate({
        session: context.session,
        method: 'turn/start',
        payload: { ...payload, cwd },
        idempotencyKey: params.idempotencyKey,
        turn: true,
        queue: params.queue === true,
      });
    },
    cancel(context) {
      validateContext(context, true);
      return sessions.cancel({
        session: context.session,
        ...fields(context.params, ['operationId']),
      });
    },
    respondInteraction(context) {
      validateContext(context, true);
      return events.respond({
        session: context.session,
        ...fields(context.params, ['interactionId', 'answer', 'credentialRef']),
      });
    },
    subscribe(context) {
      validateContext(context);
      return subscriptions.subscribe(context.session);
    },
    close(context) {
      validateContext(context);
      return close();
    },
  };
  try {
    const initialized = await client.request('initialize', {
      clientInfo: { name: 'vis_runtime', title: 'Vis Runtime', version: '0.9.0' },
      capabilities: { experimentalApi: true },
    });
    assertCurrent();
    requireValue(
      typeof initialized.userAgent === 'string' &&
        initialized.userAgent.includes(`/${CODEX_PROFILE} `),
      'codex.version',
      'version_mismatch',
    );
    client.notify('initialized', {});
    const registration = validateHarnessRegistration({
      manifest: codexManifest(scope, native),
      driver: { core, native },
    });
    options.runtime.resources.register(
      `codex:${scope.harnessInstanceId}:${processGeneration}`,
      'owned',
      close,
    );
    return { registration, close, protocolProfile: CODEX_PROFILE, journal, interactions };
  } catch (error) {
    await close();
    throw error;
  }
}
