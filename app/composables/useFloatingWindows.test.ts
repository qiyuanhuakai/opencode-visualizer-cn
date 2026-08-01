import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { clampFloatingWindowPosition, useFloatingWindows } from './useFloatingWindows';

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

  it('repositions a desktop window inside a tablet viewport', async () => {
    // Given: a window at the right edge of a desktop canvas
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 900);
    await mounted.api.open('tablet-window', {
      width: 760,
      height: 560,
      x: 520,
      y: 200,
      expiry: Infinity,
    });

    // When: the canvas narrows to a 768px tablet viewport
    mounted.api.setExtent(768, 900);

    // Then: the complete window remains inside the available width
    expect(mounted.api.get('tablet-window')).toMatchObject({ x: 8, y: 200 });
    mounted.unmount();
  });

  it('clamps live drag coordinates to the visible extent', () => {
    // Given: a desktop-sized window in a mobile extent
    const extent = { width: 375, height: 500 };

    // When: pointer movement requests coordinates outside every edge
    const position = clampFloatingWindowPosition(900, -40, 760, 560, extent);

    // Then: the rendered origin cannot leave the extent
    expect(position).toEqual({ x: 0, y: 0 });
  });

  it('clamps size and position updates before rebuilding entries', async () => {
    // Given: a visible mobile window
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);
    await mounted.api.open('updated-window', {
      width: 300,
      height: 300,
      x: 50,
      y: 100,
      expiry: Infinity,
    });

    // When: an option update supplies stale desktop geometry
    mounted.api.updateOptions('updated-window', { width: 760, height: 560, x: 900, y: 700 });

    // Then: the updated window remains visible
    expect(mounted.api.get('updated-window')).toMatchObject({ x: 0, y: 0 });
    mounted.unmount();
  });

  it('clamps stale geometry when restoring a minimized window', async () => {
    // Given: a minimized window whose stored geometry is outside the current extent
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);
    await mounted.api.open('restored-window', {
      width: 300,
      height: 400,
      x: 50,
      y: 100,
      expiry: Infinity,
    });
    mounted.api.minimize('restored-window');
    const entry = mounted.api.get('restored-window');
    if (!entry) throw new Error('Expected restored-window entry.');
    entry.x = 900;
    entry.y = 700;

    // When: the window is restored
    mounted.api.restore('restored-window');

    // Then: its full rendered bounds are reachable again
    expect(mounted.api.get('restored-window')).toMatchObject({ x: 75, y: 100, minimized: false });
    mounted.unmount();
  });

  it('preserves window position through a transient zero-sized extent', async () => {
    // Given: a desktop window with a valid remembered position
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('observer-window', {
      width: 760,
      height: 560,
      x: 500,
      y: 100,
      expiry: Infinity,
    });

    // When: a ResizeObserver briefly reports zero before layout returns
    mounted.api.setExtent(0, 0);
    mounted.api.setExtent(1280, 720);

    // Then: the valid position is not permanently overwritten
    expect(mounted.api.get('observer-window')).toMatchObject({ x: 500, y: 100 });
    mounted.unmount();
  });
});
