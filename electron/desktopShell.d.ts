import type { DesktopLocale, DesktopNotification, DesktopPreferences } from '../app/types/desktop';
import type * as Electron from 'electron';

export type DesktopShellPreferences = DesktopPreferences;
export type DesktopShellNotification = DesktopNotification;

export interface DesktopShellWindow {
  on(event: 'minimize' | 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  removeListener(
    event: 'minimize' | 'close',
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
  restore(): void;
}

export interface DesktopShell {
  configure(preferences: DesktopShellPreferences): void;
  attachWindow(window: DesktopShellWindow): void;
  getCapabilities(): Readonly<{
    trayAvailable: boolean;
    nativeNotificationsAvailable: boolean;
  }>;
  notify(payload: DesktopShellNotification): void;
  restore(): void;
  dispose(): void;
}

export interface DesktopShellDependencies {
  app: Electron.App;
  BrowserWindow: typeof Electron.BrowserWindow;
  Menu: typeof Electron.Menu;
  Tray: typeof Electron.Tray;
  nativeImage: typeof Electron.nativeImage;
  Notification: typeof Electron.Notification;
  shell: typeof Electron.shell;
  getWindow?(): DesktopShellWindow | null;
  onNotificationClick?(payload: DesktopShellNotification): void;
  onChange?(): void;
}

export declare function createDesktopShell(dependencies: DesktopShellDependencies): DesktopShell;

export type { DesktopLocale };
