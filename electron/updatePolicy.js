const REPOSITORY_PATH = '/repos/qiyuanhuakai/opencode-visualizer-cn/';
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+)$/u;
const AUTOMATIC_VERSION_PATTERN = /^(\d+\.\d+\.\d+)$/u;
const SHA256_PATTERN = /^sha256:([a-fA-F0-9]{64})$/u;
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

class DesktopUpdatePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DesktopUpdatePolicyError';
  }
}

export function parseStableRelease(value) {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false) {
    throw new DesktopUpdatePolicyError('GitHub did not return a stable release');
  }
  const match = typeof value.tag_name === 'string' ? VERSION_PATTERN.exec(value.tag_name) : null;
  if (!match || !Array.isArray(value.assets)) {
    throw new DesktopUpdatePolicyError('GitHub returned invalid stable release metadata');
  }
  return {
    version: match[1],
    assets: value.assets.map(parseAsset),
  };
}

export function selectManualAsset(release, component, platform, arch, linuxFormat = 'deb') {
  if (component === 'bridge') {
    return selectBridgeAsset(release, platform, arch, linuxFormat);
  }
  assertSupportedTarget(platform, arch);
  const expectedName = assetName(release.version, component, platform, arch, linuxFormat);
  return exactlyOneAsset(release, expectedName);
}

export function selectBridgeAsset(release, platform, arch, linuxFormat = 'deb') {
  assertSupportedTarget(platform, arch);
  if (platform === 'linux' && linuxFormat !== 'deb' && linuxFormat !== 'rpm') {
    throw new DesktopUpdatePolicyError(`Unsupported Linux bridge package format: ${linuxFormat}`);
  }
  const expectedName = assetName(release.version, 'bridge', platform, arch, linuxFormat ?? 'deb');
  return exactlyOneAsset(release, expectedName);
}

function exactlyOneAsset(release, expectedName) {
  const matches = release.assets.filter((asset) => asset.name === expectedName);
  if (matches.length !== 1) {
    throw new DesktopUpdatePolicyError(
      `Expected exactly one release asset named ${expectedName}, found ${matches.length}`,
    );
  }
  return matches[0];
}

export function selectAutomaticAppFile(info, platform, arch, target) {
  assertSupportedTarget(platform, arch);
  if (
    !isRecord(info) ||
    typeof info.version !== 'string' ||
    !AUTOMATIC_VERSION_PATTERN.test(info.version)
  ) {
    throw new DesktopUpdatePolicyError('Automatic update metadata has no stable version');
  }
  const expected = automaticAppNames(info.version, platform, arch, target);
  if (!Array.isArray(info.files) || info.files.length !== expected.names.size) {
    throw new DesktopUpdatePolicyError(
      'Automatic update artifact list does not match generated Vis targets',
    );
  }
  const files = new Map();
  for (const file of info.files) {
    if (
      !isRecord(file) ||
      typeof file.url !== 'string' ||
      !expected.names.has(file.url) ||
      files.has(file.url) ||
      typeof file.sha512 !== 'string' ||
      !SHA512_PATTERN.test(file.sha512) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    ) {
      throw new DesktopUpdatePolicyError(
        'Automatic update artifact does not match the Vis release target',
      );
    }
    files.set(file.url, file);
  }
  const file = files.get(expected.selected);
  if (!file)
    throw new DesktopUpdatePolicyError(
      'Automatic update manifest omits the installed Vis package target',
    );
  return { name: file.url, size: file.size, sha512: file.sha512, url: file.url };
}

export function sha256FromDigest(asset) {
  const match = typeof asset.digest === 'string' ? SHA256_PATTERN.exec(asset.digest) : null;
  if (!match) {
    throw new DesktopUpdatePolicyError(`Release asset ${asset.name} has no valid SHA-256 digest`);
  }
  return match[1].toLowerCase();
}

export function isNewerVersion(candidate, current) {
  if (current === null) return true;
  const candidateParts = parseVersionParts(candidate);
  const currentParts = parseVersionParts(current);
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] === currentParts[index]) continue;
    return candidateParts[index] > currentParts[index];
  }
  return false;
}

export function parseInstalledVersion(output) {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output.trim());
  return match ? match[1] : null;
}

export function automaticAppUpdateSupported(platform, hasAppImage, packageType) {
  return automaticAppUpdateTarget(platform, hasAppImage, packageType) !== null;
}

export function automaticAppUpdateTarget(platform, hasAppImage, packageType) {
  if (platform === 'win32') return 'nsis';
  if (platform !== 'linux') return null;
  if (hasAppImage) return 'appimage';
  return packageType === 'deb' ? 'deb' : null;
}

function parseAsset(value) {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    (typeof value.digest !== 'string' && value.digest !== null) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    typeof value.url !== 'string'
  ) {
    throw new DesktopUpdatePolicyError('GitHub returned invalid release asset metadata');
  }
  const url = checkedAssetApiUrl(value.url);
  return { name: value.name, digest: value.digest, size: value.size, url };
}

function checkedAssetApiUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DesktopUpdatePolicyError('GitHub returned an invalid release asset URL');
  }
  const assetId = url.pathname.slice(`${REPOSITORY_PATH}releases/assets/`.length);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.github.com' ||
    !url.pathname.startsWith(`${REPOSITORY_PATH}releases/assets/`) ||
    !/^\d+$/u.test(assetId) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DesktopUpdatePolicyError(
      'GitHub returned a release asset URL outside the official repository',
    );
  }
  return url.toString();
}

function assetName(version, component, platform, arch, linuxFormat) {
  if (component === 'app') {
    if (platform !== 'darwin') {
      throw new DesktopUpdatePolicyError('Manual app installers are supported only on macOS');
    }
    return `Vis-${version}-${arch}-MacOS.dmg`;
  }
  const platformName = { darwin: 'MacOS', linux: 'Linux', win32: 'Windows' }[platform];
  const extension = { darwin: 'pkg', linux: linuxFormat, win32: 'exe' }[platform];
  return `VisBridge-${version}-${arch}-${platformName}.${extension}`;
}

function assertSupportedTarget(platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new DesktopUpdatePolicyError(`Unsupported update platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new DesktopUpdatePolicyError(`Unsupported update architecture: ${arch}`);
  }
}

function automaticAppNames(version, platform, arch, target) {
  if (platform === 'win32' && target === 'nsis') {
    const selected = `Vis-${version}-${arch}-Windows.exe`;
    return { names: new Set([selected]), selected };
  }
  if (platform === 'linux') {
    const appImageArch = arch === 'x64' ? 'x86_64' : arch;
    const debArch = arch === 'x64' ? 'amd64' : arch;
    const appImage = `Vis-${version}-${appImageArch}-Linux.AppImage`;
    const deb = `Vis-${version}-${debArch}-Linux.deb`;
    if (target !== 'appimage' && target !== 'deb') {
      throw new DesktopUpdatePolicyError(
        'Automatic app update target does not match the Linux package',
      );
    }
    return { names: new Set([appImage, deb]), selected: target === 'appimage' ? appImage : deb };
  }
  throw new DesktopUpdatePolicyError('Automatic app update target does not match the platform');
}

function parseVersionParts(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new DesktopUpdatePolicyError(`Invalid update version: ${version}`);
  return match[1].split('.').map(BigInt);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
