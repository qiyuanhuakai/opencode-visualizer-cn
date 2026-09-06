export type DesktopComponent = 'app' | 'bridge';
export type DesktopLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'eo';

export interface DesktopPreferences {
  readonly locale: DesktopLocale;
  readonly minimizeToTray: boolean;
  readonly closeToTray: boolean;
  readonly autoCheckUpdates: boolean;
  readonly autoDownloadUpdates: boolean;
  readonly idleNotifications: boolean;
  readonly notificationSound: boolean;
}

export interface DesktopUpdateState {
  readonly component: DesktopComponent;
  readonly currentVersion: string | null;
  readonly availableVersion: string | null;
  readonly phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'installer-opened'
    | 'up-to-date'
    | 'error'
    | 'unsupported';
  readonly progress: number | null;
  readonly error: string | null;
  readonly installKind: 'automatic' | 'manual' | 'unsupported';
  readonly assetName: string | null;
}

export interface DesktopState {
  readonly preferences: DesktopPreferences;
  readonly trayAvailable: boolean;
  readonly nativeNotificationsAvailable: boolean;
  readonly updates: Readonly<Record<DesktopComponent, DesktopUpdateState>>;
}

export interface DesktopNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface DesktopBridgeVersionReport {
  readonly connectionId: string;
  readonly version: string | null;
}

export interface DesktopApi {
  getState(): Promise<DesktopState>;
  configure(patch: Partial<DesktopPreferences>): Promise<DesktopState>;
  reportBridgeVersion?(report: DesktopBridgeVersionReport): Promise<DesktopState>;
  check(component: DesktopComponent): Promise<DesktopState>;
  download(component: DesktopComponent): Promise<DesktopState>;
  install(component: DesktopComponent): Promise<DesktopState>;
  notify(notification: DesktopNotification): Promise<void>;
  onState(listener: (state: DesktopState) => void): () => void;
  onNotificationClick(listener: (notification: DesktopNotification) => void): () => void;
}
