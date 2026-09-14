// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFloatingWindows } from '../composables/useFloatingWindows';
import FloatingWindow from './FloatingWindow.vue';
import {
  cleanupFloatingWindowApps,
  emitPointer,
  FloatingWindowTestContent,
  registerFloatingWindowApp,
} from './floatingWindow.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

afterEach(() => {
  cleanupFloatingWindowApps();
});

async function mountFloatingWindow(): Promise<{
  target: HTMLDivElement;
  manager: ReturnType<typeof useFloatingWindows>;
}> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let manager: ReturnType<typeof useFloatingWindows> | undefined;
  const Root = defineComponent({
    setup() {
      manager = useFloatingWindows();
      return () => {
        const activeManager = manager;
        if (!activeManager) return null;
        return activeManager.entries.value.map((entry) =>
          h(FloatingWindow, { key: entry.key, entry, manager: activeManager }),
        );
      };
    },
  });
  const app = createApp(Root);
  registerFloatingWindowApp(app, target);
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { floatingWindow: { tool: 'Tool', minimizeWindow: 'Minimize' } } },
    }),
  );
  app.mount(target);
  if (!manager) throw new Error('Floating-window manager did not initialize.');
  manager.setExtent(375, 500);
  await manager.open('gesture-window', {
    component: FloatingWindowTestContent,
    width: 300,
    height: 300,
    x: 50,
    y: 100,
    resizable: true,
  });
  await nextTick();
  const windowElement = target.querySelector<HTMLElement>('.floating-window');
  if (!windowElement) throw new Error('Floating window did not render.');
  if (!windowElement.setPointerCapture) windowElement.setPointerCapture = () => undefined;
  if (!windowElement.releasePointerCapture) windowElement.releasePointerCapture = () => undefined;
  windowElement.getBoundingClientRect = () =>
    ({ left: 50, top: 100, right: 350, bottom: 400, width: 300, height: 300 }) as DOMRect;
  return { target, manager };
}

describe('FloatingWindow pointer ownership', () => {
  it('ignores movement from a pointer that does not own the drag', async () => {
    // Given: pointer 1 owns an active titlebar drag
    const mounted = await mountFloatingWindow();
    const titlebar = mounted.target.querySelector<HTMLElement>('.floating-window-titlebar');
    if (!titlebar) throw new Error('Expected floating window titlebar.');
    emitPointer(titlebar, 'pointerdown', 60, 110, 1);

    // When: pointer 2 moves while pointer 1 remains the owner
    emitPointer(titlebar, 'pointermove', 460, 110, 2);
    emitPointer(titlebar, 'pointerup', 60, 110, 1);

    // Then: the non-owner movement cannot change the window position
    expect(mounted.manager.get('gesture-window')).toMatchObject({ x: 50, y: 100 });
  });

  it('does not let a second pointer steal an active drag', async () => {
    // Given: pointer 1 starts a titlebar drag before pointer 2 presses
    const mounted = await mountFloatingWindow();
    const titlebar = mounted.target.querySelector<HTMLElement>('.floating-window-titlebar');
    if (!titlebar) throw new Error('Expected floating window titlebar.');
    emitPointer(titlebar, 'pointerdown', 60, 110, 1);
    emitPointer(titlebar, 'pointerdown', 200, 110, 2);

    // When: the original pointer moves by 40px and releases
    emitPointer(titlebar, 'pointermove', 100, 110, 1);
    emitPointer(titlebar, 'pointerup', 100, 110, 1);
    emitPointer(titlebar, 'pointercancel', 200, 110, 2);

    // Then: pointer 1 remains the owner and commits its exact movement
    expect(mounted.manager.get('gesture-window')).toMatchObject({ x: 90, y: 100 });
  });
});
