import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import type { DshJsonValue } from '../../backends/dsh/types';
import DshSessionPlugins from './DshSessionPlugins.vue';
import { readSessionPluginPresets, type SessionPluginRpc } from './sessionPluginInventory';

const row = { entryId: 'tool', moduleName: '@test/tool', enabled: true, fiberPhase: null, meta: { title: { en: 'Tool', zh: '工具' } } };
const snapshot = { entries: [], agentPresets: [
  { id: 'standard', isDefault: true, rows: [row] },
  { id: 'minimal', isDefault: false, rows: [{ ...row, moduleName: '@test/minimal', enabled: 'conditional', condition: 'ctx.environment' }] },
] };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.unmount(); document.body.innerHTML = ''; });
function mount(rpc: SessionPluginRpc, initialPreset = 'standard') {
  const presetId = ref(initialPreset);
  const sessionId = ref('session-1');
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(DshSessionPlugins, { rpc, presetId: presetId.value, sessionId: sessionId.value }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } })); app.mount(root); apps.push(app);
  return { root, presetId, sessionId };
}
it('shows preset composition count and configuration without exposing runtime activation controls', async () => {
  const call = vi.fn(async () => snapshot);
  const { root } = mount({ call });
  await vi.waitFor(() => expect(root.textContent).toContain('Session plugins (1)'));
  expect(call).toHaveBeenCalledWith('pluginInventory', 'list', {});
  expect(root.textContent).toContain('session-1');
  expect(root.textContent).toContain('Tool');
  expect(root.textContent).toContain('Enabled in preset');
  expect(root.querySelector('input[type="checkbox"]')).toBeNull();
  expect(root.querySelector('[data-session-plugin="@test/minimal"]')).toBeNull();
});
it('does not mislabel the default composition as an unknown session preset', async () => {
  const { root } = mount({ call: async () => snapshot }, 'missing');
  await vi.waitFor(() => expect(root.textContent).toContain('preset is unresolved'));
  expect(root.querySelector('[data-session-plugin]')).toBeNull();
});
it('discards in-flight inventory after switching sessions and shows conditional states', async () => {
  let resolveFirst: (value: DshJsonValue) => void = () => { throw new Error('Read not started'); };
  const first = new Promise<DshJsonValue>((resolve) => { resolveFirst = resolve; });
  const call = vi.fn().mockReturnValueOnce(first).mockResolvedValue(snapshot);
  const { root, presetId, sessionId } = mount({ call });
  presetId.value = 'minimal'; sessionId.value = 'session-2';
  await vi.waitFor(() => expect(root.textContent).toContain('Conditional'));
  resolveFirst({ entries: [], agentPresets: [] });
  await vi.waitFor(() => expect(root.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false'));
  expect(root.textContent).toContain('session-2');
  expect(root.textContent).toContain('ctx.environment');
  expect(root.querySelector('[data-session-plugin="@test/minimal"]')).not.toBeNull();
});
it('shows errors distinctly and allows retry', async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error('inventory unavailable')).mockResolvedValue(snapshot);
  const { root } = mount({ call });
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe('inventory unavailable'));
  root.querySelector('button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Session plugins (1)'));
  expect(root.querySelector('[role="alert"]')).toBeNull();
});
it('rejects malformed enabled states instead of treating them as enabled', async () => {
  await expect(readSessionPluginPresets({ call: async () => ({ entries: [], agentPresets: [{ id: 'standard', isDefault: true, rows: [{ ...row, enabled: 'yes' }] }] }) })).rejects.toThrow('Invalid DSH');
});
it('reports broken presets with their real zero count', async () => {
  const { root } = mount({ call: async () => ({ entries: [], agentPresets: [{ id: 'standard', isDefault: true, broken: 'Composition dependency missing', rows: [] }] }) });
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe('Composition dependency missing'));
  expect(root.textContent).toContain('Session plugins (0)');
});
