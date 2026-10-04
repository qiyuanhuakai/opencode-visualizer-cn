// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import DshProviderSettings from './DshProviderSettings.vue';
import { providerHarness } from '../../backends/dsh/dshProviderConfig.fixtures';
import type { DshRpcClient } from '../../utils/dshRpc';
import { DshRpcError } from '../../utils/dshRpc';
vi.mock('@iconify/vue', () => ({ Icon: { render: () => null } }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function flush() { for (let index = 0; index < 12; index += 1) { await Promise.resolve(); await nextTick(); } }
async function mount(configure?: (host: ReturnType<typeof providerHarness>) => void) {
  const host = providerHarness();
  configure?.(host);
  const rpc = ref<DshRpcClient>({ call: host.call, callMultipart: vi.fn(), nextRpcId: vi.fn() });
  const container = document.createElement('div');
  document.body.append(container);
  const changed = vi.fn();
  const app = createApp({ render: () => h(DshProviderSettings, { rpc: rpc.value, providerId: 'test', onProvidersChanged: changed }) });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }));
  app.provide('showConfirm', async () => true);
  app.mount(container);
  const dispose = () => { app.unmount(); container.remove(); };
  cleanups.push(dispose);
  await flush();
  return { host, rpc, container, changed, dispose };
}
function input(container: HTMLElement, value: string) {
  const element = container.querySelector<HTMLInputElement>('[data-field="baseURL"]');
  if (!element) throw new Error('Missing base URL input');
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
function submit(container: HTMLElement) { container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }

describe('DshProviderSettings', () => {
  it('edits models graphically while preserving unknown model metadata and the existing key', async () => {
    const { container, host } = await mount((fixture) => { fixture.profile.models = [{ id: 'model-a', contextWindow: 1000, compat: { customWireOption: true } }]; });
    expect(container.querySelector('textarea')).toBeNull();
    const name = container.querySelector<HTMLInputElement>('[data-model-name]');
    const image = container.querySelector<HTMLInputElement>('[data-model-image]');
    if (!name || !image) throw new Error('Missing model controls');
    name.value = 'Edited name';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    image.click();
    await flush();
    submit(container);
    await flush();
    expect(host.profile.models).toEqual([{ id: 'model-a', name: 'Edited name', contextWindow: 1000, input: ['text', 'image'], compat: { customWireOption: true } }]);
    expect(host.writes.map((write) => write.method)).toEqual(['settings/mutate']);
  });
  it('filters discovery, selects candidates and bulk adds without duplicating existing models', async () => {
    const { container, host } = await mount();
    host.call.mockResolvedValueOnce([{ id: 'model-a' }, { id: 'vision-b', name: 'Vision B', contextWindow: 32000, inputModalities: ['text', 'image'] }, { id: 'text-c' }]);
    container.querySelector<HTMLButtonElement>('[data-discover-models]')?.click();
    await flush();
    expect(container.querySelector<HTMLInputElement>('[aria-label="model-a"]')?.disabled).toBe(true);
    const search = container.querySelector<HTMLInputElement>('[data-model-search]');
    if (!search) throw new Error('Missing search');
    search.value = 'Vision'; search.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    container.querySelector<HTMLButtonElement>('[data-select-models]')?.click();
    await flush();
    container.querySelector<HTMLButtonElement>('[data-add-selected]')?.click();
    await flush();
    expect(container.querySelectorAll('[data-model-card]')).toHaveLength(2);
    expect(host.writes).toEqual([]);
    submit(container);
    await flush();
    expect(host.profile.models).toEqual([{ id: 'model-a', contextWindow: 1000 }, { id: 'vision-b', name: 'Vision B', contextWindow: 32000, input: ['text', 'image'] }]);
  });
  it('shows discovery failure and retries to an empty result', async () => {
    const { container, host } = await mount();
    host.call.mockRejectedValueOnce(new DshRpcError('Discovery unavailable', { code: 'DISCOVERY_UNSUPPORTED' }));
    container.querySelector<HTMLButtonElement>('[data-discover-models]')?.click();
    await flush();
    expect(container.querySelector('.model-discovery [role="alert"]')?.textContent).toContain('Discovery unavailable');
    host.call.mockResolvedValueOnce([]);
    container.querySelector<HTMLButtonElement>('[data-retry-models]')?.click();
    await flush();
    expect(container.querySelector('.model-discovery [role="status"]')?.textContent).toBe('dsh.providers.noModels');
    expect(container.querySelector<HTMLButtonElement>('[data-add-selected]')?.disabled).toBe(true);
    expect(host.writes).toEqual([]);
  });
  it('ignores discovery results after the endpoint draft changes', async () => {
    const { container, host } = await mount();
    let finish: (() => void) | undefined;
    host.call.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve([{ id: 'stale-model' }]); }));
    container.querySelector<HTMLButtonElement>('[data-discover-models]')?.click();
    await flush();
    expect(container.querySelector('.model-discovery')?.getAttribute('aria-busy')).toBe('true');
    input(container, 'https://other.example/v1');
    await flush();
    finish?.(); await flush();
    expect(container.querySelector('.model-discovery')).toBeNull();
    expect(host.writes).toEqual([]);
  });
  it('restores native defaults by unsetting the model override on save', async () => {
    const { container, host } = await mount();
    container.querySelector<HTMLButtonElement>('[data-restore-models]')?.click();
    await flush();
    submit(container); await flush();
    expect(host.writes[0]?.args.ops).toEqual([{ op: 'unset', path: ['providers', 'test', 'models'] }]);
    expect(host.profile.models).toBeUndefined();
  });
  it('loads and saves an endpoint without changing the masked credential', async () => {
    const { container, host, changed } = await mount();
    input(container, 'https://new.example/v1');
    submit(container);
    await flush();
    expect(host.writes).toHaveLength(1);
    expect(host.writes[0]?.args.ops).toEqual([{ op: 'set', path: ['providers', 'test', 'baseURL'], value: 'https://new.example/v1' }]);
    expect(changed).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('kimiWeb.providers.saved');
  });
  it('keeps the draft after a rejected save and refreshes the authoritative revision', async () => {
    const { container, host, changed } = await mount();
    input(container, 'https://draft.example/v1');
    host.bumpRevision();
    host.profile.models = [{ id: 'server-added-model' }];
    submit(container);
    await flush();
    expect(container.querySelector<HTMLInputElement>('[data-field="baseURL"]')?.value).toBe('https://draft.example/v1');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
    submit(container);
    await flush();
    expect(host.writes[1]?.args.expectedRevision).toBe(4);
    expect(host.profile.models).toEqual([{ id: 'server-added-model' }]);
    expect(changed).toHaveBeenCalledOnce();
  });
  it('shows transport failures and preserves a rejected draft', async () => {
    const { container, host } = await mount();
    input(container, 'https://draft.example/v1');
    host.call.mockRejectedValueOnce(new DshRpcError('Unavailable', { code: 'network-failure' }));
    submit(container);
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Unavailable');
    expect(container.querySelector<HTMLInputElement>('[data-field="baseURL"]')?.value).toBe('https://draft.example/v1');
  });
  it('ignores a pending save after the rpc client changes', async () => {
    const { container, host, rpc, changed } = await mount();
    let finish: (() => void) | undefined;
    host.call.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ revision: 4 }); }));
    input(container, 'https://old-client.example/v1');
    submit(container);
    await flush();
    const nextHost = providerHarness();
    nextHost.profile.baseURL = 'https://current-client.example/v1';
    rpc.value = { call: nextHost.call, callMultipart: vi.fn(), nextRpcId: vi.fn() };
    await flush();
    finish?.();
    await flush();
    expect(container.querySelector<HTMLInputElement>('[data-field="baseURL"]')?.value).toBe('https://current-client.example/v1');
    expect(changed).not.toHaveBeenCalled();
  });
  it('does not emit completion after unmount while saving', async () => {
    const { container, host, changed, dispose } = await mount();
    let finish: (() => void) | undefined;
    host.call.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ revision: 4 }); }));
    input(container, 'https://draft.example/v1');
    submit(container);
    await flush();
    dispose();
    finish?.();
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });
});
