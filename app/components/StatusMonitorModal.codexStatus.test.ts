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

function mountStatusMonitor(initialTab?: 'token' | 'skills' | 'mc') {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const open = ref(false);
  const codexApi = useCodexApi();
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(StatusMonitorModal, {
            open: open.value,
            initialTab,
            preload: false,
            activeBackendKind: 'codex',
            sessionId: 'thread-1',
            codexApi,
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  open.value = true;
  return { app, root, codexApi };
}

describe('StatusMonitorModal Codex status isolation', () => {
  beforeEach(() => {
    registryMock.getAdapter.mockReturnValue(createBackend());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('finishes Token loading independently when MCP status remains pending', async () => {
    const { app, root } = mountStatusMonitor();
    await nextTick();
    clickTab(root, 'Token');
    await nextTick();

    await vi.waitFor(() => expect(root.textContent).toContain('No token data for this session yet'));
    expect(root.textContent).not.toContain('Loading...');
    app.unmount();
  });

  it('shows current thread totals and last input from App Server without using message estimates', async () => {
    const { app, root, codexApi } = mountStatusMonitor('token');
    codexApi.tokenUsage.value = {
      threadId: 'thread-1', turnId: 'turn-2', tokenUsage: {
        total: { totalTokens: 1900, inputTokens: 1300, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
        last: { totalTokens: 350, inputTokens: 280, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 70, reasoningOutputTokens: 20 },
        modelContextWindow: 1000,
      },
    };
    await nextTick();
    expect(root.querySelector('.codex-session-usage')?.textContent).toContain('1,900');
    expect(root.querySelector('.codex-session-usage')?.textContent).toContain('280');
    expect(root.querySelector('.codex-session-usage')?.textContent).toContain('28%');
    expect(root.querySelector('.codex-session-usage')?.textContent).not.toContain('321');
    app.unmount();
  });

  it('does not show a notification from another thread', async () => {
    const { app, root, codexApi } = mountStatusMonitor('token');
    codexApi.tokenUsage.value = {
      threadId: 'other', turnId: 'turn-1', tokenUsage: {
        total: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 },
        last: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 },
        modelContextWindow: 10000,
      },
    };
    await nextTick();
    expect(root.querySelector('.codex-session-usage')?.textContent).not.toContain('9,000');
    expect(root.querySelector('.codex-session-usage')?.textContent).toContain('No token data for this session yet');
    app.unmount();
  });

  it('opens the requested Token tab without creating or selecting a session', async () => {
    const { app, root } = mountStatusMonitor('token');
    await nextTick();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Token');
    expect(root.textContent).toContain('Codex account token activity');
    expect(root.textContent).toContain('Connect Codex');
    app.unmount();
  });

  it('shows Plus five-hour and weekly limits beneath account tokens, with weekly for other plans', async () => {
    const { app, root, codexApi } = mountStatusMonitor('token');
    codexApi.status.value = 'connected';
    codexApi.account.value = { type: 'chatgpt', planType: 'plus' };
    codexApi.accountPlanType.value = 'plus';
    codexApi.accountRateLimits.value = {
      limitId: 'codex',
      primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1 },
      secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 2 },
    };
    await nextTick();

    expect(root.querySelector('#status-monitor-tab-codex')).toBeNull();
    const accountUsage = root.querySelector('.account-token-usage');
    const quotas = root.querySelector('.codex-rate-limits');
    expect(accountUsage).not.toBeNull();
    expect(quotas).not.toBeNull();
    expect(accountUsage && quotas ? accountUsage.compareDocumentPosition(quotas) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
    expect(quotas?.textContent).toContain('Used (5 hours)');
    expect(quotas?.textContent).toContain('23%');
    expect(quotas?.textContent).toContain('Used (weekly)');
    expect(quotas?.textContent).toContain('61%');

    codexApi.accountPlanType.value = 'pro';
    await nextTick();
    expect(quotas?.textContent).not.toContain('Used (5 hours)');
    expect(quotas?.textContent).toContain('Used (weekly)');

    codexApi.account.value = { type: 'apiKey' };
    await nextTick();
    expect(quotas?.textContent).toContain('Used (weekly)');
    app.unmount();
  });

  it('does not select the hidden MC tab when Codex requests it initially', async () => {
    const { app, root } = mountStatusMonitor('mc');
    await nextTick();
    expect(root.querySelector('#status-monitor-tab-mc')).toBeNull();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('status-monitor-tab-server');
    app.unmount();
  });

  it('scrolls only the active tab into view when opened and when tabs change', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const { app, root } = mountStatusMonitor('token');
    await nextTick();
    await nextTick();
    expect(scroll).toHaveBeenLastCalledWith({ inline: 'nearest', block: 'nearest' });
    expect(scroll.mock.contexts.at(-1)).toBe(root.querySelector('#status-monitor-tab-token'));
    clickTab(root, 'Skills');
    await nextTick();
    await nextTick();
    expect(scroll.mock.contexts.at(-1)).toBe(root.querySelector('#status-monitor-tab-skills'));
    app.unmount();
  });

  it('keeps the selected tab visible on container resize and disconnects its observer', async () => {
    let resize = () => undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = () => { callback(); return undefined; }; }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    });
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const { app, root } = mountStatusMonitor('token');
    await nextTick();
    await nextTick();
    expect(observe).toHaveBeenCalledWith(root.querySelector('[role="tablist"]'));
    scroll.mockClear();
    resize();
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll.mock.contexts[0]).toBe(root.querySelector('#status-monitor-tab-token'));
    app.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('implements complete keyboard tab semantics', async () => {
    const { app, root } = mountStatusMonitor();
    await nextTick();

    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(7);
    expect(tabs.some((tab) => tab.textContent?.trim() === 'MC')).toBe(false);
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
