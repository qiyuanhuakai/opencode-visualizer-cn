import { createApp, h, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../locales/en';
import ProjectPicker from './ProjectPicker.vue';

const fake = vi.hoisted(() => {
  let backendKind = 'kimi-web';
  const entriesByPath: Record<string, Array<{ name: string; path: string; is_dir: boolean }>> = {
    '/': [{ name: 'home', path: '/home', is_dir: true }],
    '/.git': [{ name: 'objects', path: '/.git/objects', is_dir: true }],
    '/home/user': [{ name: 'apps', path: '/home/user/apps', is_dir: true }],
    '/home/user/.git': [{ name: 'objects', path: '/home/user/.git/objects', is_dir: true }],
    '/home/user/apps': [
      { name: 'src', path: '/home/user/apps/src', is_dir: true },
      { name: '.git', path: '/home/user/apps/.git', is_dir: false },
    ],
  };
  const browseDirectories = vi.fn(async (path: string) => ({
    path,
    parent: '/home',
    entries: (entriesByPath[path] ?? []).filter((entry) => entry.is_dir),
  }));
  const listFiles = vi.fn(async ({ directory, path }: { directory: string; path: string }) => {
    const fullPath = path === '.' ? directory : `${directory.replace(/\/$/, '')}/${path}`;
    return (entriesByPath[fullPath] ?? []).map((entry) => ({
      name: entry.name,
      path: entry.path,
      absolute: entry.path,
      type: entry.is_dir ? 'directory' as const : 'file' as const,
      ignored: false,
    }));
  });
  class KimiWebAdapter {
    restClient = { browseDirectories };
    listFiles = listFiles;
  }
  return {
    browseDirectories,
    listFiles,
    KimiWebAdapter,
    get backendKind() { return backendKind; },
    set backendKind(value: string) { backendKind = value; },
  };
});

vi.mock('../backends/kimiWeb/kimiWebAdapter', () => ({ KimiWebAdapter: fake.KimiWebAdapter }));
vi.mock('../backends/registry', () => ({
  getActiveBackendKind: () => fake.backendKind,
  getActiveBackendAdapter: () => fake.backendKind === 'kimi-web'
    ? new fake.KimiWebAdapter()
    : { listFiles: fake.listFiles },
}));
vi.mock('@iconify/vue', () => ({ Icon: () => null }));

let mounted: { app: App; host: HTMLElement } | undefined;
afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = undefined;
  fake.browseDirectories.mockClear();
  fake.listFiles.mockClear();
  fake.backendKind = 'kimi-web';
});

it.each(['kimi-web', 'opencode', 'codex'])('lets %s browse below home but stops at a project with .git', async (backendKind) => {
  fake.backendKind = backendKind;
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
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextTick();
  const src = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent?.trim() === 'src/',
  );
  expect(src?.getAttribute('aria-disabled')).toBe('true');
});

it.each(['kimi-web', 'opencode', 'codex'])('lets %s browse below filesystem root even when root contains .git', async (backendKind) => {
  fake.backendKind = backendKind;
  const host = document.createElement('div');
  document.body.append(host);
  const open = ref(false);
  const app = createApp({ render: () => h(ProjectPicker, { open: open.value, homePath: '/home/user' }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(host);
  mounted = { app, host };
  open.value = true;
  await nextTick();
  const input = host.querySelector<HTMLInputElement>('.path-input');
  expect(input).toBeDefined();
  if (!input) return;
  input.value = '/';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextTick();

  const home = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent?.trim() === 'home/',
  );
  expect(home?.getAttribute('aria-disabled')).toBe('false');
});
