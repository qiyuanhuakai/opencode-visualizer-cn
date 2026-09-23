import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { describe, expect, it, vi } from 'vitest';
import { createKimiWebPluginsClient } from '../../utils/kimiWebPlugins';
import KimiWebPluginManager from './KimiWebPluginManager.vue';

describe('Kimi plugin management', () => {
  it('shows a load error without claiming an empty installation and recovers after refresh', async () => {
    let reachable = false;
    const client = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      fetcher: async (input) =>
        reachable
          ? new Response(
              JSON.stringify({
                code: 0,
                data: String(input).endsWith('marketplace') ? { entries: [] } : { plugins: [] },
              }),
            )
          : new Response('', { status: 503 }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(KimiWebPluginManager, { client });
    app.use(createI18n({ legacy: false, locale: 'en', messages: {} }));
    app.provide('showConfirm', async () => true);
    app.mount(host);
    await nextTick();
    try {
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
      expect(host.textContent).not.toContain('No installed plugins');
      reachable = true;
      host.querySelector<HTMLButtonElement>('header button')?.click();
      await vi.waitFor(() => expect(host.textContent).toContain('No installed plugins'));
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      app.unmount();
      host.remove();
    }
  });
  it('retains installed state and exposes action errors when the marketplace is unavailable', async () => {
    const client = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      fetcher: async (input, init) => {
        if (String(input).endsWith('marketplace')) return new Response('', { status: 503 });
        return new Response(
          JSON.stringify(
            init?.method === 'POST'
              ? { code: 40001, msg: 'Cannot disable this plugin', data: null }
              : {
                  code: 0,
                  data: {
                    plugins: [{ id: 'demo', displayName: 'Demo', enabled: true, state: 'ok' }],
                  },
                },
          ),
        );
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(KimiWebPluginManager, { client });
    app.use(createI18n({ legacy: false, locale: 'en', messages: {} }));
    app.mount(host);
    await nextTick();
    try {
      await vi.waitFor(() =>
        expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('false'),
      );
      expect(host.textContent).toContain('Marketplace unavailable');
      host.querySelector<HTMLButtonElement>('[aria-pressed]')?.click();
      await vi.waitFor(() =>
        expect(host.querySelector('[role="alert"]')?.textContent).toBe(
          'Cannot disable this plugin',
        ),
      );
      expect(host.querySelector('[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');
    } finally {
      app.unmount();
      host.remove();
    }
  });
  it('installs, disables, enables and removes a plugin with refreshed visible state', async () => {
    let installed = false;
    let enabled = true;
    const calls: string[] = [];
    const client = createKimiWebPluginsClient({
      bridgeUrl: 'ws://bridge.test/kimi-web/ws',
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method} ${path}`);
        if (init?.method === 'POST') {
          if (path.endsWith(':remove')) installed = false;
          else if (path.endsWith(':disable')) enabled = false;
          else if (path.endsWith(':enable')) enabled = true;
          else installed = true;
        }
        const data = path.endsWith('marketplace')
          ? { entries: [] }
          : init?.method === 'POST'
            ? { ok: true }
            : {
                plugins: installed
                  ? [{ id: 'demo', displayName: 'Demo', enabled, state: 'ok' }]
                  : [],
              };
        return new Response(JSON.stringify({ code: 0, data }));
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(KimiWebPluginManager, { client });
    app.use(createI18n({ legacy: false, locale: 'en', messages: {} }));
    app.provide('showConfirm', async () => true);
    app.mount(host);
    await nextTick();
    const click = async (label: string) => {
      const button = [...host.querySelectorAll('button')].find(
        (item) => item.textContent?.trim() === label,
      );
      if (!button) throw new Error(`Button not found: ${label}`);
      button.click();
      await nextTick();
    };
    try {
      await vi.waitFor(() => {
        expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('false');
        expect(host.textContent).toContain('No installed plugins');
      });
      const input = host.querySelector('input');
      if (!input) throw new Error('Missing plugin source input');
      input.value = 'owner/repo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();
      host
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(host.querySelector('[data-plugin-id="demo"]')).not.toBeNull());
      await click('Disable');
      await vi.waitFor(() =>
        expect(host.querySelector('[aria-pressed]')?.textContent?.trim()).toBe('Enable'),
      );
      await click('Enable');
      await vi.waitFor(() =>
        expect(host.querySelector('[aria-pressed]')?.textContent?.trim()).toBe('Disable'),
      );
      await click('Remove');
      await vi.waitFor(() => expect(host.querySelector('[data-plugin-id="demo"]')).toBeNull());
      expect(calls).toContain('POST /kimi-web/api/v1/plugins/demo:remove');
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
