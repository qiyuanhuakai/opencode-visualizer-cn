import path from 'node:path';

const APPLICATION_ICON_RESOURCE = 'application-icon.png';

export function resolveApplicationTrayIconPath(app, resourcesPath = process.resourcesPath) {
  return app.isPackaged
    ? path.join(resourcesPath, APPLICATION_ICON_RESOURCE)
    : path.join(app.getAppPath(), 'build', 'icon.png');
}

export function createApplicationTrayIcon(app, nativeImage, resourcesPath = process.resourcesPath) {
  const source = nativeImage.createFromPath(resolveApplicationTrayIconPath(app, resourcesPath));
  if (source.isEmpty()) throw new Error('Application tray icon could not be decoded');
  return source.resize({ width: 16, height: 16, quality: 'best' });
}
