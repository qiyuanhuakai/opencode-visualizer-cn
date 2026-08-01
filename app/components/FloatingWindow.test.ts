import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { getFloatingWindowSnapPosition, useFloatingWindows } from '../composables/useFloatingWindows';
import FloatingWindow from './FloatingWindow.vue';

const TestContent = defineComponent(() => () => h('div', 'content'));

async function mountFloatingWindow() {
  let manager: ReturnType<typeof useFloatingWindows> | undefined;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = createApp(
    defineComponent({
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
    }),
  );
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { floatingWindow: { tool: 'Tool', minimizeWindow: 'Minimize' } } },
    }),
  );
  app.mount(target);
  if (!manager) throw new Error('Floating window manager did not mount.');
  manager.setExtent(375, 500);
  await manager.open('gesture-window', {
    component: TestContent,
    width: 300,
    height: 300,
    x: 50,
    y: 100,
    resizable: true,
    expiry: Infinity,
  });
  await nextTick();
  const windowElement = target.querySelector<HTMLElement>('.floating-window');
  if (!windowElement) throw new Error('Floating window did not render.');
  if (!windowElement.setPointerCapture) windowElement.setPointerCapture = () => undefined;
  if (!windowElement.releasePointerCapture) windowElement.releasePointerCapture = () => undefined;
  windowElement.getBoundingClientRect = () =>
    ({ left: 50, top: 100, right: 350, bottom: 400, width: 300, height: 300 }) as DOMRect;
  return {
    manager,
    target,
    unmount() {
      app.unmount();
      target.remove();
    },
  };
}

function emitPointer(target: HTMLElement, type: string, x: number, y: number) {
  if (!target.setPointerCapture) target.setPointerCapture = () => undefined;
  if (!target.releasePointerCapture) target.releasePointerCapture = () => undefined;
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }),
  );
}

