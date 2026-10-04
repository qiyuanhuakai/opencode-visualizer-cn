// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import DshCustomProviderSettings from './DshCustomProviderSettings.vue';
import { customProviderHarness } from './customProviderConfiguration.fixtures';
import { DshRpcError } from '../../utils/dshRpc';
vi.mock('@iconify/vue', () => ({ Icon: { render: () => null } }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function flush() { for (let index = 0; index < 12; index++) { await Promise.resolve(); await nextTick(); } }
async function mount() {
  const host = customProviderHarness();
  const container = document.createElement('div'); document.body.append(container);
  const closed = vi.fn(); const changed = vi.fn();
  const app = createApp({ render: () => h(DshCustomProviderSettings, { rpc: { call: host.call, callMultipart: vi.fn(), nextRpcId: vi.fn() }, onClose: closed, onProvidersChanged: changed }) });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.mount(container); cleanups.push(() => { app.unmount(); container.remove(); }); await flush();
  for (const [selector, value] of [['[data-custom-field="id"]', 'local-models'], ['[data-custom-field="baseURL"]', 'https://local.example/v1'], ['[data-custom-model="0"]', 'model-a'], ['input[type="password"]', 'test-key']]) {
    const input = container.querySelector<HTMLInputElement>(selector ?? '');
    if (!input) throw new Error('Missing custom field');
    input.value = value ?? ''; input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await flush();
  function submit() { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
  return { host, container, closed, changed, submit };
}
it('retries only the secret after profile commit and a failed credential write', async () => {
  const { host, container, closed, submit } = await mount();
  const original = host.call.getMockImplementation();
  if (!original) throw new Error('Missing mock implementation');
  let fail = true;
  host.call.mockImplementation(async (ns, method, args) => {
    if (ns === 'credentials' && fail) { fail = false; throw new Error('Credential store unavailable'); }
    return original(ns, method, args);
  });
  submit(); await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Credential store unavailable');
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
  expect(closed).not.toHaveBeenCalled();
  submit(); await flush();
  expect(host.call.mock.calls.filter(([ns, method]) => ns === 'settings' && method === 'mutate')).toHaveLength(1);
  expect(host.call.mock.calls.filter(([ns]) => ns === 'credentials')).toHaveLength(2);
  expect(closed).toHaveBeenCalledOnce();
});
it('keeps the draft after CAS conflict and never writes its credential', async () => {
  const { host, container, submit } = await mount();
  host.call.mockRejectedValueOnce(new DshRpcError('Stale revision', { code: 'settings/conflict' }));
  submit(); await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('dsh.providers.conflict');
  expect(container.querySelector<HTMLInputElement>('[data-custom-field="id"]')?.value).toBe('local-models');
  expect(host.call.mock.calls.filter(([ns]) => ns === 'credentials')).toHaveLength(0);
});
