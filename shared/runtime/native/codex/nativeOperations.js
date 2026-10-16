import { requireValue } from '../../capabilities.js';
import { NATIVE_METHODS, COMMANDS } from './capabilities.js';
import { fields, nativeArguments, record, rejectSecretInput } from './boundaries.js';

export function createCodexNativeOperations({
  request,
  sessions,
  instance,
  validateContext,
  catalog,
  summary,
  steer,
  resolveCredential,
  privacy,
  authorizeSession,
}) {
  async function invoke(name, context) {
    validateContext(context, NATIVE_METHODS[name].scope === 'session');
    const spec = NATIVE_METHODS[name];
    const params = fields(context.params ?? {}, ['native', 'idempotencyKey', 'credentialRef']);
    let payload = nativeArguments(params.native, spec.fields);
    rejectSecretInput(payload);
    if (name === 'codex.review')
      requireValue(
        !payload.delivery || payload.delivery === 'inline',
        'codex.review.detached',
        'unsupported',
      );
    if (spec.method === 'thread/fork') payload = { ...payload, excludeTurns: true };
    if (spec.method === 'permissionProfile/list')
      payload = { ...payload, cwd: await authorizeSession(context.session) };
    if (!spec.mutation)
      return request(spec.method, {
        ...payload,
        ...(spec.scope === 'session' && spec.method.startsWith('thread/')
          ? { threadId: context.session.nativeSessionId }
          : {}),
      });
    requireValue(typeof params.idempotencyKey === 'string', 'codex.idempotencyKey');
    if (spec.scope === 'instance') {
      const accepted = await instance.accept({
        method: spec.method,
        idempotencyKey: params.idempotencyKey,
        payload: { native: payload, credentialRef: params.credentialRef ?? null },
      });
      const result = await instance.execute(
        accepted.operationId,
        async ({ method, payload: durable }) => {
          const native = durable.credentialRef
            ? await resolveCredential(durable.credentialRef, { operation: name })
            : durable.native;
          return request(method, native);
        },
      );
      return { accepted, ...result };
    }
    catalog.invalidate();
    const result = await sessions.mutate({
      session: context.session,
      method: spec.method,
      payload,
      idempotencyKey: params.idempotencyKey,
      turn: name === 'compactSession' ? 'compact' : name === 'codex.review',
    });
    if (name === 'deleteSession') await catalog.changed(context.session, 'thread/deleted');
    if (result.result?.thread && spec.method === 'thread/fork')
      await sessions.loaded({ ...context.session, nativeSessionId: result.result.thread.id });
    if (result.result?.thread)
      return { ...result, result: { session: await summary(result.result.thread) } };
    return result;
  }
  const native = Object.fromEntries(
    Object.keys(NATIVE_METHODS).map((name) => [name, (context) => invoke(name, context)]),
  );
  native.updateSession = async (context) => {
    validateContext(context, true);
    const params = fields(context.params, ['native', 'idempotencyKey']);
    const payload = fields(params.native, ['name', 'archived']);
    requireValue(Object.keys(payload).length === 1, 'codex.update.one_action');
    const archive = Object.hasOwn(payload, 'archived');
    requireValue(
      archive
        ? typeof payload.archived === 'boolean'
        : typeof payload.name === 'string' || payload.name === null,
      'codex.update.value',
    );
    const method = archive
      ? payload.archived
        ? 'thread/archive'
        : 'thread/unarchive'
      : 'thread/name/set';
    catalog.invalidate();
    const result = await sessions.mutate({
      session: context.session,
      method,
      payload: archive ? {} : payload,
      idempotencyKey: params.idempotencyKey,
    });
    await catalog.changed(
      context.session,
      archive
        ? payload.archived
          ? 'thread/archived'
          : 'thread/unarchived'
        : 'thread/name/updated',
      payload,
    );
    return result;
  };
  native.listProviders = async (context) => {
    validateContext(context);
    const result = await request('config/read', { includeLayers: true });
    const ids = new Set(['openai']);
    for (const config of [result.config, ...(result.layers ?? []).map((layer) => layer.config)]) {
      if (!config || typeof config !== 'object') continue;
      if (typeof config.model_provider === 'string') ids.add(config.model_provider);
      for (const id of Object.keys(config.model_providers ?? {})) ids.add(id);
    }
    return {
      providers: [...ids].map((id) => ({ id })),
      active: result.config?.model_provider ?? 'openai',
    };
  };
  native.listCommands = (context) => {
    validateContext(context);
    return COMMANDS;
  };
  native['codex.steer'] = (context) => {
    validateContext(context, true);
    const params = fields(context.params, ['idempotencyKey', 'native']);
    const payload = fields(params.native, ['expectedTurnId', 'input']);
    return steer({ session: context.session, ...payload, idempotencyKey: params.idempotencyKey });
  };
  native.sendCommand = async (context) => {
    validateContext(context, true);
    const params = fields(context.params, ['idempotencyKey', 'command', 'native']);
    const command = COMMANDS.find((entry) => entry.name === params.command);
    requireValue(command, 'codex.command', 'unsupported');
    let payload = record(params.native ?? {});
    if (command.ephemeral) payload = { ...payload, ephemeral: true };
    if (command.name === 'archive') payload = { archived: true };
    if (command.name === 'fast') {
      fields(payload, ['modelId', 'enabled']);
      requireValue(
        typeof payload.enabled === 'boolean' && typeof payload.modelId === 'string',
        'codex.fast.params',
      );
      const models = await request('model/list', { limit: 200 });
      const model = models.data.find(
        (entry) => entry.id === payload.modelId || entry.model === payload.modelId,
      );
      const tier = model?.serviceTiers?.find((entry) => /^(fast|priority)$/i.test(entry.id));
      requireValue(!payload.enabled || tier, 'codex.fast.unavailable', 'unsupported');
      payload = {
        keyPath: 'service_tier',
        value: payload.enabled ? tier.id : 'default',
        mergeStrategy: 'replace',
      };
    }
    return native[command.operation]({
      ...context,
      params: { native: privacy(payload), idempotencyKey: params.idempotencyKey },
    });
  };
  return native;
}
