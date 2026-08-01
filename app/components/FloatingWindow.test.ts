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
    const resizeHandle = mounted.target.querySelector<HTMLElement>(
      '.floating-window-resizer',
    );
    expect(resizeHandle, mounted.target.innerHTML).not.toBeNull();
    if (!resizeHandle) throw new Error('Expected floating window resize handle.');

    // When: the resize pointer moves far beyond the canvas
    emitPointer(resizeHandle, 'pointerdown', 350, 400);
    emitPointer(resizeHandle, 'pointermove', 900, 900);

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
    emitPointer(body, 'pointermove', 900, 900);

    // Then: capture-phase corner detection starts the same unrestricted resize path
    expect(mounted.manager.get('gesture-window')).toMatchObject({ width: 851, height: 801 });
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
