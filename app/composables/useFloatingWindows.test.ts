import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { getFloatingWindowDragBounds, useFloatingWindows } from './useFloatingWindows';

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

    // Then: the created geometry fits entirely inside the mobile canvas
    expect(mounted.api.get('mobile-window')).toMatchObject({
      x: 0,
      y: 0,
      width: 375,
      height: 500,
    });
    mounted.unmount();
  });

  it('restores creation geometry after a zero-height loading extent becomes ready', async () => {
    // Given: a terminal opens before the floating canvas has measurable height
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 0);
    await mounted.api.open('loading-window', {
      width: 600,
      height: 400,
      x: 100,
      y: 100,
      expiry: Infinity,
    });

    // When: page layout reports its first positive floating extent
    mounted.api.setExtent(375, 500);

    // Then: one deferred creation layout restores a visible, usable window
    expect(mounted.api.get('loading-window')).toMatchObject({
      x: 0,
      y: 100,
      width: 375,
      height: 400,
    });
    mounted.unmount();
  });

  it('uses the latest extent when loading finishes before the window mounts', async () => {
    // Given: asynchronous terminal setup starts while the canvas extent is zero
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 0);
    let finishSetup: (() => void) | undefined;
    const setupGate = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const opening = mounted.api.open('async-loading-window', {
      width: 600,
      height: 400,
      x: 100,
      y: 100,
      expiry: Infinity,
      beforeOpen: () => setupGate,
    });

    // When: layout becomes ready before asynchronous setup completes
    mounted.api.setExtent(375, 500);
    if (!finishSetup) throw new Error('Expected beforeOpen setup gate.');
    finishSetup();
    await opening;

    // Then: mounting uses the latest positive extent instead of stale zero geometry
    expect(mounted.api.get('async-loading-window')).toMatchObject({
      x: 0,
      y: 100,
      width: 375,
      height: 400,
    });
    mounted.unmount();
  });

  it('preserves an existing window position when the viewport narrows', async () => {
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

    // Then: viewport changes do not override the user-controlled position
    expect(mounted.api.get('responsive-window')).toMatchObject({ x: 500, y: 100 });
    mounted.unmount();
  });

  it('preserves a desktop window position in a tablet viewport', async () => {
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

    // Then: the window remains where the user left it
    expect(mounted.api.get('tablet-window')).toMatchObject({ x: 520, y: 200 });
    mounted.unmount();
  });

  it('allows dragging beyond the canvas while keeping the titlebar reachable', () => {
    // Given: a desktop-sized window and a mobile canvas
    const windowSize = { width: 760, height: 560 };
    const extent = { width: 375, height: 500 };

    // When: drag bounds are calculated
    const bounds = getFloatingWindowDragBounds(windowSize, extent);

    // Then: most of the window may leave the canvas but 32px of titlebar stays reachable
    expect(bounds).toEqual({ minX: -728, maxX: 343, minY: 0, maxY: 468 });
  });

  it('preserves explicit position updates outside the canvas', async () => {
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

    // Then: updateOptions retains the requested user-controlled position
    expect(mounted.api.get('updated-window')).toMatchObject({ x: 900, y: 700 });
    mounted.unmount();
  });

  it('preserves an existing off-canvas position when opening the same key again', async () => {
    // Given: an existing window has been moved outside the canvas
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);
    await mounted.api.open('reopened-window', {
      width: 300,
      height: 300,
      x: 50,
      y: 100,
      expiry: Infinity,
    });
    mounted.api.updateOptions('reopened-window', { x: 340, y: 468 });

    // When: the same logical window is opened again to refresh its options
    await mounted.api.open('reopened-window', { title: 'Updated title' });

    // Then: reopening does not reinterpret the existing window as a new creation
    expect(mounted.api.get('reopened-window')).toMatchObject({ x: 340, y: 468 });
    mounted.unmount();
  });

  it('preserves off-canvas geometry when restoring a minimized window', async () => {
    // Given: a minimized window the user placed partly outside the current extent
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

    // Then: restore does not override the user-controlled position
    expect(mounted.api.get('restored-window')).toMatchObject({ x: 900, y: 700, minimized: false });
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
