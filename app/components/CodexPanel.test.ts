import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { useCodexApi } from '../composables/useCodexApi';
import CodexPanel from './CodexPanel.vue';

const apps: VueApp[] = [];

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexPanel', () => {
  it('disables cached thread selection while disconnected', () => {
    const api = useCodexApi();
    api.reconnectOnMount.value = false;
    api.threads.value = [{ id: 'thread-1', name: 'Cached thread', cwd: '/workspace' }];
    api.activeThreadId.value = 'thread-1';

    const target = document.createElement('div');
    document.body.append(target);
    const app = createApp(CodexPanel, { api });
    app.use(
      createI18n({
        legacy: false,
        locale: 'en',
        missingWarn: false,
        fallbackWarn: false,
        messages: { en: {} },
      }),
    );
    apps.push(app);
    app.mount(target);

    const threadButton = target.querySelector<HTMLButtonElement>('.codex-thread-select');
    expect(threadButton?.disabled).toBe(true);
  });
});
