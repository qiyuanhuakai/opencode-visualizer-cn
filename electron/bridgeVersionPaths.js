import path from 'node:path';

export function bridgeVersionPaths(platform, localAppData) {
  switch (platform) {
    case 'darwin': return ['/usr/local/bin/vis_bridge', 'vis_bridge'];
    case 'linux': return ['/usr/bin/vis_bridge', 'vis_bridge'];
    case 'win32': return localAppData
      ? [path.win32.join(localAppData, 'Programs', 'vis_bridge', 'vis_bridge.exe'), 'vis_bridge']
      : ['vis_bridge'];
    default: return ['vis_bridge'];
  }
}
