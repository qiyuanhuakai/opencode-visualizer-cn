import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { expect, it, vi } from 'vitest';
import en from '../locales/en';
import { useMessages } from '../composables/useMessages';
import { makeUserHistoryEntry } from './historyTestBuilders';
import OutputPanel from './OutputPanel.vue';

vi.mock('../utils/workerRenderer', () => ({
  startRenderWorkerHtml: () => ({ promise: Promise.resolve(''), cancel: () => {} }),
  RenderCancelledError: class RenderCancelledError extends Error {},
}));
vi.mock('../composables/useFileTree', async () => {
  const { ref } = await import('vue');
  return { useFileTree: () => ({ files: ref<string[]>([]) }) };
});
vi.mock('@iconify/vue', () => ({ Icon: { template: '<span />' } }));

it('waits for cold rendering and stable geometry without expanding the initial history window', async () => {
  const messages = useMessages();
  messages.loadHistory(Array.from({ length: 100 }, (_, index) => makeUserHistoryEntry(index)));
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(OutputPanel, {
    isFollowing: true,
    isAnchoring: true,
    statusText: '',
    isStatusError: false,
    isThinking: false,
    theme: 'github-dark',
    currentSessionId: 'root-session',
    backendKind: 'codex',
  });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  const instance = app.mount(host);
  try {
    await nextTick();
    const panel = host.querySelector<HTMLElement>('.output-panel-scroll');
    if (!panel) throw new Error('Output panel missing');
    let height = 1600;
    Object.defineProperties(panel, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => 600 },
    });
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const frame = async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
      await nextTick();
    };
    let finishRenders = () => {};
    const waitForRenders = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRenders = resolve;
        }),
    );
    const scrollToBottom = Reflect.get(instance, 'scrollToBottom');
    if (typeof scrollToBottom !== 'function') throw new Error('Scroll API missing');
    let settled = false;
    const scrolling = Promise.resolve(scrollToBottom(waitForRenders)).then(() => {
      settled = true;
    });
    await nextTick();
    expect(waitForRenders).toHaveBeenCalledOnce();
    panel.dispatchEvent(new Event('scroll'));
    await frame();
    expect(panel.scrollTop).toBe(0);
    finishRenders();
    await nextTick();
    await nextTick();
    await frame();
    height = 2600;
    await frame();
    expect(settled).toBe(false);
    await frame();
    await frame();
    await scrolling;
    expect(panel.scrollTop).toBe(2000);
    expect(host.querySelectorAll('.thread-card-item')).toHaveLength(20);
  } finally {
    app.unmount();
    messages.reset();
    host.remove();
    vi.unstubAllGlobals();
  }
});
