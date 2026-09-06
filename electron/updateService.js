import path from 'node:path';
import { createUpdateAdmission } from './updateAdmission.js';
import { createAutomaticUpdate } from './updateAutomatic.js';
import { attachUpdaterEvents } from './updateEvents.js';
import { isNewerVersion, selectManualAsset, sha256FromDigest } from './updatePolicy.js';
import { createUpdateRuntime } from './updateRuntime.js';
import { boundedPercent, errorMessage, initialState, settleWithin, transition, unsupportedMessage, versionFromInfo } from './updateState.js';

const COMPONENTS = ['app', 'bridge'];
const DISPOSE_WAIT_MS = 5_000;

export function createDesktopUpdates({ app, shell, onChange, beforeInstall }, injectedRuntime) {
  const runtime = injectedRuntime ?? createUpdateRuntime();
  const automaticApp = app.isPackaged && runtime.automaticAppUpdates;
  const manualApp = app.isPackaged && runtime.platform === 'darwin';
  const bridgeSupported = ['darwin', 'linux', 'win32'].includes(runtime.platform) &&
    ['arm64', 'x64'].includes(runtime.arch);
  const state = {
    app: initialState('app', app.getVersion(), automaticApp ? 'automatic' : manualApp ? 'manual' : 'unsupported'),
    bridge: initialState('bridge', null, bridgeSupported ? 'manual' : 'unsupported'),
  };
  const assets = new Map();
  const downloads = new Map();
  const stagingFiles = new Set();
  const handedOffFiles = new Set();
  const admission = createUpdateAdmission();
  const automaticUpdate = createAutomaticUpdate(runtime);
  let autoCheckUpdates = false;
  let autoDownloadUpdates = false;
  let disposed = false;
  let disposePromise = null;
  let automaticOfferError = null;
  const installAbortController = new AbortController();

  const publish = (component, patch) => {
    if (disposed) return;
    state[component] = { ...state[component], ...patch };
    onChange(getState());
  };
  const fail = (component, error) => {
    publish(component, { phase: 'error', progress: null, error: errorMessage(error) });
  };

  const acceptAutomaticOffer = (info) => {
    return automaticUpdate.accept(info);
  };
  const removeUpdaterListeners = attachUpdaterEvents(
    runtime.updater,
    publish,
    () => state.app.availableVersion,
    acceptAutomaticOffer,
    (error) => { automaticOfferError = error; automaticUpdate.clear(); },
  );
  runtime.updater.autoDownload = false;
  runtime.updater.autoInstallOnAppQuit = false;
  runtime.updater.allowPrerelease = false;
  runtime.updater.channel = runtime.platform === 'win32' && runtime.arch === 'arm64' ? 'latest-arm64' : null;
  runtime.updater.allowDowngrade = false;

  function getState() {
    return Object.freeze({ app: Object.freeze({ ...state.app }), bridge: Object.freeze({ ...state.bridge }) });
  }

  async function checkUnlocked(component) {
    if (state[component].installKind === 'unsupported') {
      publish(component, { phase: 'unsupported', progress: null, error: unsupportedMessage(component) });
      return getState();
    }
    publish(component, transition('checking'));
    let checkSucceeded = false;
    try {
      if (component === 'app' && automaticApp) await checkAutomaticApp();
      else await checkManual(component);
      checkSucceeded = true;
    } catch (error) {
      fail(component, error);
    }
    if (checkSucceeded && autoDownloadUpdates && state[component].phase === 'available') {
      await downloadUnlocked(component);
    }
    return getState();
  }

  async function checkAutomaticApp() {
    automaticUpdate.clear();
    automaticOfferError = null;
    const result = await runtime.updater.checkForUpdates();
    if (automaticOfferError) throw automaticOfferError;
    if (result === null) {
      automaticUpdate.clear();
      publish('app', { phase: 'unsupported', error: 'Automatic app updater is inactive', progress: null });
      return;
    }
    const file = automaticUpdate.accept(result.updateInfo);
    const version = versionFromInfo(result.updateInfo);
    if (version !== null && isNewerVersion(version, state.app.currentVersion)) {
      publish('app', { availableVersion: version, phase: 'available', error: null, assetName: file.name });
    } else {
      automaticUpdate.clear();
      publish('app', { availableVersion: null, phase: 'up-to-date', error: null, assetName: null });
    }
  }

  async function checkManual(component) {
    const currentVersion = component === 'bridge'
      ? await runtime.getBridgeVersion()
      : state.app.currentVersion;
    const release = await runtime.getLatestRelease();
    if (!isNewerVersion(release.version, currentVersion)) {
      assets.delete(component);
      publish(component, {
        currentVersion,
        availableVersion: null,
        phase: 'up-to-date',
        progress: null,
        error: null,
        assetName: null,
      });
      return;
    }
    const asset = selectManualAsset(release, component, runtime.platform, runtime.arch);
    sha256FromDigest(asset);
    assets.set(component, asset);
    publish(component, {
      currentVersion,
      availableVersion: release.version,
      phase: 'available',
      progress: null,
      error: null,
      assetName: asset.name,
    });
  }

  async function downloadUnlocked(component) {
    if (state[component].phase !== 'available') {
      fail(component, new Error(`No ${component} update is available to download`));
      return getState();
    }
    publish(component, { phase: 'downloading', progress: 0, error: null });
    try {
      if (component === 'app' && automaticApp) {
        const paths = await runtime.downloadAppUpdate();
        automaticUpdate.recordDownload(paths);
        if (state.app.phase === 'downloading') publish('app', { phase: 'downloaded', progress: 100 });
      } else {
        await downloadManual(component);
      }
    } catch (error) {
      fail(component, error);
    }
    return getState();
  }

  async function downloadManual(component) {
    const asset = assets.get(component);
    if (!asset) throw new Error(`No verified ${component} release asset is selected`);
    const expectedSha256 = sha256FromDigest(asset);
    const filePath = await runtime.downloadAsset(asset, (progress) => {
      publish(component, { phase: 'downloading', progress: boundedPercent({ percent: progress }), error: null });
    });
    if (disposed) {
      await runtime.removeFile(filePath);
      return;
    }
    try {
      await runtime.verifyAsset(filePath, asset, expectedSha256);
    } catch (error) {
      await runtime.removeFile(filePath);
      throw error;
    }
    if (disposed) {
      await runtime.removeFile(filePath);
      return;
    }
    stagingFiles.add(filePath);
    downloads.set(component, filePath);
    publish(component, { phase: 'downloaded', progress: 100, error: null });
  }

  async function installUnlocked(component) {
    if (state[component].phase !== 'downloaded') {
      fail(component, new Error(`No downloaded ${component} update is ready to install`));
      return getState();
    }
    try {
      const approved = await beforeInstall(component, installAbortController.signal);
      if (approved === false || disposed) return getState();
      publish(component, { phase: 'installing', error: null });
      if (component === 'app' && automaticApp) {
        await automaticUpdate.verifyDownload();
        if (disposed) return getState();
        runtime.updater.quitAndInstall(false, true);
      } else {
        await openManualInstaller(component);
      }
    } catch (error) {
      fail(component, error);
    }
    return getState();
  }

  async function openManualInstaller(component) {
    const asset = assets.get(component);
    const filePath = downloads.get(component);
    if (!asset || !filePath) throw new Error(`No downloaded ${component} installer is ready`);
    await runtime.verifyAsset(filePath, asset, sha256FromDigest(asset));
    if (disposed) return;
    handedOffFiles.add(filePath);
    try {
      const openError = await shell.openPath(filePath);
      if (openError) throw new Error(`Could not open ${path.basename(filePath)}: ${openError}`);
    } catch (error) {
      handedOffFiles.delete(filePath);
      if (disposed) await runtime.removeFile(filePath);
      throw error;
    }
    publish(component, { phase: 'installer-opened', progress: 100, error: null });
  }

  const admit = (component, operation) => {
    assertComponent(component);
    if (disposed) return Promise.reject(new Error('Desktop update service is disposed'));
    return admission.run(component, operation);
  };
  const check = (component) => admit(component, () => checkUnlocked(component));
  const download = (component) => admit(component, () => downloadUnlocked(component));
  const install = (component) => admit(component, () => installUnlocked(component));

  async function configure(preferences) {
    const shouldCheck = preferences.autoCheckUpdates && !autoCheckUpdates;
    const shouldDownload = preferences.autoDownloadUpdates && !autoDownloadUpdates;
    autoCheckUpdates = preferences.autoCheckUpdates;
    autoDownloadUpdates = preferences.autoDownloadUpdates;
    if (!app.isPackaged) return getState();
    if (shouldCheck) await Promise.allSettled(COMPONENTS.map((component) => check(component)));
    if (autoDownloadUpdates && (shouldCheck || shouldDownload)) {
      await Promise.allSettled(COMPONENTS.filter((component) => state[component].phase === 'available').map(download));
    }
    return getState();
  }

  function dispose() {
    disposePromise ??= disposeUnlocked();
    return disposePromise;
  }

  async function disposeUnlocked() {
    disposed = true;
    installAbortController.abort();
    removeUpdaterListeners();
    runtime.dispose();
    await settleWithin(Promise.allSettled(admission.pending()), DISPOSE_WAIT_MS);
    const disposable = [...stagingFiles].filter((filePath) => !handedOffFiles.has(filePath));
    await Promise.all(disposable.map((filePath) => runtime.removeFile(filePath)));
    stagingFiles.clear();
    handedOffFiles.clear();
    downloads.clear();
    assets.clear();
    automaticUpdate.clear();
  }

  return { getState, check, download, install, configure, dispose };
}

function assertComponent(component) {
  if (component !== 'app' && component !== 'bridge') throw new TypeError('Invalid update component');
}
