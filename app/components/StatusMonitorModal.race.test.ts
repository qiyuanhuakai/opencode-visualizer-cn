import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

const registryMock = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getPersistedCodexBridgeToken: () => '',
  getActiveBackendAdapter: () => registryMock.getAdapter(),
}));
vi.mock('../composables/useMessages', () => ({
  useMessages: () => ({
    roots: {
      value: [
        { id: 'assistant-1', sessionID: 'thread-1' },
        { id: 'assistant-2', sessionID: 'thread-2' },
      ],
    },
    getThread: (rootId: string) => {
      const suffix = rootId.endsWith('2') ? '2' : '1';
      return [
        {
          id: `assistant-${suffix}`,
          sessionID: `thread-${suffix}`,
          role: 'assistant',
          time: { created: Number(suffix) },
        },
      ];
    },
    getUsage: (messageId: string) => {
      const suffix = messageId.endsWith('2') ? 'b' : 'a';
      return {
        providerId: 'openai',
        modelId: `gpt-${suffix}`,
        tokens: {
          input: suffix === 'a' ? 321 : 654,
          output: 45,
          reasoning: 12,
          cache: { read: 0, write: 0 },
          total: suffix === 'a' ? 378 : 711,
        },
      };
    },
    loadHistory: () => undefined,
  }),
}));
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({ showCodexInStatusMonitor: { value: false, __v_isRef: true } }),
}));
vi.mock('../composables/useAcpBridge', () => ({
  useAcpBridge: () => ({
    services: { value: [] },
    agents: { value: [] },
    loading: { value: false },
    bridgeAvailable: { value: true },
    error: { value: '' },
    refresh: async () => undefined,
    updateAgent: async () => undefined,
    createAgent: async () => undefined,
    removeAgent: async () => undefined,
  }),
}));

import StatusMonitorModal from './StatusMonitorModal.vue';
import en from '../locales/en';
import { useCodexApi } from '../composables/useCodexApi';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createBackend(overrides: Record<string, unknown> = {}) {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '0.145.0' }),
    getMcpStatus: async () => ({}),
    getLspStatus: async () => [],
    getSkillStatus: async () => [],
    getGlobalConfig: async () => ({}),
    ...overrides,
  };
}

function clickTab(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

function mountStatusMonitor() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const open = ref(false);
  const sessionId = ref<string | undefined>('thread-1');
  const backendKind = ref<'codex' | 'opencode'>('codex');
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(StatusMonitorModal, {
            open: open.value,
            preload: false,
            activeBackendKind: backendKind.value,
            sessionId: sessionId.value,
            codexApi: useCodexApi(),
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  open.value = true;
  return { app, root, sessionId, backendKind };
}

describe('StatusMonitorModal stale request isolation', () => {
  beforeEach(() => {
    registryMock.getAdapter.mockReturnValue(createBackend());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the current session context limit when an older provider lookup finishes last', async () => {
    const firstProviders = deferred<Record<string, unknown>>();
    const secondProviders = deferred<Record<string, unknown>>();
    let providerCalls = 0;
    registryMock.getAdapter.mockReturnValue(
      createBackend({
        listProviders: () => (++providerCalls === 1 ? firstProviders.promise : secondProviders.promise),
      }),
    );
    const { app, root, sessionId } = mountStatusMonitor();
    await vi.waitFor(() => expect(providerCalls).toBe(1));

    sessionId.value = 'thread-2';
    await vi.waitFor(() => expect(providerCalls).toBe(2));
    secondProviders.resolve({
      all: [{ id: 'openai', models: { 'gpt-b': { limit: { context: 222_222 } } } }],
    });
    clickTab(root, 'Token');
    await vi.waitFor(() => expect(root.textContent).toContain('222,222'));

    firstProviders.resolve({
      all: [{ id: 'openai', models: { 'gpt-a': { limit: { context: 111_111 } } } }],
    });
    await nextTick();
    await nextTick();
    expect(root.textContent).toContain('222,222');
    expect(root.textContent).not.toContain('111,111');
    app.unmount();
  });

  it('invalidates Token loading when the selected session is cleared', async () => {
    const providers = deferred<Record<string, unknown>>();
    let providerCalls = 0;
    registryMock.getAdapter.mockReturnValue(
      createBackend({
        listProviders: () => {
          providerCalls++;
          return providers.promise;
        },
      }),
    );
    const { app, root, sessionId } = mountStatusMonitor();
    await vi.waitFor(() => expect(providerCalls).toBe(1));

    sessionId.value = undefined;
    clickTab(root, 'Token');
    await nextTick();
    expect(root.textContent).toContain('No session selected');
    expect(root.textContent).not.toContain('Loading...');

    providers.resolve({ all: [] });
    await nextTick();
    expect(root.textContent).toContain('No session selected');
    app.unmount();
  });

  it('keeps a newer backend refresh after the older refresh settles', async () => {
    const firstHealth = deferred<{ healthy: boolean; version: string }>();
    const secondHealth = deferred<{ healthy: boolean; version: string }>();
    registryMock.getAdapter.mockReturnValue(
      createBackend({ getGlobalHealth: () => firstHealth.promise }),
    );
    const { app, root, backendKind } = mountStatusMonitor();
    await nextTick();

    registryMock.getAdapter.mockReturnValue(
      createBackend({ getGlobalHealth: () => secondHealth.promise }),
    );
    backendKind.value = 'opencode';
    await nextTick();
    firstHealth.resolve({ healthy: true, version: '1.0.0' });
    await nextTick();
    await nextTick();
    expect(root.textContent).toContain('Loading...');

    secondHealth.resolve({ healthy: true, version: '2.0.0' });

    await vi.waitFor(() => expect(root.textContent).toContain('2.0.0'));
    expect(root.textContent).not.toContain('1.0.0');
    expect(root.textContent).not.toContain('Loading...');
    app.unmount();
  });
});
