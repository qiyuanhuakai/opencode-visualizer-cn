import { createApp, defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiWebClient } from '../../utils/kimiWeb';
import KimiWebAgentManager from './KimiWebAgentManager.vue';
vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function flushPromises() { for (let i = 0; i < 16; i++) { await Promise.resolve(); await nextTick(); } }
function setup() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/models')) return Response.json({ code: 0, data: { items: [
      { model: 'provider/model', provider: 'provider', display_name: 'Model One', support_efforts: ['high', 'max'], default_effort: 'high' },
      { model: 'provider/other', provider: 'provider', display_name: 'Model Two', support_efforts: ['low'], default_effort: 'low' },
    ] } });
    if (url.pathname.endsWith('/config')) return Response.json({ code: 0, data: init?.method === 'POST'
      ? JSON.parse(String(init.body))
      : { default_model: 'provider/other', secondary_model: { defaultModel: 'provider/model', defaultEffort: 'high' }, experimental: { tower: false } } });
    throw new Error('Unexpected request: ' + url.pathname);
  });
  const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher });
  const sessionId = ref('parent');
  const activeClient = shallowRef(client);
  const root = document.createElement('div'); document.body.append(root);
  const onTowerExperimentUpdated = vi.fn();
  const app = createApp(defineComponent({ setup: () => () => h(KimiWebAgentManager, { sessionId: sessionId.value, client: activeClient.value, onTowerExperimentUpdated }) }));
  app.use(createI18n({ legacy: false, locale: 'en' })); app.mount(root);
  cleanups.push(() => { app.unmount(); root.remove(); });
  return { root, fetcher, sessionId, activeClient, onTowerExperimentUpdated };
}

describe('Kimi settings menu', () => {
  it('loads global subagent settings without reading or showing child conversations', async () => {
    const { root, fetcher } = setup();
    await flushPromises();
    expect(root.textContent).toContain('Default subagent model');
    expect(root.textContent).toContain('Model One');
    expect(root.textContent).not.toContain('Child conversations');
    expect(root.querySelector('select')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/children'))).toBe(false);
  });

  it('uses themed dropdown choices and saves model plus thinking effort', async () => {
    const { root, fetcher } = setup();
    await flushPromises();
    const modelTrigger = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Model One'));
    modelTrigger?.click();
    await nextTick();
    const option = Array.from(root.querySelectorAll('[role="option"]')).find((item) => item.textContent?.includes('Model Two'));
    (option as HTMLElement | undefined)?.click();
    await nextTick();
    expect(root.textContent).toContain('Model Two');
    const save = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Save settings');
    save?.click();
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/config') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ secondary_model: { default_model: 'provider/other', default_effort: 'low' } });
  });

  it('saves the tower experiment through global config and reports rejection', async () => {
    const { root, fetcher, onTowerExperimentUpdated } = setup();
    await flushPromises();
    const toggle = root.querySelector<HTMLInputElement>('input[aria-label="Enable tower experiment"]');
    if (!toggle) throw new Error('Missing tower switch');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    const call = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/config') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ experimental: { tower: true } });
    expect(toggle.checked).toBe(true);
    expect(onTowerExperimentUpdated).toHaveBeenCalledWith(true);

    fetcher.mockImplementationOnce(async () => Response.json({ code: 40001, msg: 'Experiment rejected', data: null }));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Experiment rejected');
    expect(toggle.checked).toBe(true);
  });

  it('discards late settings reads when the session changes', async () => {
    const { root, sessionId, fetcher } = setup();
    await flushPromises();
    let release: (response: Response) => void = () => { throw new Error('Pending response missing'); };
    const late = new Promise<Response>((resolve) => { release = resolve; });
    fetcher.mockImplementationOnce(async () => late);
    sessionId.value = 'middle';
    await flushPromises();
    sessionId.value = 'next';
    await flushPromises();
    release(Response.json({ code: 0, data: { items: [{ model: 'stale', display_name: 'Stale' }] } }));
    await flushPromises();
    expect(root.textContent).not.toContain('Stale');
    expect(root.querySelector('section')?.getAttribute('aria-busy')).not.toBe('true');
  });
});
