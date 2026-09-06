import path from 'node:path';
import { selectAutomaticAppFile } from './updatePolicy.js';

export function createAutomaticUpdate(runtime) {
  let selectedFile = null;
  let downloadedPaths = [];

  const clear = () => {
    selectedFile = null;
    downloadedPaths = [];
  };

  const accept = (info) => {
    clear();
    if (!runtime.automaticAppUpdateTarget) throw new Error('Automatic app updater has no package target');
    selectedFile = selectAutomaticAppFile(info, runtime.platform, runtime.arch, runtime.automaticAppUpdateTarget);
    return selectedFile;
  };

  const recordDownload = (paths) => {
    const filePath = selectedPath(selectedFile, paths);
    downloadedPaths = [...paths];
    return filePath;
  };

  const verifyDownload = async () => {
    const filePath = selectedPath(selectedFile, downloadedPaths);
    await runtime.verifyAsset(filePath, selectedFile, selectedFile.sha512, 'sha512');
  };

  return { accept, clear, recordDownload, verifyDownload };
}

function selectedPath(selectedFile, paths) {
  if (!selectedFile) throw new Error('No verified app update artifact is selected');
  const matches = paths.filter((filePath) => path.basename(filePath) === selectedFile.name);
  if (matches.length !== 1) throw new Error('Downloaded paths do not contain the selected app update artifact');
  return matches[0];
}
