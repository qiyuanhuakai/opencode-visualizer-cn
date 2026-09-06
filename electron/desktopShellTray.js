const SUPPORTED_LINUX_DESKTOPS = new Set([
  'budgie',
  'cinnamon',
  'cosmic',
  'flashback',
  'kde',
  'lxde',
  'lxqt',
  'mate',
  'pantheon',
  'plasma',
  'ubuntu',
  'unity',
  'xfce',
]);

export function trayEnvironmentIsSupported(platform, app, environment) {
  if (platform !== 'linux') return true;

  try {
    if (app.isUnityRunning?.()) return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }

  if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) return false;
  const desktopTokens = [
    environment.XDG_CURRENT_DESKTOP,
    environment.XDG_SESSION_DESKTOP,
    environment.DESKTOP_SESSION,
  ]
    .filter((value) => typeof value === 'string')
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/));
  return desktopTokens.some((token) => SUPPORTED_LINUX_DESKTOPS.has(token));
}
