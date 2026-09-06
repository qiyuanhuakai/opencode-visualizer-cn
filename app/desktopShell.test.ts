import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopShell,
  type DesktopShellDependencies,
  type DesktopShellNotification,
  type DesktopShellPreferences,
  type DesktopShellWindow,
} from '../electron/desktopShell.js';
import { nativeNotificationsAreAvailable } from '../electron/desktopShellNotification.js';
import { trayEnvironmentIsSupported } from '../electron/desktopShellTray.js';

type PreventableEvent = { preventDefault(): void };
type Listener = (...args: PreventableEvent[]) => void;

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: Listener) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  emit(event: string, ...args: PreventableEvent[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class WindowMock extends Emitter implements DesktopShellWindow {
  visible = true;
  focused = false;
  minimized = false;
  destroyed = false;
  readonly hide = vi.fn(() => {
    this.visible = false;
  });
  readonly show = vi.fn(() => {
    this.visible = true;
  });
  readonly focus = vi.fn(() => {
    this.focused = true;
  });
  readonly restore = vi.fn(() => {
    this.minimized = false;
  });

  isVisible() {
    return this.visible;
  }

  isFocused() {
    return this.focused;
  }

  isMinimized() {
    return this.minimized;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

class TrayMock extends Emitter {
  destroyed = false;
  readonly setContextMenu = vi.fn();
  readonly setToolTip = vi.fn();
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });

  isDestroyed() {
    return this.destroyed;
  }
}

class NotificationMock extends Emitter {
  static supported = true;
  static readonly instances: NotificationMock[] = [];
  readonly show = vi.fn();
  readonly close = vi.fn(() => this.emit('close'));

  static isSupported() {
    return NotificationMock.supported;
  }

  constructor(readonly options: Record<string, unknown>) {
    super();
    NotificationMock.instances.push(this);
  }
}

const basePreferences: DesktopShellPreferences = {
  locale: 'en',
  minimizeToTray: false,
  closeToTray: false,
  autoCheckUpdates: true,
  autoDownloadUpdates: false,
  idleNotifications: false,
  notificationSound: false,
};

function createHarness(
  options: {
    beforeQuitListener?: Listener;
    failTray?: boolean;
    failTrayMenu?: boolean;
    linuxTray?: boolean;
    notifications?: boolean;
  } = {},
) {
  NotificationMock.instances.length = 0;
  NotificationMock.supported = options.notifications ?? true;
  const appListeners = new Map<string, Listener[]>();
  if (options.beforeQuitListener) appListeners.set('before-quit', [options.beforeQuitListener]);
  const app = {
    name: 'Vis',
    getName: vi.fn(() => 'Vis'),
    isUnityRunning: vi.fn(() => options.linuxTray ?? true),
    on: vi.fn((event: string, listener: Listener) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), listener]);
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      appListeners.set(
        event,
        (appListeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
    }),
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
  };
  const emitApp = (event: string, value: PreventableEvent) => {
    for (const listener of appListeners.get(event) ?? []) listener(value);
  };
  const trays: TrayMock[] = [];
  const Tray = class extends TrayMock {
    constructor(_icon: unknown) {
      super();
      if (options.failTray) throw new Error('tray unavailable');
      if (options.failTrayMenu) {
        this.setContextMenu.mockImplementation(() => {
          throw new Error('tray menu unavailable');
        });
      }
      trays.push(this);
    }
  };
  const builtMenus: Array<{ template: Array<Record<string, unknown>> }> = [];
  const Menu = {
    buildFromTemplate: vi.fn((template: Array<Record<string, unknown>>) => {
      const menu = { template };
      builtMenus.push(menu);
      return menu;
    }),
    setApplicationMenu: vi.fn(),
  };
  const image = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(),
  };
  const nativeImage = { createFromDataURL: vi.fn(() => image) };
  const shellApi = { beep: vi.fn() };
  const window = new WindowMock();
  const onChange = vi.fn();
  const onNotificationClick = vi.fn();
  const desktopShell = createDesktopShell({
    app,
    BrowserWindow: { getFocusedWindow: vi.fn(() => window) },
    Menu,
    Tray,
    nativeImage,
    Notification: NotificationMock,
    shell: shellApi,
    getWindow: () => window,
    onNotificationClick,
    onChange,
  } as unknown as DesktopShellDependencies);

  return {
    app,
    appListeners,
    builtMenus,
    desktopShell,
    emitApp,
    image,
    Menu,
    Notification: NotificationMock,
    onChange,
    onNotificationClick,
    shellApi,
    trays,
    window,
  };
}

