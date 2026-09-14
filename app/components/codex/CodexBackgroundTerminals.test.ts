import { createApp, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { expect, it } from 'vitest';
import CodexBackgroundTerminals from './CodexBackgroundTerminals.vue';
import type { useCodexApi } from '../../composables/useCodexApi';

it('updates terminal output live and clears rows when switching conversations', async () => {
  const api = {
    activeThreadId: ref('main'),
    events: ref<ReturnType<typeof useCodexApi>['events']['value']>([
      {
        id: 1,
        method: 'item/started',
        time: 1,
        params: {
          threadId: 'main',
          item: { id: 'cmd', type: 'commandExecution', command: 'npm run dev' },
        },
      },
    ]),
  };
  const target = document.createElement('div');
  const app = createApp(CodexBackgroundTerminals, { api });
  app.use(createI18n({ legacy: false, locale: 'en' }));
  app.mount(target);
  try {
    expect(target.querySelectorAll('article')).toHaveLength(1);
    api.events.value.push({
      id: 2,
      method: 'item/completed',
      time: 2,
      params: {
        threadId: 'main',
        item: {
          id: 'cmd',
          type: 'commandExecution',
          command: 'npm run dev',
          aggregatedOutput: 'one\ntwo\nthree\nfour',
          status: 'completed',
        },
      },
    });
    await nextTick();
    expect(target.querySelector('pre')?.textContent).toBe('two\nthree\nfour');
    api.activeThreadId.value = 'other';
    await nextTick();
    expect(target.querySelectorAll('article')).toHaveLength(0);
    expect(target.querySelector('[role="status"]')).not.toBeNull();
  } finally {
    app.unmount();
  }
});
