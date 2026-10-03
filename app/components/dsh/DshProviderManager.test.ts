// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { providerHarness } from '../../backends/dsh/dshProviderConfig.fixtures';
import { buttonByText, changeCheckbox, expandProviderList, flushUi, mountProviderManager, openCodeBackend, requireElement, setProviderBackend } from '../providerManagerModal.test-helpers';

async function mount(disabled = false) {
  const host = providerHarness();
  setProviderBackend(openCodeBackend());
  const modal = await mountProviderManager({
    backendKind: 'dsh', dshRpcClient: { call: host.call, callMultipart: vi.fn(), nextRpcId: vi.fn() },
    providers: [{ id: 'test', name: 'Test provider', models: { 'model-a': { id: 'model-a', name: 'Model A' } } }],
    providerConfig: disabled ? { disabled_providers: ['test'] } : null,
    connectedProviderIds: ['test'], selectedModel: 'test/model-a', hiddenModels: ['test/model-a'],
  });
  await modal.setOpen(true);
  await vi.waitFor(() => expect(modal.host.querySelector('[data-dsh-provider-settings]')).not.toBeNull());
  return { ...modal, runtime: host };
}
it('uses the same shared provider tabs, installed rows and discovery catalog as other backends', async () => {
  const { host } = await mount();
  expect(host.querySelectorAll('.provider-manager-tab')).toHaveLength(2);
  expect(host.querySelector('.provider-list-row')?.textContent).toContain('Test provider');
  expect(host.querySelector('.provider-rail')).toBeNull();
  expect(host.querySelector('.model-rail')).toBeNull();
  expect(host.querySelector('form')).toBeNull();
  await expandProviderList(host);
  expect(host.querySelector('.custom-provider-entry')).not.toBeNull();
  expect(host.querySelector('.provider-mini-row')).not.toBeNull();
  expect(host.querySelector('select')).toBeNull();
});
it('opens native DSH configuration in a secondary view and keeps the key when editing endpoint', async () => {
  const { host, runtime, events } = await mount();
  requireElement<HTMLButtonElement>(host, '[data-dsh-provider-settings]').click();
  await vi.waitFor(() => expect(host.querySelector('.dsh-provider-settings [data-field="baseURL"]')).not.toBeNull());
  const input = requireElement<HTMLInputElement>(host, '.dsh-provider-settings [data-field="baseURL"]');
  input.value = 'https://new.example/v1'; input.dispatchEvent(new Event('input', { bubbles: true }));
  requireElement<HTMLFormElement>(host, '.dsh-provider-settings form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(events.providersChanged).toHaveBeenCalledOnce());
  expect(runtime.writes).toEqual([{ method: 'settings/mutate', args: { ns: 'custom-ns', expectedRevision: 3, ops: [{ op: 'set', path: ['providers', 'test', 'baseURL'], value: 'https://new.example/v1' }] } }]);
  expect(host.querySelector('.dsh-provider-settings')).not.toBeNull();
  expect(host.querySelectorAll('dialog')).toHaveLength(1);
  expect(host.querySelector('.provider-sections')).toBeNull();
  requireElement<HTMLButtonElement>(host, '[data-provider-back]').click(); await flushUi();
  expect(host.querySelector('.dsh-provider-settings')).toBeNull();
  expect(host.querySelector('.provider-list-row')).not.toBeNull();
});
it('uses the shared model tab and visibility event without DSH settings writes', async () => {
  const { host, runtime, events } = await mount();
  buttonByText(host, 'Model management').click(); await flushUi();
  expect(host.querySelector('.model-toolbar')).not.toBeNull();
  expect(host.querySelector('.model-group .model-row.is-selected')).not.toBeNull();
  const input = requireElement<HTMLInputElement>(host, '.model-row .toggle-input');
  expect(input.checked).toBe(false);
  changeCheckbox(input, true);
  expect(events.modelVisibility).toHaveBeenCalledWith([]);
  expect(runtime.writes).toHaveLength(0);
});
it('opens the shared custom-provider entry in a secondary provider view', async () => {
  const { host } = await mount();
  await expandProviderList(host);
  requireElement<HTMLButtonElement>(host, '.custom-provider-entry button').click();
  await vi.waitFor(() => expect(host.querySelector('.dsh-custom-provider-settings')).not.toBeNull());
  expect(host.querySelector('.dsh-custom-provider-settings [data-custom-field="id"]')).not.toBeNull();
  expect(host.querySelector('.dsh-custom-provider-settings select')).toBeNull();
  expect(host.querySelectorAll('dialog')).toHaveLength(1);
  expect(host.querySelector('.provider-sections')).toBeNull();
  requireElement<HTMLButtonElement>(host, '[data-provider-back]').click(); await flushUi();
  expect(host.querySelector('.dsh-custom-provider-settings')).toBeNull();
  expect(host.querySelector('.provider-sections')).not.toBeNull();
});
it('connects an undeclared native catalog provider through settings, without generic auth writes', async () => {
  const runtime = providerHarness();
  const original = runtime.call.getMockImplementation();
  if (!original) throw new Error('Missing native fixture');
  runtime.call.mockImplementation(async (ns, method, args) => {
    if (ns === 'llm') return [{ provider: 'available', displayName: 'Available provider', settingsNs: 'custom-ns', settingsPath: ['providers', 'available'], declared: false }];
    if (ns === 'credentials' && method === 'describe') return { AVAILABLE_API_KEY: { configured: false, writable: true } };
    return original(ns, method, args);
  });
  const backend = openCodeBackend(); setProviderBackend(backend);
  const modal = await mountProviderManager({ backendKind: 'dsh', dshRpcClient: { call: runtime.call, callMultipart: vi.fn(), nextRpcId: vi.fn() } });
  await modal.setOpen(true);
  await expandProviderList(modal.host);
  await vi.waitFor(() => expect(modal.host.querySelector('.provider-mini-row')?.textContent).toContain('Available provider'));
  requireElement<HTMLButtonElement>(modal.host, '.provider-mini-row button').click();
  await vi.waitFor(() => expect(modal.host.querySelector('.dsh-provider-settings [data-field="baseURL"]')).not.toBeNull());
  expect(modal.host.querySelector('.dsh-provider-settings')?.textContent).toContain('available');
  expect(backend.setProviderAuth).not.toHaveBeenCalled();
  expect(runtime.writes).toHaveLength(0);
});

it('shows the same disabled availability in installed rows and provider catalog', async () => {
  const { host } = await mount(true);
  expect(host.querySelector('.provider-list-row .status-badge')?.textContent).toBe('Disabled');
  await expandProviderList(host);
  const badge = host.querySelector('.provider-mini-row .status-badge');
  expect(badge?.textContent).toBe('Disabled');
  expect(badge?.classList.contains('is-disabled')).toBe(true);
});

it('leaves the provider secondary view when switching to the shared model tab', async () => {
  const { host } = await mount();
  requireElement<HTMLButtonElement>(host, '[data-dsh-provider-settings]').click();
  await vi.waitFor(() => expect(host.querySelector('.dsh-provider-settings')).not.toBeNull());
  buttonByText(host, 'Model management').click(); await flushUi();
  expect(host.querySelector('.dsh-provider-settings')).toBeNull();
  expect(host.querySelector('.model-toolbar')).not.toBeNull();
  buttonByText(host, 'Provider management').click(); await flushUi();
  expect(host.querySelector('.provider-sections')).not.toBeNull();
});
