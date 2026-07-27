import { createApp, nextTick, ref, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import CodexConfigViewer from './CodexConfigViewer.vue';

const mountedApps: VueApp[] = [];

function mountViewer() {
  const api = {
    connected: ref(true),
    config: ref({ config: {}, layers: [] }),
    configLoading: ref(false),
    externalAgentConfigItems: ref([]),
    externalAgentConfigLoading: ref(false),
    externalAgentImportStatus: ref(null),
    refreshConfig: vi.fn(),
    detectExternalAgentConfig: vi.fn(),
    importExternalAgentConfig: vi.fn(),
  } as unknown as ReturnType<typeof useCodexApi>;
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(CodexConfigViewer, { api });
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          common: { loading: 'Loading', processing: 'Processing' },
          codexPanel: {
            configTitle: 'Configuration',
            configRefresh: 'Refresh',
            configIncludeLayers: 'Include layers',
            configNoConfig: 'No config',
            configMerged: 'Merged',
            configLayers: 'Layers',
            externalAgentConfigTitle: 'External agent configuration',
            includeHome: 'Include home',
            detect: 'Detect',
            externalAgentConfigNoItems: 'Nothing detected',
            connectToLoad: 'Connect to load',
          },
        },
      },
    }),
  );
  mountedApps.push(app);
  app.mount(target);
  return target;
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexConfigViewer', () => {
  it('opens the existing external-agent import surface from the config viewer', async () => {
    const target = mountViewer();
    const header = Array.from(target.querySelectorAll<HTMLElement>('.codex-config-section-header')).find(
      (candidate) => candidate.textContent?.includes('External agent configuration'),
    );

    expect(header).toBeDefined();
    header?.click();
    await nextTick();

    expect(target.textContent).toContain('Detect');
  });
});
