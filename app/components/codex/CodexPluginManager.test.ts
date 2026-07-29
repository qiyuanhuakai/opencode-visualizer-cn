import { createApp, ref, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import CodexPluginManager from './CodexPluginManager.vue';

vi.mock('@iconify/vue', () => ({ Icon: { render: () => null } }));

const apps: VueApp[] = [];

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexPluginManager details', () => {
  it('reads and displays plugin detail from the card action', async () => {
    const readPlugin = vi.fn().mockResolvedValue({
      plugin: {
        marketplaceName: 'official',
        summary: { id: 'demo', name: 'demo', isEnabled: true, source: null },
        skills: [{ name: 'review', description: 'Review changes', path: '/skills/review', enabled: true }],
        apps: [],
        mcpServers: ['github'],
      },
    });
    const api = {
      connected: ref(true), pluginsLoading: ref(false),
      plugins: ref([{ id: 'demo', name: 'demo', isEnabled: true, state: 'installed', source: { type: 'remote' }, marketplaceName: 'official' }]),
      refreshPlugins: vi.fn(), addMarketplace: vi.fn(), installPlugin: vi.fn(), uninstallPlugin: vi.fn(), readPlugin,
    } as unknown as ReturnType<typeof useCodexApi>;
    const target = document.createElement('div');
    document.body.append(target);
    const app = createApp(CodexPluginManager, { api });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { common: { refresh: 'Refresh' }, codexPanel: { pluginsTitle: 'Plugins', pluginsInstalled: 'Installed', pluginDetails: 'Details', pluginBundledSkills: 'Skills', pluginBundledApps: 'Apps', pluginBundledMcp: 'MCP servers' } } } }));
    apps.push(app);
    app.mount(target);

    target.querySelector<HTMLButtonElement>('[data-plugin-details="demo"]')?.click();
    await vi.waitFor(() => expect(readPlugin).toHaveBeenCalledWith('demo', undefined, 'official'));
    await vi.waitFor(() => expect(target.textContent).toContain('review'));
    expect(target.textContent).toContain('github');
  });

  it('shows plugin/read failures on the affected card', async () => {
    const readPlugin = vi.fn().mockRejectedValue(new Error('Plugin not found'));
    const api = {
      connected: ref(true), pluginsLoading: ref(false),
      plugins: ref([{ id: 'missing', name: 'missing', isEnabled: false, source: { type: 'remote' }, marketplaceName: 'official' }]),
      refreshPlugins: vi.fn(), addMarketplace: vi.fn(), installPlugin: vi.fn(), uninstallPlugin: vi.fn(), readPlugin,
    } as unknown as ReturnType<typeof useCodexApi>;
    const target = document.createElement('div');
    document.body.append(target);
    const app = createApp(CodexPluginManager, { api });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { common: { refresh: 'Refresh' }, codexPanel: { pluginsTitle: 'Plugins', pluginsFeatured: 'Featured', pluginDetails: 'Details', pluginsInstall: 'Install' } } } }));
    apps.push(app);
    app.mount(target);

    target.querySelector<HTMLButtonElement>('[data-plugin-details="missing"]')?.click();

    await vi.waitFor(() => expect(target.textContent).toContain('Plugin not found'));
  });
});
