import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { reactive, ref } from 'vue';

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

function createToolEntries(count: number, prefix: string, commandPrefix = prefix) {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${index}`,
    kind: 'tool' as const,
    time: index,
    part: {
      id: `${prefix}-${index}`,
      callID: `${prefix}-${index}`,
      sessionID: 's1',
      messageID: `m-${index}`,
      type: 'tool' as const,
      tool: 'bash',
      state: {
        status: 'completed' as const,
         input: { command: `printf ${commandPrefix}-${index}` },
        output: '',
        title: 'shell',
        metadata: {},
        time: { start: index, end: index },
      },
    },
  }));
}

function mountHistory(initialEntries: ReturnType<typeof createToolEntries>) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
  const root = document.createElement('div');
  root.className = 'floating-window-body';
  document.body.appendChild(root);
  const state = reactive({ entries: initialEntries });
  const app = createApp(defineComponent({
    setup() {
      return () => h(ThreadHistoryContent, { entries: state.entries });
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
  return { app, root, state };
}

describe('ThreadHistoryContent', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
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

  it('mounts a bounded window for a long hydrated history', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const entries = Array.from({ length: 3_000 }, (_, index) => ({
      key: `tool-${index}`,
      kind: 'tool' as const,
      time: index,
      part: {
        id: `tool-${index}`,
        callID: `tool-${index}`,
        sessionID: 's1',
        messageID: `m-${index}`,
        type: 'tool' as const,
        tool: 'bash',
        state: {
          status: 'completed' as const,
          input: { command: `printf ${index}` },
          output: '',
          title: 'shell',
          metadata: {},
          time: { start: index, end: index },
        },
      },
    }));
    const app = createApp(defineComponent({
      setup() {
        return () => h('div', { class: 'floating-window-body' }, [
          h(ThreadHistoryContent, { entries }),
        ]);
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

    const rendered = root.querySelectorAll('.history-item');
    expect(rendered).toHaveLength(100);
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('tool-2900');

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    const scrollHost = root.querySelector<HTMLElement>('.floating-window-body');
    scrollHost?.dispatchEvent(new Event('scroll'));
    await flushRender();
    await flushRender();
    const shifted = root.querySelectorAll('.history-item');
    expect(shifted).toHaveLength(100);
    expect(shifted[0]?.getAttribute('data-history-key')).toBe('tool-2880');

    app.unmount();
    root.remove();
  });

  it('resets to the valid tail when a middle window shrinks from 3000 to 100 entries', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = reactive({ entries: createToolEntries(3_000, 'original') });
    const app = createApp(defineComponent({
      setup() {
        return () => h('div', { class: 'floating-window-body' }, [
          h(ThreadHistoryContent, { entries: state.entries }),
        ]);
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

    const scrollHost = root.querySelector<HTMLElement>('.floating-window-body');
    scrollHost?.dispatchEvent(new Event('scroll'));
    await flushRender();
    await flushRender();
    expect(root.querySelector('.history-item')?.getAttribute('data-history-key')).toBe(
      'original-2880',
    );

    state.entries = createToolEntries(100, 'shrunk');
    await flushRender();

    const rendered = root.querySelectorAll('.history-item');
    expect(rendered).toHaveLength(100);
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('shrunk-0');
    expect(rendered[99]?.getAttribute('data-history-key')).toBe('shrunk-99');

    app.unmount();
    root.remove();
  });

  it('resets a middle window to the tail for a same-length replacement', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = reactive({ entries: createToolEntries(3_000, 'original') });
    const app = createApp(defineComponent({
      setup() {
        return () => h('div', { class: 'floating-window-body' }, [
          h(ThreadHistoryContent, { entries: state.entries }),
        ]);
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

    const scrollHost = root.querySelector<HTMLElement>('.floating-window-body');
    scrollHost?.dispatchEvent(new Event('scroll'));
    await flushRender();
    await flushRender();
    expect(root.querySelector('.history-item')?.getAttribute('data-history-key')).toBe(
      'original-2880',
    );

    state.entries = createToolEntries(3_000, 'replacement');
    await flushRender();

    const rendered = root.querySelectorAll('.history-item');
    expect(rendered).toHaveLength(100);
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('replacement-2900');

    app.unmount();
    root.remove();
  });

  it('preserves a middle window when same ordered keys receive new content', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = reactive({ entries: createToolEntries(3_000, 'original') });
    const app = createApp(defineComponent({
      setup() {
        return () => h('div', { class: 'floating-window-body' }, [
          h(ThreadHistoryContent, { entries: state.entries }),
        ]);
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

    const scrollHost = root.querySelector<HTMLElement>('.floating-window-body');
    scrollHost?.dispatchEvent(new Event('scroll'));
    await flushRender();
    await flushRender();
    expect(root.querySelector('.history-item')?.getAttribute('data-history-key')).toBe(
      'original-2880',
    );

    state.entries = createToolEntries(3_000, 'original', 'updated');
    await flushRender();

    const rendered = root.querySelectorAll('.history-item');
    expect(rendered).toHaveLength(100);
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('original-2880');
    expect(rendered[99]?.getAttribute('data-history-key')).toBe('original-2979');
    expect(rendered[0]?.textContent).toContain('$ printf updated-2880');

    app.unmount();
    root.remove();
  });

  it('preserves an away window on append and follows again when near the bottom', async () => {
    const mounted = mountHistory(createToolEntries(3_000, 'original'));
    await flushRender();
    Object.defineProperties(mounted.root, {
      scrollTop: { configurable: true, writable: true, value: 1_000 },
      scrollHeight: { configurable: true, value: 3_000 },
      clientHeight: { configurable: true, value: 600 },
    });

    mounted.state.entries = [
      ...mounted.state.entries,
      ...createToolEntries(1, 'appended-a'),
    ];
    await flushRender();
    let rendered = mounted.root.querySelectorAll('.history-item');
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('original-2900');
    expect(rendered[99]?.getAttribute('data-history-key')).toBe('original-2999');

    mounted.root.scrollTop = 2_400;
    mounted.state.entries = [
      ...mounted.state.entries,
      ...createToolEntries(1, 'appended-b'),
    ];
    await flushRender();
    rendered = mounted.root.querySelectorAll('.history-item');
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('original-2900');
    expect(rendered[99]?.getAttribute('data-history-key')).toBe('original-2999');

    mounted.root.dispatchEvent(new Event('scroll'));
    await flushRender();
    mounted.state.entries = [
      ...mounted.state.entries,
      ...createToolEntries(1, 'appended-c'),
    ];
    await flushRender();
    rendered = mounted.root.querySelectorAll('.history-item');
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('original-2903');
    expect(rendered[99]?.getAttribute('data-history-key')).toBe('appended-c-0');

    mounted.app.unmount();
    mounted.root.remove();
  });

  it('extends a short history at the bottom without a negative window start', async () => {
    const mounted = mountHistory(createToolEntries(50, 'short'));
    await flushRender();
    Object.defineProperties(mounted.root, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
    });
    mounted.state.entries = [
      ...mounted.state.entries,
      ...createToolEntries(1, 'appended'),
    ];
    await flushRender();

    mounted.root.scrollTop = 900;
    mounted.root.dispatchEvent(new Event('scroll'));
    await flushRender();

    const rendered = mounted.root.querySelectorAll('.history-item');
    expect(rendered).toHaveLength(51);
    expect(rendered[0]?.getAttribute('data-history-key')).toBe('short-0');
    expect(rendered[50]?.getAttribute('data-history-key')).toBe('appended-0');

    mounted.app.unmount();
    mounted.root.remove();
  });
});
