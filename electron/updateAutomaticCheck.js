import { isNewerVersion } from './updatePolicy.js';
import { versionFromInfo } from './updateState.js';

export function createAutomaticAppCheck({ automaticUpdate, currentVersion, publish, runtime }) {
  let offerError = null;

  function accept(info) {
    return automaticUpdate.accept(info);
  }

  function reject(error) {
    offerError = error;
    automaticUpdate.clear();
  }

  async function check() {
    automaticUpdate.clear();
    offerError = null;
    const result = await runtime.updater.checkForUpdates();
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
    const file = automaticUpdate.accept(result.updateInfo);
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
    publish('app', {
      availableVersion: null,
      phase: 'up-to-date',
      error: null,
      assetName: null,
    });
  }

  return { accept, check, reject };
}
