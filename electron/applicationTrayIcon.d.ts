import type { App, NativeImage, nativeImage } from 'electron';

type TrayIconApp = Pick<App, 'isPackaged' | 'getAppPath'>;

export function resolveApplicationTrayIconPath(app: TrayIconApp, resourcesPath?: string): string;
export function createApplicationTrayIcon(
  app: TrayIconApp,
  images: Pick<typeof nativeImage, 'createFromPath'>,
  resourcesPath?: string,
): NativeImage;
