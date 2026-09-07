import '../styles/tailwind.css';
import type { Locale } from '../i18n/types';
import type { DesktopApi, DesktopComponent, DesktopState, DesktopUpdateState } from '../types/desktop';
import type { ConnectedBridgeVersion } from '../composables/useConnectedBridgeVersion';

const params = new URLSearchParams(window.location.search);
const page = params.get('page') === 'desktop' ? 'desktop' : 'editor';
const locales: readonly Locale[] = ['en', 'zh-CN', 'zh-TW', 'ja', 'eo'];
const requestedLocale = params.get('locale') ?? 'en';
const locale = locales.find((candidate) => candidate === requestedLocale) ?? 'en';
const localApplicationPath =
  params.get('path') ?? '/opt/homebrew/bin/code --goto /Users/dev/project/src/index.ts';

const phases: readonly DesktopUpdateState['phase'][] = [
  'idle', 'checking', 'available', 'downloading', 'downloaded',
  'installing', 'installer-opened', 'up-to-date', 'error', 'unsupported',
];
const requestedPhase = params.get('phase') ?? 'idle';
const phase = phases.find((candidate) => candidate === requestedPhase) ?? 'idle';

function phaseOverrides(value: DesktopUpdateState['phase']): Partial<DesktopUpdateState> {
  switch (value) {
    case 'available':
      return { phase: value, availableVersion: '1.5.0', assetName: 'Vis-1.5.0.AppImage' };
    case 'downloading':
      return { phase: value, availableVersion: '1.5.0', progress: 45 };
    case 'downloaded':
      return { phase: value, availableVersion: '1.5.0', progress: 100 };
    case 'error':
      return { phase: value, error: 'network unreachable' };
    default:
      return { phase: value };
  }
}

let state: DesktopState = {  preferences: {
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
      ...phaseOverrides(phase),
    },
    bridge: {
      component: 'bridge',
      currentVersion: '0.9.1',
      availableVersion: null,
      phase: 'idle',
      progress: null,
      error: null,
      installKind: 'manual',
      assetName: null,
      ...phaseOverrides(phase),
    },
  },
};

const desktop: DesktopApi = {
  getState: () => Promise.resolve(state),
  configure: (patch) => {
    Object.assign(state.preferences, patch);
    return Promise.resolve(state);
  },
  reportBridgeVersion: () => Promise.resolve(state),
  check: (component: DesktopComponent) => {
    state = {
      ...state,
      updates: {
        ...state.updates,
        [component]: { ...state.updates[component], phase: 'up-to-date' },
      },
    };
    return Promise.resolve(state);
  },
  download: () => Promise.resolve(state),
  install: () => Promise.resolve(state),
  notify: () => Promise.resolve(),
  onState: () => () => {},
  onNotificationClick: () => () => {},
};

window.electronAPI = {
  platform: 'darwin',
  versions: { node: '24.0.0', electron: '43.4.1', chrome: '150.0.0' },
  getAppVersion: () => Promise.resolve('1.4.0'),
  getPlatform: () => Promise.resolve('darwin'),
  desktop,
  localFile: {
    selectApplication: () => Promise.resolve(null),
    clearApplication: () => Promise.resolve(),
    open: (payload) => Promise.resolve({ sessionId: payload.sessionId }),
    close: () => Promise.resolve(),
    onChanged: () => {},
    offChanged: () => {},
    onError: () => {},
    offError: () => {},
  },
};

window.localStorage.setItem('opencode.settings.localApplicationPath.v1', localApplicationPath);

const [{ createApp, h, nextTick, ref }, { default: SettingsModal }, { i18n, setLocale }, { useRegionTheme }] =
  await Promise.all([
    import('vue'),
    import('../components/SettingsModal.vue'),
    import('../i18n'),
    import('../composables/useRegionTheme'),
  ]);

setLocale(locale);

const connectedBridgeState: ConnectedBridgeVersion = { status: 'ready', version: '0.9.2' };

const open = ref(false);
const app = createApp({
  setup() {
    useRegionTheme();
    return () =>
      h(SettingsModal, {
        open: open.value,
        initialPage: page,
        connectedBridgeState,
        refreshBridgeVersion: () => Promise.resolve(true),
      });
  },
});
app.use(i18n);
app.mount('#app');
await nextTick();
open.value = true;
await nextTick();
document.body.dataset.fixtureReady = 'true';
