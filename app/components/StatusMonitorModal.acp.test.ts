import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

const acpRefresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeToken: () => '',
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getActiveBackendAdapter: () => ({
    getGlobalHealth: async () => { throw new Error('unsupported'); },
    getMcpStatus: async () => { throw new Error('unsupported'); },
    getLspStatus: async () => { throw new Error('unsupported'); },
    getSkillStatus: async () => { throw new Error('unsupported'); },
    getGlobalConfig: async () => { throw new Error('unsupported'); },
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
    agents: { value: [{
      id: 'oh-my-pi',
      name: 'Oh My Pi',
      command: 'omp',
      args: ['--mode', 'acp'],
      enabled: false,
      state: 'disabled',
      owned: false,
      connected: false,
      droppedFrames: 0,
    }] },
    loading: { value: false },
    bridgeAvailable: { value: true },
    error: { value: '' },
    refresh: acpRefresh,
    updateAgent: async () => undefined,
    createAgent: async () => undefined,
    removeAgent: async () => undefined,
  }),
}));

import StatusMonitorModal from './StatusMonitorModal.vue';
import en from '../locales/en';
import zhCN from '../locales/zh-CN';
import zhTW from '../locales/zh-TW';
import ja from '../locales/ja';
import eo from '../locales/eo';
import { useCodexApi } from '../composables/useCodexApi';

function createCodexApi() {
  return useCodexApi();
}

describe('StatusMonitorModal ACP integration', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    acpRefresh.mockClear();
  });

  it('opens ACP management inside the existing status monitor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(defineComponent({
      setup() {
        return () => h(StatusMonitorModal, {
          open: true,
          preload: false,
          activeBackendKind: 'opencode',
          codexApi: createCodexApi(),
        });
      },
    }));
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(root);
    await nextTick();
    root.querySelector<HTMLButtonElement>('.refresh-button')?.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.status-monitor-feedback.is-error')).not.toBeNull();
    });

    const acpTab = [...root.querySelectorAll<HTMLButtonElement>('[role="tablist"] button')]
      .find((button) => button.textContent?.trim() === 'ACP');
    expect(acpTab).toBeDefined();
    acpTab?.click();
    await nextTick();

    expect(root.textContent).toContain('Oh My Pi');
    expect(acpRefresh).toHaveBeenCalled();
    expect(root.querySelector('.status-monitor-feedback.is-error')).toBeNull();
    app.unmount();
  });

  it('defines the ACP manager schema in every locale', () => {
    for (const locale of [en, zhCN, zhTW, ja, eo]) {
      expect(Reflect.get(locale.statusMonitor.tabs, 'acp')).toBeTruthy();
      const acp = Reflect.get(locale.statusMonitor, 'acp');
      expect(acp).toEqual(expect.objectContaining({
        add: expect.any(String),
        services: expect.any(String),
        disconnected: expect.any(String),
        droppedFrames: expect.any(String),
        states: expect.objectContaining({ adopted: expect.any(String) }),
      }));
    }
  });
});
