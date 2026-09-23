import { describe, expect, it } from 'vitest';
import { createKimiWebPluginsClient } from './kimiWebPlugins';

describe('Kimi Web plugin API', () => {
  it('routes plugin installation and actions through the authenticated bridge', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      bridgeToken: 'fixture',
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ code: 0, data: { ok: true } }));
      },
    });
    await client.install('owner/repo');
    await client.action('owner/plugin', 'disable');
    expect(calls.map((call) => call.url)).toEqual([
      'http://bridge.test/kimi-web/api/v1/plugins',
      'http://bridge.test/kimi-web/api/v1/plugins/owner%2Fplugin:disable',
    ]);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ source: 'owner/repo' }));
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer fixture' });
  });

  it('rejects business failures even when HTTP succeeds', async () => {
    const client = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      fetcher: async () =>
        new Response(JSON.stringify({ code: 40419, msg: 'Plugin not found', data: null })),
    });
    await expect(client.action('missing', 'enable')).rejects.toThrow('Plugin not found');
  });

  it('reads installed plugins and rejects malformed list envelopes', async () => {
    const client = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      fetcher: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: { plugins: [{ id: 'demo', displayName: 'Demo', enabled: true, state: 'ok' }] },
          }),
        ),
    });
    expect(await client.list()).toEqual([
      { id: 'demo', displayName: 'Demo', enabled: true, state: 'ok' },
    ]);
    const invalid = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      fetcher: async () => new Response(JSON.stringify({ code: 0, data: {} })),
    });
    await expect(invalid.list()).rejects.toThrow();
  });
});
