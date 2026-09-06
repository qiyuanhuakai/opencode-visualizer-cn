import { createUpdateAdmission } from './updateAdmission.js';
import { createAutomaticUpdate } from './updateAutomatic.js';
import { createAutomaticAppCheck } from './updateAutomaticCheck.js';
import { createBridgeUpdateSession } from './updateBridgeSession.js';
import { attachUpdaterEvents } from './updateEvents.js';
import { createManualUpdate } from './updateManual.js';
import { createUpdateRuntime } from './updateRuntime.js';
import {
  errorMessage,
  initialState,
  settleWithin,
  transition,
  unsupportedMessage,
} from './updateState.js';

const COMPONENTS = ['app', 'bridge'];
const DISPOSE_WAIT_MS = 5_000;

export function createDesktopUpdates({ app, shell, onChange, beforeInstall }, injectedRuntime) {
  const runtime = injectedRuntime ?? createUpdateRuntime();
  const automaticApp = app.isPackaged && runtime.automaticAppUpdates;
  const manualApp = app.isPackaged && runtime.platform === 'darwin';
  const bridgeSupported =
    ['darwin', 'linux', 'win32'].includes(runtime.platform) &&
    ['arm64', 'x64'].includes(runtime.arch);
  const state = {
    app: initialState(
      'app',
      app.getVersion(),
      automaticApp ? 'automatic' : manualApp ? 'manual' : 'unsupported',
    ),
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
  const installAbortController = new AbortController();

  const publish = (component, patch) => {
    if (disposed) return;
    state[component] = { ...state[component], ...patch };
    onChange(getState());
  };
  let bridgeSession;
  const isCurrent = (component, revision) => bridgeSession.isCurrent(component, revision);
  const isUsable = (component, revision) => !disposed && isCurrent(component, revision);
  const fail = (component, error, revision) => {
    if (!isCurrent(component, revision)) return;
    publish(component, { phase: 'error', progress: null, error: errorMessage(error) });
  };

  const automaticAppCheck = createAutomaticAppCheck({
    automaticUpdate,
    currentVersion: () => state.app.currentVersion,
    publish,
    runtime,
  });
  const removeUpdaterListeners = attachUpdaterEvents(
    runtime.updater,
    publish,
    () => state.app.availableVersion,
    automaticAppCheck.accept,
    automaticAppCheck.reject,
  );
  runtime.updater.autoDownload = false;
  runtime.updater.autoInstallOnAppQuit = false;
  runtime.updater.allowPrerelease = false;
  runtime.updater.channel =
    runtime.platform === 'win32' && runtime.arch === 'arm64' ? 'latest-arm64' : null;
  runtime.updater.allowDowngrade = false;

  const manualUpdate = createManualUpdate({
    assets,
    downloads,
    handedOffFiles,
    isUsable,
    publish,
    runtime,
    shell,
    stagingFiles,
  });
  bridgeSession = createBridgeUpdateSession({
    isPackaged: app.isPackaged,
    isDisposed: () => disposed,
    onVersionChange: resetBridge,
    runCheck: () => check('bridge'),
  });

  function getState() {
    return Object.freeze({
      app: Object.freeze({ ...state.app }),
      bridge: Object.freeze({ ...state.bridge }),
    });
  }

  async function checkUnlocked(component, revision) {
    if (!isCurrent(component, revision)) return getState();
    if (state[component].installKind === 'unsupported') {
      publish(component, {
        phase: 'unsupported',
        progress: null,
        error: unsupportedMessage(component),
      });
      return getState();
    }
    if (component === 'bridge' && state.bridge.currentVersion === null) return getState();
    publish(component, transition('checking'));
    let checkSucceeded = false;
    try {
      if (component === 'app' && automaticApp) await automaticAppCheck.check();
      else await manualUpdate.check(component, state[component].currentVersion, revision);
      checkSucceeded = isCurrent(component, revision);
    } catch (error) {
      fail(component, error, revision);
    }
    if (checkSucceeded && autoDownloadUpdates && state[component].phase === 'available') {
      await downloadUnlocked(component, revision);
    }
    return getState();
  }

  async function downloadUnlocked(component, revision) {
    if (!isCurrent(component, revision)) return getState();
    if (state[component].phase !== 'available') {
      fail(component, new Error(`No ${component} update is available to download`), revision);
      return getState();
    }
    publish(component, { phase: 'downloading', progress: 0, error: null });
    try {
      if (component === 'app' && automaticApp) {
        const paths = await runtime.downloadAppUpdate();
        automaticUpdate.recordDownload(paths);
        if (state.app.phase === 'downloading')
          publish('app', { phase: 'downloaded', progress: 100 });
      } else {
        await manualUpdate.download(component, revision);
      }
    } catch (error) {
      fail(component, error, revision);
    }
    return getState();
  }

  async function installUnlocked(component, revision) {
    if (!isCurrent(component, revision)) return getState();
    if (state[component].phase !== 'downloaded') {
      fail(component, new Error(`No downloaded ${component} update is ready to install`), revision);
      return getState();
    }
    try {
      const approved = await beforeInstall(component, installAbortController.signal);
      if (approved === false || disposed || !isCurrent(component, revision)) return getState();
      publish(component, { phase: 'installing', error: null });
      if (component === 'app' && automaticApp) {
        await automaticUpdate.verifyDownload();
        if (disposed) return getState();
        runtime.updater.quitAndInstall(false, true);
      } else {
        await manualUpdate.openInstaller(component, revision);
      }
    } catch (error) {
      fail(component, error, revision);
    }
    return getState();
  }

  const admit = (component, operation) => {
    assertComponent(component);
    if (disposed) return Promise.reject(new Error('Desktop update service is disposed'));
    const admitted = admission.run(component, operation);
    bridgeSession.track(component, admitted);
    return admitted;
  };
  const check = (component) => {
    const revision = bridgeSession.capture(component);
    return admit(component, () => checkUnlocked(component, revision));
  };
  const download = (component) => {
    const revision = bridgeSession.capture(component);
    return admit(component, () => downloadUnlocked(component, revision));
  };
  const install = (component) => {
    const revision = bridgeSession.capture(component);
    return admit(component, () => installUnlocked(component, revision));
  };

  function resetBridge(version) {
    assets.delete('bridge');
    manualUpdate.retireDownload('bridge', bridgeSession.pending());
    state.bridge = initialState('bridge', version, bridgeSupported ? 'manual' : 'unsupported');
    onChange(getState());
  }

  function reportBridgeVersion(report) {
    if (disposed) throw new Error('Desktop update service is disposed');
    bridgeSession.report(report);
    return getState();
  }

  async function configure(preferences) {
    const shouldCheck = preferences.autoCheckUpdates && !autoCheckUpdates;
    const shouldDownload = preferences.autoDownloadUpdates && !autoDownloadUpdates;
    autoCheckUpdates = preferences.autoCheckUpdates;
    autoDownloadUpdates = preferences.autoDownloadUpdates;
    bridgeSession.configure(autoCheckUpdates, shouldCheck && state.bridge.currentVersion === null);
    if (!app.isPackaged) return getState();
    if (shouldCheck) {
      const components = state.bridge.currentVersion === null ? ['app'] : COMPONENTS;
      await Promise.allSettled(components.map((component) => check(component)));
    }
    if (autoDownloadUpdates && (shouldCheck || shouldDownload)) {
      await Promise.allSettled(
        COMPONENTS.filter((component) => state[component].phase === 'available').map(download),
      );
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
    await settleWithin(Promise.allSettled([...admission.pending(), ...manualUpdate.pendingCleanup()]), DISPOSE_WAIT_MS);
    const disposable = [...stagingFiles].filter((filePath) => !handedOffFiles.has(filePath));
    await Promise.all(disposable.map((filePath) => runtime.removeFile(filePath)));
    stagingFiles.clear();
    handedOffFiles.clear();
    downloads.clear();
    assets.clear();
    automaticUpdate.clear();
  }

  return { getState, reportBridgeVersion, check, download, install, configure, dispose };
}

function assertComponent(component) {
  if (component !== 'app' && component !== 'bridge')
    throw new TypeError('Invalid update component');
}
