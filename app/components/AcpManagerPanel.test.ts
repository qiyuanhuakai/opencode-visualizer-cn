import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

import AcpManagerPanel from './AcpManagerPanel.vue';
import type {
  AcpAgentStatus,
  BridgeServiceStatus,
  useAcpBridge,
} from '../composables/useAcpBridge';

function createMessages() {
  return {
    en: {
      statusMonitor: {
        acp: {
          unavailable: 'Bridge unavailable',
          empty: 'No ACP agents',
          enable: 'Enable',
          disable: 'Disable',
          connected: 'Connected',
          disconnected: 'Not connected',
          droppedFrames: '{count} dropped frames',
          services: 'Managed services',
          states: {
            disabled: 'Disabled',
            stopped: 'Stopped',
            starting: 'Starting',
            running: 'Running',
            adopted: 'External',
            stopping: 'Stopping',
            error: 'Error',
          },
          add: 'Add agent',
          addTitle: 'Custom ACP agent',
          id: 'ID',
          name: 'Name',
          command: 'Command',
          args: 'Arguments',
          cancel: 'Cancel',
          remove: 'Remove',
          invalidArgs: 'Arguments must be a JSON string array.',
          required: 'ID, name, and command are required.',
        },
      },
    },
  };
}

function createApi() {
  const agents = ref<AcpAgentStatus[]>([{
    id: 'oh-my-pi',
    name: 'Oh My Pi',
    command: 'omp',
    args: ['--mode', 'acp'],
    enabled: true,
    state: 'running' as const,
    owned: true,
    connected: true,
    droppedFrames: 0,
  }]);
  return {
    agents,
    services: ref<BridgeServiceStatus[]>([{
      id: 'opencode',
      name: 'OpenCode Server',
      command: 'opencode',
      args: ['serve'],
      state: 'adopted' as const,
      owned: false,
    }]),
    loading: ref(false),
    bridgeAvailable: ref(true),
    error: ref(''),
    refresh: vi.fn(async () => {}),
    updateAgent: vi.fn(async () => agents.value[0]),
    createAgent: vi.fn(async (input) => ({
      ...input,
      state: 'disabled' as const,
      owned: false,
      connected: false,
      droppedFrames: 0,
    })),
    removeAgent: vi.fn(async () => {}),
  } satisfies ReturnType<typeof useAcpBridge>;
}

async function mountPanel(api: ReturnType<typeof useAcpBridge>) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(defineComponent({
    setup() {
      return () => h(AcpManagerPanel, { api });
    },
  }));
  app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
  app.mount(root);
  await nextTick();
  await Promise.resolve();
  return { app, root };
}

describe('AcpManagerPanel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders managed agents and toggles daemon settings in place', async () => {
    const api = createApi();
    const { app, root } = await mountPanel(api);

    expect(root.textContent).toContain('Oh My Pi');
    expect(root.textContent).toContain('OpenCode Server');
    expect(root.textContent).toContain('Connected');
    expect(root.textContent).toContain('omp --mode acp');
    const toggle = root.querySelector<HTMLInputElement>('[data-acp-toggle="oh-my-pi"]');
    expect(toggle).not.toBeNull();
    toggle?.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    expect(api.updateAgent).toHaveBeenCalledWith('oh-my-pi', { enabled: false });
    app.unmount();
  });

  it('adds an arbitrary ACP CLI using a JSON argument list', async () => {
    const api = createApi();
    const { app, root } = await mountPanel(api);
    root.querySelector<HTMLButtonElement>('[data-acp-add-toggle]')?.click();
    await nextTick();
    const setValue = (selector: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error(`Missing input: ${selector}`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue('[data-acp-id]', 'custom-agent');
    setValue('[data-acp-name]', 'Custom Agent');
    setValue('[data-acp-command]', '/usr/local/bin/custom-agent');
    setValue('[data-acp-args]', '["--acp"]');
    root.querySelector<HTMLButtonElement>('[data-acp-add-submit]')?.click();
    await nextTick();

    expect(api.createAgent).toHaveBeenCalledWith({
      id: 'custom-agent',
      name: 'Custom Agent',
      command: '/usr/local/bin/custom-agent',
      args: ['--acp'],
      enabled: false,
    });
    app.unmount();
  });

  it('shows complete multiline startup errors for services and ACP agents', async () => {
    const api = createApi();
    api.services.value[0] = {
      ...api.services.value[0],
      state: 'error',
      error: 'OpenCode failed\nport 4096 is unavailable',
    };
    api.agents.value[0] = {
      ...api.agents.value[0],
      state: 'error',
      error: 'Oh My Pi failed\nexecutable not found',
    };

    const { app, root } = await mountPanel(api);

    const serviceError = root.querySelector<HTMLElement>('[data-service-startup-error]');
    const agentError = root.querySelector<HTMLElement>('[data-agent-startup-error]');
    expect(serviceError?.textContent).toContain('port 4096 is unavailable');
    expect(agentError?.textContent).toContain('executable not found');
    expect(serviceError?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(agentError?.classList.contains('whitespace-pre-wrap')).toBe(true);
    app.unmount();
  });
});
