import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import type { BackendPluginManagementEntry, BackendPluginChange } from '../../backends/types';
import DshPluginManager from './DshPluginManager.vue';

const writable: BackendPluginManagementEntry = { id: 'tool', name: 'Test tool', moduleName: 'test/tool', enabled: false, phase: null, writable: true };
const protectedEntry: BackendPluginManagementEntry = { id: 'manager', name: 'Manager', moduleName: 'manager', enabled: true, phase: 'active', writable: false, readOnlyReason: 'management-required' };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.unmount(); document.body.innerHTML = ''; });
function mount(client: { getPluginManagementEntries(): Promise<BackendPluginManagementEntry[]>; setPluginEnabled(id: string, enabled: boolean): Promise<BackendPluginChange> }) {
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(DshPluginManager, { client }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } })); app.mount(root); apps.push(app);
  return root;
}
async function checkbox(root: HTMLElement, id = 'tool') {
  await vi.waitFor(() => expect(root.querySelector(`[data-plugin-id="${id}"] input`)).not.toBeNull());
  const input = root.querySelector(`[data-plugin-id="${id}"] input`);
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing checkbox');
  return input;
}
it('keeps protected inventory rows visible with disabled controls', async () => {
  const client = { getPluginManagementEntries: async () => [writable, protectedEntry], setPluginEnabled: vi.fn<() => Promise<BackendPluginChange>>() };
  const root = mount(client);
  expect((await checkbox(root, 'manager')).disabled).toBe(true);
  expect((await checkbox(root)).disabled).toBe(false);
  expect(client.setPluginEnabled).not.toHaveBeenCalled();
});
it('dispatches the entry ID and refetches authoritative state after a toggle', async () => {
  const getPluginManagementEntries = vi.fn().mockResolvedValueOnce([writable]).mockResolvedValueOnce([{ ...writable, enabled: true, phase: 'active' }]);
  const setPluginEnabled = vi.fn(async (): Promise<BackendPluginChange> => ({ changed: true, application: 'applied' }));
  const root = mount({ getPluginManagementEntries, setPluginEnabled });
  const input = await checkbox(root); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(getPluginManagementEntries).toHaveBeenCalledTimes(2));
  expect(setPluginEnabled).toHaveBeenCalledWith('tool', true);
  await vi.waitFor(() => expect(input.checked).toBe(true));
});
it('reports failure and retains the previous checkbox state', async () => {
  const root = mount({ getPluginManagementEntries: async () => [writable], setPluginEnabled: async () => { throw new Error('profile write denied'); } });
  const input = await checkbox(root); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe('profile write denied'));
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(false);
});
it('filters entries by module name without dropping protected inventory', async () => {
  const root = mount({ getPluginManagementEntries: async () => [writable, protectedEntry], setPluginEnabled: vi.fn<() => Promise<BackendPluginChange>>() });
  await checkbox(root);
  const search = root.querySelector('input[type="search"]');
  if (!(search instanceof HTMLInputElement)) throw new Error('Missing search');
  search.value = 'test/tool'; search.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
  expect(root.querySelectorAll('.plugin-row')).toHaveLength(1);
  expect(root.querySelector('.plugin-row')?.getAttribute('data-plugin-id')).toBe('tool');
});

it('keeps the observed enabled state when the change requires a restart', async () => {
  const root = mount({ getPluginManagementEntries: async () => [writable], setPluginEnabled: async () => ({ changed: true, application: 'restart-required' }) });
  const input = await checkbox(root); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain('restart'));
  expect(input.checked).toBe(false);
});
