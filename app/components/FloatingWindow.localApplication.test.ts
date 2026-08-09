import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFloatingWindows } from '../composables/useFloatingWindows';
import { useSettings } from '../composables/useSettings';
import FloatingWindow from './FloatingWindow.vue';

const mountedApps: Array<() => void> = [];
const TestContent = defineComponent(() => () => h('div', 'content'));

async function mountFileViewer() {
  const onOpenLocal = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = createApp(
    defineComponent({
      setup() {
        const manager = useFloatingWindows();
        void manager.open('file-viewer:test.ts', {
          component: TestContent,
          props: { fileContent: 'content', fileSizeBytes: 7, canEditInVis: true },
          expiry: Infinity,
        });
        return () =>
          manager.entries.value.map((entry) =>
            h(FloatingWindow, {
              entry,
              manager,
              onOpenLocal,
            }),
          );
      },
    }),
  );
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          floatingWindow: {
            tool: 'Tool',
            minimizeWindow: 'Minimize',
            openInEditor: 'Open in editor',
            openInLocalApplication: 'Open locally',
            editInVis: 'Edit in Vis',
          },
        },
      },
    }),
  );
  app.mount(target);
  mountedApps.push(() => {
    app.unmount();
    target.remove();
  });
  await nextTick();
  return { target, onOpenLocal };
}

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  useSettings().localApplicationPath.value = '';
  useSettings().editInVis.value = false;
  Reflect.deleteProperty(window, 'electronAPI');
  document.body.innerHTML = '';
});

describe('FloatingWindow local application action', () => {
  it('does not render the action in the web runtime', async () => {
    useSettings().localApplicationPath.value = '/bin/true';
    useSettings().editInVis.value = true;

    const mounted = await mountFileViewer();

    expect(mounted.target.querySelector('[title="Open locally"]')).toBeNull();
  });

  it('renders before Edit in Vis and emits only in Electron', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        localFile: {
          selectApplication: vi.fn(),
          clearApplication: vi.fn(),
          open: vi.fn(),
          close: vi.fn(),
          onChanged: vi.fn(),
          offChanged: vi.fn(),
          onError: vi.fn(),
          offError: vi.fn(),
        },
      },
    });
    useSettings().localApplicationPath.value = '/bin/true';
    useSettings().editInVis.value = true;

    const mounted = await mountFileViewer();
    const button = mounted.target.querySelector<HTMLButtonElement>('[title="Open locally"]');
    expect(button).not.toBeNull();
    const actionTitles = Array.from(
      mounted.target.querySelectorAll<HTMLButtonElement>('.window-actions > button'),
      (action) => action.title,
    );
    expect(actionTitles.indexOf('Open locally')).toBeLessThan(actionTitles.indexOf('Edit in Vis'));
    button?.click();
    expect(mounted.onOpenLocal).toHaveBeenCalledWith('file-viewer:test.ts');
  });

  it('does not depend on the Edit in Vis preference', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        localFile: {
          selectApplication: vi.fn(),
          clearApplication: vi.fn(),
          open: vi.fn(),
          close: vi.fn(),
          onChanged: vi.fn(),
          offChanged: vi.fn(),
          onError: vi.fn(),
          offError: vi.fn(),
        },
      },
    });
    useSettings().localApplicationPath.value = '/bin/true';
    useSettings().editInVis.value = false;

    const mounted = await mountFileViewer();

    expect(mounted.target.querySelector('[title="Open locally"]')).not.toBeNull();
    expect(mounted.target.querySelector('[title="Edit in Vis"]')).toBeNull();
  });
});
