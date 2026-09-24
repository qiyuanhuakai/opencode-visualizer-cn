import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KimiWebComposerActions from './KimiWebComposerActions.vue';
import en from '../../locales/en';
import { createKimiWebClient } from '../../utils/kimiWeb';
vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
describe('Kimi composer actions', () => {
  it('opens subagent management directly beside the mode selector', async () => {
    const disabled = ref(false);
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher: async () => Response.json({ code: 0, data: { items: [], has_more: false } }) });
    const root = document.createElement('div'); document.body.append(root);
    const app = createApp(defineComponent({ setup: () => () => h(KimiWebComposerActions, { disabled: disabled.value, sessionId: 'session', client }) }));
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } })); app.mount(root);
    cleanups.push(() => { app.unmount(); root.remove(); });
    await nextTick();
    root.querySelector('button')?.click(); await nextTick();
    expect(root.querySelector('button')?.textContent?.trim()).toBe('Settings');
    expect(root.querySelector('[role="dialog"]')?.classList.contains('is-open')).toBe(true);
    disabled.value = true; await nextTick(); expect(root.querySelector('button')?.disabled).toBe(true);
    root.querySelector('button')?.click(); expect(root.querySelector('button')?.disabled).toBe(true);
  });
});
