import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import electronUpdater from 'electron-updater';
import { bridgeVersionPaths } from './bridgeVersionPaths.js';
import { automaticAppUpdateTarget, parseInstalledVersion, parseStableRelease } from './updatePolicy.js';

const execFileAsync = promisify(execFile);
const API_URL = 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/latest';
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const updateAgent = new https.Agent({ proxyEnv: process.env });
const DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const { CancellationToken } = electronUpdater;

export function createUpdateRuntime() {
  const { autoUpdater } = electronUpdater;
  const activeRequests = new Set();
  const activeDownloads = new Set();
  const versionProbe = new AbortController();
  const removeUpdaterRequestPolicy = installUpdaterRequestPolicy(autoUpdater);
  const appUpdateTarget = detectAutomaticAppUpdateTarget();
  let disposed = false;

  const assertActive = () => {
    if (disposed) throw new Error('Desktop update runtime is disposed');
  };

  const downloadAppUpdate = async () => {
    assertActive();
    const token = new CancellationToken();
    activeDownloads.add(token);
    try {
      return await autoUpdater.downloadUpdate(token);
    } finally {
      activeDownloads.delete(token);
      token.dispose();
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    versionProbe.abort();
    for (const token of activeDownloads) token.cancel();
    for (const requestHandle of activeRequests) requestHandle.destroy(new Error('Desktop update runtime disposed'));
    removeUpdaterRequestPolicy();
  };

  return {
    platform: process.platform,
    arch: process.arch,
    automaticAppUpdates: appUpdateTarget !== null,
    automaticAppUpdateTarget: appUpdateTarget,
    updater: autoUpdater,
    getLatestRelease: () => {
      assertActive();
      return getLatestRelease(activeRequests);
    },
    getBridgeVersion: () => {
      assertActive();
      return getBridgeVersion(versionProbe.signal);
    },
    downloadAsset: (asset, onProgress) => {
      assertActive();
      return downloadAsset(asset, onProgress, activeRequests);
    },
    downloadAppUpdate,
    verifyAsset,
    removeFile: (filePath) => rm(path.dirname(filePath), { recursive: true, force: true }),
    dispose,
  };
}

async function getLatestRelease(activeRequests) {
  const body = await requestBuffer(new URL(API_URL), 'application/vnd.github+json', MAX_METADATA_BYTES, activeRequests);
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('GitHub returned malformed release metadata');
  }
  return parseStableRelease(payload);
}

async function getBridgeVersion(signal) {
  for (const command of bridgeVersionPaths(process.platform, process.env.LOCALAPPDATA)) {
    try {
      const { stdout } = await execFileAsync(command, ['--version'], {
        encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS, windowsHide: true, signal,
      });
      const version = parseInstalledVersion(stdout);
      if (version) return version;
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}

async function downloadAsset(asset, onProgress, activeRequests) {
  if (asset.size > MAX_ASSET_BYTES) throw new Error(`Release asset ${asset.name} exceeds the download limit`);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vis-update-'));
  const filePath = path.join(directory, path.basename(asset.name));
  try {
    await downloadToFile(new URL(asset.url), filePath, asset.size, onProgress, activeRequests);
    await chmod(filePath, 0o600);
    return filePath;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function verifyAsset(filePath, asset, expectedDigest, algorithm = 'sha256') {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size !== asset.size) {
    throw new Error(`Downloaded asset ${asset.name} has an unexpected size`);
  }
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const encoding = algorithm === 'sha512' ? 'base64' : 'hex';
  if (hash.digest(encoding) !== expectedDigest) {
    throw new Error(`Downloaded asset ${asset.name} failed ${algorithm.toUpperCase()} verification`);
  }
}

async function requestBuffer(url, accept, maximumBytes, activeRequests, redirects = 0) {
  const response = await request(url, accept, activeRequests);
  if (isRedirect(response.statusCode)) {
    response.resume();
    return requestBuffer(redirectUrl(response, url, redirects), accept, maximumBytes, activeRequests, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Update request failed with HTTP ${response.statusCode ?? 'unknown'}`);
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of response) {
    received += chunk.length;
    if (received > maximumBytes) {
      response.destroy();
      throw new Error('Update response exceeded the size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadToFile(url, filePath, expectedSize, onProgress, activeRequests, redirects = 0) {
  const response = await request(url, 'application/octet-stream', activeRequests);
  if (isRedirect(response.statusCode)) {
    response.resume();
    return downloadToFile(redirectUrl(response, url, redirects), filePath, expectedSize, onProgress, activeRequests, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Asset download failed with HTTP ${response.statusCode ?? 'unknown'}`);
  }
  const advertisedSize = Number(response.headers['content-length']);
  if (Number.isFinite(advertisedSize) && advertisedSize !== expectedSize) {
    response.resume();
    throw new Error('Asset download Content-Length does not match release metadata');
  }
  let received = 0;
  await pipeline(response, async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      if (received > expectedSize || received > MAX_ASSET_BYTES) {
        throw new Error('Asset download exceeded the declared size');
      }
      onProgress(Math.min(100, (received / expectedSize) * 100));
      yield chunk;
    }
  }, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (received !== expectedSize) throw new Error('Asset download ended before the declared size');
}

function request(url, accept, activeRequests) {
  assertAllowedDownloadUrl(url);
  return new Promise((resolve, reject) => {
    const requestHandle = https.get(
      url,
      {
        agent: updateAgent,
        headers: {
          Accept: accept,
          'User-Agent': 'Vis-Desktop-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      resolve,
    );
    activeRequests.add(requestHandle);
    requestHandle.once('close', () => activeRequests.delete(requestHandle));
    requestHandle.setTimeout(REQUEST_TIMEOUT_MS, () => requestHandle.destroy(new Error('Update request timed out')));
    requestHandle.on('error', reject);
  });
}

function redirectUrl(response, currentUrl, redirects) {
  if (redirects >= MAX_REDIRECTS) throw new Error('Update request exceeded the redirect limit');
  const location = response.headers.location;
  if (!location) throw new Error('Update redirect had no Location header');
  const nextUrl = new URL(location, currentUrl);
  assertAllowedDownloadUrl(nextUrl);
  return nextUrl;
}

function assertAllowedDownloadUrl(url) {
  if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error('Update URL is outside the GitHub download allowlist');
  }
}

function installUpdaterRequestPolicy(autoUpdater) {
  const webRequest = autoUpdater.netSession.webRequest;
  webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedUpdaterUrl(details.url) });
  });
  return () => webRequest.onBeforeRequest(null);
}

function isAllowedUpdaterUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && DOWNLOAD_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRedirect(statusCode) {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function detectAutomaticAppUpdateTarget() {
  let packageType = null;
  try {
    const packageTypePath = path.join(process.resourcesPath, 'package-type');
    if (existsSync(packageTypePath)) packageType = readFileSync(packageTypePath, 'utf8').trim();
  } catch {
    packageType = null;
  }
  return automaticAppUpdateTarget(process.platform, Boolean(process.env.APPIMAGE), packageType);
}
