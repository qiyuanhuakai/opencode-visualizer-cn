import { createApp, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopMessages } from '../locales/desktop';
import type { DesktopApi, DesktopState } from '../types/desktop';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

const en = desktopMessages.en.desktopSettings;

const mountedApps: Array<() => void> = [];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete window.electronAPI;
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete window.electronAPI;
});

function makeState(): DesktopState {
  return {
    preferences: {
      locale: 'en',
      minimizeToTray: true,
      closeToTray: false,
      autoCheckUpdates: true,
      autoDownloadUpdates: false,
      idleNotifications: true,
      notificationSound: false,
    },
    trayAvailable: true,
    nativeNotificationsAvailable: true,
    updates: {
      app: {
        component: 'app',
        currentVersion: '1.4.0',
        availableVersion: null,
        phase: 'idle',
        progress: null,
        error: null,
        installKind: 'automatic',
        assetName: null,
      },
      bridge: {
        component: 'bridge',
        currentVersion: null,
        availableVersion: null,
        phase: 'idle',
        progress: null,
        error: null,
        installKind: 'manual',
        assetName: null,
      },
    },
  };
}

function createDesktopApi() {
  const api: DesktopApi = {
    getState: vi.fn(() => Promise.resolve(makeState())),
    configure: vi.fn(() => Promise.resolve(makeState())),
    check: vi.fn(() => Promise.resolve(makeState())),
    download: vi.fn(() => Promise.resolve(makeState())),
    install: vi.fn(() => Promise.resolve(makeState())),
    notify: vi.fn(() => Promise.resolve()),
    onState: vi.fn(() => () => {}),
    onNotificationClick: vi.fn(() => () => {}),
  };
  return api;
}

async function flushAsync() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountModal() {
  const [{ default: SettingsModal }, { i18n }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsModal, { open: true });
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return host;
}

function modalBody(host: HTMLElement) {
  const body = host.querySelector('.modal-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function pageRows(host: HTMLElement) {
  return Array.from(modalBody(host).querySelectorAll(':scope > .setting-row'));
}

describe('SettingsModal desktop mounting', () => {
  it('hides the desktop link row when the desktop API is unavailable', async () => {
    // Given: a web runtime without window.electronAPI.
    const host = await mountModal();

    // Then: the root page keeps its original twelve rows and no desktop entry.
    expect(pageRows(host)).toHaveLength(12);
    const labels = pageRows(host).map((row) => row.querySelector('.setting-label')?.textContent);
    expect(labels).not.toContain(en.linkLabel);
  });

  it('shows the desktop link row and navigates to the desktop page when the API exists', async () => {
    // Given: a desktop runtime with the desktop bridge API.
    const api = createDesktopApi();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: api } });
    const host = await mountModal();

    // Then: a thirteenth link row leads to the desktop page.
    const rows = pageRows(host);
    expect(rows).toHaveLength(13);
    const linkRow = rows[12];
    expect(linkRow.querySelector('.setting-label')?.textContent).toBe(en.linkLabel);
    expect(linkRow.querySelector('.setting-description')?.textContent).toBe(en.linkDescription);

    // When: the link row is clicked.
    linkRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the desktop page renders with its title and live state.
    expect(host.querySelector('.modal-title')!.textContent).toBe(en.pageTitle);
    expect(api.getState).toHaveBeenCalled();
    const cards = modalBody(host).querySelectorAll('.desktop-update-card');
    expect(cards).toHaveLength(2);
  });
});
