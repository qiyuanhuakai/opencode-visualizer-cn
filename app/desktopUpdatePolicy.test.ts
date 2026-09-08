import { describe, expect, it } from 'vitest';
import {
  automaticAppUpdateSupported,
  parseStableRelease,
  selectAutomaticAppFile,
  selectBridgeAsset,
  selectManualAsset,
  sha256FromDigest,
} from '../electron/updatePolicy.js';

describe('desktop update release policy', () => {
  it('selects only the exact bridge installer for the current platform and architecture', () => {
    // Given: a stable release containing adjacent platform and architecture installers.
    const release = parseStableRelease({
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets: [
        asset('VisBridge-1.2.3-x64-Linux.deb'),
        asset('VisBridge-1.2.3-arm64-Linux.deb'),
        asset('VisBridge-1.2.3-x64-Windows.exe'),
      ],
    });

    // When: Linux x64 asks for the bridge installer.
    const selected = selectManualAsset(release, 'bridge', 'linux', 'x64');

    // Then: selection is an exact filename match rather than a fuzzy platform match.
    expect(selected.name).toBe('VisBridge-1.2.3-x64-Linux.deb');
  });

  it('selects the requested Linux bridge package while retaining the DEB default', () => {
    // Given: the release ships both supported Linux package formats.
    const release = parseStableRelease({
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets: [asset('VisBridge-1.2.3-x64-Linux.deb'), asset('VisBridge-1.2.3-x64-Linux.rpm')],
    });

    // When/Then: callers can request RPM while an omitted format still selects DEB.
    expect(selectBridgeAsset(release, 'linux', 'x64', 'rpm').name).toBe(
      'VisBridge-1.2.3-x64-Linux.rpm',
    );
    expect(selectManualAsset(release, 'bridge', 'linux', 'x64', 'rpm').name).toBe(
      'VisBridge-1.2.3-x64-Linux.rpm',
    );
    expect(selectManualAsset(release, 'bridge', 'linux', 'x64').name).toBe(
      'VisBridge-1.2.3-x64-Linux.deb',
    );
  });

  it('rejects draft and prerelease responses even when the endpoint returns them', () => {
    // Given: GitHub-shaped releases that are not stable publication candidates.
    const draft = { tag_name: 'v1.2.3', draft: true, prerelease: false, assets: [] };
    const prerelease = { tag_name: 'v1.2.3-rc.1', draft: false, prerelease: true, assets: [] };

    // When/Then: neither response crosses the stable-release boundary.
    expect(() => parseStableRelease(draft)).toThrow('stable');
    expect(() => parseStableRelease(prerelease)).toThrow('stable');
  });

  it('requires GitHub sha256 digest metadata', () => {
    // Given: an otherwise valid release asset without a digest.
    const release = parseStableRelease({
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets: [asset('VisBridge-1.2.3-x64-Linux.deb', null)],
    });

    // When: its digest is requested.
    const selected = selectManualAsset(release, 'bridge', 'linux', 'x64');

    // Then: download cannot proceed without independently published SHA-256 metadata.
    expect(() => sha256FromDigest(selected)).toThrow('SHA-256 digest');
  });

  it('rejects extra path segments masquerading as a GitHub asset id', () => {
    // Given: an API-hosted URL that is not an exact numeric asset endpoint.
    const release = {
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets: [
        { ...asset('VisBridge-1.2.3-x64-Linux.deb'), url: `${asset('unused').url}/payload` },
      ],
    };

    // When/Then: the URL cannot escape the exact repository asset endpoint shape.
    expect(() => parseStableRelease(release)).toThrow('outside the official repository');
  });

  it('enables automatic Linux updates only for shipped package identities', () => {
    // Given: the package identities electron-updater may encounter on Linux.
    const identities = [null, 'deb', 'rpm', 'pacman'] as const;

    // When: runtime capability is derived for the configured distribution targets.
    const supported = identities.map((packageType) =>
      automaticAppUpdateSupported('linux', false, packageType),
    );

    // Then: only the shipped DEB package is automatic without an AppImage identity.
    expect(supported).toEqual([false, true, false, false]);
    expect(automaticAppUpdateSupported('linux', true, null)).toBe(true);
    expect(automaticAppUpdateSupported('win32', false, null)).toBe(true);
  });

  it.each([
    ['win32', 'x64', 'nsis', 'Vis-1.2.3-x64-Windows.exe'],
    ['win32', 'arm64', 'nsis', 'Vis-1.2.3-arm64-Windows.exe'],
    ['linux', 'x64', 'appimage', 'Vis-1.2.3-x86_64-Linux.AppImage'],
    ['linux', 'x64', 'deb', 'Vis-1.2.3-amd64-Linux.deb'],
    ['linux', 'arm64', 'appimage', 'Vis-1.2.3-arm64-Linux.AppImage'],
    ['linux', 'arm64', 'deb', 'Vis-1.2.3-arm64-Linux.deb'],
  ] as const)(
    'selects the generated automatic artifact for %s %s %s',
    (platform, arch, target, name) => {
      // Given: updater metadata produced from the configured targets and artifactName templates.
      const info = automaticInfo(platform === 'linux' ? linuxNames(arch) : [name]);

      // When: the offer crosses the app-update policy boundary.
      const selected = selectAutomaticAppFile(info, platform, arch, target);

      // Then: the exact Vis installer and its integrity metadata are retained.
      expect(selected).toEqual({ name, size: 12, sha512: `${'A'.repeat(86)}==`, url: name });
    },
  );

  it.each([
    'VisBridge-1.2.3-x64-Windows.exe',
    'Vis-1.2.3-arm64-Windows.exe',
    'Vis-1.2.3-x64-Linux.AppImage',
    'Vis-1.2.3-x86_64-Linux.deb',
  ])('rejects a mismatched automatic artifact before download: %s', (name) => {
    // Given: stable-looking metadata for a different component, architecture, or generated Linux name.
    const info = automaticInfo([name]);

    // When/Then: Windows x64 selection rejects it instead of using a fuzzy Vis prefix.
    expect(() => selectAutomaticAppFile(info, 'win32', 'x64', 'nsis')).toThrow(
      /automatic update artifact/iu,
    );
  });

  it('rejects prerelease versions and ambiguous automatic file lists', () => {
    // Given: an exact artifact paired with unstable or extra manifest metadata.
    const exact = automaticInfo(['Vis-1.2.3-x64-Windows.exe']);

    // When/Then: neither a prerelease version nor an adjacent bridge file is accepted.
    expect(() =>
      selectAutomaticAppFile({ ...exact, version: '1.2.3-rc.1' }, 'win32', 'x64', 'nsis'),
    ).toThrow('stable');
    expect(() =>
      selectAutomaticAppFile(
        { ...exact, files: [...exact.files, exact.files[0]] },
        'win32',
        'x64',
        'nsis',
      ),
    ).toThrow(/automatic update artifact list/iu);
  });
});

function asset(name: string, digest: string | null = `sha256:${'a'.repeat(64)}`) {
  return {
    name,
    digest,
    size: 12,
    url: `https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1`,
  };
}

function automaticInfo(names: readonly string[]) {
  return {
    version: '1.2.3',
    files: names.map((url) => ({ url, sha512: `${'A'.repeat(86)}==`, size: 12 })),
  };
}

function linuxNames(arch: 'arm64' | 'x64') {
  return arch === 'x64'
    ? ['Vis-1.2.3-x86_64-Linux.AppImage', 'Vis-1.2.3-amd64-Linux.deb']
    : ['Vis-1.2.3-arm64-Linux.AppImage', 'Vis-1.2.3-arm64-Linux.deb'];
}
