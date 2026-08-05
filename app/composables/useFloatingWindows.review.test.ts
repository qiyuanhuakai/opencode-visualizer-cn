import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('useFloatingWindows review regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('rebuilds visible entries after every asynchronous closeAll hook finishes', async () => {
    // Given: closeAll includes a window whose beforeClose is still pending
    const mounted = mountFloatingWindows();
    let finishClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    await mounted.api.open('slow-close', {
      beforeClose: () => closeGate,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    await mounted.api.open('fast-close', { expiresAt: Number.MAX_SAFE_INTEGER });

    // When: the asynchronous close completes after closeAll has started
    const closing = mounted.api.closeAll();
    finishClose?.();
    await closing;

    // Then: canonical state and the rendered entries projection are both empty
    expect(mounted.api.has('slow-close')).toBe(false);
    expect(mounted.api.has('fast-close')).toBe(false);
    expect(mounted.api.entries.value).toEqual([]);
    mounted.unmount();
  });

  it('prevents closeAll from being undone by an earlier pending open', async () => {
    // Given: a window open is suspended before its entry is committed
    const mounted = mountFloatingWindows();
    let finishOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const opening = mounted.api.open('pending-open', {
      beforeOpen: () => openGate,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    await Promise.resolve();

    // When: closeAll runs after open started but before beforeOpen resolves
    const closing = mounted.api.closeAll();
    finishOpen?.();
    await Promise.all([opening, closing]);

    // Then: the earlier open cannot resurrect a window after closeAll
    expect(mounted.api.has('pending-open')).toBe(false);
    expect(mounted.api.entries.value).toEqual([]);
    mounted.unmount();
  });

  it('does not let initial asynchronous content overwrite a newer setContent value', async () => {
    // Given: initial function content is still resolving after the window opens
    const mounted = mountFloatingWindows();
    let finishInitial: ((value: string) => void) | undefined;
    const initialContent = new Promise<string>((resolve) => {
      finishInitial = resolve;
    });
    await mounted.api.open('content-race', {
      content: () => initialContent,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });

    // When: setContent publishes a newer value before the initial content resolves
    await mounted.api.setContent('content-race', 'new content');
    finishInitial?.('stale content');
    await initialContent;
    await Promise.resolve();

    // Then: the newer content remains authoritative
    expect(mounted.api.get('content-race')?.resolvedHtml).toBe('new content');
    mounted.unmount();
  });

  it('initializes each omitted position axis independently', async () => {
    // Given: deterministic random placement in a positive floating extent
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(800, 600);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // When: separate windows provide only x or only y
    await mounted.api.open('x-only', {
      x: 40,
      width: 300,
      height: 200,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    await mounted.api.open('y-only', {
      y: 50,
      width: 300,
      height: 200,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });

    // Then: the provided axis is preserved and the omitted axis is finite
    expect(mounted.api.get('x-only')).toMatchObject({ x: 40, y: 20 });
    expect(mounted.api.get('y-only')).toMatchObject({ x: 20, y: 50 });
    mounted.unmount();
  });
});
