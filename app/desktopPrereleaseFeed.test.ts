// @vitest-environment node
import { AppUpdater } from 'electron-updater';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automaticUpdateFeed } from '../electron/updateFeed.js';
import { selectAutomaticAppFile } from '../electron/updatePolicy.js';

class FeedUpdater extends AppUpdater {
  provider: GenericProvider | null = null;

  constructor() {
    super(null, {
      version: '1.2.3-alpha.2', name: 'Vis', isPackaged: true,
      appUpdateConfigPath: '/private/app-update.yml', userDataPath: '/private/user-data',
      baseCachePath: '/private/cache', whenReady: async () => undefined,
      relaunch: () => undefined, quit: () => undefined, onQuit: () => undefined,
    });
    this.autoDownload = false;
    this.logger = null;
  }

  protected override async getUpdateInfoAndProvider() {
    if (!this.provider) throw new Error('Test provider is missing');
    return { info: await this.provider.getLatestVersion(), provider: this.provider };
  }

  protected override doDownloadUpdate(): Promise<string[]> {
    return Promise.resolve([]);
  }

  override quitAndInstall(): void {}
}

describe('published prerelease metadata feeds', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { platform: 'win32', arch: 'x64', manifest: 'latest.yml' },
    { platform: 'win32', arch: 'arm64', manifest: 'latest-arm64.yml' },
    { platform: 'linux', arch: 'x64', manifest: 'latest-linux.yml' },
    { platform: 'linux', arch: 'arm64', manifest: 'latest-linux-arm64.yml' },
  ] as const)('requests $manifest from the selected alpha release for $platform $arch', async ({ platform, arch, manifest }) => {
    // Given: real electron-updater provider logic and the metadata of a published alpha.
    vi.stubEnv('TEST_UPDATER_ARCH', arch);
    const updater = new FeedUpdater();
    const feed = automaticUpdateFeed({ version: '1.2.3-alpha.10' }, platform, arch);
    updater.setFeedURL(feed);
    updater.channel = feed.channel;
    updater.allowPrerelease = true;
    updater.allowDowngrade = false;
    const executor = new ElectronHttpExecutor();
    const artifact = platform === 'win32'
      ? `Vis-1.2.3-alpha.10-${arch}-Windows.exe`
      : `Vis-1.2.3-alpha.10-${arch === 'x64' ? 'x86_64' : arch}.AppImage`;
    const names = platform === 'win32' ? [artifact] : [
      artifact, `Vis-1.2.3-alpha.10-${arch === 'x64' ? 'amd64' : arch}-Linux.deb`,
    ];
    const request = vi.spyOn(executor, 'request').mockResolvedValue(JSON.stringify({
      version: '1.2.3-alpha.10',
      files: names.map((url) => ({ url, sha512: `${'A'.repeat(86)}==`, size: 12 })),
    }));
    const provider = new GenericProvider(feed, updater, {
      platform, executor, isUseMultipleRangeRequest: feed.useMultipleRangeRequest,
    });
    updater.provider = provider;

    // When: the provider resolves and parses its release metadata.
    const result = await updater.checkForUpdates();
    if (!result) throw new Error('Real updater did not check the fixture feed');
    const info = result.updateInfo;

    // Then: both metadata and artifacts resolve under the selected release, using published channels.
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'https:', hostname: 'github.com',
      path: expect.stringContaining(`/releases/download/v1.2.3-alpha.10/${manifest}`),
    }), undefined);
    expect(result.isUpdateAvailable).toBe(true);
    expect(info.version).toBe('1.2.3-alpha.10');
    expect(provider.resolveFiles(info)[0]?.url.href).toBe(`${feed.url}${artifact}`);
    expect(selectAutomaticAppFile(info, platform, arch, platform === 'win32' ? 'nsis' : 'appimage').name).toBe(artifact);
    expect(updater.allowDowngrade).toBe(false);
    expect(provider.isUseMultipleRangeRequest).toBe(false);
  });

  it('retains an unprefixed official release tag', () => {
    // Given: release metadata uses an unprefixed valid SemVer tag.
    const tag = '1.2.3-alpha.10+build.1';

    // When: constructing its feed.
    const feed = automaticUpdateFeed({ version: tag, tagName: tag }, 'win32', 'x64');

    // Then: the exact tag is URL encoded rather than guessed.
    expect(feed.url).toBe('https://github.com/qiyuanhuakai/opencode-visualizer-cn/releases/download/1.2.3-alpha.10%2Bbuild.1/');
  });

  it.each(['../../other', 'v1.2.4', '1.2.3-alpha.01'])('rejects an invalid or mismatched release tag %s', (tag) => {
    // Given/When/Then: an untrusted tag cannot alter the pinned feed location.
    expect(() => automaticUpdateFeed({ version: '1.2.3-alpha.10', tagName: tag }, 'win32', 'x64')).toThrow();
  });
});
