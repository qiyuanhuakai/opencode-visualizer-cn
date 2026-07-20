import { createApp, h, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import ProviderManagerModal from './ProviderManagerModal.vue';

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.app.unmount();
    entry.host.remove();
  }
});

describe('ProviderManagerModal ACP setup', () => {
  it('emits the terminal-auth action from the ACP provider surface', async () => {
    const onOpen = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(ProviderManagerModal, {
          open: true,
          providers: [],
          connectedProviderIds: [],
          selectedModel: '',
          hiddenModels: [],
          providerConfig: null,
          backendKind: 'acp',
          onOpenAcpAuthTerminal: onOpen,
        }),
    });
    app.use(i18n);
    app.mount(host);
    mounted.push({ app, host });
    await nextTick();

    const button = host.querySelector<HTMLButtonElement>('.ghost-action');
    expect(button?.textContent).toContain('Open setup terminal');
    button?.click();

    expect(onOpen).toHaveBeenCalledOnce();
  });
});
