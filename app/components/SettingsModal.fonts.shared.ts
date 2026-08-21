import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, expect, vi } from 'vitest';

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
  (pageRows(host)[9] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

/**
 * Canonical serialization of a rendered row: tag names, attributes (sorted,
 * scope ids excluded), and trimmed text — insensitive to attribute order and
 * Vue scope-id churn, sensitive to any structural or content change.
 */
export function canonical(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').trim();
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const attrs = Array.from(el.attributes)
    .filter((attr) => !attr.name.startsWith('data-v-'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((attr) => `${attr.name}="${attr.value}"`)
    .join(' ');
  const children = Array.from(el.childNodes)
    .map(canonical)
    .filter((part) => part.length > 0);
  const open =
    attrs.length > 0 ? `<${el.tagName.toLowerCase()} ${attrs}>` : `<${el.tagName.toLowerCase()}>`;
  return `${open}${children.join('')}</${el.tagName.toLowerCase()}>`;
}
