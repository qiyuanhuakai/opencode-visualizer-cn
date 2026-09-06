import type {
  DesktopBridgeVersionReport,
  DesktopComponent,
  DesktopUpdateState,
} from '../app/types/desktop';
import type { UpdateRuntime } from './updateRuntime.js';

export interface DesktopUpdatesOptions {
  readonly app: {
    readonly isPackaged: boolean;
    getVersion(): string;
  };
  readonly shell: {
    openPath(filePath: string): Promise<string>;
  };
  readonly onChange: (state: Readonly<Record<DesktopComponent, DesktopUpdateState>>) => void;
  readonly beforeInstall: (
    component: DesktopComponent,
    signal: AbortSignal,
  ) => Promise<void | boolean>;
}

export interface DesktopUpdates {
  getState(): Readonly<Record<DesktopComponent, DesktopUpdateState>>;
  reportBridgeVersion(
    report: DesktopBridgeVersionReport,
  ): Readonly<Record<DesktopComponent, DesktopUpdateState>>;
  configure(preferences: {
    readonly autoCheckUpdates: boolean;
    readonly autoDownloadUpdates: boolean;
  }): Promise<Readonly<Record<DesktopComponent, DesktopUpdateState>>>;
  check(
    component: DesktopComponent,
  ): Promise<Readonly<Record<DesktopComponent, DesktopUpdateState>>>;
  download(
    component: DesktopComponent,
  ): Promise<Readonly<Record<DesktopComponent, DesktopUpdateState>>>;
  install(
    component: DesktopComponent,
  ): Promise<Readonly<Record<DesktopComponent, DesktopUpdateState>>>;
  dispose(): Promise<void>;
}

export declare function createDesktopUpdates(
  options: DesktopUpdatesOptions,
  runtime?: UpdateRuntime,
): DesktopUpdates;