function preventableEvent() {
  return { preventDefault: vi.fn() };
}

describe('Electron desktop shell', () => {
  it('conservatively detects whether a Linux tray can be reached', () => {
    const app = { isUnityRunning: () => false };
    expect(trayEnvironmentIsSupported('linux', app, {})).toBe(false);
    expect(
      trayEnvironmentIsSupported('linux', app, {
        DISPLAY: ':99',
        XDG_CURRENT_DESKTOP: 'GNOME',
      }),
    ).toBe(false);
    expect(
      trayEnvironmentIsSupported('linux', app, {
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_CURRENT_DESKTOP: 'KDE',
      }),
    ).toBe(true);
    expect(trayEnvironmentIsSupported('win32', app, {})).toBe(true);
  });

  it('does not claim native notification support for ad-hoc macOS releases', () => {
    expect(nativeNotificationsAreAvailable('darwin', NotificationMock)).toBe(false);
  });

  it.each([
    ['en', 'Reload', 'Restore', 'Quit'],
    ['zh-CN', '刷新', '恢复', '退出'],
    ['zh-TW', '重新載入', '恢復', '結束'],
    ['ja', '再読み込み', '表示', '終了'],
    ['eo', 'Reŝargi', 'Restarigi', 'Ĉesi'],
  ] as const)(
    'builds a reduced native %s menu without losing editing roles',
    (locale, edit, restore, quit) => {
      const harness = createHarness();
      harness.desktopShell.configure({ ...basePreferences, locale });

      const applicationTemplate = harness.builtMenus.at(-2)?.template;
      const trayTemplate = harness.builtMenus.at(-1)?.template;
      if (!applicationTemplate || !trayTemplate) throw new Error('Expected native menu templates');
      const applicationSubmenu = applicationTemplate[0]?.submenu;
      const editSubmenu = applicationTemplate[1]?.submenu;
      if (!Array.isArray(applicationSubmenu) || !Array.isArray(editSubmenu)) {
        throw new Error('Expected native menu submenus');
      }
      expect(applicationTemplate.map((item) => item.label)).toEqual(['Vis', edit]);
      expect((applicationSubmenu as Array<Record<string, unknown>>).at(-1)).toEqual({
        label: quit,
        role: 'quit',
      });
      expect(
        (editSubmenu as Array<Record<string, unknown>>)
          .filter((item) => item.role)
          .map((item) => item.role),
      ).toEqual(['reload', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
      expect(editSubmenu.filter((item) => item.visible !== false)).toEqual([
        { label: edit, role: 'reload', accelerator: 'CmdOrCtrl+R' },
      ]);
      expect(trayTemplate.map((item) => item.label)).toEqual([restore, quit]);
    },
  );

  it('hides only enabled window actions while a live tray is available', () => {
    const harness = createHarness();
    harness.desktopShell.attachWindow(harness.window);
    const ordinaryMinimize = preventableEvent();
    const ordinaryClose = preventableEvent();
    harness.window.emit('minimize', ordinaryMinimize);
    harness.window.emit('close', ordinaryClose);
    expect(ordinaryMinimize.preventDefault).not.toHaveBeenCalled();
    expect(ordinaryClose.preventDefault).not.toHaveBeenCalled();

    harness.desktopShell.configure({
      ...basePreferences,
      minimizeToTray: true,
    });
    const minimize = preventableEvent();
    const closeWhileOnlyMinimizeIsEnabled = preventableEvent();
    harness.window.emit('minimize', minimize);
    harness.window.emit('close', closeWhileOnlyMinimizeIsEnabled);
    expect(minimize.preventDefault).toHaveBeenCalledOnce();
    expect(closeWhileOnlyMinimizeIsEnabled.preventDefault).not.toHaveBeenCalled();
    expect(harness.window.hide).toHaveBeenCalledOnce();

    harness.desktopShell.configure({
      ...basePreferences,
      closeToTray: true,
    });
    const minimizeWhileOnlyCloseIsEnabled = preventableEvent();
    const close = preventableEvent();
    harness.window.emit('minimize', minimizeWhileOnlyCloseIsEnabled);
    harness.window.emit('close', close);
    expect(minimizeWhileOnlyCloseIsEnabled.preventDefault).not.toHaveBeenCalled();
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(harness.window.hide).toHaveBeenCalledTimes(2);
    harness.emitApp('before-quit', preventableEvent());
    const quittingClose = preventableEvent();
    harness.window.emit('close', quittingClose);
    expect(quittingClose.preventDefault).not.toHaveBeenCalled();
  });

  it('records quit intent even when async cleanup registered its listener first', () => {
    const asyncCleanup = vi.fn((event: PreventableEvent) => event.preventDefault());
    const harness = createHarness({ beforeQuitListener: asyncCleanup });
    harness.desktopShell.configure({ ...basePreferences, closeToTray: true });
    harness.desktopShell.attachWindow(harness.window);
    const quitEvent = preventableEvent();
    harness.emitApp('before-quit', quitEvent);
    const close = preventableEvent();
    harness.window.emit('close', close);

    expect(asyncCleanup).toHaveBeenCalledWith(quitEvent);
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(close.preventDefault).not.toHaveBeenCalled();
  });

  it('falls back to normal window behavior when tray initialization fails', () => {
    const harness = createHarness({ failTray: true });
    harness.desktopShell.configure({
      ...basePreferences,
      minimizeToTray: true,
      closeToTray: true,
    });
    harness.desktopShell.attachWindow(harness.window);
    const minimize = preventableEvent();
    const close = preventableEvent();
    harness.window.emit('minimize', minimize);
    harness.window.emit('close', close);

    expect(harness.desktopShell.getCapabilities().trayAvailable).toBe(false);
    expect(minimize.preventDefault).not.toHaveBeenCalled();
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(harness.window.hide).not.toHaveBeenCalled();
  });

  it('discards a tray that cannot accept its native context menu', () => {
    const harness = createHarness({ failTrayMenu: true });
    harness.desktopShell.configure({ ...basePreferences, minimizeToTray: true });
    harness.desktopShell.attachWindow(harness.window);
    const minimize = preventableEvent();
    harness.window.emit('minimize', minimize);

    expect(harness.trays[0]?.destroy).toHaveBeenCalledOnce();
    expect(harness.desktopShell.getCapabilities().trayAvailable).toBe(false);
    expect(minimize.preventDefault).not.toHaveBeenCalled();
  });

  it('restores hidden and minimized windows from tray activation', () => {
    const harness = createHarness();
    harness.desktopShell.attachWindow(harness.window);
    harness.window.visible = false;
    harness.window.minimized = true;
    harness.trays[0]?.emit('click');

    expect(harness.window.restore).toHaveBeenCalledOnce();
    expect(harness.window.show).toHaveBeenCalledOnce();
    expect(harness.window.focus).toHaveBeenCalledOnce();
  });

  it('suppresses attentive notifications and uses one explicit sound source when hidden', () => {
    const harness = createHarness();
    harness.desktopShell.configure({
      ...basePreferences,
      idleNotifications: true,
      notificationSound: true,
    });
    harness.desktopShell.attachWindow(harness.window);
    const payload = {
      id: 'completion-1',
      title: 'Task complete',
      body: 'The background task completed.',
      projectId: 'project-1',
      sessionId: 'session-1',
    };
    harness.window.focused = true;
    harness.desktopShell.notify(payload);
    expect(NotificationMock.instances).toHaveLength(0);
    expect(harness.shellApi.beep).not.toHaveBeenCalled();

    harness.window.visible = false;
    harness.desktopShell.notify({ ...payload, id: 'completion-2' });
    expect(NotificationMock.instances).toHaveLength(1);
    expect(NotificationMock.instances[0]?.options).toEqual({
      title: payload.title,
      body: payload.body,
      silent: true,
    });
    expect(NotificationMock.instances[0]?.show).toHaveBeenCalledOnce();
    expect(harness.shellApi.beep).toHaveBeenCalledOnce();
  });

  it('retires asynchronously failed native alerts and reports the lost capability', () => {
    const harness = createHarness();
    harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
    harness.window.visible = false;
    harness.onChange.mockClear();
    const payload = {
      id: 'completion-1',
      title: 'Complete',
      body: 'Done',
      projectId: 'project-1',
      sessionId: 'session-1',
    };
    harness.desktopShell.notify(payload);
    NotificationMock.instances[0]?.emit('failed');
    harness.desktopShell.notify({ ...payload, id: 'completion-2' });

    expect(NotificationMock.instances[0]?.close).toHaveBeenCalledOnce();
    expect(NotificationMock.instances).toHaveLength(1);
    expect(harness.desktopShell.getCapabilities().nativeNotificationsAvailable).toBe(false);
    expect(harness.onChange).toHaveBeenCalledOnce();
  });

  it('bounds live native alert references when the OS never emits close', () => {
    const harness = createHarness();
    harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
    harness.window.visible = false;
    const payload = {
      title: 'Complete',
      body: 'Done',
      projectId: 'project-1',
      sessionId: 'session-1',
    };
    for (let index = 0; index <= 64; index += 1) {
      harness.desktopShell.notify({ ...payload, id: `live-${index}` });
    }

    expect(NotificationMock.instances[0]?.close).toHaveBeenCalledOnce();
    expect(NotificationMock.instances[1]?.close).not.toHaveBeenCalled();
  });

  it('bounds completion deduplication by time instead of suppressing a session forever', () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const harness = createHarness();
      harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
      harness.window.visible = false;
      const payload = {
        id: 'completion-1',
        title: 'Complete',
        body: 'Done',
        projectId: 'project-1',
        sessionId: 'session-1',
      };
      harness.desktopShell.notify(payload);
      harness.desktopShell.notify(payload);
      expect(NotificationMock.instances).toHaveLength(1);

      vi.advanceTimersByTime(10 * 60 * 1_000 + 1);
      harness.desktopShell.notify(payload);
      expect(NotificationMock.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds completion deduplication storage instead of retaining every completion id', () => {
    const harness = createHarness();
    harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
    harness.window.visible = false;
    const payload = {
      title: 'Complete',
      body: 'Done',
      projectId: 'project-1',
      sessionId: 'session-1',
    };
    for (let index = 0; index <= 256; index += 1) {
      harness.desktopShell.notify({ ...payload, id: `completion-${index}` });
    }
    harness.desktopShell.notify({ ...payload, id: 'completion-0' });

    expect(NotificationMock.instances).toHaveLength(258);
  });

  it('restores and forwards the immutable payload when a native alert is clicked', () => {
    const harness = createHarness();
    harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
    harness.window.visible = false;
    const payload = {
      id: 'completion-1',
      title: 'Complete',
      body: 'Done',
      projectId: 'project-1',
      sessionId: 'session-1',
    };
    harness.desktopShell.notify(payload);
    NotificationMock.instances[0]?.emit('click');

    expect(harness.window.show).toHaveBeenCalledOnce();
    expect(harness.onNotificationClick).toHaveBeenCalledWith(payload);
    expect(harness.onNotificationClick.mock.calls[0]?.[0]).not.toBe(payload);
    expect(NotificationMock.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it('validates notification shape and length before any native side effect', () => {
    const harness = createHarness();
    harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
    harness.window.visible = false;

    expect(() =>
      harness.desktopShell.notify({ id: 'missing-fields' } as DesktopShellNotification),
    ).toThrow(TypeError);
    expect(() =>
      harness.desktopShell.notify({
        id: 'completion-1',
        title: 'x'.repeat(161),
        body: 'Done',
        projectId: 'project-1',
        sessionId: 'session-1',
      }),
    ).toThrow(TypeError);
    expect(NotificationMock.instances).toHaveLength(0);
  });

  it('reports unsupported native alerts while retaining the configured sound fallback', () => {
    const harness = createHarness({ notifications: false });
    harness.desktopShell.configure({
      ...basePreferences,
      idleNotifications: true,
      notificationSound: true,
    });
    harness.window.visible = false;
    harness.desktopShell.notify({
      id: 'completion-1',
      title: 'Complete',
      body: 'Done',
      projectId: 'project-1',
      sessionId: 'session-1',
    });

    expect(harness.desktopShell.getCapabilities().nativeNotificationsAvailable).toBe(false);
    expect(NotificationMock.instances).toHaveLength(0);
    expect(harness.shellApi.beep).toHaveBeenCalledOnce();
  });

  it('sets the stable app identity and disposes native resources and listeners', () => {
    const harness = createHarness();
    harness.desktopShell.configure({ ...basePreferences, idleNotifications: true });
    harness.window.visible = false;
    harness.desktopShell.notify({
      id: 'completion-1',
      title: 'Complete',
      body: 'Done',
      projectId: 'project-1',
      sessionId: 'session-1',
    });
    harness.desktopShell.dispose();

    expect(harness.app.setAppUserModelId).toHaveBeenCalledWith('com.xenodrive.vis');
    expect(harness.trays[0]?.destroy).toHaveBeenCalledOnce();
    expect(NotificationMock.instances[0]?.close).toHaveBeenCalledOnce();
    expect(harness.Menu.setApplicationMenu).toHaveBeenLastCalledWith(null);
    expect(harness.app.removeListener).toHaveBeenCalledWith('before-quit', expect.any(Function));
    expect(harness.desktopShell.getCapabilities().trayAvailable).toBe(false);
  });
});
