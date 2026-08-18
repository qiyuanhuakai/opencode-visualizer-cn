import { createApp, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import { useMessages } from '../composables/useMessages';
import OutputPanel from './OutputPanel.vue';

const outputWorkerState = vi.hoisted(() => ({
  startRenderWorkerHtml: vi.fn(() => ({
    promise: Promise.resolve('<p>rendered</p>'),
    cancel: vi.fn(),
  })),
}));

vi.mock('../utils/workerRenderer', () => ({
  startRenderWorkerHtml: outputWorkerState.startRenderWorkerHtml,
  RenderCancelledError: class RenderCancelledError extends Error {},
}));

vi.mock('@iconify/vue', () => ({
  Icon: { template: '<span class="mock-icon" />' },
}));

vi.mock('../composables/useFileTree', async () => {
  const { ref } = await import('vue');
  return { useFileTree: () => ({ files: ref<string[]>([]) }) };
});

describe('OutputPanel card continuity', () => {
  const messages = useMessages();

  afterEach(() => {
    messages.reset();
    outputWorkerState.startRenderWorkerHtml.mockClear();
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

  it('shows the current progressive history window while history is loading', async () => {
    const historyEntry = (index: number) => ({
      info: {
        id: `user-${index}`,
        sessionID: 'root-session',
        role: 'user' as const,
        time: { created: index + 1 },
        model: { providerID: 'openai', modelID: 'gpt' },
      },
      parts: [
        {
          id: `user-part-${index}`,
          sessionID: 'root-session',
          messageID: `user-${index}`,
          type: 'text' as const,
          text: `Prompt ${index}`,
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const isLoading = ref(true);
    const app = createApp({
      setup() {
        return () =>
          h(OutputPanel, {
            isFollowing: false,
            statusText: 'Loading',
            isStatusError: false,
            isThinking: false,
            isLoading: isLoading.value,
            theme: 'github-dark',
            currentSessionId: 'root-session',
          });
      },
    });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.provide('showConfirm', async () => true);
    app.mount(host);

    await nextTick();

    expect(host.querySelectorAll('.thread-block')).toHaveLength(0);
    expect(outputWorkerState.startRenderWorkerHtml).not.toHaveBeenCalled();

    messages.loadHistory([historyEntry(0)]);
    await nextTick();
    await nextTick();
    expect(host.querySelectorAll('.thread-block')).toHaveLength(1);

    messages.loadHistory(Array.from({ length: 124 }, (_, index) => historyEntry(index + 1)));
    await nextTick();
    await nextTick();
    expect(host.querySelectorAll('.thread-block').length).toBeLessThanOrEqual(20);

    isLoading.value = false;
    await nextTick();
    expect(host.querySelectorAll('.thread-block').length).toBeLessThanOrEqual(100);
    app.unmount();
  });
});
