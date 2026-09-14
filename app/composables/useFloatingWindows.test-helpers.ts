import { createApp, defineComponent, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { useFloatingWindows } from './useFloatingWindows';

const mountedApps = new Set<App>();

export function mountFloatingWindows() {
  let manager: ReturnType<typeof useFloatingWindows> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        manager = useFloatingWindows();
        return () => null;
      },
    }),
  );
  mountedApps.add(app);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  const root = document.createElement('div');
  document.body.appendChild(root);
  app.mount(root);
  if (!manager) throw new Error('floating window manager did not mount');
  return {
    api: manager,
    unmount() {
      if (!mountedApps.delete(app)) return;
      app.unmount();
      root.remove();
    },
  };
}

export function cleanupFloatingWindows() {
  for (const app of mountedApps) app.unmount();
  mountedApps.clear();
}

export function createExtent(width = 1200, height = 800) {
  return { width, height };
}

export function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('deferred resolver is unavailable');
      resolve(value);
    },
  };
}
