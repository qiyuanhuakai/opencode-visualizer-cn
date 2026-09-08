import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import electronUpdater from 'electron-updater';
import { detectLinuxPackageFormat } from '../bridge/updatePlatform.js';
import { bridgeVersionPaths } from './bridgeVersionPaths.js';
import { automaticAppUpdateTarget, parseInstalledVersion } from './updatePolicy.js';
import { createUpdateTransport, isAllowedUpdateUrl } from './updateTransport.js';

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 15_000;
const { CancellationToken } = electronUpdater;

export function createUpdateRuntime() {
  const { autoUpdater } = electronUpdater;
  const transport = createUpdateTransport();
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
    transport.dispose();
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
      return transport.getLatestRelease();
    },
    getBridgeVersion: () => {
      assertActive();
      return getBridgeVersion(versionProbe.signal);
    },
    resolveBridgeLinuxFormat: () => {
      assertActive();
      return detectLinuxPackageFormat({ requireOwnership: true });
    },
    downloadAsset: (asset, onProgress) => {
      assertActive();
      return transport.downloadAsset(asset, onProgress);
    },
    downloadAppUpdate,
    verifyAsset: transport.verifyAsset,
    removeFile: transport.removeFile,
    dispose,
  };
}

async function getBridgeVersion(signal) {
  for (const command of bridgeVersionPaths(process.platform, process.env.LOCALAPPDATA)) {
    try {
      const { stdout } = await execFileAsync(command, ['--version'], {
        encoding: 'utf8',
        timeout: REQUEST_TIMEOUT_MS,
        windowsHide: true,
        signal,
      });
      const version = parseInstalledVersion(stdout);
      if (version) return version;
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}

function installUpdaterRequestPolicy(autoUpdater) {
  const webRequest = autoUpdater.netSession.webRequest;
  webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedUpdateUrl(details.url) });
  });
  return () => webRequest.onBeforeRequest(null);
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
