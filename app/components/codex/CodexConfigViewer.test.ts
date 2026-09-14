import { computed, createApp, nextTick, ref, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import type { CodexExternalAgentConfigItem } from '../../backends/codex/codexAdapter';
import CodexConfigViewer from './CodexConfigViewer.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const mountedApps: VueApp[] = [];

type ViewerApi = Pick<
  ReturnType<typeof useCodexApi>,
  | 'connected'
  | 'config'
  | 'configLoading'
  | 'externalAgentConfigItems'
  | 'externalAgentConfigLoading'
  | 'externalAgentImportStatus'
  | 'refreshConfig'
  | 'detectExternalAgentConfig'
  | 'importExternalAgentConfig'
>;

type ImportResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

type CodexApiFakeOptions = {
  readonly connected?: boolean;
  readonly detectedItems?: readonly CodexExternalAgentConfigItem[];
  readonly initialItems?: readonly CodexExternalAgentConfigItem[];
  readonly importResult?: ImportResult;
};

const claudeConfig: CodexExternalAgentConfigItem = {
  itemType: 'CONFIG',
  description: 'Claude provider config',
  cwd: '/workspace/project',
};

const cursorAgents: CodexExternalAgentConfigItem = {
  itemType: 'AGENTS_MD',
  description: 'Cursor AGENTS.md',
  cwd: '/workspace/project/subdir',
};

function createCodexApiFake(options: CodexApiFakeOptions = {}) {
  const connectedState = ref(options.connected ?? true);
  const connected = computed(() => connectedState.value);
  const config = ref({ config: {}, layers: [] });
  const configLoading = ref(false);
  const externalAgentConfigItems = ref<CodexExternalAgentConfigItem[]>([
    ...(options.initialItems ?? []),
  ]);
  const externalAgentConfigLoading = ref(false);
  const externalAgentImportStatus = ref<{ success: boolean; error?: string } | null>(null);
  let detectedItems = [...(options.detectedItems ?? [])];
  const importResult = options.importResult ?? { success: true };

  const refreshConfig = vi.fn(async () => {
    config.value = { config: { imported: true }, layers: [] };
  });
  const detectExternalAgentConfig = vi.fn(async (_includeHome?: boolean, _cwds?: string[]) => {
    if (!connected.value) throw new Error('Codex is not connected.');
    externalAgentConfigLoading.value = true;
    try {
      externalAgentConfigItems.value = [...detectedItems];
      return { items: externalAgentConfigItems.value };
    } finally {
      externalAgentConfigLoading.value = false;
    }
  });
  const importExternalAgentConfig = vi.fn(async (_items: CodexExternalAgentConfigItem[]) => {
    if (!connected.value) throw new Error('Codex is not connected.');
    externalAgentImportStatus.value = null;
    if (!importResult.success) {
      externalAgentImportStatus.value = { success: false, error: importResult.error };
      throw new Error(importResult.error);
    }
    externalAgentImportStatus.value = { success: true };
    return {};
  });

  const api: ViewerApi = {
    connected,
    config,
    configLoading,
    externalAgentConfigItems,
    externalAgentConfigLoading,
    externalAgentImportStatus,
    refreshConfig,
    detectExternalAgentConfig,
    importExternalAgentConfig,
  };

  function setDetectedItems(items: readonly CodexExternalAgentConfigItem[]) {
    detectedItems = [...items];
  }

  return { api, detectExternalAgentConfig, importExternalAgentConfig, setDetectedItems };
}

function mountViewer(api: ViewerApi = createCodexApiFake().api) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(CodexConfigViewer, { api });
  mountedApps.push(app);
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
            import_: 'Import',
            importSuccess: 'Imported successfully',
            connectToLoad: 'Connect to load',
          },
        },
      },
    }),
  );
  app.mount(target);
  return target;
}

async function openExternalAgentConfig(target: HTMLElement) {
  const header = Array.from(
    target.querySelectorAll<HTMLElement>('.codex-config-section-header'),
  ).find((candidate) => candidate.textContent?.includes('External agent configuration'));

  expect(header).toBeDefined();
  header?.click();
  await flushVueUpdates();
}

