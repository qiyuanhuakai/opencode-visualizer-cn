import MarkdownIt from 'markdown-it';
import { nextTick, ref, type Ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMarkdownSegmentCache } from '../utils/markdownSegmentCache';
import { useStreamingMarkdown } from './useStreamingMarkdown';

type Harness = {
  readonly text: Ref<string>;
  readonly theme: Ref<string>;
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
  const enabled = ref(false);
  const container = ref<HTMLElement | null>(document.createElement('div'));
  const { dispose } = useStreamingMarkdown({
    text,
    theme,
    enabled,
    render,
    containerRef: container,
  });
  enabled.value = true;
  return { text, theme, enabled, container, dispose };
}

describe('useStreamingMarkdown', () => {
  beforeEach(() => {
    clearMarkdownSegmentCache();
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
