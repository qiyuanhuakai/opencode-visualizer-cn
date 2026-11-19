// @vitest-environment node
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const root = fileURLToPath(new URL('../', import.meta.url));
type Download = { readonly checksums?: Record<string, string>; readonly mirrorOptions?: Record<string, unknown> };
type Configuration = Record<string, unknown> & { readonly electronDownload?: Download };
const { getConfig, validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js') as {
  getConfig(root: string, config?: string | null, overrides?: Record<string, unknown>): Promise<Configuration>;
  validateConfiguration(config: Configuration, logger: { isEnabled: boolean; add(): void }): Promise<void>;
};
const { createElectronFrameworkSupport } = builderRequire('app-builder-lib/out/electron/ElectronFramework.js') as {
  createElectronFrameworkSupport(config: Configuration, packager: object): Promise<{
    prepareApplicationStageDirectory(options: object): Promise<void>;
  }>;
};
const { version } = require('electron/package.json') as { version: string };
const official = require('electron/checksums.json') as Record<string, string>;

it('loads the official locked package manifest through the real builder configuration loader', async () => {
  const config = await getConfig(root, null, { compression: 'store' });
  await validateConfiguration(config, { isEnabled: false, add() {} });
  expect(config.compression).toBe('store');
  expect(config.electronDownload?.checksums).toEqual(official);
  expect(config.electronDownload?.mirrorOptions).toEqual({});
});

it.each([false, true])('validates archive bytes without a remote manifest request (corrupt=%s)', async corrupt => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vis-electron-download-'));
  const executable = Buffer.from('controlled Electron archive boundary fixture');
  const content = zipSync({ electron: executable });
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url?.endsWith('SHASUMS256.txt')) { res.writeHead(504); res.end('manifest unavailable'); return; }
    const bytes = corrupt ? Buffer.from('corrupted artifact') : content;
    res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/zip' });
    res.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const config = await getConfig(root);
    if (!config.electronDownload?.checksums) throw new Error('Builder did not load package checksums');
    const filename = `electron-v${version}-linux-x64.zip`;
    expect(config.electronDownload.checksums[filename]).toBe(official[filename]);
    // The archive is controlled test bytes; retain the production option shape and
    // replace only this fixture's hash and endpoint. No third-party mirror is used.
    vi.stubEnv('ELECTRON_DOWNLOAD_CACHE_MODE', '3');
    const fixtureConfig = {
      ...config,
      electronVersion: version,
      electronDownload: {
        ...config.electronDownload,
        mirrorOptions: { mirror: `http://127.0.0.1:${address.port}/` },
        tempDirectory: directory,
        checksums: { [filename]: createHash('sha256').update(content).digest('hex') },
      },
    };
    const packager = {
      config: fixtureConfig,
      appInfo: { type: 'commonjs' },
      info: { getWorkspaceRoot: async () => root },
    };
    const framework = await createElectronFrameworkSupport(fixtureConfig, packager);
    const appOutDir = path.join(directory, 'app');
    const stage = framework.prepareApplicationStageDirectory({ packager, appOutDir, platformName: 'linux', arch: 'x64', version });
    if (corrupt) await expect(stage).rejects.toThrow(/checksum/i);
    else {
      await stage;
      expect(await readFile(path.join(appOutDir, 'electron'))).toEqual(executable);
    }
    expect(requests.some(url => url.endsWith('SHASUMS256.txt'))).toBe(false);
    expect(requests.filter(url => url.endsWith('.zip'))).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