async function flushVueUpdates() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function buttonWithText(target: HTMLElement, text: string) {
  const button = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  expect(button).toBeDefined();
  return button;
}

function rowWithText(target: HTMLElement, text: string) {
  const row = Array.from(
    target.querySelectorAll<HTMLElement>('.codex-external-agent-config-item'),
  ).find((candidate) => candidate.textContent?.includes(text));
  expect(row).toBeDefined();
  return row;
}

function includeHomeCheckbox(target: HTMLElement) {
  const checkbox = target.querySelector<HTMLInputElement>(
    '.codex-toggle-label input[type="checkbox"]',
  );
  expect(checkbox).toBeDefined();
  return checkbox;
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexConfigViewer', () => {
  it('opens the existing external-agent import surface from the config viewer', async () => {
    const target = mountViewer();
    const header = Array.from(
      target.querySelectorAll<HTMLElement>('.codex-config-section-header'),
    ).find((candidate) => candidate.textContent?.includes('External agent configuration'));

    expect(header).toBeDefined();
    header?.click();
    await nextTick();

    expect(target.textContent).toContain('Detect');
  });

  it('renders detected items, imports a selection, and refreshes the list on the next detect', async () => {
    const { api, detectExternalAgentConfig, importExternalAgentConfig, setDetectedItems } =
      createCodexApiFake({
        detectedItems: [claudeConfig, cursorAgents],
        importResult: { success: true },
      });
    const target = mountViewer(api);

    await openExternalAgentConfig(target);
    includeHomeCheckbox(target)?.click();
    await flushVueUpdates();
    buttonWithText(target, 'Detect')?.click();
    await flushVueUpdates();

    expect(detectExternalAgentConfig).toHaveBeenCalledWith(true);
    expect(rowWithText(target, 'Claude provider config')?.textContent).toContain(
      '/workspace/project',
    );
    expect(rowWithText(target, 'Cursor AGENTS.md')?.textContent).toContain(
      '/workspace/project/subdir',
    );

    rowWithText(target, 'Claude provider config')
      ?.querySelector<HTMLButtonElement>('button')
      ?.click();
    await flushVueUpdates();

    expect(importExternalAgentConfig).toHaveBeenCalledWith([claudeConfig]);
    expect(target.textContent).toContain('Imported successfully');
    expect(api.externalAgentConfigItems.value).toEqual([claudeConfig, cursorAgents]);
    expect(api.refreshConfig).not.toHaveBeenCalled();
    expect(target.textContent).toContain('Claude provider config');
    expect(target.textContent).toContain('Cursor AGENTS.md');

    setDetectedItems([cursorAgents]);
    buttonWithText(target, 'Detect')?.click();
    await flushVueUpdates();

    expect(detectExternalAgentConfig).toHaveBeenCalledTimes(2);
    expect(detectExternalAgentConfig).toHaveBeenLastCalledWith(true);
    expect(target.textContent).not.toContain('Claude provider config');
    expect(target.textContent).toContain('Cursor AGENTS.md');
  });

  it('shows the import request failure from the reactive API status', async () => {
    const { api, importExternalAgentConfig } = createCodexApiFake({
      initialItems: [claudeConfig],
      importResult: { success: false, error: 'Cannot import Claude provider config' },
    });
    const target = mountViewer(api);

    await openExternalAgentConfig(target);
    rowWithText(target, 'Claude provider config')
      ?.querySelector<HTMLButtonElement>('button')
      ?.click();
    await flushVueUpdates();

    expect(importExternalAgentConfig).toHaveBeenCalledWith([claudeConfig]);
    expect(target.textContent).toContain('Cannot import Claude provider config');
    expect(buttonWithText(target, 'Import')?.disabled).toBe(false);
  });

  it('shows disconnected feedback and disables external-agent actions', async () => {
    const { api, detectExternalAgentConfig } = createCodexApiFake({ connected: false });
    const target = mountViewer(api);

    await openExternalAgentConfig(target);

    expect(target.textContent).toContain('Connect to load');
    expect(includeHomeCheckbox(target)?.disabled).toBe(true);
    expect(buttonWithText(target, 'Detect')?.disabled).toBe(true);
    expect(detectExternalAgentConfig).not.toHaveBeenCalled();
  });
});
