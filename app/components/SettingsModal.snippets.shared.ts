import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import en from '../locales/en';

const fileExport = vi.hoisted(() => ({
  downloadJsonFile: vi.fn(),
  downloadTextFile: vi.fn(),
}));

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { 'data-icon': props.icon }),
}));
vi.mock('../utils/fileExport', () => fileExport);

export function getFileExport() {
  return fileExport;
}

export const initialSnippets = [
  {
    id: 'snippet-review',
    trigger: '::review',
    name: 'Review changes',
    body: 'Review the selected changes.',
    description: 'Checks correctness',
    enabled: true,
    tags: ['Review', 'Quality'],
  },
  {
    id: 'snippet-write',
    trigger: 'write',
    name: 'Write draft',
    body: 'Write a concise draft.',
    enabled: false,
    tags: ['Writing'],
  },
] as const;

interface SnippetSettingsFixture {
  readonly id: string;
  readonly trigger: string;
  readonly name: string;
  readonly body: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly tags: readonly string[];
}

export function encodeUtf8(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

export function createJsonFile(name: string, value: unknown): File {
  return new File([JSON.stringify(value)], name, { type: 'application/json' });
}

const mountedApps: Array<() => void> = [];

export async function mountSnippetSettings(
  snippets: readonly SnippetSettingsFixture[] = initialSnippets,
) {
  localStorage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(snippets));
  const [{ default: SettingsModal }, { i18n }, { useSettings }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
    import('../composables/useSettings'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const open = ref(true);
  const initialPage = ref<'transformers' | undefined>();
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(SettingsModal, {
            open: open.value,
            initialPage: initialPage.value,
            onClose: () => {
              open.value = false;
            },
          });
      },
    }),
  );
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  const link = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(en.settings.textTransformers.label),
  );
  expect(link).toBeDefined();
  link!.click();
  await nextTick();
  return {
    host,
    settings: useSettings(),
    reopenSnippets: async () => {
      open.value = false;
      await nextTick();
      initialPage.value = 'transformers';
      open.value = true;
      await nextTick();
    },
  };
}

export function inputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

export function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  inputValue(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function registerSnippetSettingsLifecycle() {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    Reflect.deleteProperty(window, 'electronAPI');
    fileExport.downloadJsonFile.mockReset();
    fileExport.downloadTextFile.mockReset();
  });

  afterEach(() => {
    while (mountedApps.length > 0) mountedApps.pop()?.();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });
}
