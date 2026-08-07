import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import { useMessages } from '../composables/useMessages';
import OutputPanel from './OutputPanel.vue';

vi.mock('../composables/useFileTree', async () => {
  const { ref } = await import('vue');
  return { useFileTree: () => ({ files: ref<string[]>([]) }) };
});

describe('OutputPanel card continuity', () => {
  const messages = useMessages();

  afterEach(() => {
    messages.reset();
    document.body.replaceChildren();
  });

  it('renders every thread continuously without virtual spacer gaps', async () => {
    messages.loadHistory(
      Array.from({ length: 25 }, (_, index) => {
        const messageId = `message-${index}`;
        return {
          info: {
            id: messageId,
            sessionID: 'root-session',
            role: 'user' as const,
            time: { created: index + 1 },
            model: { providerID: 'openai', modelID: 'gpt' },
          },
          parts: [
            {
              id: `part-${index}`,
              sessionID: 'root-session',
              messageID: messageId,
              type: 'text' as const,
              text: `Prompt ${index}`,
            },
          ],
        };
      }),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(OutputPanel, {
      isFollowing: false,
      statusText: 'Idle',
      isStatusError: false,
      isThinking: false,
      theme: 'github-dark',
      currentSessionId: 'root-session',
    });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.provide('showConfirm', async () => true);
    app.mount(host);

    await nextTick();

    expect(document.querySelectorAll('.thread-block')).toHaveLength(20);
    expect(document.querySelector('.virtual-scroll-spacer')).toBeNull();

    const panel = document.querySelector('.output-panel-scroll');
    expect(panel).toBeInstanceOf(HTMLDivElement);
    panel?.dispatchEvent(new Event('scroll'));
    await nextTick();
    await nextTick();

    expect(document.querySelectorAll('.thread-block')).toHaveLength(25);
    expect(document.querySelector('.virtual-scroll-spacer')).toBeNull();
    app.unmount();
  });
});
