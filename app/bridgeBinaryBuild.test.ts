import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSeaBuildPaths,
  createSeaConfig,
  getBinaryPreparationCommands,
} from '../scripts/build-vis-bridge.mjs';

describe('vis_bridge SEA build', () => {
  it('uses deterministic bundle, blob, and platform executable paths', () => {
    const root = path.resolve('/workspace/vis');
    const linux = createSeaBuildPaths(root, 'linux');
    expect(linux).toEqual({
      outputDirectory: path.join(root, 'dist-bridge'),
      bundlePath: path.join(root, 'dist-bridge', 'vis_bridge.cjs'),
      blobPath: path.join(root, 'dist-bridge', 'vis_bridge.blob'),
      configPath: path.join(root, 'dist-bridge', 'sea-config.json'),
      binaryPath: path.join(root, 'dist-bridge', 'vis_bridge'),
    });
    expect(createSeaBuildPaths(root, 'win32').binaryPath).toBe(path.join(root, 'dist-bridge', 'vis_bridge.exe'));
  });

  it('generates a code-cache-free SEA config for the bundled bridge entry', () => {
    const paths = createSeaBuildPaths(path.resolve('/workspace/vis'), 'linux');
    expect(createSeaConfig(paths)).toEqual({
      main: paths.bundlePath,
      output: paths.blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    });
  });

  it('strips Linux symbols before SEA injection to keep the executable lightweight', () => {
    expect(getBinaryPreparationCommands('linux', '/tmp/vis_bridge')).toEqual([
      { command: 'strip', args: ['--strip-all', '/tmp/vis_bridge'] },
    ]);
    expect(getBinaryPreparationCommands('win32', 'C:\\vis_bridge.exe')).toEqual([]);
  });
});
