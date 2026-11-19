import { createApp, defineComponent, h, reactive, resolveComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import InputPanel from './InputPanel.vue';
import { INPUT_PANEL_DEFAULT_PROPS } from './inputPanel.test-helpers';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId } from '../../shared/runtime/identity.js';
import { RUNTIME_SESSION_ACTIONS_KEY } from '../composables/useRuntimeSessionActions';
import type { RuntimeSessionRouter, RuntimeSessionRuntime } from '../composables/useRuntimeSessionActions';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const SESSION = parseSessionRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  harnessInstanceId: '10000000-0000-4000-8000-000000000001' as HarnessInstanceId,
  nativeSessionId: 'native-1',
});

const apps = new Set<ReturnType<typeof createApp>>();
afterEach(() => { for (const app of apps) app.unmount(); apps.clear(); document.body.replaceChildren(); });

function makeRouter() {
  return {
    sendMessage: vi.fn(), cancel: vi.fn(), fork: vi.fn(), rename: vi.fn(), archive: vi.fn(),
    unarchive: vi.fn(), delete: vi.fn(), compact: vi.fn(), revert: vi.fn(), todos: vi.fn(),
    tokenMonitor: vi.fn(), history: vi.fn(), respond: vi.fn(),
  } satisfies Record<keyof RuntimeSessionRouter, ReturnType<typeof vi.fn>>;
}

function mount(options: { port?: RuntimeSessionRuntime; onSend?: () => void }) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const props = reactive({ ...INPUT_PANEL_DEFAULT_PROPS, messageInput: 'hi', canSend: true, onSend: options.onSend ?? vi.fn() });
  const app = createApp(defineComponent({ setup: () => () => h(resolveComponent('InputPanel'), props) }));
  apps.add(app);
  app.component('InputPanel', InputPanel);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  if (options.port) app.provide(RUNTIME_SESSION_ACTIONS_KEY, options.port);
  app.mount(root);
  return root;
}

describe('InputPanel uses the qualified runtime path when a port is provided', () => {
  it('routes the send through the port and does not emit legacy send', () => {
    const router = makeRouter();
    const onSend = vi.fn();
    const port: RuntimeSessionRuntime = { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, onSend });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(router.sendMessage).toHaveBeenCalledTimes(1);
    const [binding, input] = router.sendMessage.mock.calls[0]!;
    expect(binding).toEqual({ profileId: PROFILE, session: SESSION });
    expect(input).toMatchObject({ text: 'hi', model: 'openai/gpt' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('falls back to the legacy emit when no port is provided', () => {
    const onSend = vi.fn();
    const root = mount({ onSend });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('falls back to the legacy emit when the port has no qualified binding', () => {
    const router = makeRouter();
    const onSend = vi.fn();
    const port: RuntimeSessionRuntime = { binding: () => null, router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, onSend });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(router.sendMessage).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
