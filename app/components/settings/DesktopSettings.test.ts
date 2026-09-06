import { createApp, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeUpdateState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
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

function makeState(overrides: StateOverrides = {}): DesktopState {
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

function createDesktopApi(initial: DesktopState) {
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

async function flushAsync() {
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountDesktopSettings(options: { locale?: Locale } = {}) {
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

function updateCards(host: HTMLElement) {
  return Array.from(host.querySelectorAll('.desktop-update-card')) as HTMLElement[];
}

function cardFor(host: HTMLElement, component: DesktopComponent) {
  const card = host.querySelector(`[data-testid="desktop-update-${component}"]`);
  expect(card, `${component} update card must exist`).not.toBeNull();
  return card as HTMLElement;
}

function cardButton(card: HTMLElement, label: string) {
  const button = Array.from(card.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  return button as HTMLButtonElement | undefined;
}

function toggleRowByLabel(host: HTMLElement, label: string) {
  const row = Array.from(host.querySelectorAll('.setting-row')).find(
    (candidate) => candidate.querySelector('.setting-label')?.textContent === label,
  );
  expect(row, `toggle row labeled "${label}" must exist`).toBeDefined();
  return row as HTMLElement;
}

function toggleInput(row: HTMLElement) {
  const input = row.querySelector('input.toggle-input[type="checkbox"]');
  expect(input, 'toggle row must contain a checkbox input').not.toBeNull();
  return input as HTMLInputElement;
}

async function clickToggle(input: HTMLInputElement) {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

describe('DesktopSettings', () => {
  it('keeps the completion sound configurable without native notifications', async () => {
    const desktop = createDesktopApi(makeState({ nativeNotificationsAvailable: false }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();
    const sound = toggleInput(toggleRowByLabel(host, en.preferences.notificationSound.label));
    expect(sound.disabled).toBe(false);
    await clickToggle(sound);
    expect(desktop.api.configure).toHaveBeenCalledWith({ notificationSound: true });
  });
  it('renders nothing when the desktop API is unavailable (web)', async () => {
    // Given: a web runtime without window.electronAPI.
    const { host } = await mountDesktopSettings();

    // Then: the entire desktop section stays hidden.
    expect(host.querySelector('.desktop-page-description')).toBeNull();
    expect(host.querySelector('.desktop-update-card')).toBeNull();
    expect(host.querySelector('.setting-row')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('loads and renders persisted preferences and update state', async () => {
    // Given: the desktop runtime exposes persisted preferences and versions.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });

    // When: the settings section mounts.
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: state was fetched and every toggle reflects the persisted value.
    expect(desktop.api.getState).toHaveBeenCalledTimes(1);
    const minimizeRow = host.querySelector('[data-testid="desktop-toggle-minimizeToTray"]');
    expect(minimizeRow, 'stable testid hook for QA must exist').not.toBeNull();
    expect(toggleInput(minimizeRow as HTMLElement).checked).toBe(true);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label)).checked).toBe(false);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.autoCheckUpdates.label)).checked).toBe(true);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.autoDownloadUpdates.label)).checked).toBe(false);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.idleNotifications.label)).checked).toBe(true);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.notificationSound.label)).checked).toBe(false);

    // And: the app card shows its known version while the bridge version is reported as unknown.
    const appCard = cardFor(host, 'app');
    expect(appCard.textContent).toContain('Current: 1.4.0');
    const bridgeCard = cardFor(host, 'bridge');
    expect(bridgeCard.textContent).toContain(en.updates.connectedBridge.notConnected);
    expect(bridgeCard.textContent).toContain(en.updates.installKind.manual);
    expect(appCard.textContent).toContain(en.updates.installKind.automatic);
  });

  it('writes a preference toggle through configure and applies the returned state', async () => {
    // Given: mounted settings with the desktop runtime.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: the close-to-tray toggle is switched on.
    const input = toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label));
    expect(input.checked).toBe(false);
    await clickToggle(input);
    await flushAsync();

    // Then: the patch crosses the API seam and the returned state drives the control.
    expect(desktop.api.configure).toHaveBeenCalledWith({ closeToTray: true });
    expect(toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label)).checked).toBe(true);
  });

  it('disables preference toggles while a configure request is in flight', async () => {
    // Given: a configure call that stays pending.
    const desktop = createDesktopApi(makeState());
    let resolveConfigure: ((state: DesktopState) => void) | undefined;
    desktop.api.configure = vi.fn(
      () =>
        new Promise<DesktopState>((resolve) => {
          resolveConfigure = resolve;
        }),
    );
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: a toggle is flipped.
    const input = toggleInput(toggleRowByLabel(host, en.preferences.minimizeToTray.label));
    await clickToggle(input);

    // Then: every preference toggle is disabled until the runtime answers.
    const toggles = Array.from(host.querySelectorAll('input.toggle-input')) as HTMLInputElement[];
    expect(toggles.length).toBe(6);
    for (const toggle of toggles) expect(toggle.disabled).toBe(true);

    // And: resolving the request re-enables the controls with the authoritative value.
    resolveConfigure?.(makeState({ preferences: { minimizeToTray: false } }));
    await flushAsync();
    const reEnabled = toggleInput(toggleRowByLabel(host, en.preferences.minimizeToTray.label));
    expect(reEnabled.disabled).toBe(false);
    expect(reEnabled.checked).toBe(false);
  });

  it('checks for updates and surfaces the available version with a download action', async () => {
    // Given: mounted settings whose check resolves to an available app update.
    const desktop = createDesktopApi(makeState());
    desktop.api.check = vi.fn(() =>
      Promise.resolve(
        makeState({ app: { phase: 'available', availableVersion: '1.5.0', assetName: 'Vis-1.5.0.AppImage' } }),
      ),
    );
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: the app card check button is clicked.
    const appCard = cardFor(host, 'app');
    const checkButton = cardButton(appCard, en.updates.actions.check);
    expect(checkButton).toBeDefined();
    checkButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the real API seam is invoked and the card reflects the returned phase.
    expect(desktop.api.check).toHaveBeenCalledWith('app');
    const updatedCard = cardFor(host, 'app');
    expect(updatedCard.textContent).toContain(en.updates.status.available);
    expect(updatedCard.textContent).toContain('Available: 1.5.0');
    expect(cardButton(updatedCard, en.updates.actions.download)).toBeDefined();
  });

  it('downloads and installs an automatic app update with restart labeling', async () => {
    // Given: an app update ready to download.
    const desktop = createDesktopApi(
      makeState({ app: { phase: 'available', availableVersion: '1.5.0' } }),
    );
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: download is requested.
    const downloadButton = cardButton(cardFor(host, 'app'), en.updates.actions.download);
    expect(downloadButton).toBeDefined();
    downloadButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(desktop.api.download).toHaveBeenCalledWith('app');

    // And: the runtime reports the download finished.
    desktop.emit(makeState({ app: { phase: 'downloaded', availableVersion: '1.5.0', progress: 100 } }));
    await flushAsync();

    // Then: the automatic install action is labeled as install-and-restart.
    const installButton = cardButton(cardFor(host, 'app'), en.updates.actions.installRestart);
    expect(installButton).toBeDefined();
    installButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(desktop.api.install).toHaveBeenCalledWith('app');
  });

  it('uses manual-install labeling for the bridge and keeps installer-opened truthful', async () => {
    // Given: a downloaded bridge update (manual install kind).
    const desktop = createDesktopApi(
      makeState({ bridge: { phase: 'downloaded', availableVersion: '0.9.0', progress: 100 } }),
    );
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the bridge card offers to open the installer instead of claiming a restart.
    const bridgeCard = cardFor(host, 'bridge');
    const openInstaller = cardButton(bridgeCard, en.updates.actions.openInstaller);
    expect(openInstaller).toBeDefined();
    expect(cardButton(bridgeCard, en.updates.actions.installRestart)).toBeUndefined();
    expect(bridgeCard.textContent).toContain(en.updates.bridgeInterruptNotice);

    // When: the installer is opened.
    openInstaller!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(desktop.api.install).toHaveBeenCalledWith('bridge');
    desktop.emit(
      makeState({ bridge: { phase: 'installer-opened', availableVersion: '0.9.0', progress: 100 } }),
    );
    await flushAsync();

    // Then: the status says the installer opened, explicitly NOT that the update was installed.
    const updatedCard = cardFor(host, 'bridge');
    expect(updatedCard.textContent).toContain(en.updates.status.installerOpened);
    expect(updatedCard.textContent).toContain(en.updates.manualInstallerOpenedNotice);
    expect(updatedCard.textContent).toContain(en.updates.bridgeInterruptNotice);
    const remainingButtons = Array.from(updatedCard.querySelectorAll('button'));
    expect(remainingButtons.map((button) => button.textContent?.trim())).toEqual([
      en.updates.actions.check,
    ]);
  });

  it('renders download progress from state events and disables actions while busy', async () => {
    // Given: mounted settings that receive a downloading progress event.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: the runtime pushes a 45% download progress state.
    desktop.emit(makeState({ app: { phase: 'downloading', progress: 45 } }));
    await flushAsync();

    // Then: a progressbar reflects the percent and the card actions are disabled.
    const appCard = cardFor(host, 'app');
    const progressbar = appCard.querySelector('[role="progressbar"]');
    expect(progressbar).not.toBeNull();
    expect(progressbar!.getAttribute('aria-valuenow')).toBe('45');
    expect(progressbar!.textContent).toContain('45%');
    const fill = appCard.querySelector('.desktop-progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('45%');
    const buttons = Array.from(appCard.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled).toBe(true);
  });

  it('shows the runtime error and retries through the check action', async () => {
    // Given: a mounted section whose app update falls into the error phase.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();
    desktop.emit(makeState({ app: { phase: 'error', error: 'network unreachable' } }));
    await flushAsync();

    // Then: the raw error text and a retry action are rendered.
    const appCard = cardFor(host, 'app');
    expect(appCard.textContent).toContain('network unreachable');
    const retryButton = cardButton(appCard, en.updates.actions.retry);
    expect(retryButton).toBeDefined();

    // When: retry is clicked.
    retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Then: a fresh check crosses the API seam.
    expect(desktop.api.check).toHaveBeenCalledWith('app');
  });

  it('shows a load error with retry when the initial state fetch fails', async () => {
    // Given: a desktop runtime whose first getState rejects.
    const desktop = createDesktopApi(makeState());
    desktop.api.getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockImplementation(() => Promise.resolve(makeState()));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });

    // When: the section mounts.
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the load error surface replaces the content and offers retry.
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(en.loadError);
    expect(host.querySelector('.desktop-update-card')).toBeNull();

    // When: retry is clicked and the runtime recovers.
    const retryButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === en.retry,
    ) as HTMLButtonElement;
    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the state is refetched and the cards render.
    expect(desktop.api.getState).toHaveBeenCalledTimes(2);
    expect(updateCards(host)).toHaveLength(2);
  });

  it('renders unsupported components without actions and with a truthful notice', async () => {
    // Given: a bridge component unsupported on this platform.
    const desktop = createDesktopApi(
      makeState({
        bridge: {
          phase: 'unsupported',
          installKind: 'unsupported',
          error: 'Bridge updates are unavailable on this platform or architecture',
        },
      }),
    );
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: the bridge card shows the unsupported badge/notice and no action buttons.
    const bridgeCard = cardFor(host, 'bridge');
    expect(bridgeCard.textContent).toContain(en.updates.status.unsupported);
    expect(bridgeCard.textContent).toContain(en.updates.unsupportedNotice);
    expect(bridgeCard.querySelector('button')).toBeNull();

    // And: the supported app card keeps its actions.
    expect(cardFor(host, 'app').querySelector('button')).not.toBeNull();
  });

  it('re-renders labels when the UI locale changes', async () => {
    // Given: mounted settings in English.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host, setLocale } = await mountDesktopSettings();
    await flushAsync();
    expect(cardFor(host, 'app').textContent).toContain(en.updates.components.app);

    // When: the UI locale switches to Simplified Chinese.
    setLocale('zh-CN');
    await flushAsync();

    // Then: card content follows the locale from the local desktop table.
    const zhCN = desktopMessages['zh-CN'].desktopSettings;
    const appCard = cardFor(host, 'app');
    expect(appCard.textContent).toContain(zhCN.updates.components.app);
    expect(appCard.textContent).toContain(zhCN.updates.status.idle);
    expect(
      toggleRowByLabel(host, zhCN.preferences.minimizeToTray.label),
    ).toBeDefined();
  });

  it('syncs the active UI locale to the desktop runtime when persisted locale differs', async () => {
    // Given: persisted desktop locale is English but the UI runs in Simplified Chinese.
    const desktop = createDesktopApi(makeState({ preferences: { locale: 'en' } }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });

    // When: the section mounts with zh-CN as the active UI locale.
    await mountDesktopSettings({ locale: 'zh-CN' });
    await flushAsync();

    // Then: the runtime is configured to the UI locale.
    expect(desktop.api.configure).toHaveBeenCalledWith({ locale: 'zh-CN' });
  });

  it('does not reconfigure when the persisted locale already matches the UI locale', async () => {
    // Given: persisted locale matches the UI locale.
    const desktop = createDesktopApi(makeState({ preferences: { locale: 'en' } }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });

    // When: the section mounts.
    await mountDesktopSettings();
    await flushAsync();

    // Then: no redundant configure call is made.
    expect(desktop.api.configure).not.toHaveBeenCalled();
  });

  it('does not overwrite pushed update state with a late locale response', async () => {
    const desktop = createDesktopApi(makeState());
    let finishLocale: ((state: DesktopState) => void) | undefined;
    desktop.api.configure = vi.fn(() => new Promise<DesktopState>((resolve) => { finishLocale = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings({ locale: 'zh-CN' });
    await flushAsync();
    desktop.emit(makeState({ preferences: { locale: 'zh-CN' }, app: { phase: 'downloading', progress: 72 } }));
    finishLocale?.(makeState({ preferences: { locale: 'zh-CN' } }));
    await flushAsync();
    expect(cardFor(host, 'app').querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('72');
  });

  it('does not configure the locale after the settings view unmounts during loading', async () => {
    const desktop = createDesktopApi(makeState());
    let finishLoading: ((state: DesktopState) => void) | undefined;
    desktop.api.getState = vi.fn(() => new Promise<DesktopState>((resolve) => { finishLoading = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    await mountDesktopSettings({ locale: 'zh-CN' });
    mountedApps.pop()?.();
    finishLoading?.(makeState());
    await flushAsync();
    expect(desktop.api.configure).not.toHaveBeenCalled();
  });

  it('disables tray toggles with a hint when the system tray is unavailable', async () => {
    // Given: a desktop session without tray support.
    const desktop = createDesktopApi(makeState({ trayAvailable: false }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: both tray toggles are disabled and the hint explains why.
    expect(host.textContent).toContain(en.preferences.trayUnavailable);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.minimizeToTray.label)).disabled).toBe(true);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label)).disabled).toBe(true);
    expect(
      toggleInput(toggleRowByLabel(host, en.preferences.idleNotifications.label)).disabled,
    ).toBe(false);
  });

  it('unsubscribes from desktop state events on unmount', async () => {
    // Given: a mounted section subscribed to state events.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    await mountDesktopSettings();
    await flushAsync();
    expect(desktop.listeners.size).toBe(1);

    // When: the component unmounts.
    mountedApps.pop()?.();
    await nextTick();

    // Then: the subscription is disposed.
    expect(desktop.listeners.size).toBe(0);
  });
});

describe('DesktopSettings connected bridge version', () => {
  function healthResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function mountWithBridgeUrl(initialUrl: string) {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the connected bridge version instead of the local installed version', async () => {
    // Given: the local installed bridge is 0.7.9 but the connected bridge reports 9.9.9.
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const fetchMock = vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '9.9.9' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    // When: the settings section mounts with a connected bridge health URL.
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // Then: the connected version is fetched and shown distinctly from the local version.
    expect(fetchMock).toHaveBeenCalledWith('http://bridge.test/healthz', expect.objectContaining({ credentials: 'omit' }));
    const bridgeCard = cardFor(host, 'bridge');
    expect(bridgeCard.textContent).not.toContain('0.7.9');
    expect(bridgeCard.textContent).toContain(`${en.updates.connectedBridge.label}: 9.9.9`);
  });

  it('marks the connected version unavailable when the old bridge health reports no version', async () => {
    // Given: an old bridge whose health payload lacks a version field.
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge' }))));

    // When: the settings section mounts.
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // Then: the connected row is explicitly unavailable and never mirrors the local version.
    const bridgeCard = cardFor(host, 'bridge');
    const connectedRow = bridgeCard.querySelector('[data-testid="bridge-connected-version"]');
    expect(connectedRow?.textContent).toContain(en.updates.connectedBridge.unavailable);
    expect(connectedRow?.textContent).not.toContain('0.7.9');
    expect(bridgeCard.textContent).not.toContain('0.7.9');
  });

  it('ignores a delayed response from the previous bridge after switching backends', async () => {
    // Given: bridge A answers slowly while bridge B answers immediately.
    let resolveA: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input).includes('a.test')) {
        return new Promise<Response>((resolve) => { resolveA = resolve; });
      }
      return Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '2.0.0' }));
    }));
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });

    // When: the connected backend switches from A to B before A answers.
    const mounted = mountWithBridgeUrl('http://a.test/healthz');
    const { host } = await mounted.mount();
    await flushAsync();
    mounted.url.value = 'http://b.test/healthz';
    await flushAsync();

    // Then: B's version is shown.
    const bridgeCard = () => cardFor(host, 'bridge');
    expect(bridgeCard().textContent).toContain(`${en.updates.connectedBridge.label}: 2.0.0`);

    // And: A's late response cannot overwrite it.
    resolveA?.(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' }));
    await flushAsync();
    expect(bridgeCard().textContent).toContain(`${en.updates.connectedBridge.label}: 2.0.0`);
    expect(bridgeCard().textContent).not.toContain('1.0.0');
  });

  it('clears the connected version when the bridge disconnects', async () => {
    // Given: a connected bridge that already reported its version.
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '9.9.9' })),
    ));
    const mounted = mountWithBridgeUrl('http://bridge.test/healthz');
    const { host } = await mounted.mount();
    await flushAsync();
    expect(cardFor(host, 'bridge').textContent).toContain(`${en.updates.connectedBridge.label}: 9.9.9`);

    // When: the bridge disconnects.
    mounted.url.value = '';
    await flushAsync();

    // Then: no stale version remains and the not-connected state is visible.
    const connectedRow = cardFor(host, 'bridge').querySelector('[data-testid="bridge-connected-version"]');
    expect(connectedRow?.textContent).toContain(en.updates.connectedBridge.notConnected);
    expect(connectedRow?.textContent).not.toContain('9.9.9');
  });

  it('refreshes health and reports the fresh version before a manual bridge check', async () => {
    // Given: a connected bridge at 1.0.0 that is then externally upgraded at the same URL.
    let version = '1.0.0';
    const fetchMock = vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const desktop = createDesktopApi(makeState());
    const order: string[] = [];
    desktop.api.reportBridgeVersion = vi.fn((report) => {
      order.push(`report:${report.version ?? 'null'}`);
      return Promise.resolve(makeState());
    });
    desktop.api.check = vi.fn(() => {
      order.push('check');
      return Promise.resolve(makeState());
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();
    expect(cardFor(host, 'bridge').textContent).toContain(`${en.updates.connectedBridge.label}: 1.0.0`);

    // When: the user checks for bridge updates after the external upgrade.
    version = '2.0.0';
    const checkButton = cardButton(cardFor(host, 'bridge'), en.updates.actions.check);
    expect(checkButton).toBeDefined();
    checkButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: health was re-fetched, the fresh version reached the runtime BEFORE the check ran.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(order.slice(-2)).toEqual(['report:2.0.0', 'check']);
    expect(desktop.api.check).toHaveBeenCalledWith('bridge');
    expect(cardFor(host, 'bridge').textContent).toContain(`${en.updates.connectedBridge.label}: 2.0.0`);
  });

  it('does not run the native check when the health refresh fails', async () => {
    // Given: a bridge that was connected and then goes down.
    let failing = false;
    vi.stubGlobal('fetch', vi.fn(() =>
      failing
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' })),
    ));
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();
    expect(cardFor(host, 'bridge').textContent).toContain(`${en.updates.connectedBridge.label}: 1.0.0`);

    // When: the user checks for updates while the bridge is unreachable.
    failing = true;
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the stale version is not trusted, no check ran, and the error stays visible.
    expect(desktop.api.check).not.toHaveBeenCalled();
    const connectedRow = cardFor(host, 'bridge').querySelector('[data-testid="bridge-connected-version"]');
    expect(connectedRow?.textContent).toContain(en.updates.connectedBridge.error);
  });

  it('does not run the native check when the runtime cannot accept version reports', async () => {
    // Given: a legacy desktop runtime without the reportBridgeVersion API.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' })),
    ));
    const desktop = createDesktopApi(makeState());
    delete desktop.api.reportBridgeVersion;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // When: the user checks for bridge updates.
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: without a fresh accepted report there is no check.
    expect(desktop.api.check).not.toHaveBeenCalled();
  });

  it('does not run the native check when the version report is rejected', async () => {
    // Given: a healthy bridge but a runtime whose report call fails.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' })),
    ));
    const desktop = createDesktopApi(makeState());
    desktop.api.reportBridgeVersion = vi.fn(() => Promise.reject(new Error('ipc down')));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // When: the user checks for bridge updates.
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: the rejected report blocks the check.
    expect(desktop.api.check).not.toHaveBeenCalled();
  });

  it('keeps the bridge actions busy while the manual health refresh is in flight', async () => {
    // Given: a bridge whose refresh response is delayed.
    let resolveRefresh: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' }));
      }
      return new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { desktop: desktop.api } });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // When: the user checks for bridge updates and clicks again mid-refresh.
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    // Then: one refresh is in flight, every bridge action is disabled, and no duplicate starts.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const buttons = Array.from(
      cardFor(host, 'bridge').querySelectorAll('button'),
    ) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled).toBe(true);
    buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(desktop.api.check).not.toHaveBeenCalled();

    // And: once the refresh answers, the check proceeds.
    resolveRefresh?.(healthResponse({ ok: true, service: 'vis_bridge', version: '2.0.0' }));
    await flushAsync();
    expect(desktop.api.check).toHaveBeenCalledWith('bridge');
  });
});

describe('desktop locale table', () => {
  function collectKeys(value: unknown, prefix = ''): string[] {
    if (value === null || typeof value !== 'object') return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      collectKeys(entry, prefix ? `${prefix}.${key}` : key),
    );
  }

  it('provides an identical key shape for every supported locale', () => {
    const reference = collectKeys(desktopMessages.en.desktopSettings).sort();
    for (const locale of Object.keys(desktopMessages)) {
      const keys = collectKeys(
        desktopMessages[locale as keyof typeof desktopMessages].desktopSettings,
      ).sort();
      expect(keys, `locale ${locale} must cover every desktopSettings key`).toEqual(reference);
    }
  });
});
