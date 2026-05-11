import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { ref } from 'vue';

import ThreadHistoryContent from './ThreadHistoryContent.vue';
import { FLOATING_WINDOW_KEY } from '../composables/useFloatingWindow';

function createMessages() {
  return {
    en: {
      toolTitles: {
        shell: 'SHELL',
        write: 'WRITE',
        edit: 'EDIT',
        patch: 'PATCH',
      },
      toolStatus: {
        completed: 'completed',
      },
      threadHistory: {
        thinking: 'Thinking',
        delegation: 'Delegation',
        question: 'Question',
      },
      questionStatus: {
        replied: 'replied',
      },
    },
  };
}

async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe('ThreadHistoryContent', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows all multiedit file paths in history summary', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
    const root = document.createElement('div');
    document.body.appendChild(root);

    const app = createApp(defineComponent({
      setup() {
        return () => h(ThreadHistoryContent, {
          entries: [{
            key: 'tool-1',
            kind: 'tool',
            time: 1,
            part: {
              id: 'tool-1',
              callID: 'tool-1',
              sessionID: 's1',
              messageID: 'm1',
              type: 'tool',
              tool: 'multiedit',
              state: {
                status: 'completed',
                input: { filePath: '1.txt', files: ['1.txt', '2.txt'] },
                output: 'done',
                title: 'edit files',
                metadata: {},
                time: { start: 1, end: 1 },
              },
            },
          }],
          theme: 'github-dark',
        });
      },
    }));

    app.use(i18n);
    app.provide(FLOATING_WINDOW_KEY, {
      key: 'test-floating-window',
      content: ref(''),
      html: ref(''),
      title: ref(''),
      status: ref('completed'),
      notifyContentChange: () => {},
      setContent: () => {},
      appendContent: () => {},
      setTitle: () => {},
      setStatus: () => {},
      setColor: () => {},
      bringToFront: () => {},
      minimize: () => {},
      close: () => {},
      onResize: () => {},
    });
    app.mount(root);
    await flushRender();

    expect(root.textContent).toContain('1.txt, 2.txt');

    app.unmount();
    root.remove();
  });
});
