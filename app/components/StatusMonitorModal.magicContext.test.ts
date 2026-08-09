import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../backends/registry', () => ({
  getPersistedCodexBridgeUrl: () => 'ws://localhost:23004/codex',
  getPersistedCodexBridgeToken: () => '',
  getActiveBackendAdapter: () => ({
    getGlobalHealth: async () => ({ healthy: true, version: 'test' }),
    getMcpStatus: async () => ({}),
    getLspStatus: async () => [],
    getSkillStatus: async () => [],
    getGlobalConfig: async () => ({}),
  }),
}));
vi.mock('../composables/useMessages', () => ({
  useMessages: () => ({
    roots: { value: [] },
    getThread: () => [],
    getUsage: () => undefined,
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

describe('StatusMonitorModal Magic Context status', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists magic-context workers only on the MC tab with their live session status', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(StatusMonitorModal, {
              open: true,
              preload: false,
              activeBackendKind: 'opencode',
              sessionId: 'ses-parent',
              codexApi: useCodexApi(),
              magicContextWorkers: [
                { sessionId: 'mc-1', name: 'magic-context-reviewer', status: 'busy' },
                { sessionId: 'mc-2', name: 'magic-context-historian', status: 'idle' },
                { sessionId: 'mc-3', name: 'magic-context-recomp', status: 'retry' },
              ],
            });
        },
      }),
    );
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(root);
    await nextTick();

    expect(root.textContent).not.toContain('magic-context-reviewer');
    const mcTab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent?.trim() === 'MC',
    );
    expect(mcTab).toBeDefined();
    mcTab?.click();
    await nextTick();

    expect(root.textContent).toContain('magic-context-reviewer');
    expect(root.textContent).toContain('Running');
    expect(root.textContent).toContain('Idle');
    expect(root.textContent).toContain('Retrying');
    app.unmount();
  });
});
