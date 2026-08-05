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

function createGate() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release() {
      if (!release) throw new Error('Expected lifecycle gate.');
      release();
    },
  };
}

describe('useFloatingWindows async lifecycle', () => {
  afterEach(() => {
    document.body.innerHTML = '';
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
    const setup = createGate();
    const opening = mounted.api.open('async-loading-window', {
      width: 600,
      height: 400,
      x: 100,
      y: 100,
      expiry: Infinity,
      beforeOpen: () => setup.promise,
    });

    // When: layout becomes ready before asynchronous setup completes
    mounted.api.setExtent(375, 500);
    setup.release();
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

  it('does not resurrect a window closed while beforeOpen is pending', async () => {
    // Given: a new window is awaiting asynchronous setup
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);
    const setup = createGate();
    const opening = mounted.api.open('closed-pending-window', {
      beforeOpen: () => setup.promise,
      expiry: Infinity,
    });

    // When: the window closes before setup completes
    await mounted.api.close('closed-pending-window');
    setup.release();
    await opening;

    // Then: the obsolete open cannot mount the closed window
    expect(mounted.api.get('closed-pending-window')).toBeUndefined();
    mounted.unmount();
  });

  it('keeps the latest result when same-key opens complete out of order', async () => {
    // Given: two same-key opens await independent setup operations
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);
    const firstSetup = createGate();
    const secondSetup = createGate();
    const firstOpening = mounted.api.open('overlapping-window', {
      title: 'First',
      beforeOpen: () => firstSetup.promise,
      expiry: Infinity,
    });
    const secondOpening = mounted.api.open('overlapping-window', {
      title: 'Second',
      beforeOpen: () => secondSetup.promise,
      expiry: Infinity,
    });

    // When: the newer open completes before the older open
    secondSetup.release();
    await secondOpening;
    firstSetup.release();
    await firstOpening;

    // Then: the stale completion cannot overwrite the latest window
    expect(mounted.api.get('overlapping-window')).toMatchObject({ title: 'Second' });
    mounted.unmount();
  });

  it('preserves deferred layout when an awaited reopen finishes later', async () => {
    // Given: an existing zero-extent window is reopened with asynchronous setup
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 0);
    await mounted.api.open('reopened-pending-window', {
      width: 600,
      height: 400,
      x: 100,
      y: 100,
      expiry: Infinity,
    });
    const setup = createGate();
    const reopening = mounted.api.open('reopened-pending-window', {
      title: 'Updated',
      beforeOpen: () => setup.promise,
    });

    // When: positive layout calibrates the live entry before reopen completes
    mounted.api.setExtent(375, 500);
    setup.release();
    await reopening;

    // Then: stale pre-await geometry cannot overwrite the calibrated live geometry
    expect(mounted.api.get('reopened-pending-window')).toMatchObject({
      title: 'Updated',
      x: 0,
      y: 100,
      width: 375,
      height: 400,
    });
    mounted.unmount();
  });

  it('does not let a delayed close delete a newer same-key open', async () => {
    // Given: an existing window whose beforeClose is still pending
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(800, 600);
    const closeGate = createGate();
    await mounted.api.open('close-race', {
      title: 'Old',
      beforeClose: () => closeGate.promise,
      expiry: Infinity,
    });
    const closing = mounted.api.close('close-race');
    await Promise.resolve();

    // When: the same key is opened synchronously before the old close resumes
    await mounted.api.open('close-race', {
      title: 'New',
      beforeClose: undefined,
      expiry: Infinity,
    });
    closeGate.release();
    await closing;

    // Then: the old close cannot delete the newer entry
    expect(mounted.api.get('close-race')?.title).toBe('New');
    mounted.unmount();
  });

  it('keeps close authoritative over an earlier delayed reopen', async () => {
    // Given: a delayed reopen captured an existing desktop-sized window
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(375, 500);
    await mounted.api.open('recreate-race', {
      title: 'Old',
      x: 100,
      y: 100,
      width: 600,
      height: 400,
      expiry: Infinity,
    });
    const openGate = createGate();
    const reopening = mounted.api.open('recreate-race', {
      title: 'New',
      x: 100,
      width: 600,
      beforeOpen: () => openGate.promise,
      expiry: Infinity,
    });

    // When: the old entry closes before the delayed reopen commits
    await mounted.api.close('recreate-race');
    openGate.release();
    await reopening;

    // Then: the earlier pending reopen cannot resurrect the closed window
    expect(mounted.api.get('recreate-race')).toBeUndefined();
    mounted.unmount();
  });
});
