import { computed, createApp, ref, type Component } from 'vue';
import { FLOATING_WINDOW_KEY, type FloatingWindowAPI } from '../../composables/useFloatingWindow';
import { i18n } from '../../i18n';
import type { DesktopState } from '../../types/desktop';
import type { FixtureApi } from './types';

export const scenario = new URLSearchParams(location.search).get('scenario') ?? 'tree';
export const fixtureApi: FixtureApi = { ready: false, scenario };

function makeDesktopState(): DesktopState {
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
        currentVersion: '0.7.17-with-a-deliberately-long-desktop-build-label',
        availableVersion: '0.8.0-beta.123456789',
        phase: 'available',
        progress: null,
        error: null,
        installKind: 'automatic',
        assetName: 'vis-desktop-linux-x64-with-a-long-readable-package-name.AppImage',
      },
      bridge: {
        component: 'bridge',
        currentVersion: '0.7.17',
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

function configureFixtureStyles(): void {
  document.documentElement.style.setProperty(
    '--app-monospace-font-family',
    'ui-monospace, monospace',
  );
  document.documentElement.style.setProperty('--app-monospace-font-size', '13px');
  document.documentElement.style.setProperty('--message-font-size', '13px');
  document.documentElement.style.setProperty('--ui-font-size', '12px');
  document.body.style.margin = '0';
  document.body.style.background = '#0f172a';
  document.body.style.color = '#e2e8f0';
  document.body.style.fontFamily = 'var(--app-monospace-font-family)';
}

function configureDesktopBridge(): void {
  const desktopState = makeDesktopState();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      desktop: {
        getState: async () => desktopState,
        configure: async () => desktopState,
        check: async () => desktopState,
        download: async () => desktopState,
        install: async () => desktopState,
        notify: async () => undefined,
        onState: () => () => undefined,
        onNotificationClick: () => () => undefined,
      },
      localFile: {
        selectApplication: async () => null,
        clearApplication: async () => undefined,
      },
    },
  });
}

export function configureFixtureEnvironment(): void {
  window.__uiContracts = fixtureApi;
  configureFixtureStyles();
  configureDesktopBridge();
}

export function installApp(component: Component): void {
  const app = createApp(component);
  app.use(i18n);
  app.provide('showConfirm', async () => true);
  app.provide('showPrompt', async () => null);
  const floatingContent = ref('');
  const floatingApi: FloatingWindowAPI = {
    key: 'qa-contract',
    content: computed(() => floatingContent.value),
    html: computed(() => ''),
    title: computed(() => 'QA contract'),
    status: computed(() => 'completed'),
    notifyContentChange: () => undefined,
    setContent: (content) => (floatingContent.value = content),
    appendContent: (content) => (floatingContent.value += content),
    setTitle: () => undefined,
    setStatus: () => undefined,
    setColor: () => undefined,
    bringToFront: () => undefined,
    close: () => undefined,
    minimize: () => undefined,
    onResize: () => undefined,
  };
  app.provide(FLOATING_WINDOW_KEY, floatingApi);
  app.mount('#app');
}

export function waitForRender(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