describe('FloatingWindow gestures', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('tracks pointer movement one-to-one after crossing the canvas edge', async () => {
    // Given: a draggable window whose titlebar starts inside the canvas
    const mounted = await mountFloatingWindow();
    const titlebar = mounted.target.querySelector<HTMLElement>('.floating-window-titlebar');
    const windowElement = mounted.target.querySelector<HTMLElement>('.floating-window');
    if (!titlebar || !windowElement) throw new Error('Expected floating window drag elements.');

    // When: two pointer movements continue beyond the horizontal drag bound
    emitPointer(titlebar, 'pointerdown', 60, 110);
    emitPointer(titlebar, 'pointermove', 460, 110);
    emitPointer(titlebar, 'pointermove', 470, 110);

    // Then: the second 10px pointer delta remains a 10px window delta
    expect(windowElement.style.getPropertyValue('--win-x')).toBe('460px');
    mounted.unmount();
  });

  it('allows live resize beyond the canvas and input boundaries', async () => {
    // Given: a resizable 300px by 300px window in a 375px by 500px canvas
    const mounted = await mountFloatingWindow();
    expect(mounted.manager.get('gesture-window')).toMatchObject({
      resizable: true,
      minimized: false,
    });
    const windowElement = mounted.target.querySelector<HTMLElement>('.floating-window');
    const resizeHandle = mounted.target.querySelector<HTMLElement>(
      '.floating-window-resizer',
    );
    if (!windowElement || !resizeHandle) throw new Error('Expected floating resize elements.');

    // When: the resize pointer moves far beyond the canvas
    emitPointer(resizeHandle, 'pointerdown', 350, 400);
    emitPointer(windowElement, 'pointermove', 900, 900);

    // Then: live size follows the pointer instead of the canvas remainder
    expect(mounted.manager.get('gesture-window')).toMatchObject({ width: 850, height: 800 });
    mounted.unmount();
  });

  it('starts resize from the corner when window content covers the handle', async () => {
    // Given: content is the pointer target over the bottom-right resize corner
    const mounted = await mountFloatingWindow();
    const windowElement = mounted.target.querySelector<HTMLElement>('.floating-window');
    const body = mounted.target.querySelector<HTMLElement>('.floating-window-body');
    if (!windowElement || !body) throw new Error('Expected floating window resize surface.');
    windowElement.getBoundingClientRect = () =>
      ({ left: 50, top: 100, right: 350, bottom: 400, width: 300, height: 300 }) as DOMRect;

    // When: the user presses the covered corner and drags beyond the canvas
    emitPointer(body, 'pointerdown', 349, 399);
    emitPointer(windowElement, 'pointermove', 900, 900);

    // Then: capture-phase corner detection starts the same unrestricted resize path
    expect(mounted.manager.get('gesture-window')).toMatchObject({ width: 851, height: 801 });
    mounted.unmount();
  });

  it.each(['pointercancel', 'lostpointercapture'])(
    'finishes a drag when %s ends pointer capture',
    async (terminalEvent) => {
      // Given: a drag has moved beyond the horizontal pointer-up bound
      const mounted = await mountFloatingWindow();
      const titlebar = mounted.target.querySelector<HTMLElement>('.floating-window-titlebar');
      const windowElement = mounted.target.querySelector<HTMLElement>('.floating-window');
      if (!titlebar || !windowElement) throw new Error('Expected floating window drag elements.');
      emitPointer(titlebar, 'pointerdown', 60, 110);
      emitPointer(titlebar, 'pointermove', 470, 110);

      // When: the browser cancels or loses pointer capture
      emitPointer(titlebar, terminalEvent, 470, 110);
      emitPointer(titlebar, 'pointermove', 500, 110);

      // Then: the gesture is cleaned up and calibrated exactly once
      expect(mounted.manager.get('gesture-window')).toMatchObject({ x: 343, y: 100 });
      expect(windowElement.style.getPropertyValue('--win-x')).toBe('343px');
      mounted.unmount();
    },
  );

  it.each(['pointercancel', 'lostpointercapture'])(
    'cleans up resize when %s ends pointer capture',
    async (terminalEvent) => {
      // Given: a stable window capture target owns an active resize
      const mounted = await mountFloatingWindow();
      const windowElement = mounted.target.querySelector<HTMLElement>('.floating-window');
      const resizeHandle = mounted.target.querySelector<HTMLElement>('.floating-window-resizer');
      if (!windowElement || !resizeHandle) throw new Error('Expected floating resize elements.');
      emitPointer(resizeHandle, 'pointerdown', 350, 400);
      emitPointer(windowElement, 'pointermove', 500, 500);

      // When: capture ends before a normal pointerup and later moves continue
      emitPointer(windowElement, terminalEvent, 500, 500);
      emitPointer(windowElement, 'pointermove', 900, 900);

      // Then: the cancelled resize no longer consumes pointer movement
      expect(mounted.manager.get('gesture-window')).toMatchObject({ width: 450, height: 400 });
      mounted.unmount();
    },
  );

  it('calibrates position after shrinking a partly offscreen window', async () => {
    // Given: a wide window is partly offscreen with its titlebar still reachable
    const mounted = await mountFloatingWindow();
    const windowElement = mounted.target.querySelector<HTMLElement>('.floating-window');
    const resizeHandle = mounted.target.querySelector<HTMLElement>('.floating-window-resizer');
    if (!windowElement || !resizeHandle) throw new Error('Expected floating resize elements.');
    mounted.manager.updateOptions('gesture-window', { width: 760, x: -728 });
    await nextTick();

    // When: resize shrinks the window to its 200px minimum
    emitPointer(resizeHandle, 'pointerdown', 32, 400);
    emitPointer(windowElement, 'pointermove', -528, 400);
    emitPointer(windowElement, 'pointerup', -528, 400);

    // Then: pointer-up restores a reachable 32px titlebar without limiting live resize
    expect(mounted.manager.get('gesture-window')).toMatchObject({ width: 200, x: -168 });
    mounted.unmount();
  });

  it('calibrates only the invalid axis after a drag ends', () => {
    // Given: only the horizontal position exceeds its post-drag bound
    const position = { x: 450, y: 468 };

    // When: the pointer-up position is calibrated
    const calibrated = getFloatingWindowSnapPosition(
      position,
      { width: 300, height: 300 },
      { width: 375, height: 500 },
    );

    // Then: X returns to its bound while the valid Y remains unchanged
    expect(calibrated).toEqual({ x: 343, y: 468 });
  });

  it('does not calibrate a drag against a zero-sized extent', () => {
    // Given: a pointer-up arrives while layout temporarily reports zero extent
    const position = { x: 190, y: 190 };

    // When: post-drag calibration runs
    const calibrated = getFloatingWindowSnapPosition(
      position,
      { width: 300, height: 300 },
      { width: 0, height: 0 },
    );

    // Then: the user position is retained until a valid extent exists
    expect(calibrated).toEqual(position);
  });
});
