import {
  createApplicationMenuTemplate,
  createTrayMenuTemplate,
  getDesktopShellLabels,
} from './desktopShellLabels.js';
import {
  COMPLETION_DEDUP_MAX_ENTRIES,
  COMPLETION_DEDUP_TTL_MS,
  nativeNotificationsAreAvailable,
  validateDesktopNotification,
} from './desktopShellNotification.js';
import { safelyDisposeNativeResource } from './desktopShellNative.js';
import { trayEnvironmentIsSupported } from './desktopShellTray.js';

const APP_USER_MODEL_ID = 'com.xenodrive.vis';
const ACTIVE_NOTIFICATION_MAX_ENTRIES = 64;
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA10lEQVR4nKRSuw4BURCdGb5ChF9QSqh3RbMbjUqhUSl8jmjRymrE+gKlX/CIL9BI1r1mE9a9dpebvaebk3POzGSGwBIElihnkRfXH0gAX4JsxjUC7hEgqIbB/FuLanHt9uqREDMmnaxgDt2ViUaVzer45rQVIvFY5plf3RxusFC5JODkekMetQV/wCHtWJsKQIQ+GELVJgFSQsPQr2mtz6iucDA1qdrPCgKnhn5Nq/3BueNtmXJ/miWsa2HgpyaIURJiwt93z3fDjYjGKoVZusKvXATWZ3wCAAD//2Dk3HsAAAAGSURBVAMATmRCumuMUIkAAAAASUVORK5CYII=';
const DEFAULT_PREFERENCES = Object.freeze({
  locale: 'en',
  minimizeToTray: false,
  closeToTray: false,
  autoCheckUpdates: false,
  autoDownloadUpdates: false,
  idleNotifications: false,
  notificationSound: false,
});

