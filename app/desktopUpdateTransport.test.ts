// @vitest-environment node
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createUpdateRuntime } from '../electron/updateRuntime.js';

const updaterHarness = vi.hoisted(() => ({
  downloadUpdate: vi.fn(),
  onBeforeRequest: vi.fn(),
}));
vi.mock('electron-updater', async (importOriginal) => {
  const original = await importOriginal<typeof import('electron-updater')>();
  return { default: { autoUpdater: {
    downloadUpdate: updaterHarness.downloadUpdate,
    netSession: { webRequest: { onBeforeRequest: updaterHarness.onBeforeRequest } },
  }, CancellationToken: original.CancellationToken } };
});
const captured = vi.hoisted(() => { const outputs: import('node:fs').WriteStream[] = []; return { outputs }; });
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, createWriteStream: (...args: Parameters<typeof original.createWriteStream>) => {
    const stream = original.createWriteStream(...args);
    captured.outputs.push(stream);
    return stream;
  } };
});
afterEach(() => vi.restoreAllMocks());

it('filters the dedicated electron-updater session to HTTPS GitHub hosts', () => {
  // Given: the runtime installs a request listener on autoUpdater.netSession.
  const runtime = createUpdateRuntime();
  const registration = updaterHarness.onBeforeRequest.mock.calls[0];
  expect(registration?.[0]).toEqual({ urls: ['<all_urls>'] });
  const listener = registration?.[1];
  if (typeof listener !== 'function') throw new Error('Expected updater request listener');

  // When: allowed and forbidden transport URLs cross the dedicated boundary.
  const decisions: boolean[] = [];
  listener({ url: 'https://release-assets.githubusercontent.com/file' }, ({ cancel }: { cancel?: boolean }) => decisions.push(Boolean(cancel)));
  listener({ url: 'http://github.com/file' }, ({ cancel }: { cancel?: boolean }) => decisions.push(Boolean(cancel)));
  listener({ url: 'https://example.com/file' }, ({ cancel }: { cancel?: boolean }) => decisions.push(Boolean(cancel)));

  // Then: only HTTPS on the fixed GitHub host set is admitted, and disposal removes the listener.
  expect(decisions).toEqual([false, true, true]);
  runtime.dispose();
  expect(updaterHarness.onBeforeRequest).toHaveBeenLastCalledWith(null);
});

it('verifies automatic artifacts with manifest size and SHA-512', async () => {
  // Given: a downloaded file and its selected updater manifest evidence.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vis-update-test-'));
  const filePath = path.join(directory, 'Vis-1.2.3-x86_64-Linux.AppImage');
  const contents = Buffer.from('verified updater payload');
  await writeFile(filePath, contents);
  const runtime = createUpdateRuntime();
  const artifact = {
    name: path.basename(filePath), url: path.basename(filePath), size: contents.length,
    sha512: createHash('sha512').update(contents).digest('base64'),
  };

  try {
    // When/Then: exact evidence passes, while a changed digest is rejected.
    await expect(runtime.verifyAsset(filePath, artifact, artifact.sha512, 'sha512')).resolves.toBeUndefined();
    await expect(runtime.verifyAsset(filePath, { ...artifact, size: contents.length + 1 }, artifact.sha512, 'sha512'))
      .rejects.toThrow('unexpected size');
    await expect(runtime.verifyAsset(filePath, artifact, `${'A'.repeat(86)}==`, 'sha512'))
      .rejects.toThrow('SHA512 verification');
  } finally {
    runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('uses a scoped proxy-aware HTTPS agent for release requests', async () => {
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  let proxyAware = false;
  vi.spyOn(https, 'get').mockImplementation((_input, options, callback) => {
    if (typeof options !== 'function' && options.agent instanceof https.Agent) {
      proxyAware = Object.hasOwn(options.agent.options, 'proxyEnv');
    }
    return http.get(`http://127.0.0.1:${address.port}`, typeof options === 'function' ? options : callback);
  });
  try {
    await createUpdateRuntime().getLatestRelease();
    expect(proxyAware).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('closes the destination file when the actual HTTP response is truncated', async () => {
  let activeResponse: http.ServerResponse | undefined;
  const server = http.createServer((_request, response) => {
    activeResponse = response;
    response.writeHead(200, { 'Content-Length': '4', Connection: 'close' });
    response.write('ab');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const outputs = captured.outputs;
  vi.spyOn(https, 'get').mockImplementation((_input, options, callback) =>
    http.get(`http://127.0.0.1:${address.port}`, typeof options === 'function' ? options : callback),
  );
  try {
    const runtime = createUpdateRuntime();
    await expect(runtime.downloadAsset({ name: 'fixture.deb', size: 4, digest: null,
      url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
    }, () => activeResponse?.destroy())).rejects.toThrow('aborted');
    expect(outputs.length).toBe(1);
    await vi.waitFor(() => expect(outputs[0]?.closed).toBe(true));
  } finally {
    for (const output of outputs) output.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it('cancels active release requests during runtime disposal', async () => {
  let requestStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const server = http.createServer((_request, response) => {
    requestStarted?.();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  vi.spyOn(https, 'get').mockImplementation((_input, options, callback) =>
    http.get(`http://127.0.0.1:${address.port}`, typeof options === 'function' ? options : callback),
  );
  try {
    const runtime = createUpdateRuntime();
    const request = runtime.getLatestRelease();
    await started;

    runtime.dispose();

    await expect(request).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('cancels an active electron-updater download during runtime disposal', async () => {
  updaterHarness.downloadUpdate.mockImplementationOnce((token: import('electron-updater').CancellationToken) =>
    token.createPromise<string[]>((_resolve, _reject, onCancel) => onCancel(() => undefined)),
  );
  const runtime = createUpdateRuntime();
  const download = runtime.downloadAppUpdate();
  await Promise.resolve();

  runtime.dispose();

  await expect(download).rejects.toThrow('cancelled');
});
