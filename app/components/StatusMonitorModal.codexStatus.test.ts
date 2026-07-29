import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

const never = new Promise<Record<string, unknown>>(() => undefined);
const registryMock = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getPersistedCodexBridgeToken: () => '',
  getActiveBackendAdapter: () => registryMock.getAdapter(),
}));

function createBackend(overrides: Record<string, unknown> = {}) {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '0.145.0' }),
    getMcpStatus: () => never,
    getLspStatus: async () => [],
    getSkillStatus: async () => [],
    getGlobalConfig: async () => ({}),
    ...overrides,
  };
}
vi.mock('../composables/useMessages', () => ({
  useMessages: () => ({
    roots: {
      value: [{ id: 'assistant-1', sessionID: 'thread-1' }],
    },
    getThread: () => [
      {
        id: 'assistant-1',
        sessionID: 'thread-1',
        role: 'assistant',
        time: { created: 1 },
      },
    ],
    getUsage: () => ({
      providerId: 'openai',
      modelId: 'gpt-5.6',
      tokens: {
        input: 321,
        output: 45,
        reasoning: 12,
        cache: { read: 0, write: 0 },
        total: 378,
      },
    }),
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

function clickTab(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

function mountStatusMonitor() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const open = ref(false);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(StatusMonitorModal, {
            open: open.value,
            preload: false,
            activeBackendKind: 'codex',
            sessionId: 'thread-1',
            codexApi: useCodexApi(),
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  open.value = true;
  return { app, root };
}

describe('StatusMonitorModal Codex status isolation', () => {
  beforeEach(() => {
    registryMock.getAdapter.mockReturnValue(createBackend());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finishes Token loading independently when MCP status remains pending', async () => {
    const { app, root } = mountStatusMonitor();
    await nextTick();
    clickTab(root, 'Token');
    await nextTick();

    await vi.waitFor(() => expect(root.textContent).toContain('321'));
    expect(root.textContent).not.toContain('Loading...');
    app.unmount();
  });

  it('implements complete keyboard tab semantics', async () => {
    const { app, root } = mountStatusMonitor();
    await nextTick();

    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(7);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();

    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(root.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
      tabs[1]?.id,
    );
    app.unmount();
  });

  it('does not show a duplicate total above Codex plugin statistics', async () => {
    registryMock.getAdapter.mockReturnValue(
      createBackend({
        getMcpStatus: async () => ({}),
        getPluginStatus: async () => [
          { id: 'plugin-1', name: 'plugin-1', enabled: true, installed: true, accessible: true },
        ],
      }),
    );
    const { app, root } = mountStatusMonitor();
    await vi.waitFor(() => expect(root.textContent).toContain('0.145.0'));
    clickTab(root, 'Plugins');
    await nextTick();

    expect(root.querySelector('.status-monitor-actions')).toBeNull();
    app.unmount();
  });

  it('toggles an MCP configured under config.mcp_servers', async () => {
    const updateMcp = vi.fn(async () => undefined);
    registryMock.getAdapter.mockReturnValue(
      createBackend({
        getMcpStatus: async () => ({ officecli: { status: 'configured' } }),
        getGlobalConfig: async () => ({
          mcp_servers: { officecli: { command: 'officecli', enabled: true } },
        }),
        updateMcp,
      }),
    );
    const { app, root } = mountStatusMonitor();
    await vi.waitFor(() => expect(root.textContent).toContain('0.145.0'));
    clickTab(root, 'MCP');
    await nextTick();
    const toggle = root.querySelector<HTMLInputElement>('.toggle-input');
    expect(toggle?.getAttribute('aria-label')).toBe('Disable');
    toggle?.click();

    await vi.waitFor(() =>
      expect(updateMcp).toHaveBeenCalledWith({
        name: 'officecli',
        config: { command: 'officecli', enabled: false },
      }),
    );
    app.unmount();
  });
});
