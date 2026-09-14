import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import en from '../locales/en';

const mountedApps: Array<() => void> = [];

export function registerSettingsModalLifecycle() {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    while (mountedApps.length > 0) mountedApps.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });
}

export async function mountModal() {
  const [{ default: SettingsModal }, { i18n }, { useSettings }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
    import('../composables/useSettings'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsModal, { open: true });
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return { host, settings: useSettings() };
}

function modalBody(host: HTMLElement) {
  const body = host.querySelector('.modal-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

export function pageRows(host: HTMLElement) {
  return Array.from(modalBody(host).querySelectorAll(':scope > .setting-row'));
}

export async function openFontsPage(host: HTMLElement) {
  const control = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.getAttribute('aria-label') === en.settings.fontSettings.label,
  );
  expect(control).toBeDefined();
  control!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
  const rows = pageRows(host);
  expect(rows).toHaveLength(2);
  return rows;
}

export function sections(row: Element) {
  return Array.from(
    row.querySelectorAll(':scope > .font-setting-controls > .font-setting-section'),
  );
}

export async function click(el: Element) {
  (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
}
