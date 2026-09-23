import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import KimiAccountUsage from './KimiAccountUsage.vue';

const unmount: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of unmount.splice(0)) cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
function mount() {
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(KimiAccountUsage);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(root);
  unmount.push(() => app.unmount());
  return root;
}
function response(data: unknown) { return new Response(JSON.stringify({ code: 0, data })); }

describe('Kimi account quota', () => {
  it('renders reported windows and refreshes through the account control', async () => {
    let usedRatio = 0.25;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/userinfo')
      ? { kind: 'ok', userInfo: { userLevelName: 'Test plan' } }
      : { kind: 'ok', quota: { usages: { limit5h: { usedRatio } } } })));
    const root = mount();
    await vi.waitFor(() => expect(root.textContent).toContain('25% used'));
    expect(root.textContent).toContain('Test plan');
    expect(root.querySelector('h3')?.textContent).toBe('Kimi account quota');
    usedRatio = 0.5;
    root.querySelector('button')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain('50% used'));
    expect(root.querySelector('progress')?.value).toBe(50);
  });

  it('shows a quota failure without presenting zero usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ kind: 'error', message: 'Not signed in' })));
    const root = mount();
    await nextTick();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.querySelector('progress')).toBeNull();
    expect(root.querySelector('button')?.disabled).toBe(false);
  });
});
