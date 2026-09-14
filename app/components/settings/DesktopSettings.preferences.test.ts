import { nextTick } from 'vue';
// allow: SIZE_OK — desktop preference, locale, and lifecycle cases stay in one requested suite.
import { describe, expect, it, vi } from 'vitest';
import { desktopMessages } from '../../locales/desktop';
import type { DesktopState } from '../../types/desktop';
import {
  registerDesktopSettingsLifecycle,
  en,
  makeState,
  createDesktopApi,
  flushAsync,
  mountDesktopSettings,
  cardFor,
  toggleRowByLabel,
  toggleInput,
  clickToggle,
  unmountLastDesktopSettings,
} from './DesktopSettings.shared';

registerDesktopSettingsLifecycle();

describe('DesktopSettings preferences', () => {
  it('keeps the completion sound configurable without native notifications', async () => {
    const desktop = createDesktopApi(makeState({ nativeNotificationsAvailable: false }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
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
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });

    // When: the settings section mounts.
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: state was fetched and every toggle reflects the persisted value.
    expect(desktop.api.getState).toHaveBeenCalledTimes(1);
    const minimizeRow = host.querySelector('[data-testid="desktop-toggle-minimizeToTray"]');
    expect(minimizeRow, 'stable testid hook for QA must exist').not.toBeNull();
    expect(toggleInput(minimizeRow as HTMLElement).checked).toBe(true);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label)).checked).toBe(
      false,
    );
    expect(toggleInput(toggleRowByLabel(host, en.preferences.autoCheckUpdates.label)).checked).toBe(
      true,
    );
    expect(
      toggleInput(toggleRowByLabel(host, en.preferences.autoDownloadUpdates.label)).checked,
    ).toBe(false);
    expect(
      toggleInput(toggleRowByLabel(host, en.preferences.idleNotifications.label)).checked,
    ).toBe(true);
    expect(
      toggleInput(toggleRowByLabel(host, en.preferences.notificationSound.label)).checked,
    ).toBe(false);

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
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // When: the close-to-tray toggle is switched on.
    const input = toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label));
    expect(input.checked).toBe(false);
    await clickToggle(input);
    await flushAsync();

    // Then: the patch crosses the API seam and the returned state drives the control.
    expect(desktop.api.configure).toHaveBeenCalledWith({ closeToTray: true });
    expect(toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label)).checked).toBe(
      true,
    );
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
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
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

  it('re-renders labels when the UI locale changes', async () => {
    // Given: mounted settings in English.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
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
    expect(toggleRowByLabel(host, zhCN.preferences.minimizeToTray.label)).toBeDefined();
  });

  it('syncs the active UI locale to the desktop runtime when persisted locale differs', async () => {
    // Given: persisted desktop locale is English but the UI runs in Simplified Chinese.
    const desktop = createDesktopApi(makeState({ preferences: { locale: 'en' } }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });

    // When: the section mounts with zh-CN as the active UI locale.
    await mountDesktopSettings({ locale: 'zh-CN' });
    await flushAsync();

    // Then: the runtime is configured to the UI locale.
    expect(desktop.api.configure).toHaveBeenCalledWith({ locale: 'zh-CN' });
  });

  it('does not reconfigure when the persisted locale already matches the UI locale', async () => {
    // Given: persisted locale matches the UI locale.
    const desktop = createDesktopApi(makeState({ preferences: { locale: 'en' } }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });

    // When: the section mounts.
    await mountDesktopSettings();
    await flushAsync();

    // Then: no redundant configure call is made.
    expect(desktop.api.configure).not.toHaveBeenCalled();
  });

  it('does not overwrite pushed update state with a late locale response', async () => {
    const desktop = createDesktopApi(makeState());
    let finishLocale: ((state: DesktopState) => void) | undefined;
    desktop.api.configure = vi.fn(
      () =>
        new Promise<DesktopState>((resolve) => {
          finishLocale = resolve;
        }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings({ locale: 'zh-CN' });
    await flushAsync();
    desktop.emit(
      makeState({ preferences: { locale: 'zh-CN' }, app: { phase: 'downloading', progress: 72 } }),
    );
    finishLocale?.(makeState({ preferences: { locale: 'zh-CN' } }));
    await flushAsync();
    expect(
      cardFor(host, 'app').querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('72');
  });

  it('does not configure the locale after the settings view unmounts during loading', async () => {
    const desktop = createDesktopApi(makeState());
    let finishLoading: ((state: DesktopState) => void) | undefined;
    desktop.api.getState = vi.fn(
      () =>
        new Promise<DesktopState>((resolve) => {
          finishLoading = resolve;
        }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    await mountDesktopSettings({ locale: 'zh-CN' });
    unmountLastDesktopSettings();
    finishLoading?.(makeState());
    await flushAsync();
    expect(desktop.api.configure).not.toHaveBeenCalled();
  });

  it('disables tray toggles with a hint when the system tray is unavailable', async () => {
    // Given: a desktop session without tray support.
    const desktop = createDesktopApi(makeState({ trayAvailable: false }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountDesktopSettings();
    await flushAsync();

    // Then: both tray toggles are disabled and the hint explains why.
    expect(host.textContent).toContain(en.preferences.trayUnavailable);
    expect(toggleInput(toggleRowByLabel(host, en.preferences.minimizeToTray.label)).disabled).toBe(
      true,
    );
    expect(toggleInput(toggleRowByLabel(host, en.preferences.closeToTray.label)).disabled).toBe(
      true,
    );
    expect(
      toggleInput(toggleRowByLabel(host, en.preferences.idleNotifications.label)).disabled,
    ).toBe(false);
  });

  it('unsubscribes from desktop state events on unmount', async () => {
    // Given: a mounted section subscribed to state events.
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    await mountDesktopSettings();
    await flushAsync();
    expect(desktop.listeners.size).toBe(1);

    // When: the component unmounts.
    unmountLastDesktopSettings();
    await nextTick();

    // Then: the subscription is disposed.
    expect(desktop.listeners.size).toBe(0);
  });

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
