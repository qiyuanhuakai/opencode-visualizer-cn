import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';
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

function mountWindowBody(key: string): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-floating-key', key);
  const body = document.createElement('div');
  body.className = 'floating-window-body';
  body.tabIndex = 0;
  host.appendChild(body);
  document.body.appendChild(host);
  return body;
}

describe('useFloatingWindows explicit activation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('restores a minimized window and brings it forward on explicit activation', async () => {
    // Given: a minimized manual panel sits behind a later window
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('codex-panel', {
      title: 'Panel',
      closable: true,
      expiry: Infinity,
    });
    await mounted.api.open('codex-models', {
      title: 'Models',
      closable: true,
      expiry: Infinity,
    });
    mounted.api.minimize('codex-panel');
    const behindZ = mounted.api.get('codex-models')?.zIndex;

    // When: the user explicitly reopens the existing panel
    mounted.api.activate('codex-panel');

    // Then: the panel leaves the dock and stacks above the later window
    expect(mounted.api.get('codex-panel')).toMatchObject({ minimized: false });
    expect(mounted.api.get('codex-panel')?.zIndex).toBeGreaterThan(behindZ ?? 0);
    mounted.unmount();
  });

  it('brings an already visible existing window forward on explicit activation', async () => {
    // Given: two visible manual windows where the later one is on top
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('codex-panel', {
      title: 'Panel',
      closable: true,
      expiry: Infinity,
    });
    await mounted.api.open('codex-config', {
      title: 'Config',
      closable: true,
      expiry: Infinity,
    });
    const topZ = mounted.api.get('codex-config')?.zIndex ?? 0;

    // When: the user explicitly reopens the earlier window
    mounted.api.activate('codex-panel');

    // Then: the earlier window rises above the previously topmost window
    expect(mounted.api.get('codex-panel')?.zIndex).toBeGreaterThan(topZ);
    mounted.unmount();
  });

  it('focuses the floating window body on explicit activation', async () => {
    // Given: a rendered manual panel whose body is in the document
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('codex-panel', {
      title: 'Panel',
      closable: true,
      expiry: Infinity,
    });
    const body = mountWindowBody('codex-panel');
    mounted.api.minimize('codex-panel');

    // When: the user explicitly reopens the panel and the DOM settles
    mounted.api.activate('codex-panel');
    await nextTick();

    // Then: keyboard focus lands inside the restored panel body
    expect(document.activeElement).toBe(body);
    mounted.unmount();
  });

  it('does not re-resolve content or reset user geometry on explicit activation', async () => {
    // Given: an existing panel with resolved content and user-controlled geometry
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('codex-panel', {
      title: 'Panel',
      content: 'resolved content',
      closable: true,
      expiry: Infinity,
    });
    mounted.api.updateOptions('codex-panel', { x: 340, y: 260, width: 900, height: 620 });
    mounted.api.minimize('codex-panel');

    // When: the user explicitly reopens the panel
    mounted.api.activate('codex-panel');

    // Then: content and geometry stay exactly as the user left them
    expect(mounted.api.get('codex-panel')).toMatchObject({
      resolvedHtml: 'resolved content',
      x: 340,
      y: 260,
      width: 900,
      height: 620,
      minimized: false,
    });
    mounted.unmount();
  });

  it('preserves explicit activation while an older open is pending', async () => {
    // Given: a background update is waiting while another window sits above it.
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('codex-models', { closable: true, expiry: Infinity });
    await mounted.api.open('codex-panel', { closable: true, expiry: Infinity });
    const pending = Promise.withResolvers<void>();
    const update = mounted.api.open('codex-models', { beforeOpen: () => pending.promise });

    // When: explicit activation races with completion of that update.
    mounted.api.activate('codex-models');
    const activatedZ = mounted.api.get('codex-models')?.zIndex;
    pending.resolve();
    await update;

    // Then: the stale update cannot put the activated window behind its sibling.
    expect(mounted.api.get('codex-models')?.zIndex).toBe(activatedZ);
    expect(mounted.api.get('codex-models')?.zIndex).toBeGreaterThan(
      mounted.api.get('codex-panel')?.zIndex ?? 0,
    );
    mounted.unmount();
  });

  it('does not steal focus when an existing window is refreshed through open', async () => {
    // Given: a rendered existing panel whose body could receive focus
    const mounted = mountFloatingWindows();
    mounted.api.setExtent(1280, 720);
    await mounted.api.open('stream-window', {
      title: 'Stream',
      closable: true,
      focusOnOpen: true,
      expiry: Infinity,
    });
    const body = mountWindowBody('stream-window');

    // When: an automatic streaming update reopens the same key with focusOnOpen
    await mounted.api.open('stream-window', { title: 'Stream updated' });
    await nextTick();

    // Then: the update cannot move keyboard focus into the window
    expect(document.activeElement).not.toBe(body);
    mounted.unmount();
  });
});
