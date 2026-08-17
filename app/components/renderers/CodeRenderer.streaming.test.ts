import { createApp, defineComponent, h, nextTick, reactive, watch } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderWorkerStream } from '../../utils/workerStream';
import type { StreamTokenBatch } from '../../workers/streamHandler';
import { useSettings } from '../../composables/useSettings';

const workerState = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    posted: unknown[] = [];
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(message: unknown) {
      this.posted.push(message);
    }
    emit(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  return { FakeWorker };
});

vi.mock('../../workers/render-worker?worker', () => ({ default: workerState.FakeWorker }));

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../../utils/workerStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/workerStream')>();
  return {
    ...actual,
    startRenderWorkerStream: vi.fn(),
  };
});

import { startRenderWorkerStream } from '../../utils/workerStream';
import CodeRenderer from './CodeRenderer.vue';

const mockStartStream = vi.mocked(startRenderWorkerStream);

function createMockStream(): {
  stream: RenderWorkerStream;
  sendChunk: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  triggerBatch: (batch: StreamTokenBatch) => void;
} {
  const sendChunk = vi.fn();
  const close = vi.fn().mockResolvedValue('<pre class="shiki"><code>final</code></pre>');
  const cancel = vi.fn();
  let batchCallback: ((batch: StreamTokenBatch) => void) | null = null;

  const stream: RenderWorkerStream = {
    sendChunk,
    close,
    cancel,
    onBatch: (cb) => {
      batchCallback = cb;
    },
  };

  const triggerBatch = (batch: StreamTokenBatch) => {
    batchCallback?.(batch);
  };

  return { stream, sendChunk, close, cancel, triggerBatch };
}

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

type MountedRenderer = {
  readonly target: HTMLElement;
  readonly props: Record<string, unknown>;
  readonly renderedCount: () => number;
  readonly readState: (key: string) => unknown;
  readonly unmount: () => void;
};

type ElementWithVueInstance = HTMLElement & {
  __vueParentComponent?: {
    setupState?: Record<string, unknown>;
  };
};

const mountedApps: Array<() => void> = [];

function mountCodeRenderer(initialProps: Record<string, unknown>): MountedRenderer {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = reactive({ ...initialProps });
  let rendered = 0;
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(CodeRenderer, {
            ...props,
            onRendered: () => {
              rendered += 1;
            },
          });
      },
    }),
  );
  app.mount(target);
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    app.unmount();
    target.remove();
  };
  mountedApps.push(unmount);
  return {
    target,
    props,
    renderedCount: () => rendered,
    readState: (key) =>
      (target.querySelector('.code-renderer-content') as ElementWithVueInstance | null)
        ?.__vueParentComponent?.setupState?.[key],
    unmount,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useSettings().floatingPreviewWordWrap.value = false;
});

