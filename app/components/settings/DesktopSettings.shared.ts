import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { desktopMessages } from '../../locales/desktop';
import type {
  DesktopApi,
  DesktopComponent,
  DesktopPreferences,
  DesktopState,
  DesktopUpdateState,
} from '../../types/desktop';
import type { Locale } from '../../i18n/types';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

export const en = desktopMessages.en.desktopSettings;

const mountedApps: Array<() => void> = [];

export function registerDesktopSettingsLifecycle() {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete window.electronAPI;
  });

  afterEach(() => {
    while (mountedApps.length > 0) mountedApps.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    delete window.electronAPI;
  });
}

export function makeUpdateState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    component: 'app',
    currentVersion: '1.4.0',
    availableVersion: null,
    phase: 'idle',
    progress: null,
    error: null,
    installKind: 'automatic',
    assetName: null,
    ...overrides,
  };
}

interface StateOverrides {
  preferences?: Partial<DesktopPreferences>;
  trayAvailable?: boolean;
  nativeNotificationsAvailable?: boolean;
  app?: Partial<DesktopUpdateState>;
  bridge?: Partial<DesktopUpdateState>;
}

export function makeState(overrides: StateOverrides = {}): DesktopState {
  return {
    preferences: {
      locale: 'en',
      minimizeToTray: true,
      closeToTray: false,
      autoCheckUpdates: true,
      autoDownloadUpdates: false,
      idleNotifications: true,
      notificationSound: false,
      ...overrides.preferences,
    },
    trayAvailable: overrides.trayAvailable ?? true,
    nativeNotificationsAvailable: overrides.nativeNotificationsAvailable ?? true,
    updates: {
      app: makeUpdateState(overrides.app),
      bridge: makeUpdateState({
        component: 'bridge',
        currentVersion: null,
        installKind: 'manual',
        ...overrides.bridge,
      }),
    },
  };
}

export function createDesktopApi(initial: DesktopState) {
  let current = initial;
  const listeners = new Set<(state: DesktopState) => void>();
  const api: DesktopApi = {
    getState: vi.fn(() => Promise.resolve(current)),
    configure: vi.fn((patch: Partial<DesktopPreferences>) => {
      current = { ...current, preferences: { ...current.preferences, ...patch } };
      return Promise.resolve(current);
    }),
    reportBridgeVersion: vi.fn(() => Promise.resolve(current)),
    check: vi.fn((_component: DesktopComponent) => Promise.resolve(current)),
    download: vi.fn((_component: DesktopComponent) => Promise.resolve(current)),
    install: vi.fn((_component: DesktopComponent) => Promise.resolve(current)),
    notify: vi.fn(() => Promise.resolve()),
    onState: vi.fn((listener: (state: DesktopState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    onNotificationClick: vi.fn(() => () => {}),
  };
  return {
    api,
    listeners,
    setState(next: DesktopState) {
      current = next;
    },
    emit(next: DesktopState) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

export function unmountLastDesktopSettings() {
  mountedApps.pop()?.();
}

export async function flushAsync() {
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

export async function mountDesktopSettings(options: { locale?: Locale } = {}) {
  const [{ default: DesktopSettings }, { i18n, setLocale }] = await Promise.all([
    import('./DesktopSettings.vue'),
    import('../../i18n'),
  ]);
  if (options.locale) setLocale(options.locale);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(DesktopSettings);
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return { host, setLocale };
}

export function updateCards(host: HTMLElement) {
  return Array.from(host.querySelectorAll('.desktop-update-card')) as HTMLElement[];
}

export function cardFor(host: HTMLElement, component: DesktopComponent) {
  const card = host.querySelector(`[data-testid="desktop-update-${component}"]`);
  expect(card, `${component} update card must exist`).not.toBeNull();
  return card as HTMLElement;
}

export function cardButton(card: HTMLElement, label: string) {
  const button = Array.from(card.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  return button as HTMLButtonElement | undefined;
}

export function toggleRowByLabel(host: HTMLElement, label: string) {
  const row = Array.from(host.querySelectorAll('.setting-row')).find(
    (candidate) => candidate.querySelector('.setting-label')?.textContent === label,
  );
  expect(row, `toggle row labeled "${label}" must exist`).toBeDefined();
  return row as HTMLElement;
}

export function toggleInput(row: HTMLElement) {
  const input = row.querySelector('input.toggle-input[type="checkbox"]');
  expect(input, 'toggle row must contain a checkbox input').not.toBeNull();
  return input as HTMLInputElement;
}

export async function clickToggle(input: HTMLInputElement) {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

export function healthResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function mountWithBridgeUrl(initialUrl: string) {
  const url = ref(initialUrl);
  return {
    url,
    async mount() {
      const [{ default: DesktopSettings }, { i18n }, { useDesktopBridgeVersion }] =
        await Promise.all([
          import('./DesktopSettings.vue'),
          import('../../i18n'),
          import('../../composables/useDesktopBridgeVersion'),
        ]);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const app = createApp({
        setup() {
          const bridge = useDesktopBridgeVersion(url, window.electronAPI?.desktop);
          return () =>
            h(DesktopSettings, {
              connectedBridgeState: bridge.state.value,
              refreshBridgeVersion: bridge.refresh,
            });
        },
      });
      app.use(i18n);
      app.mount(host);
      mountedApps.push(() => app.unmount());
      await nextTick();
      return { host };
    },
  };
}
