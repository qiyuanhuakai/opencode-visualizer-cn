// @vitest-environment node
import http from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectLatestPublishedRelease } from '../electron/updateRelease.js';
import { createUpdateTransport } from '../electron/updateTransport.js';

afterEach(() => vi.restoreAllMocks());

function release(version: string, draft = false) {
  return { tag_name: `v${version}`, draft, prerelease: version.includes('-'), assets: [] };
}

describe('published release discovery', () => {
  it('selects the greatest published SemVer regardless of publication order', () => {
    // Given: a recent old stable release, a draft, and reordered prereleases.
    const releases = [release('0.8.11'), release('99.0.0', true), release('0.8.20-alpha.2'),
      release('0.8.20-alpha.10'), release('0.8.20-alpha.1'), release('nightly')];
    // When/Then: public numeric precedence wins, excluding drafts and nonversion tags.
    expect(selectLatestPublishedRelease(releases)?.version).toBe('0.8.20-alpha.10');
  });

  it('prefers stable over a prerelease with the same core version', () => {
    // Given/When/Then: final releases supersede all prerelease identifiers.
    expect(selectLatestPublishedRelease([release('0.8.20-rc.9'), release('0.8.20')])?.version)
      .toBe('0.8.20');
  });

  it.each([null, {}, [null], [{ tag_name: 'v1.0.0', draft: false }]])(
    'rejects malformed list metadata %j', (value) => {
      // Given/When/Then: malformed upstream shapes do not become update offers.
      expect(() => selectLatestPublishedRelease(value)).toThrow('invalid release list');
    },
  );

  it('keeps exact asset URL checks for the selected prerelease', () => {
    // Given: a selected public prerelease carrying an unrelated repository asset.
    const value = { ...release('0.8.20-alpha.1'), assets: [{
      name: 'VisBridge-0.8.20-alpha.1-x64-Linux.deb', size: 12, digest: null,
      url: 'https://api.github.com/repos/other/repo/releases/assets/1',
    }] };
    // When/Then: prerelease selection cannot relax asset provenance.
    expect(() => selectLatestPublishedRelease([value])).toThrow('outside the official repository');
  });

  it('checks subsequent pages before deciding the latest version', async () => {
    // Given: a newer prerelease outside the first complete page.
    const pages = [Array.from({ length: 30 }, () => release('0.8.11')), [release('0.8.20-alpha.1')]];
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      const page = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('page'));
      response.end(JSON.stringify(pages[page - 1] ?? []));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    vi.spyOn(https, 'get').mockImplementation((input, options, callback) => {
      const url = input instanceof URL ? input : new URL(String(input));
      return http.get(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        typeof options === 'function' ? options : callback);
    });
    const transport = createUpdateTransport();
    try {
      // When: the actual HTTP transport discovers releases.
      const selected = await transport.getLatestRelease();
      // Then: page two is selected and the stable-only endpoint is never requested.
      expect(selected.version).toBe('0.8.20-alpha.1');
      expect(requests).toEqual([
        '/repos/qiyuanhuakai/opencode-visualizer-cn/releases?per_page=30&page=1',
        '/repos/qiyuanhuakai/opencode-visualizer-cn/releases?per_page=30&page=2',
      ]);
    } finally {
      transport.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