afterEach(() => {
  vi.useRealTimers();
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('CodeRenderer streaming', () => {
  it('clears delayed row measurements when the renderer unmounts', async () => {
    const mounted = mountCodeRenderer({
      rawHtml: '<div class="code-row">line</div>',
      fileContent: 'line',
      lang: 'text',
    });
    await settle();
    const rowRectTimerIds = mounted.readState('rowRectTimerIds');
    if (!(rowRectTimerIds instanceof Set)) throw new Error('Expected row measurement timers');
    expect(rowRectTimerIds.size).toBeGreaterThan(0);

    mounted.unmount();

    expect(rowRectTimerIds.size).toBe(0);
  });

  it('surfaces the stream error instead of a blank container when the stream fails', async () => {
    // Given: a streaming renderer whose close rejects (worker-reported failure)
    const { stream, close } = createMockStream();
    close.mockRejectedValue(new Error('boom'));
    mockStartStream.mockReturnValue(stream);
    const mounted = mountCodeRenderer({
      fileContent: 'line1\nline2',
      lang: 'typescript',
      streaming: true,
    });
    await settle();

    // When: the debounced close fails
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    // Then: the failure is visible instead of an indefinitely blank container
    expect(mounted.target.textContent).toContain('boom');
  });

  it('re-runs line highlights and the rendered emit when the stream converges', async () => {
    // Given: a streaming code renderer with a line selection
    const finalHtml =
      '<pre class="shiki"><code><div class="code-row">line1</div><div class="code-row">line2</div></code></pre>';
    const { stream, close } = createMockStream();
    close.mockResolvedValue(finalHtml);
    mockStartStream.mockReturnValue(stream);
    const mounted = mountCodeRenderer({
      fileContent: 'line1\nline2',
      lang: 'typescript',
      lines: '1',
      streaming: true,
    });
    await settle();
    expect(mockStartStream).toHaveBeenCalledTimes(1);
    const baselineRendered = mounted.renderedCount();

    // When: the stream converges (debounced close resolves with the final HTML)
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    // Then: the final HTML is rendered with the line highlight applied
    const rows = mounted.target.querySelectorAll('.code-row');
    expect(rows.length).toBe(2);
    expect(rows[0]?.classList.contains('line-highlight')).toBe(true);
    // And: the rendered event fired again on stream completion
    expect(mounted.renderedCount()).toBeGreaterThan(baselineRendered);
  });

  it('renders rawHtml instead of an empty stream container when streaming has no render params', async () => {
    // Given: a streaming renderer with rawHtml but no fileContent (binary preview path)
    const mounted = mountCodeRenderer({
      rawHtml: '<div class="code-row">BINARY</div>',
      streaming: true,
    });
    await settle();

    // Then: no stream opens and the rawHtml branch is what renders
    expect(mockStartStream).not.toHaveBeenCalled();
    const scrollContent = mounted.target.querySelector('.code-scroll-content');
    expect(scrollContent?.innerHTML).toContain('BINARY');
  });

  it('shows the loading indicator when streaming with no fileContent yet', async () => {
    // Given: a streaming renderer whose content has not arrived
    const mounted = mountCodeRenderer({ streaming: true });
    await settle();

    // Then: the loading indicator is shown instead of a blank viewer
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(mounted.target.querySelector('.viewer-loading')).not.toBeNull();
  });

  it('keeps the viewport row anchored when a taller overscan row is measured above it', async () => {
    const settings = useSettings();
    settings.floatingPreviewWordWrap.value = true;
    const rawHtml = Array.from(
      { length: 1_200 },
      (_, index) => `<div class="code-row"><span>${index}</span></div>`,
    ).join('');
    const mounted = mountCodeRenderer({
      rawHtml,
      fileContent: 'placeholder',
      lang: 'text',
    });
    await settle();

    const body = mounted.target.querySelector<HTMLElement>('.viewer-body');
    if (!body) throw new Error('Expected a code viewer body');
    expect(mounted.target.querySelectorAll('.virtual-row').length).toBeGreaterThan(0);
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 2_000, writable: true });
    body.dispatchEvent(new Event('scroll'));
    await settle();

    const rows = [...mounted.target.querySelectorAll<HTMLElement>('.virtual-row')];
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, index === 0 ? 0 : 20, 100, index === 0 ? 60 : 20),
      );
    });

    body.dispatchEvent(new Event('scroll'));
    await settle(20);

    expect(body.scrollTop).toBe(2_040);
  });

  it('captures the rendered viewport anchor before the app applies a new font size', async () => {
    const settings = useSettings();
    const previousFontSize = settings.appFontSizePx.value;
    settings.floatingPreviewWordWrap.value = true;
    let layout: 'old' | 'new' = 'old';
    const stopAppFontWatcher = watch(settings.appFontSizePx, () => {
      layout = 'new';
    });
    const rawHtml = Array.from(
      { length: 1_200 },
      (_, index) => `<div class="code-row"><span>${index}</span></div>`,
    ).join('');
    const mounted = mountCodeRenderer({ rawHtml, fileContent: 'placeholder', lang: 'text' });
    try {
      await settle();
      const body = mounted.target.querySelector<HTMLElement>('.viewer-body');
      if (!body) throw new Error('Expected a code viewer body');
      Object.defineProperty(body, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 400, 600),
      });
      Object.defineProperty(body, 'scrollTop', { configurable: true, value: 2_000, writable: true });
      body.dispatchEvent(new Event('scroll'));
      await settle();

      const rows = [...mounted.target.querySelectorAll<HTMLElement>('.virtual-row')];
      rows.forEach((row, index) => {
        Object.defineProperty(row, 'getBoundingClientRect', {
          configurable: true,
          value: () => new DOMRect(0, (index - (layout === 'old' ? 10 : 8)) * 20, 400, 20),
        });
      });

      settings.appFontSizePx.value = Math.min(20, previousFontSize + 1);
      window.dispatchEvent(new Event('resize'));
      expect(mounted.readState('pendingRowAnchor')).toEqual({
        rowIndex: 100,
        offsetWithinRow: 0,
      });
      await settle(20);

      expect(body.scrollTop).toBe(2_000);
    } finally {
      stopAppFontWatcher();
      settings.appFontSizePx.value = previousFontSize;
    }
  });

  it('measures fixed virtual rows from inner code rows so font-size shrink removes spacer gaps', async () => {
    const settings = useSettings();
    const previousFontSize = settings.appFontSizePx.value;
    const rawHtml = Array.from(
      { length: 1_200 },
      (_, index) => `<div class="code-row"><span>${index}</span></div>`,
    ).join('');
    const mounted = mountCodeRenderer({
      rawHtml,
      fileContent: 'placeholder',
      lang: 'text',
      path: '/large-file.ts',
      onRequestAddLineComment: vi.fn(),
    });
    try {
      await settle();

      const root = mounted.target.querySelector<HTMLElement>('.code-renderer-content');
      const body = mounted.target.querySelector<HTMLElement>('.viewer-body');
      const scrollContent = mounted.target.querySelector<HTMLElement>('.code-scroll-content');
      if (!root || !body || !scrollContent) throw new Error('Expected a virtual code viewer');
      Object.defineProperty(root, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 400, 600),
      });

      const setMeasuredHeight = (innerHeight: number, outerHeight: number) => {
        const innerRows = [...scrollContent.querySelectorAll<HTMLElement>('.code-row')];
        innerRows.forEach((row, index) => {
          Object.defineProperty(row, 'getBoundingClientRect', {
            configurable: true,
            value: () => new DOMRect(0, index * innerHeight, 400, innerHeight),
          });
          const outerRow = row.closest<HTMLElement>('.virtual-row');
          if (!outerRow) throw new Error('Expected an outer virtual row');
          Object.defineProperty(outerRow, 'getBoundingClientRect', {
            configurable: true,
            value: () => new DOMRect(0, index * innerHeight, 400, outerHeight),
          });
        });
      };
      const bottomSpacer = () =>
        Number(scrollContent.lastElementChild?.getAttribute('style')?.match(/height:\s*([\d.]+)px/)?.[1]);

      setMeasuredHeight(48, 48);
      settings.appFontSizePx.value = Math.min(20, previousFontSize + 1);
      body.dispatchEvent(new Event('scroll'));
      await settle(20);
      const grownBottomSpacer = bottomSpacer();
      expect(grownBottomSpacer).toBeGreaterThan(0);

      setMeasuredHeight(16, 48);
      settings.appFontSizePx.value = Math.max(10, previousFontSize - 1);
      body.dispatchEvent(new Event('scroll'));
      await settle(20);
      const shrunkBottomSpacer = bottomSpacer();
      expect(shrunkBottomSpacer).toBeLessThan(grownBottomSpacer);

      const innerRows = [...scrollContent.querySelectorAll<HTMLElement>('.code-row')];
      expect(innerRows.length).toBeGreaterThan(1);
      body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 23 }),
      );
      document.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10, clientY: 30 }),
      );
      await nextTick();

      expect(mounted.target.querySelector<HTMLElement>('.comment-editor')?.style.top).toBe('40px');
    } finally {
      settings.appFontSizePx.value = previousFontSize;
    }
  });
});
