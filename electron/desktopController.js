const DEFAULTS = Object.freeze({
  locale: 'en',
  minimizeToTray: false,
  closeToTray: false,
  autoCheckUpdates: false,
  autoDownloadUpdates: false,
  idleNotifications: true,
  notificationSound: false,
});
const LOCALES = new Set(['en', 'zh-CN', 'zh-TW', 'ja', 'eo']);

function parsePreferences(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Invalid desktop preferences');
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`Unknown desktop preference: ${key}`);
    if (key === 'locale' ? !LOCALES.has(value) : typeof value !== 'boolean') {
      throw new TypeError(`Invalid desktop preference: ${key}`);
    }
  }
  return { ...patch };
}

function parseComponent(component) {
  if (component !== 'app' && component !== 'bridge') throw new TypeError('Invalid update component');
  return component;
}

function parseNotification(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw new TypeError('Invalid desktop notification');
  }
  const result = {};
  for (const key of ['id', 'title', 'body', 'projectId', 'sessionId']) {
    const value = notification[key];
    if (typeof value !== 'string' || value.length > 2048 || (key !== 'body' && !value)) {
      throw new TypeError(`Invalid desktop notification: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

export function createDesktopController({ storage, desktopShell, updates, publish }) {
  const saved = storage.getItem('preferences');
  let preferences = { ...DEFAULTS, ...(saved === null ? {} : parsePreferences(JSON.parse(saved))) };
  const getState = () => ({ preferences: { ...preferences }, ...desktopShell.getCapabilities(), updates: updates.getState() });
  const activate = () => {
    desktopShell.configure(preferences);
    updates.configure(preferences);
  };
  const runUpdate = async (operation, component) => {
    await updates[operation](parseComponent(component));
    return getState();
  };
  return {
    getState,
    start: activate,
    configure(patch) {
      const next = { ...preferences, ...parsePreferences(patch) };
      storage.setItem('preferences', JSON.stringify(next));
      preferences = next;
      activate();
      const state = getState();
      publish(state);
      return state;
    },
    check: (component) => runUpdate('check', component),
    download: (component) => runUpdate('download', component),
    install: (component) => runUpdate('install', component),
    notify: (notification) => desktopShell.notify(parseNotification(notification)),
  };
}

export function registerDesktopIpc({ ipcMain, controller, assertTrustedRenderer }) {
  const handlers = {
    'desktop-get-state': () => controller.getState(),
    'desktop-configure': (payload) => controller.configure(payload),
    'desktop-check': (payload) => controller.check(payload),
    'desktop-download': (payload) => controller.download(payload),
    'desktop-install': (payload) => controller.install(payload),
    'desktop-notify': (payload) => controller.notify(payload),
  };
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, payload) => {
      assertTrustedRenderer(event);
      return handle(payload);
    });
  }
}
