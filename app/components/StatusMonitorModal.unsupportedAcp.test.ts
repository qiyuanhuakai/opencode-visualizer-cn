import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

type BackendKind = 'opencode' | 'codex' | 'acp';

type MockPlugin = {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  accessible: boolean;
};

type MockAdapter = {
  getGlobalHealth?: () => Promise<{ healthy: boolean; version: string }>;
  getMcpStatus?: () => Promise<Record<string, unknown>>;
  getLspStatus?: () => Promise<Array<Record<string, unknown>>>;
  getSkillStatus?: () => Promise<Array<Record<string, unknown>>>;
  getPluginStatus?: () => Promise<MockPlugin[]>;
  getGlobalConfig?: () => Promise<Record<string, unknown>>;
};

const adapterSlot = vi.hoisted(() => ({ current: {} as MockAdapter }));

function acpUnsupportedAdapter(): MockAdapter {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '0.27.0' }),
    getMcpStatus: async () => {
      throw new Error('unsupported');
    },
    getPluginStatus: async () => {
      throw new Error('unsupported');
    },
    getSkillStatus: async () => {
      throw new Error('unsupported');
    },
    getGlobalConfig: async () => ({}),
  };
}

function pluginEntriesAdapter(): MockAdapter {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '0.27.0' }),
    getPluginStatus: async () => [
      { id: 'p1', name: 'Demo', enabled: true, installed: true, accessible: true },
    ],
    getGlobalConfig: async () => ({}),
  };
}

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeToken: () => '',
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getActiveBackendAdapter: () => adapterSlot.current,
}));
vi.mock('../composables/useMessages', () => ({
  useMessages: () => ({
    roots: { value: [] },
    getThread: () => [],
    getUsage: () => undefined,
    loadHistory: () => {},
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

async function mountModal(activeBackendKind: BackendKind) {
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
            activeBackendKind,
            codexApi: useCodexApi(),
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  open.value = true;
  await nextTick();
  await vi.waitFor(() => expect(root.textContent).toContain('0.27.0'));
  return { root, app };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ACP-worded unsupported messages', () => {
  it('shows the ACP variant on the MCP tab for an ACP backend', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, 'MCP');
    await nextTick();
    expect(root.textContent).toContain('Structured MCP status is not exposed by this ACP agent');
    expect(root.textContent).not.toContain('OpenCode');
    app.unmount();
  });

  it('shows the ACP variant on the LSP tab for an ACP backend', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, 'LSP');
    await nextTick();
    expect(root.textContent).toContain('Structured LSP status is not exposed by this ACP agent');
    expect(root.textContent).not.toContain('OpenCode');
    app.unmount();
  });

  it('shows the ACP variant on the Plugins tab for an ACP backend', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, 'Plugins');
    await nextTick();
    expect(root.textContent).toContain('Structured plugin status is not exposed by this ACP agent');
    expect(root.textContent).not.toContain('OpenCode');
    app.unmount();
  });

  it('shows the ACP variant on the Skills tab for an ACP backend', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, 'Skills');
    await nextTick();
    expect(root.textContent).toContain('Structured skill status is not exposed by this ACP agent');
    expect(root.textContent).not.toContain('OpenCode');
    app.unmount();
  });

  it('keeps the generic and OpenCode-worded messages for an opencode backend', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('opencode');

    clickTab(root, 'MCP');
    await nextTick();
    expect(root.textContent).toContain('Structured MCP status is not exposed by this backend');

    clickTab(root, 'Skills');
    await nextTick();
    expect(root.textContent).toContain('OpenCode');
    app.unmount();
  });
});

describe('plugin stat-card grid gated to codex', () => {
  it('hides the summary grid for an ACP backend while listing plugin entries', async () => {
    adapterSlot.current = pluginEntriesAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, 'Plugins');
    await nextTick();
    expect(root.textContent).toContain('Demo');
    expect(root.querySelector('.status-monitor-summary-grid')).toBeNull();
    app.unmount();
  });

  it('hides the summary grid for an opencode backend while listing plugin entries', async () => {
    adapterSlot.current = pluginEntriesAdapter();
    const { root, app } = await mountModal('opencode');

    clickTab(root, 'Plugins');
    await nextTick();
    expect(root.textContent).toContain('Demo');
    expect(root.querySelector('.status-monitor-summary-grid')).toBeNull();
    app.unmount();
  });

  it('shows the five stat chips for a codex backend', async () => {
    adapterSlot.current = pluginEntriesAdapter();
    const { root, app } = await mountModal('codex');

    clickTab(root, 'Plugins');
    await nextTick();
    const grid = root.querySelector('.status-monitor-summary-grid');
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll('.status-monitor-summary-chip')).toHaveLength(5);
    app.unmount();
  });
});

describe('ACP pluginUnsupported not masked by getGlobalConfig', () => {
  it('shows the ACP plugin unsupported message when only getPluginStatus rejects', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, 'Plugins');
    await nextTick();
    expect(root.textContent).toContain('Structured plugin status is not exposed by this ACP agent');
    expect(root.querySelector('.status-monitor-summary-grid')).toBeNull();
    expect(root.textContent).not.toContain('No plugins loaded.');
    app.unmount();
  });

  it('keeps the noData state for an opencode backend with the same adapter shape', async () => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('opencode');

    clickTab(root, 'Plugins');
    await nextTick();
    expect(root.textContent).not.toContain('Structured plugin status is not exposed');
    expect(root.textContent).toContain('No plugins loaded.');
    app.unmount();
  });
});
