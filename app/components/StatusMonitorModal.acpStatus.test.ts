import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getPersistedCodexBridgeToken: () => '',
  getActiveBackendAdapter: () => ({
    getGlobalHealth: async () => ({ healthy: true, version: '17.0.2' }),
    getMcpStatus: async () => ({ context7: { status: 'configured' } }),
    getSkillStatus: async () => [{ name: 'Review Work', enabled: false, path: '/safe/SKILL.md' }],
    getPluginStatus: async () => [
      { id: 'extension-module:demo', name: 'Demo Extension', enabled: true, installed: true, accessible: true },
    ],
    getGlobalConfig: async () => ({}),
  }),
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
  const button = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  expect(button).toBeDefined();
  button?.click();
}

describe('StatusMonitorModal ACP capability adaptation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows real server/MCP/plugin/skill data and an explicit LSP unavailable state', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const open = ref(false);
    const app = createApp(defineComponent({
      setup() {
        return () => h(StatusMonitorModal, {
          open: open.value,
          preload: false,
          activeBackendKind: 'acp',
          codexApi: useCodexApi(),
        });
      },
    }));
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(root);
    open.value = true;
    await nextTick();
    await vi.waitFor(() => expect(root.textContent).toContain('17.0.2'));

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
