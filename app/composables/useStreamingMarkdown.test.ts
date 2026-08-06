import MarkdownIt from 'markdown-it';
import { nextTick, ref, type Ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownSegmentCache } from '../utils/markdownSegmentCache';
import { useStreamingMarkdown } from './useStreamingMarkdown';

type Harness = {
  readonly text: Ref<string>;
  readonly theme: Ref<string>;
  readonly context: Ref<string>;
  readonly enabled: Ref<boolean>;
  readonly container: Ref<HTMLElement | null>;
  readonly dispose: () => void;
};

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function createRenderer() {
  return vi.fn(async (markdown: string, theme: string) =>
    `<article data-theme="${theme}">${markdown}</article>`,
  );
}

function createHarness(
  render: (markdown: string, theme: string) => Promise<string>,
  initialText: string,
): Harness {
  const text = ref(initialText);
  const theme = ref('light');
  const context = ref('');
  const enabled = ref(false);
  const container = ref<HTMLElement | null>(document.createElement('div'));
  const { dispose } = useStreamingMarkdown({
    text,
    theme,
    renderContext: context,
    enabled,
    render,
    containerRef: container,
  });
  enabled.value = true;
  return { text, theme, context, enabled, container, dispose };
}

describe('useStreamingMarkdown', () => {
  beforeEach(() => {
    clearMarkdownSegmentCache();
  });

  it('re-renders with fresh output when the render context changes mid-stream', async () => {
    let label = 'COPY';
    const render = vi.fn(
      async (markdown: string, theme: string) =>
        `<article data-theme="${theme}" data-label="${label}">${markdown}</article>`,
    );
    const harness = createHarness(render, '# Title');

    await settle();
    expect(harness.container.value?.innerHTML).toContain('data-label="COPY"');
    const callsBefore = render.mock.calls.length;

    // When the locale/files context changes, cached segment HTML from the old
    // context must not be reused — everything re-renders with the new label.
    label = '复制';
    harness.context.value = 'zh';
    await settle();

    expect(harness.container.value?.innerHTML).toContain('data-label="复制"');
    expect(harness.container.value?.innerHTML).not.toContain('data-label="COPY"');
    expect(render.mock.calls.length).toBeGreaterThan(callsBefore);
    harness.dispose();
  });

  it('notifies after each applied DOM update so scroll-follow can react', async () => {
    const render = createRenderer();
    const onApplied = vi.fn();
    const text = ref('# Title');
    const theme = ref('light');
    const context = ref('');
    const enabled = ref(true);
    const container = ref<HTMLElement | null>(document.createElement('div'));
    const { dispose } = useStreamingMarkdown({
      text,
      theme,
      renderContext: context,
      enabled,
      render,
      containerRef: container,
      onApplied,
    });

    await settle();
    const callsAfterFirst = onApplied.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    text.value = '# Title\n\nSecond paragraph.';
    await settle();
    expect(onApplied.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    dispose();
  });

  it('does not notify after disposal', async () => {
    const render = createRenderer();
    const onApplied = vi.fn();
    const text = ref('# Title');
    const theme = ref('light');
    const context = ref('');
    const enabled = ref(true);
    const container = ref<HTMLElement | null>(document.createElement('div'));
    const { dispose } = useStreamingMarkdown({
      text,
      theme,
      renderContext: context,
      enabled,
      render,
      containerRef: container,
      onApplied,
    });

    await settle();
    dispose();
    onApplied.mockClear();

    text.value = '# Title\n\nMore.';
    await settle();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('converges to the full markdown-it render across safe growing splits', async () => {
    const markdown = new MarkdownIt();
    const render = vi.fn(async (text: string) => markdown.render(text));
    const finalText = '# Title\n\nFirst paragraph.\n\n```ts\nconst value = 1;\n```\n\nSecond paragraph.';
    const harness = createHarness(render, '# Title');

    for (const text of [
      '# Title\n\nFirst paragraph.',
      '# Title\n\nFirst paragraph.\n\n```ts\nconst value = 1;',
      finalText,
    ]) {
      harness.text.value = text;
      await settle();
    }

    expect(harness.container.value?.innerHTML).toBe(markdown.render(finalText));
    harness.dispose();
  });

  it('renders each newly stable block once while rerendering the tail', async () => {
    const render = createRenderer();
    const harness = createHarness(render, '# Title');
    const texts = [
      '# Title\n\nFirst paragraph.',
      '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
      '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nTail',
    ];

    for (const text of texts) {
      harness.text.value = text;
      await settle();
    }

    const stableBlock = '# Title\n\n';
    expect(render.mock.calls.filter(([text]) => text === stableBlock)).toHaveLength(1);
    expect(render.mock.calls.filter(([text]) => text === 'Tail')).toHaveLength(1);
    expect(render.mock.calls.length).toBeGreaterThan(texts.length);
    harness.dispose();
  });

  it('keeps stable blocks in offset order when deferred renders resolve out of order', async () => {
    const pending: Array<{
      readonly markdown: string;
      readonly theme: string;
      readonly resolve: (html: string) => void;
    }> = [];
    const render = vi.fn((markdown: string, theme: string) =>
      new Promise<string>((resolve) => pending.push({ markdown, theme, resolve })),
    );
    const harness = createHarness(render, 'alpha\n\nbeta');

    await settle();
    expect(pending.map(({ markdown }) => markdown)).toEqual(['alpha\n\n', 'beta']);
    pending[1]?.resolve('<p>beta</p>');
    await settle();
    expect(harness.container.value?.innerHTML).toBe('');
    pending[0]?.resolve('<p>alpha</p>');
    await settle();
    expect(harness.container.value?.innerHTML).toBe('<p>alpha</p><p>beta</p>');
    harness.dispose();
  });

  it('coalesces pushes during an in-flight tail render to the latest text', async () => {
    const pending: Array<{ readonly markdown: string; readonly resolve: (html: string) => void }> = [];
    const render = vi.fn((markdown: string) =>
      new Promise<string>((resolve) => pending.push({ markdown, resolve })),
    );
    const harness = createHarness(render, 'start');

    await settle();
    harness.text.value = 'start one';
    harness.text.value = 'start two';
    await nextTick();
    pending[0]?.resolve('<p>start</p>');
    await settle();

    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual(['start', 'start two']);
    pending[1]?.resolve('<p>start two</p>');
    await settle();
    expect(harness.container.value?.innerHTML).toBe('<p>start two</p>');
    harness.dispose();
  });

  it('resets all stable DOM on theme changes', async () => {
    const render = createRenderer();
    const harness = createHarness(render, 'alpha\n\nbeta');

    await settle();
    expect(harness.container.value?.innerHTML).toContain('data-theme="light"');
    harness.theme.value = 'dark';
    await settle();

    expect(harness.container.value?.innerHTML).toContain('data-theme="dark"');
    expect(harness.container.value?.innerHTML).not.toContain('data-theme="light"');
    expect(render.mock.calls.filter(([, theme]) => theme === 'dark').length).toBeGreaterThan(0);
    harness.dispose();
  });

  it('resets when the markdown shrinks or is replaced', async () => {
    const render = createRenderer();
    const harness = createHarness(render, 'old\n\ncontent');

    await settle();
    harness.text.value = 'new\n\ntext';
    await settle();

    expect(harness.container.value?.innerHTML).toContain('new\n\n');
    expect(harness.container.value?.innerHTML).not.toContain('old');
    harness.dispose();
  });

  it('uses full-render fallback permanently after segmentation is disabled', async () => {
    const render = createRenderer();
    const first = '[ref]: https://example.com\n\nbody';
    const second = `${first}\n\nmore`;
    const harness = createHarness(render, first);

    await settle();
    harness.text.value = second;
    await settle();

    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual([first, second]);
    expect(harness.container.value?.innerHTML).toContain(second);
    harness.dispose();
  });

  it('stops applying results after enabled flips false and leaves the container untouched', async () => {
    const pending: Array<{ readonly markdown: string; readonly resolve: (html: string) => void }> = [];
    const render = vi.fn((markdown: string) =>
      new Promise<string>((resolve) => pending.push({ markdown, resolve })),
    );
    const harness = createHarness(render, 'before');

    await settle();
    pending[0]?.resolve('<p>before</p>');
    await settle();
    const container = harness.container.value;
    if (!container) throw new Error('expected a test container');
    container.innerHTML = '<p>default-path</p>';
    harness.text.value = 'after';
    harness.enabled.value = false;
    await nextTick();
    pending[1]?.resolve('<p>after</p>');
    await settle();

    expect(harness.container.value?.innerHTML).toBe('<p>default-path</p>');
    harness.dispose();
  });

  it('recovers from a render rejection: keeps last good DOM, no unhandled rejection, next update renders', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const render = vi.fn(async (markdown: string) => {
        if (markdown === 'good bad') throw new Error('render exploded');
        return `<p>${markdown}</p>`;
      });
      const harness = createHarness(render, 'good');
      await settle();
      expect(harness.container.value?.innerHTML).toBe('<p>good</p>');

      // When: a render rejects mid-stream, the last good DOM stays in place
      harness.text.value = 'good bad';
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.container.value?.innerHTML).toBe('<p>good</p>');
      expect(unhandled).toEqual([]);

      // And: the loop is not dead — the next watcher tick re-renders the latest text
      harness.text.value = 'good better';
      await settle();
      expect(harness.container.value?.innerHTML).toBe('<p>good better</p>');
      harness.dispose();
    } finally {
      consoleError.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reuses cached stable HTML for a new segmenter with the same theme and text', async () => {
    const firstRender = createRenderer();
    const first = createHarness(firstRender, 'alpha\n\nbeta');
    await settle();
    first.dispose();

    const secondRender = createRenderer();
    const second = createHarness(secondRender, 'alpha\n\nbeta');
    await settle();

    expect(secondRender.mock.calls.map(([markdown]) => markdown)).toEqual(['beta']);
    expect(second.container.value?.innerHTML).toContain('alpha\n\n');
    second.dispose();
  });
});
