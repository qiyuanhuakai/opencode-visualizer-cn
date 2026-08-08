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

  it('reveals the newest window when follow-to-bottom starts several batches behind', async () => {
    messages.loadHistory(
      Array.from({ length: 250 }, (_, index) => {
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
    const panelComponent = app.mount(host);
    await nextTick();

    const panel = document.querySelector('.output-panel-scroll');
    expect(panel).toBeInstanceOf(HTMLDivElement);
    for (let batch = 0; batch < 4; batch += 1) {
      if (panel instanceof HTMLDivElement) panel.scrollTop = 0;
      panel?.dispatchEvent(new Event('scroll'));
      const expectedFirstMessage = 210 - batch * 20;
      await vi.waitFor(() => {
        expect(
          document.querySelector(`[data-root-id="message-${expectedFirstMessage}"]`),
        ).not.toBeNull();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (panel instanceof HTMLDivElement) panel.scrollTop = 0;
    panel?.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(document.querySelector('[data-root-id="message-249"]')).toBeNull();

    const scrollToBottom = Reflect.get(panelComponent, 'scrollToBottom');
    expect(scrollToBottom).toBeTypeOf('function');
    if (typeof scrollToBottom === 'function') await scrollToBottom();

    expect(document.querySelector('[data-root-id="message-249"]')).not.toBeNull();
    expect(document.querySelectorAll('.thread-block').length).toBeLessThanOrEqual(100);
    app.unmount();
  });
});
