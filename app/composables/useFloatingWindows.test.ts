import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { useFloatingWindows } from './useFloatingWindows';

function mountFloatingWindows() {
  let api: ReturnType<typeof useFloatingWindows> | undefined;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        api = useFloatingWindows();
        return () => null;
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(root);
  if (!api) throw new Error('Floating window composable did not mount.');
  return {
    api,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

describe('useFloatingWindows responsive geometry', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps an oversized window inside a narrow viewport when opening', async () => {
    // Given: a mobile-sized floating canvas
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);

    // When: a desktop-sized window opens with stale desktop coordinates
    await mounted.api.open('mobile-window', {
      width: 760,
      height: 560,
      x: 900,
      y: 700,
      expiry: Infinity,
    });

    // Then: the rendered window origin stays inside the mobile canvas
    expect(mounted.api.get('mobile-window')).toMatchObject({ x: 0, y: 0 });
    mounted.unmount();
  });

  it('repositions an existing window when the viewport narrows', async () => {
    // Given: a visible window positioned near the right edge of a desktop canvas
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('responsive-window', {
      width: 760,
      height: 560,
      x: 500,
      y: 100,
      expiry: Infinity,
    });

    // When: the floating canvas shrinks to a mobile viewport
    mounted.api.setExtent(375, 500);

    // Then: the same window is immediately moved back into view
    expect(mounted.api.get('responsive-window')).toMatchObject({ x: 0, y: 0 });
    mounted.unmount();
  });
});
