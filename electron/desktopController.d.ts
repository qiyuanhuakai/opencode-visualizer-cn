import type {
  DesktopBridgeVersionReport,
  DesktopNotification,
  DesktopPreferences,
  DesktopState,
} from '../app/types/desktop';

export interface DesktopControllerOptions {
  readonly storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): unknown;
  };
  readonly desktopShell: {
    configure(preferences: DesktopPreferences): void;
    getCapabilities(): Pick<DesktopState, 'trayAvailable' | 'nativeNotificationsAvailable'>;
    notify(notification: DesktopNotification): void;
  };
  readonly updates: {
    getState(): DesktopState['updates'];
    configure(
      preferences: Pick<DesktopPreferences, 'autoCheckUpdates' | 'autoDownloadUpdates'>,
    ): void;
    reportBridgeVersion(report: DesktopBridgeVersionReport): unknown;
    check(component: 'app' | 'bridge'): Promise<unknown>;
    download(component: 'app' | 'bridge'): Promise<unknown>;
    install(component: 'app' | 'bridge'): Promise<unknown>;
  };
  readonly publish: (state: DesktopState) => void;
}
export interface DesktopController {
  getState(): DesktopState;
  configure(patch: unknown): DesktopState;
  reportBridgeVersion(payload: unknown): Promise<DesktopState>;
  check(component: unknown): Promise<DesktopState>;
  download(component: unknown): Promise<DesktopState>;
  install(component: unknown): Promise<DesktopState>;
  notify(notification: unknown): void;
  start(): void;
}
export function createDesktopController(options: DesktopControllerOptions): DesktopController;
export function registerDesktopIpc(options: {
  readonly ipcMain: {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void;
  };
  readonly controller: DesktopController;
  readonly assertTrustedRenderer: (event: unknown) => void;
}): void;
