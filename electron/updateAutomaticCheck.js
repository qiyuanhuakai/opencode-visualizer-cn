import { isNewerVersion } from './updatePolicy.js';
import { versionFromInfo } from './updateState.js';

export function createAutomaticAppCheck({ automaticUpdate, currentVersion, isDisposed, publish, runtime }) {
  let offerError = null;
  let selectedVersion = null;

  function accept(info) {
    if (runtime.prepareAppUpdate && (selectedVersion === null || info?.version !== selectedVersion)) {
      throw new Error('Automatic update manifest does not match the selected release');
    }
    return automaticUpdate.accept(info);
  }

  function reject(error) {
    offerError = error;
    automaticUpdate.clear();
  }

  async function check() {
    automaticUpdate.clear();
    offerError = null;
    selectedVersion = null;
    if (runtime.prepareAppUpdate) {
      selectedVersion = await runtime.prepareAppUpdate(currentVersion());
      if (isDisposed()) return;
      if (selectedVersion === null) {
        publishUpToDate();
        return;
      }
    }
    const result = await runtime.updater.checkForUpdates();
    if (isDisposed()) return;
    if (offerError) throw offerError;
    if (result === null) {
      automaticUpdate.clear();
      publish('app', {
        phase: 'unsupported',
        error: 'Automatic app updater is inactive',
        progress: null,
      });
      return;
    }
    const file = accept(result.updateInfo);
    const version = versionFromInfo(result.updateInfo);
    if (version !== null && isNewerVersion(version, currentVersion())) {
      publish('app', {
        availableVersion: version,
        phase: 'available',
        error: null,
        assetName: file.name,
      });
      return;
    }
    automaticUpdate.clear();
    publishUpToDate();
  }

  function publishUpToDate() {
    publish('app', {
      availableVersion: null,
      phase: 'up-to-date',
      error: null,
      assetName: null,
    });
  }

  return { accept, check, reject };
}
