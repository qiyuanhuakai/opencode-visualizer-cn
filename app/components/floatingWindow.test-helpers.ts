import { defineComponent, h, type App } from 'vue';

export const FloatingWindowTestContent = defineComponent(() => () => h('div', 'content'));

const mountedApps = new Map<App, HTMLElement>();

export function registerFloatingWindowApp(app: App, target: HTMLElement) {
  mountedApps.set(app, target);
}

export function unregisterFloatingWindowApp(app: App) {
  const target = mountedApps.get(app);
  if (!target) return;
  mountedApps.delete(app);
  app.unmount();
  target.remove();
}

export function cleanupFloatingWindowApps() {
  for (const app of mountedApps.keys()) unregisterFloatingWindowApp(app);
}

export function emitPointer(
  target: HTMLElement,
  type: string,
  x: number,
  y: number,
  pointerId = 1,
) {
  if (!target.setPointerCapture) target.setPointerCapture = () => undefined;
  if (!target.releasePointerCapture) target.releasePointerCapture = () => undefined;
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId,
  });
  Reflect.set(event, '_vts', Date.now() + 1);
  target.dispatchEvent(event);
}
