import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodexAdapter,
  extractStatusType,
  getCodexWeeklyRateLimitWindow,
  normalizeCodexStatus,
} from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  it('selects only the weekly rate-limit window when a removed short window is still present', () => {
    const weekly = {
      usedPercent: 42,
      windowDurationMins: 10_080,
      resetsAt: 1_730_947_200,
    };

    expect(
      getCodexWeeklyRateLimitWindow({
        limitId: 'codex',
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_730_900_000,
        },
        secondary: weekly,
      }),
    ).toEqual(weekly);
  });

  it('does not label a longer rate-limit window as weekly', () => {
    const weekly = {
      usedPercent: 42,
      windowDurationMins: 10_080,
      resetsAt: 1_730_947_200,
    };

    expect(
      getCodexWeeklyRateLimitWindow({
        limitId: 'codex',
        primary: {
          usedPercent: 7,
          windowDurationMins: 43_200,
          resetsAt: 1_733_539_200,
        },
        secondary: weekly,
      }),
    ).toEqual(weekly);
  });

  it('writes Codex config patches through batchWriteConfig', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const update = adapter.updateGlobalConfig({
      model_provider: 'proxy',
      'model_providers.proxy': {
        name: 'Proxy',
        base_url: 'https://proxy.example.com/v1',
        wire_api: 'responses',
      },
    });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'config/batchWrite',
      params: {
        edits: [
          { keyPath: 'model_provider', value: 'proxy', mergeStrategy: 'replace' },
          {
            keyPath: 'model_providers.proxy',
            value: {
              name: 'Proxy',
              base_url: 'https://proxy.example.com/v1',
              wire_api: 'responses',
            },
            mergeStrategy: 'replace',
          },
        ],
      },
    });
    socket.respond(2, {});
    await waitForSent(socket, 4);
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'config/read',
      params: {},
    });
    socket.respond(3, { config: { model_provider: 'proxy' } });

    await expect(update).resolves.toEqual({ model_provider: 'proxy' });
  });

  it('keeps global config methods bound for shared provider UI destructuring', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const updateGlobalConfig = adapter.updateGlobalConfig;
    const update = updateGlobalConfig({ model_provider: 'proxy' });
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({
      id: 2,
      method: 'config/batchWrite',
      params: { edits: [{ keyPath: 'model_provider', value: 'proxy', mergeStrategy: 'replace' }] },
    });
    socket.respond(2, {});
    await waitForSent(socket, 4);
    socket.respond(3, { config: { model_provider: 'proxy' } });

    await expect(update).resolves.toEqual({ model_provider: 'proxy' });
  });

  it.each([undefined, 'openai', 'codex'])(
    'prefers the configured built-in model for provider %s',
    async (modelProvider) => {
      // Given: the catalog default differs from the configured model.
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });
      const providers = adapter.listProviders();
      const socket = MockWebSocket.instances[0];
      if (!socket) throw new Error('Expected adapter socket');
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, {
        data: [
          { id: 'codex-auto-review', model: 'codex-auto-review', isDefault: true },
          { id: 'astra-choice', model: 'gpt-6-astra' },
        ],
        nextCursor: null,
      });
      await waitForSent(socket, 4);
      // When: the resolved configuration selects Astra.
      socket.respond(3, { config: { model: 'gpt-6-astra', model_provider: modelProvider } });
      // Then: the UI receives the selectable catalog identifier for Astra.
      expect((await providers).default).toEqual({ codex: 'astra-choice' });
    },
  );

  it('maps Codex models to provider options for the shared UI', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const listProviders = adapter.listProviders;
    const providers = listProviders();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.respond(1, {});
    await waitForSent(socket, 3);
    socket.respond(2, {
      data: [
        {
          id: 'gpt-5.5-codex',
          model: 'gpt-5.5-codex',
          displayName: 'GPT-5.5 Codex',
          isDefault: true,
          inputModalities: ['text', 'image'],
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' },
          ],
        },
        { id: 'hidden-model', model: 'hidden-model', displayName: 'Hidden', hidden: true },
      ],
      nextCursor: null,
    });
    await waitForSent(socket, 4);
    expect(JSON.parse(socket.sent[3] ?? '{}')).toEqual({
      id: 3,
      method: 'config/read',
      params: { includeLayers: true },
    });
    socket.respond(3, {
      config: {
        model_provider: 'proxy',
        model: 'proxy-model',
        model_providers: {
          proxy: { name: 'Proxy', base_url: 'https://proxy.example.com/v1', wire_api: 'responses' },
          omniroute: {
            name: 'omniroute',
            base_url: 'http://localhost:20128/v1',
            wire_api: 'responses',
            env_key: 'OPENAI_API_KEY',
          },
        },
        vis: {
          model_providers: {
            proxy: { models: { 'proxy-model': { name: 'Proxy Model' } } },
          },
        },
      },
      layers: [
        {
          source: 'config.toml',
          config: {
            vis: {
              model_providers: {
                omniroute: { models: { 'mimo/mimo-v2.5': { name: 'mimo-v2.5' } } },
              },
            },
          },
        },
      ],
    });

    expect(Object.entries((await providers).default)[0]).toEqual(['proxy', 'proxy-model']);
    await expect(providers).resolves.toEqual({
      all: [
        {
          id: 'codex',
          name: 'Codex',
          source: 'codex-app-server',
          models: {
            'gpt-5.5-codex': {
              id: 'gpt-5.5-codex',
              name: 'GPT-5.5 Codex',
              providerID: 'codex',
              status: 'connected',
              variants: {
                low: { description: 'Fast' },
                high: { description: 'Deep' },
              },
              capabilities: {
                attachment: true,
                reasoning: true,
                toolcall: true,
              },
            },
            'hidden-model': {
              id: 'hidden-model',
              name: 'Hidden',
              providerID: 'codex',
              status: 'connected',
              variants: {},
              capabilities: {
                attachment: true,
                reasoning: false,
                toolcall: true,
              },
            },
          },
        },
        {
          id: 'proxy',
          name: 'Proxy',
          source: 'config',
          models: {
            'proxy-model': {
              id: 'proxy-model',
              name: 'Proxy Model',
              providerID: 'proxy',
              status: 'connected',
              variants: {},
              capabilities: {
                attachment: true,
                reasoning: true,
                toolcall: true,
              },
            },
          },
        },
        {
          id: 'omniroute',
          name: 'omniroute',
          source: 'config',
          models: {
            'mimo/mimo-v2.5': {
              id: 'mimo/mimo-v2.5',
              name: 'mimo-v2.5',
              providerID: 'omniroute',
              status: 'connected',
              variants: {},
              capabilities: {
                attachment: true,
                reasoning: true,
                toolcall: true,
              },
            },
          },
        },
      ],
      connected: ['codex', 'proxy', 'omniroute'],
      default: { codex: 'gpt-5.5-codex', proxy: 'proxy-model' },
    });
    await expect(adapter.listProviderAuthMethods()).resolves.toEqual({ codex: [] });
  });

  describe('CodexAdapter extended APIs', () => {
    it('uses current wire methods for goals, usage, provider capabilities, and permission profiles', async () => {
      MockWebSocket.instances = [];
      const adapter = createCodexAdapter({
        url: 'ws://localhost:4500',
        webSocketCtor: MockWebSocket,
      });

      const goal = adapter.getThreadGoal({ threadId: 'thread-1' });
      const socket = MockWebSocket.instances[0]!;
      socket.emitOpen();
      await waitForSent(socket, 1);
      socket.respond(1, {});
      await waitForSent(socket, 3);
      socket.respond(2, { goal: null });
      await expect(goal).resolves.toEqual({ goal: null });

      const usage = adapter.readAccountUsage();
      await waitForSent(socket, 4);
      socket.respond(3, { summary: { lifetimeTokens: 12 }, dailyUsageBuckets: [] });
      await usage;

      const providerCapabilities = adapter.readModelProviderCapabilities();
      await waitForSent(socket, 5);
      socket.respond(4, { namespaceTools: true, imageGeneration: false, webSearch: true });
      await providerCapabilities;

      const profiles = adapter.listPermissionProfiles({ cwd: '/workspace' });
      await waitForSent(socket, 6);
      socket.respond(5, { data: [{ id: 'default', description: null }], nextCursor: null });
      await profiles;

      expect(socket.sent.slice(2).map((message) => JSON.parse(message))).toEqual([
        { id: 2, method: 'thread/goal/get', params: { threadId: 'thread-1' } },
        { id: 3, method: 'account/usage/read', params: {} },
        { id: 4, method: 'modelProvider/capabilities/read', params: {} },
        { id: 5, method: 'permissionProfile/list', params: { cwd: '/workspace' } },
      ]);
    });
  });

  describe('normalizeCodexStatus / extractStatusType', () => {
    it('extracts the type field from a structured codex status object', () => {
      expect(extractStatusType({ type: 'notLoaded' })).toBe('notLoaded');
      expect(extractStatusType({ type: 'active', activeFlags: ['some'] })).toBe('active');
      expect(extractStatusType({ type: 'systemError' })).toBe('systemError');
    });

    it('returns the value directly when status is a plain string', () => {
      expect(extractStatusType('running')).toBe('running');
      expect(extractStatusType('idle')).toBe('idle');
    });

    it('returns undefined for missing or invalid status values', () => {
      expect(extractStatusType(undefined)).toBeUndefined();
      expect(extractStatusType(null)).toBeUndefined();
      expect(extractStatusType({})).toBeUndefined();
      expect(extractStatusType({ type: 123 })).toBeUndefined();
    });

    it('maps structured codex "active" status (with activeFlags) to "busy"', () => {
      expect(
        normalizeCodexStatus({ type: 'active', activeFlags: ['streaming', 'awaitingApproval'] }),
      ).toBe('busy');
    });

    it('maps structured codex "systemError" status to "retry"', () => {
      expect(normalizeCodexStatus({ type: 'systemError' })).toBe('retry');
    });

    it('maps structured codex "notLoaded" / "idle" status to "unknown" (gray hollow, matches opencode)', () => {
      expect(normalizeCodexStatus({ type: 'notLoaded' })).toBe('unknown');
      expect(normalizeCodexStatus({ type: 'idle' })).toBe('unknown');
    });

    it('maps unknown / missing status values to "unknown"', () => {
      expect(normalizeCodexStatus(undefined)).toBe('unknown');
      expect(normalizeCodexStatus(null)).toBe('unknown');
      expect(normalizeCodexStatus({})).toBe('unknown');
    });

    it('preserves string aliases for busy / retry (opencode-shaped payloads)', () => {
      expect(normalizeCodexStatus('running')).toBe('busy');
      expect(normalizeCodexStatus('inProgress')).toBe('busy');
      expect(normalizeCodexStatus('busy')).toBe('busy');
      expect(normalizeCodexStatus('retry')).toBe('retry');
    });
  });
});
