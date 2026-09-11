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

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getPersistedCodexBridgeToken: () => '',
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

function acpDataAdapter(): MockAdapter {
  return {
    getGlobalHealth: async () => ({ healthy: true, version: '17.0.2' }),
    getMcpStatus: async () => ({ context7: { status: 'configured' } }),
    getSkillStatus: async () => [{ name: 'Review Work', enabled: false, path: '/safe/SKILL.md' }],
    getPluginStatus: async () => [
      { id: 'extension-module:demo', name: 'Demo Extension', enabled: true, installed: true, accessible: true },
    ],
    getGlobalConfig: async () => ({}),
  };
}

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

function clickTab(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  expect(button).toBeDefined();
  button?.click();
}

async function mountModal(activeBackendKind: BackendKind, expectedVersion = '0.27.0') {
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
  await vi.waitFor(() => expect(root.textContent).toContain(expectedVersion));
  return { root, app };
}

afterEach(() => {
  document.body.innerHTML = '';
  adapterSlot.current = {};
});

describe('StatusMonitorModal ACP capability adaptation', () => {
  it('shows real server/MCP/plugin/skill data and an explicit LSP unavailable state', async () => {
    adapterSlot.current = acpDataAdapter();
    const { root, app } = await mountModal('acp', '17.0.2');

    clickTab(root, 'MCP');
    await nextTick();
    expect(root.textContent).toContain('context7');
    expect(root.textContent).toContain('Configured in OMP; connection status unavailable');
    expect(root.querySelector('.toggle-switch')).toBeNull();

    clickTab(root, 'LSP');
    await nextTick();
    expect(root.textContent).toContain('Structured LSP status is not exposed by this ACP agent');

    clickTab(root, 'Plugins');
    await nextTick();
    expect(root.textContent).toContain('Demo Extension');

    clickTab(root, 'Skills');
    await nextTick();
    expect(root.textContent).toContain('Review Work');
    expect(root.querySelector('.toggle-switch')).toBeNull();
    app.unmount();
  });
});

describe('ACP-worded unsupported messages', () => {
  it.each([
    ['MCP', 'Structured MCP status is not exposed by this ACP agent'],
    ['LSP', 'Structured LSP status is not exposed by this ACP agent'],
    ['Plugins', 'Structured plugin status is not exposed by this ACP agent'],
    ['Skills', 'Structured skill status is not exposed by this ACP agent'],
  ] as const)('shows the ACP variant on the %s tab for an ACP backend', async (label, message) => {
    adapterSlot.current = acpUnsupportedAdapter();
    const { root, app } = await mountModal('acp');

    clickTab(root, label);
    await nextTick();
    expect(root.textContent).toContain(message);
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
  it.each([
    { backendKind: 'acp', expectedChipCount: null },
    { backendKind: 'opencode', expectedChipCount: null },
    { backendKind: 'codex', expectedChipCount: 5 },
  ] satisfies Array<{ backendKind: BackendKind; expectedChipCount: number | null }>)(
    'renders the expected plugin summary for the $backendKind backend',
    async ({ backendKind, expectedChipCount }) => {
      adapterSlot.current = pluginEntriesAdapter();
      const { root, app } = await mountModal(backendKind);

      clickTab(root, 'Plugins');
      await nextTick();
      expect(root.textContent).toContain('Demo');
      const grid = root.querySelector('.status-monitor-summary-grid');
      if (expectedChipCount === null) {
        expect(grid).toBeNull();
      } else {
        expect(grid).not.toBeNull();
        expect(grid?.querySelectorAll('.status-monitor-summary-chip')).toHaveLength(expectedChipCount);
      }
      app.unmount();
    },
  );
});

describe('plugin row status redundancy', () => {
  it.each(['opencode', 'codex'] as const)(
    'omits the enabled label for the %s backend while retaining the success dot',
    async (backendKind) => {
      adapterSlot.current = pluginEntriesAdapter();
      const { root, app } = await mountModal(backendKind);

      clickTab(root, 'Plugins');
      await nextTick();
      const row = [...root.querySelectorAll('.status-monitor-row')].find((candidate) =>
        candidate.textContent?.includes('Demo'),
      );
      expect(row?.querySelector('.status-dot-success')).not.toBeNull();
      expect(row?.querySelector('.status-monitor-meta')).toBeNull();
      app.unmount();
    },
  );
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
