import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderWorkerStream } from '../../utils/workerStream';
import type { StreamTokenBatch } from '../../workers/streamHandler';

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
  mountedApps.push(() => {
    app.unmount();
    target.remove();
  });
  return {
    target,
    props,
    renderedCount: () => rendered,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('CodeRenderer streaming', () => {
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
});
