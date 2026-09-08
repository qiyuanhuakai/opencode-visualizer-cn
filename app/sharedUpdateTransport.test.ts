// @vitest-environment node
import http from 'node:http';
import https from 'node:https';
import { rm, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateTransport, isAllowedUpdateUrl } from '../electron/updateTransport.js';

afterEach(() => vi.restoreAllMocks());

describe('shared Node update transport policy', () => {
  it('allows only HTTPS GitHub transport on the default TLS port', () => {
    expect(isAllowedUpdateUrl('https://api.github.com/releases/latest')).toBe(true);
    expect(isAllowedUpdateUrl('https://release-assets.githubusercontent.com/file')).toBe(true);
    expect(isAllowedUpdateUrl('https://api.github.com:444/releases/latest')).toBe(false);
    expect(isAllowedUpdateUrl('http://api.github.com/releases/latest')).toBe(false);
    expect(isAllowedUpdateUrl('https://user:secret@api.github.com/releases/latest')).toBe(false);
  });

  it('stages downloads in a private directory with a private exclusive file', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '4' });
      response.end('data');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    vi.spyOn(https, 'get').mockImplementation((_input, options, callback) =>
      http.get(`http://127.0.0.1:${address.port}`, typeof options === 'function' ? options : callback),
    );
    const transport = createUpdateTransport();
    let filePath: string | null = null;
    try {
      filePath = await transport.downloadAsset({
        name: 'VisBridge-1.2.3-x64-Linux.deb', digest: null, size: 4,
        url: 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1',
      });
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(new URL('.', `file://${filePath}`))).mode & 0o777).toBe(0o700);
    } finally {
      transport.dispose();
      if (filePath) await rm(new URL('.', `file://${filePath}`), { recursive: true, force: true });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects release metadata beyond the two MiB boundary', async () => {
    const server = http.createServer((_request, response) => response.end('x'.repeat((2 * 1024 * 1024) + 1)));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    vi.spyOn(https, 'get').mockImplementation((_input, options, callback) =>
      http.get(`http://127.0.0.1:${address.port}`, typeof options === 'function' ? options : callback),
    );
    const transport = createUpdateTransport();
    try {
      await expect(transport.getLatestRelease()).rejects.toThrow('size limit');
    } finally {
      transport.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
