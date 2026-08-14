import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { inject } from 'postject';
import { stageNodePtyRuntime } from './vis-bridge-node-pty.mjs';

const execFileAsync = promisify(execFile);
const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export function createSeaBuildPaths(rootDirectory, platform = process.platform) {
  const outputDirectory = path.join(rootDirectory, 'dist-bridge');
  return {
    outputDirectory,
    bundlePath: path.join(outputDirectory, 'vis_bridge.cjs'),
    blobPath: path.join(outputDirectory, 'vis_bridge.blob'),
    configPath: path.join(outputDirectory, 'sea-config.json'),
    binaryPath: path.join(outputDirectory, platform === 'win32' ? 'vis_bridge.exe' : 'vis_bridge'),
  };
}

export function createSeaConfig(paths) {
  return {
    main: paths.bundlePath,
    output: paths.blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
}

export function getBinaryPreparationCommands(platform, binaryPath) {
  if (platform === 'linux') return [{ command: 'strip', args: ['--strip-all', binaryPath] }];
  if (platform === 'darwin') return [{ command: 'codesign', args: ['--remove-signature', binaryPath] }];
  return [];
}

async function prepareExecutable(binaryPath) {
  await copyFile(process.execPath, binaryPath);
  for (const operation of getBinaryPreparationCommands(process.platform, binaryPath)) {
    await execFileAsync(operation.command, operation.args);
  }
}

async function signExecutable(binaryPath) {
  if (process.platform === 'darwin') {
    await execFileAsync('codesign', ['--sign', '-', binaryPath]);
  }
  if (process.platform !== 'win32') await chmod(binaryPath, 0o755);
}

export async function buildVisBridgeBinary(rootDirectory) {
  const paths = createSeaBuildPaths(rootDirectory);
  await mkdir(paths.outputDirectory, { recursive: true });
  await build({
    entryPoints: [path.join(rootDirectory, 'bridge', 'binaryEntry.js')],
    outfile: paths.bundlePath,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['node-pty'],
    legalComments: 'none',
  });
  await writeFile(paths.configPath, `${JSON.stringify(createSeaConfig(paths), null, 2)}\n`, 'utf8');
  await execFileAsync(process.execPath, ['--experimental-sea-config', paths.configPath]);
  await prepareExecutable(paths.binaryPath);
  await inject(paths.binaryPath, 'NODE_SEA_BLOB', await readFile(paths.blobPath), {
    sentinelFuse: SEA_SENTINEL_FUSE,
    machoSegmentName: 'NODE_SEA',
  });
  await signExecutable(paths.binaryPath);
  await stageNodePtyRuntime(
    rootDirectory,
    path.join(paths.outputDirectory, 'node_modules', 'node-pty'),
    process.platform,
    process.arch,
  );
  return paths.binaryPath;
}

const directRun = import.meta.url.startsWith('file:')
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (directRun) {
  const rootDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const binaryPath = await buildVisBridgeBinary(rootDirectory);
  process.stdout.write(`${binaryPath}\n`);
}
