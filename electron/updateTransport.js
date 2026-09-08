import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseStableRelease } from './updatePolicy.js';

const API_URL = 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/latest';
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const DOWNLOAD_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function createUpdateTransport(options = {}) {
  const agent = options.agent ?? new https.Agent({ proxyEnv: process.env });
  const activeRequests = new Set();
  let disposed = false;

  const assertActive = () => {
    if (disposed) throw new Error('Update transport is disposed');
  };
  const request = (url, accept) => {
    assertActive();
    assertAllowedUpdateUrl(url);
    return new Promise((resolve, reject) => {
      const requestHandle = https.get(url, {
        agent,
        headers: {
          Accept: accept,
          'User-Agent': 'Vis-Desktop-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }, resolve);
      activeRequests.add(requestHandle);
      requestHandle.once('close', () => activeRequests.delete(requestHandle));
      requestHandle.setTimeout(REQUEST_TIMEOUT_MS, () => requestHandle.destroy(new Error('Update request timed out')));
      requestHandle.on('error', reject);
    });
  };
  const requestBuffer = async (url, accept, maximumBytes, redirects = 0) => {
    const response = await request(url, accept);
    if (isRedirect(response.statusCode)) {
      response.resume();
      return requestBuffer(redirectUrl(response, url, redirects), accept, maximumBytes, redirects + 1);
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
  };
  const getLatestRelease = async () => {
    const body = await requestBuffer(new URL(API_URL), 'application/vnd.github+json', MAX_METADATA_BYTES);
    try {
      return parseStableRelease(JSON.parse(body.toString('utf8')));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('GitHub returned malformed release metadata');
      throw error;
    }
  };
  const downloadAsset = async (asset, onProgress = () => undefined) => {
    assertActive();
    if (asset.size > MAX_ASSET_BYTES) throw new Error(`Release asset ${asset.name} exceeds the download limit`);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'vis-update-'));
    try {
      await chmod(directory, 0o700);
      const filePath = path.join(directory, path.basename(asset.name));
      await downloadToFile(request, new URL(asset.url), filePath, asset.size, onProgress);
      await chmod(filePath, 0o600);
      return filePath;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const requestHandle of activeRequests) requestHandle.destroy(new Error('Update transport disposed'));
  };
  return {
    getLatestRelease,
    downloadAsset,
    verifyAsset,
    removeFile: (filePath) => rm(path.dirname(filePath), { recursive: true, force: true }),
    dispose,
  };
}

export function isAllowedUpdateUrl(rawUrl) {
  try {
    const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
    return url.protocol === 'https:'
      && DOWNLOAD_HOSTS.has(url.hostname)
      && (url.port === '' || url.port === '443')
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export async function verifyAsset(filePath, asset, expectedDigest, algorithm = 'sha256') {
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

async function downloadToFile(request, url, filePath, expectedSize, onProgress, redirects = 0) {
  const response = await request(url, 'application/octet-stream');
  if (isRedirect(response.statusCode)) {
    response.resume();
    return downloadToFile(request, redirectUrl(response, url, redirects), filePath, expectedSize, onProgress, redirects + 1);
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

function redirectUrl(response, currentUrl, redirects) {
  if (redirects >= MAX_REDIRECTS) throw new Error('Update request exceeded the redirect limit');
  const location = response.headers.location;
  if (!location) throw new Error('Update redirect had no Location header');
  const nextUrl = new URL(location, currentUrl);
  assertAllowedUpdateUrl(nextUrl);
  return nextUrl;
}

function assertAllowedUpdateUrl(url) {
  if (!isAllowedUpdateUrl(url)) throw new Error('Update URL is outside the GitHub download allowlist');
}

function isRedirect(statusCode) {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}
