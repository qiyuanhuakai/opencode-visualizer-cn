import { StoreError } from '../storage/storeProtocol.js';
import { NATIVE_EXTENSIONS } from '../../../shared/runtime/nativeExtensions.js';
import { record, text } from '../../../shared/runtime/native/acp/capabilities.js';

export function createAcpExtensions({
  capabilities,
  rpc,
  mutations,
  sessions,
  interactions,
  queue,
  send,
  cwd,
  createAuthTerminal,
  agentId,
  active,
}) {
  const methods = {};
  const declarations = [];
  const declare = (name, scope, action, enabled = true) => {
    declarations.push({
      name,
      scope,
      support: enabled
        ? { state: 'supported' }
        : { state: 'unsupported', code: 'unsupported', reason: 'Not declared by this ACP agent' },
    });
    if (enabled) methods[name] = action;
  };
  const current = (input) => {
    if (!input.session) throw new StoreError('invalid_request', 'session_required');
    const value = sessions.get(input.session);
    if (!value.native) throw new StoreError('unsupported', 'session_not_loaded');
    return value.native;
  };
  const mutate = (input, method, payload) =>
    queue(() =>
      mutations.run(
        {
          ...(input.session ? { session: input.session } : {}),
          idempotencyKey: input.idempotencyKey,
          method,
          payload,
        },
        ({ payload: body }) => rpc.request(method, body),
      ),
    );
  declare('acp.loadSession', 'session', (input) => sessions.load(input), capabilities.load);
  declare(
    'acp.resumeSession',
    'session',
    (input) => sessions.load(input, 'session/resume'),
    capabilities.resume,
  );
  declare('acp.getInteraction', 'session', async (input) => {
    current(input);
    const interaction = await interactions.get(text(input.interactionId));
    if (interaction.scope.session.nativeSessionId !== input.session.nativeSessionId)
      throw new StoreError('conflict', 'scope_fence');
    return interaction;
  });
  declare('listPendingPermissions', 'instance', () => interactions.list());
  declare('getSessionStatusMap', 'instance', () => ({
    items: [...active].map(([id, operationId]) => ({
      session: sessions.sessionFor(id),
      state: 'running',
      operationId,
    })),
    status: 'partial',
    reason: 'runtime_observed_only',
  }));
  declare('listPendingQuestions', 'instance', () => ({
    items: [],
    status: 'unsupported',
    reason: 'No ACP question protocol declared',
  }));
  declare('listAgentAuthMethods', 'instance', () => capabilities.authMethods);
  declare(
    'authenticateAgent',
    'instance',
    (input) => {
      const methodId = text(input.methodId);
      if (!capabilities.authMethods.some((method) => method.id === methodId))
        throw new StoreError('unsupported', 'auth_method');
      if (input.session) throw new StoreError('invalid_request', 'instance_auth');
      return mutate(input, 'authenticate', { methodId });
    },
    capabilities.authMethods.length > 0,
  );
  declare(
    'createAgentAuthPty',
    'instance',
    (input) => {
      if (input.session) throw new StoreError('invalid_request', 'instance_auth');
      const method = capabilities.authMethods.find(
        (candidate) => candidate.id === input.methodId && candidate.type === 'terminal',
      );
      if (!method) throw new StoreError('unsupported', 'auth_terminal_method');
      return queue(() =>
        mutations.run(
          {
            idempotencyKey: input.idempotencyKey,
            method: 'auth/terminal',
            payload: { methodId: method.id },
          },
          () => createAuthTerminal(method),
        ),
      );
    },
    typeof createAuthTerminal === 'function' &&
      capabilities.authMethods.some((method) => method.type === 'terminal'),
  );
  declare('getSessionConfigOptions', 'instance', (input) => current(input).configOptions ?? []);
  declare('listProviders', 'instance', (input) => ({
    models: current(input).models ?? null,
    configOptions: current(input).configOptions ?? [],
    status: 'partial',
  }));
  declare('listAgents', 'instance', (input) => ({
    modes: current(input).modes ?? null,
    configOptions: current(input).configOptions ?? [],
    status: 'partial',
  }));
  declare('listCommands', 'instance', (input) => current(input).availableCommands ?? []);
  declare('sendCommand', 'session', (input) => {
    const command = text(input.command);
    if (!current(input).availableCommands?.some((item) => item.name === command))
      throw new StoreError('unsupported', 'slash_command');
    return send({
      ...input,
      prompt: [
        { type: 'text', text: `/${command}${input.arguments ? ` ${text(input.arguments)}` : ''}` },
      ],
    });
  });
  const setConfig = async (input, configId, value) => {
    const config = current(input).configOptions?.find((option) => option.id === configId);
    if (config?.type !== 'select' || !config.options?.some((option) => option.value === value))
      throw new StoreError('unsupported', 'config_option');
    const result = await mutate(input, 'session/set_config_option', {
      sessionId: input.session.nativeSessionId,
      configId,
      value,
    });
    sessions.register({ ...record(result.result), sessionId: input.session.nativeSessionId });
    return result;
  };
  declare('acp.setMode', 'session', (input) => {
    const modeId = text(input.modeId);
    const config = current(input).configOptions?.find(
      (option) => option.category === 'mode' || option.id === 'mode',
    );
    if (config) return setConfig(input, config.id, modeId);
    if (!current(input).modes?.availableModes?.some((mode) => mode.id === modeId))
      throw new StoreError('unsupported', 'session_mode');
    return mutate(input, 'session/set_mode', { sessionId: input.session.nativeSessionId, modeId });
  });
  declare('acp.setModel', 'session', (input) => {
    const modelId = text(input.modelId);
    const config = current(input).configOptions?.find(
      (option) => option.category === 'model' || option.id === 'model',
    );
    if (config) return setConfig(input, config.id, modelId);
    if (!current(input).models?.availableModels?.some((model) => model.modelId === modelId))
      throw new StoreError('unsupported', 'session_model');
    return mutate(input, 'session/set_model', {
      sessionId: input.session.nativeSessionId,
      modelId,
    });
  });
  declare('syncSessionConfig', 'session', async (input) => {
    if (input.configId !== undefined)
      return setConfig(input, text(input.configId), text(input.value));
    const results = [];
    for (const [category, value] of [
      ['model', input.model],
      ['mode', input.mode],
      ['thought_level', input.thoughtLevel],
    ]) {
      if (!value) continue;
      const config = current(input).configOptions?.find(
        (option) =>
          option.category === category ||
          option.id === category ||
          (category === 'thought_level' && option.id === 'thinking'),
      );
      if (!config) throw new StoreError('unsupported', 'config_option');
      results.push(
        await setConfig(
          { ...input, idempotencyKey: `${text(input.idempotencyKey)}:${config.id}` },
          config.id,
          text(value),
        ),
      );
    }
    return results;
  });
  const omp = agentId === 'oh-my-pi';
  async function extensions(kind) {
    await mutations.authority();
    const result = record(await rpc.request('_omp/extensions', { cwd }));
    if (!Array.isArray(result.extensions) || result.extensions.length > 1000)
      throw new StoreError('invalid_request', 'omp_extensions');
    return result.extensions
      .filter((item) => item.kind === kind)
      .map((item) => {
        if (!['active', 'disabled', 'shadowed'].includes(item.state))
          throw new StoreError('invalid_request', 'omp_extension_state');
        return {
          id: text(item.id),
          name: text(item.displayName),
          path: text(item.path),
          state: item.state,
        };
      });
  }
  declare('getMcpStatus', 'instance', () => extensions('mcp'), omp);
  declare('getPluginStatus', 'instance', () => extensions('extension-module'), omp);
  declare('getSkillStatus', 'instance', () => extensions('skill'), omp);
  for (const [name, method] of Object.entries({
    forkSession: 'fork',
    deleteSession: 'delete',
    'acp.closeSession': 'close',
  })) {
    declare(
      name,
      'session',
      async (input) => {
        current(input);
        const result = await mutate(input, `session/${method}`, {
          sessionId: input.session.nativeSessionId,
          ...(method === 'fork' ? { cwd, mcpServers: [] } : {}),
        });
        if (method === 'fork') return { ...result, ...sessions.register(record(result.result)) };
        sessions.forget(input.session);
        return result;
      },
      !!capabilities.native.sessionCapabilities?.[method],
    );
  }
  for (const [name, description] of Object.entries(NATIVE_EXTENSIONS)) {
    if (!declarations.some((item) => item.name === name))
      declare(name, description.scope, undefined, false);
  }
  return { methods, declarations };
}
