import path from 'node:path';
import { isNewerVersion, selectManualAsset, sha256FromDigest } from './updatePolicy.js';
import { boundedPercent } from './updateState.js';

export function createManualUpdate({
  assets,
  downloads,
  handedOffFiles,
  isUsable,
  publish,
  runtime,
  shell,
  stagingFiles,
}) {
  const retirements = new Set();

  function retireDownload(component, pendingWork) {
    const filePath = downloads.get(component);
    downloads.delete(component);
    if (!filePath || handedOffFiles.has(filePath)) return;
    const retirement = (async () => {
      await pendingWork?.catch(() => undefined);
      if (handedOffFiles.has(filePath)) return;
      await runtime.removeFile(filePath);
      stagingFiles.delete(filePath);
    })();
    retirements.add(retirement);
    const settled = () => retirements.delete(retirement);
    void retirement.then(settled, settled);
  }

  async function check(component, currentVersion, revision) {
    const release = await runtime.getLatestRelease();
    if (!isUsable(component, revision)) return;
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
    const linuxFormat =
      component === 'bridge' && runtime.platform === 'linux'
        ? await runtime.resolveBridgeLinuxFormat()
        : 'deb';
    if (!isUsable(component, revision)) return;
    const asset = selectManualAsset(
      release,
      component,
      runtime.platform,
      runtime.arch,
      linuxFormat,
    );
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

  async function download(component, revision) {
    const asset = assets.get(component);
    if (!asset) throw new Error(`No verified ${component} release asset is selected`);
    const expectedSha256 = sha256FromDigest(asset);
    const filePath = await runtime.downloadAsset(asset, (progress) => {
      if (!isUsable(component, revision)) return;
      publish(component, {
        phase: 'downloading',
        progress: boundedPercent({ percent: progress }),
        error: null,
      });
    });
    if (!isUsable(component, revision)) {
      await runtime.removeFile(filePath);
      return;
    }
    try {
      await runtime.verifyAsset(filePath, asset, expectedSha256);
    } catch (error) {
      await runtime.removeFile(filePath);
      throw error;
    }
    if (!isUsable(component, revision)) {
      await runtime.removeFile(filePath);
      return;
    }
    stagingFiles.add(filePath);
    downloads.set(component, filePath);
    publish(component, { phase: 'downloaded', progress: 100, error: null });
  }

  async function openInstaller(component, revision) {
    const asset = assets.get(component);
    const filePath = downloads.get(component);
    if (!asset || !filePath) throw new Error(`No downloaded ${component} installer is ready`);
    await runtime.verifyAsset(filePath, asset, sha256FromDigest(asset));
    if (!isUsable(component, revision)) return;
    handedOffFiles.add(filePath);
    try {
      const openError = await shell.openPath(filePath);
      if (openError) throw new Error(`Could not open ${path.basename(filePath)}: ${openError}`);
    } catch (error) {
      handedOffFiles.delete(filePath);
      if (!isUsable(component, revision)) await runtime.removeFile(filePath);
      throw error;
    }
    if (isUsable(component, revision)) {
      publish(component, { phase: 'installer-opened', progress: 100, error: null });
    }
  }

  return { check, download, openInstaller, retireDownload, pendingCleanup: () => [...retirements] };
}
