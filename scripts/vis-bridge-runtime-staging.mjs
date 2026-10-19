// Stages the runtime store worker's standalone sidecar next to a vis_bridge
// install so the installed SEA binary can fork its store worker without any
// system Node on PATH (the "Metis worker Node24 sidecar").
//
// The worker entry (bridge/runtime/storage/runtimeDatabaseWorker.mjs) resolves
// its siblings and its shared/runtime imports through RELATIVE specifiers whose
// depth assumes the repository layout:
//
//   bridge/runtime/storage/storeQueries.js -> ../../../shared/runtime/protocol.js
//
// resolveStoreWorker(installRoot) (bridge/runtime/storage/runtimeStore.js) is the
// receiver contract and is NOT modified here: it expects
//
//   <installRoot>/runtime/runtimeDatabaseWorker.mjs   (the worker)
//   <installRoot>/runtime/vis_bridge_node[.exe]       (the Node 24 sidecar)
//
// so the staged tree reproduces the repository depth exactly, with the storage
// directory staged under the name `runtime` (it plays the role of
// bridge/runtime/storage, and <installRoot> plays the role of bridge/runtime):
//
//   <stageRoot>/shared/runtime/**                    (worker's shared closure)
//   <stageRoot>/bridge/runtime/runtime/*.js          (worker + siblings)
//   <stageRoot>/bridge/runtime/runtime/vis_bridge_node[.exe]
//
// From <stageRoot>/bridge/runtime/runtime/storeQueries.js the worker's own
// ../../../shared/runtime/protocol.js specifier resolves to
// <stageRoot>/shared/runtime/protocol.js, i.e. fully inside the install tree —
// no repository source is reachable from the staged copy.
//
// The sidecar is a copy of the Node interpreter that runs the build
// (process.execPath, Node 24 per the project baseline): a SEA binary cannot act
// as a plain interpreter for an arbitrary worker script, which is exactly why
// the sidecar exists. The worker's import closure is computed with esbuild (the
// same bundler the SEA build already uses) so the staged set can never drift
// from the worker's real imports.
//
// Returns the installRoot to hand to resolveStoreWorker/createRuntimeStore.

import { build } from 'esbuild';
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const WORKER_ENTRY = ['bridge', 'runtime', 'storage', 'runtimeDatabaseWorker.mjs'];
const STORAGE_PREFIX = 'bridge/runtime/storage/';
const STAGED_RUNTIME_DIRECTORY = 'bridge/runtime/runtime';

export function createRuntimeSidecarLayout(stageRoot, platform = process.platform) {
  return {
    installRoot: path.join(stageRoot, 'bridge', 'runtime'),
    runtimeDirectory: path.join(stageRoot, ...STAGED_RUNTIME_DIRECTORY.split('/')),
    workerPath: path.join(stageRoot, ...STAGED_RUNTIME_DIRECTORY.split('/'), 'runtimeDatabaseWorker.mjs'),
    sidecarPath: path.join(
      stageRoot,
      ...STAGED_RUNTIME_DIRECTORY.split('/'),
      // The installed resolver demands the TARGET platform's sidecar name
      // (vis_bridge_node.exe on Windows), so the name must follow the staged
      // platform — not the host that happens to run the packaging. A Windows
      // installer packaged on Linux otherwise ships vis_bridge_node and the
      // installed bridge reports its sidecar missing.
      platform === 'win32' ? 'vis_bridge_node.exe' : 'vis_bridge_node',
    ),
  };
}

// Maps a repository-relative input path onto its staged location: the storage
// directory is staged under the name `runtime`; everything else keeps its
// repository-relative path so the worker's relative specifiers still resolve.
function stagedRelativePath(relativePath) {
  return relativePath.startsWith(STORAGE_PREFIX)
    ? `${STAGED_RUNTIME_DIRECTORY}/${relativePath.slice(STORAGE_PREFIX.length)}`
    : relativePath;
}

export async function computeRuntimeWorkerClosure(rootDirectory) {
  const result = await build({
    entryPoints: [path.join(rootDirectory, ...WORKER_ENTRY)],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    absWorkingDir: rootDirectory,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs)
    .map((input) => input.split(path.sep).join('/'))
    .sort();
}

export async function stageRuntimeWorkerSidecar(rootDirectory, stageRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const sidecarSource = options.sidecarSource ?? process.execPath;
  const layout = createRuntimeSidecarLayout(stageRoot, platform);
  const closure = await computeRuntimeWorkerClosure(rootDirectory);
  if (!closure.includes(WORKER_ENTRY.join('/'))) {
    throw new Error(`runtime worker closure is missing its own entry: ${WORKER_ENTRY.join('/')}`);
  }
  await rm(layout.runtimeDirectory, { recursive: true, force: true });
  await mkdir(layout.runtimeDirectory, { recursive: true });
  for (const relativePath of closure) {
    const destination = path.join(stageRoot, ...stagedRelativePath(relativePath).split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(rootDirectory, ...relativePath.split('/')), destination);
  }
  await copyFile(sidecarSource, layout.sidecarPath);
  if (platform !== 'win32') await chmod(layout.sidecarPath, 0o755);
  return { ...layout, platform, sidecarSource, stagedFiles: closure.map(stagedRelativePath) };
}
