import { createApp, h, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../locales/en';
import ProjectPicker from './ProjectPicker.vue';

const fake = vi.hoisted(() => {
  const browseDirectories = vi.fn(async (path: string) => ({
    path,
    parent: '/home',
    entries: path === '/home/user'
      ? [{ name: 'apps', path: '/home/user/apps', is_dir: true }]
      : path === '/home/user/.git'
        ? [{ name: 'objects', path: '/home/user/.git/objects', is_dir: true }]
        : [],
  }));
  class KimiWebAdapter {
    restClient = { browseDirectories };
  }
  return { browseDirectories, KimiWebAdapter };
});

vi.mock('../backends/kimiWeb/kimiWebAdapter', () => ({ KimiWebAdapter: fake.KimiWebAdapter }));
vi.mock('../backends/registry', () => ({
  getActiveBackendKind: () => 'kimi-web',
  getActiveBackendAdapter: () => new fake.KimiWebAdapter(),
}));
vi.mock('@iconify/vue', () => ({ Icon: () => null }));

let mounted: { app: App; host: HTMLElement } | undefined;
afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = undefined;
  fake.browseDirectories.mockClear();
});

it('lets Kimi browse below home even when home contains a .git directory', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const open = ref(false);
  const app = createApp({ render: () => h(ProjectPicker, { open: open.value, homePath: '/home/user' }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(host);
  mounted = { app, host };
  open.value = true;
  await nextTick();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextTick();

  const apps = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent?.trim() === 'apps/',
  );
  expect(apps?.getAttribute('aria-disabled')).toBe('false');
  apps?.click();
  await nextTick();
  expect(host.querySelector<HTMLInputElement>('.path-input')?.value).toBe('~/apps/');
});
