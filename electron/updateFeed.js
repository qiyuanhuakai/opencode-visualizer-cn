import { parseUpdateVersion } from './updateVersion.js';

export function automaticUpdateFeed(release, platform, arch) {
  const { version, tagName = `v${version}` } = release;
  if (parseUpdateVersion(version).version !== version || parseUpdateVersion(tagName).version !== version) {
    throw new Error('Automatic update feed tag does not match the selected release');
  }
  return {
    provider: 'generic',
    url: `https://github.com/qiyuanhuakai/opencode-visualizer-cn/releases/download/${encodeURIComponent(tagName)}/`,
    channel: platform === 'win32' && arch === 'arm64' ? 'latest-arm64' : 'latest',
    useMultipleRangeRequest: false,
  };
}