export function createDesktopShell({
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  Notification,
  shell,
  getWindow,
  onNotificationClick = () => {},
  onChange = () => {},
}) {
  let preferences = DEFAULT_PREFERENCES;
  let attachedWindow = null;
  let tray = null;
  let quitting = false;
  let disposed = false;
  let nativeNotificationsAvailable = nativeNotificationsAreAvailable(
    process.platform,
    Notification,
  );
  const activeNotifications = new Set();
  const recentCompletionIds = new Map();

  const resolveWindow = () => getWindow?.() ?? attachedWindow ?? BrowserWindow.getFocusedWindow?.();

  const trayAvailable = () => tray !== null && !tray.isDestroyed();

  const discardTray = () => {
    const currentTray = tray;
    tray = null;
    safelyDisposeNativeResource(() => {
      if (currentTray && !currentTray.isDestroyed()) currentTray.destroy();
    });
  };

  const restore = () => {
    const window = resolveWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  };

  const rebuildMenus = () => {
    const labels = getDesktopShellLabels(preferences.locale);
    const appName = app.getName?.() ?? app.name;
    Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate(appName, labels)));
    if (trayAvailable()) {
      try {
        tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate(labels, restore)));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        discardTray();
      }
    }
  };

  const beforeQuit = () => {
    quitting = true;
  };

  const minimizeWindow = (event) => {
    if (!preferences.minimizeToTray || !trayAvailable()) return;
    event.preventDefault();
    attachedWindow?.hide();
  };

  const closeWindow = (event) => {
    if (quitting || !preferences.closeToTray || !trayAvailable()) return;
    event.preventDefault();
    attachedWindow?.hide();
  };

  const detachWindow = () => {
    if (!attachedWindow) return;
    attachedWindow.removeListener('minimize', minimizeWindow);
    attachedWindow.removeListener('close', closeWindow);
    attachedWindow = null;
  };

  const completionWasRecentlyHandled = (id) => {
    const now = Date.now();
    for (const [completionId, handledAt] of recentCompletionIds) {
      if (now - handledAt > COMPLETION_DEDUP_TTL_MS) recentCompletionIds.delete(completionId);
    }
    if (recentCompletionIds.has(id)) return true;
    recentCompletionIds.set(id, now);
    while (recentCompletionIds.size > COMPLETION_DEDUP_MAX_ENTRIES) {
      recentCompletionIds.delete(recentCompletionIds.keys().next().value);
    }
    return false;
  };

  const windowIsAttentive = () => {
    const window = resolveWindow();
    return Boolean(
      window &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      window.isFocused(),
    );
  };

  const playNotificationSound = () => {
    if (preferences.notificationSound) shell.beep();
  };

  const closeNotification = (notification) => {
    activeNotifications.delete(notification);
    safelyDisposeNativeResource(() => notification.close());
  };

  const reportNotificationFailure = (notification) => {
    const capabilityChanged = nativeNotificationsAvailable;
    nativeNotificationsAvailable = false;
    try {
      if (capabilityChanged) onChange();
    } finally {
      if (notification) closeNotification(notification);
    }
  };

  const retainNotification = (notification) => {
    activeNotifications.add(notification);
    while (activeNotifications.size > ACTIVE_NOTIFICATION_MAX_ENTRIES) {
      const oldestNotification = activeNotifications.values().next().value;
      if (!oldestNotification) return;
      closeNotification(oldestNotification);
    }
  };

  const notify = (payload) => {
    const notificationPayload = validateDesktopNotification(payload);
    if (!preferences.idleNotifications) return;
    if (completionWasRecentlyHandled(notificationPayload.id) || windowIsAttentive()) return;

    if (!nativeNotificationsAvailable) {
      playNotificationSound();
      return;
    }

    let notification;
    try {
      notification = new Notification({
        title: notificationPayload.title,
        body: notificationPayload.body,
        silent: true,
      });
      retainNotification(notification);
      notification.on('click', () => {
        restore();
        try {
          onNotificationClick(notificationPayload);
        } finally {
          closeNotification(notification);
        }
      });
      notification.on('close', () => activeNotifications.delete(notification));
      notification.on('failed', () => reportNotificationFailure(notification));
      notification.show();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reportNotificationFailure(notification);
    }
    playNotificationSound();
  };

  const configure = (nextPreferences) => {
    preferences = Object.freeze({ ...DEFAULT_PREFERENCES, ...nextPreferences });
    rebuildMenus();
    onChange();
  };

  const attachWindow = (window) => {
    if (attachedWindow === window) return;
    detachWindow();
    attachedWindow = window;
    attachedWindow.on('minimize', minimizeWindow);
    attachedWindow.on('close', closeWindow);
  };

  const getCapabilities = () =>
    Object.freeze({
      trayAvailable: trayAvailable(),
      nativeNotificationsAvailable,
    });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    detachWindow();
    app.removeListener?.('before-quit', beforeQuit);
    for (const notification of activeNotifications) closeNotification(notification);
    activeNotifications.clear();
    recentCompletionIds.clear();
    discardTray();
    Menu.setApplicationMenu(null);
  };

  app.setAppUserModelId?.(APP_USER_MODEL_ID);
  app.on('before-quit', beforeQuit);
  let initializingTray = null;
  if (trayEnvironmentIsSupported(process.platform, app, process.env)) {
    try {
      const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
      if (icon.isEmpty()) throw new Error('Tray icon could not be decoded');
      if (process.platform === 'darwin') icon.setTemplateImage(true);
      initializingTray = new Tray(icon);
      initializingTray.setToolTip(app.getName?.() ?? app.name);
      initializingTray.on('click', restore);
      initializingTray.on('double-click', restore);
      tray = initializingTray;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      safelyDisposeNativeResource(() => {
        if (initializingTray && !initializingTray.isDestroyed()) initializingTray.destroy();
      });
      tray = null;
    }
  }
  rebuildMenus();

  return Object.freeze({ configure, attachWindow, getCapabilities, notify, restore, dispose });
}
