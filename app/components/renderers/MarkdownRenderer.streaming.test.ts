import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarkdownRenderer from './MarkdownRenderer.vue';

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

type PostedRequest = {
  id: string;
  code: string;
  lang: string;
  theme: string;
  gutterMode?: string;
};

const respondedIds = new Set<string>();

function htmlFor(code: string): string {
  return `<div class="seg" data-len="${code.length}">${code}</div>`;
}

function postedRequests(): PostedRequest[] {
  return workerState.FakeWorker.instances.flatMap(
    (worker) => worker.posted as PostedRequest[],
  );
}

// The worker pool round-robins posts across workers, so a global slice index
// is meaningless. A cursor snapshots each worker's posted length.
type Cursor = readonly number[];

function cursor(): Cursor {
  return workerState.FakeWorker.instances.map((worker) => worker.posted.length);
}

function requestsSince(from: Cursor): PostedRequest[] {
  return workerState.FakeWorker.instances.flatMap((worker, index) =>
    (worker.posted as PostedRequest[]).slice(from[index] ?? 0),
  );
}

let testStart: Cursor = [];

async function settle(rounds = 8): Promise<void> {  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function flushRenders(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    let answered = 0;
    for (const worker of workerState.FakeWorker.instances) {
      for (const message of worker.posted) {
        const request = message as PostedRequest;
        if (respondedIds.has(request.id)) continue;
        respondedIds.add(request.id);
        worker.emit({ id: request.id, ok: true, html: htmlFor(request.code) });
        answered += 1;
      }
    }
    await settle();
    if (answered === 0) {
      const remaining = postedRequests().filter((request) => !respondedIds.has(request.id));
      if (remaining.length === 0) return;
    }
  }
  throw new Error('flushRenders did not quiesce');
}

type MountedRenderer = {
  readonly target: HTMLElement;
  readonly props: Record<string, unknown>;
  readonly renderedCount: () => number;
};

const mountedApps: Array<() => void> = [];

function mountMarkdownRenderer(initialProps: Record<string, unknown>): MountedRenderer {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = reactive({ ...initialProps });
  let rendered = 0;
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(MarkdownRenderer, {
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
  testStart = cursor();
  for (const request of postedRequests()) respondedIds.add(request.id);
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('MarkdownRenderer characterization (default path, no streaming)', () => {
  it('does not schedule copy-state cleanup after unmount while clipboard write is pending', async () => {
    let resolveClipboard: () => void = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClipboard = resolve;
        }),
    );
    const browserWindow = window as unknown as {
      electronAPI?: { clipboard?: { writeText: (text: string) => Promise<void> } };
    };
    const previousElectronApi = browserWindow.electronAPI;
    browserWindow.electronAPI = { clipboard: { writeText } };
    try {
      const mounted = mountMarkdownRenderer({ html: '<p>given</p>', lang: 'markdown' });
      await settle();
      const content = mounted.target.querySelector<HTMLElement>('.message-content');
      if (!content) throw new Error('Expected markdown content');
      content.innerHTML =
        '<div class="md-code-block"><button class="md-copy-btn"></button><pre>copy me</pre></div>';
      const codeBlock = content.querySelector<HTMLElement>('.md-code-block');
      const button = content.querySelector<HTMLElement>('.md-copy-btn');
      if (!codeBlock || !button) throw new Error('Expected copy fixture');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith('copy me');

      mountedApps.pop()?.();
      resolveClipboard();
      await settle();

      expect(codeBlock.classList.contains('copied')).toBe(false);
    } finally {
      browserWindow.electronAPI = previousElectronApi;
    }
  });

  it('renders the full document through the worker and re-renders fully on code changes', async () => {
    // Given: a markdown renderer without the streaming prop
    const code = '# Alpha\n\nBody text.';
    const mounted = mountMarkdownRenderer({ code, lang: 'markdown' });
    // When: the worker completes the render
    await flushRenders();

    // Then: exactly one full-document request went to the worker
    const requests = requestsSince(testStart);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ code, lang: 'markdown', gutterMode: 'none' });

    // And: the html lands in the message content container and 'rendered' fired
    const content = mounted.target.querySelector('.message-content');
    expect(mounted.target.querySelector('.markdown-renderer')).toBeTruthy();
    expect(content?.innerHTML).toBe(htmlFor(code));
    expect(mounted.renderedCount()).toBe(1);

    // When: the code changes
    const nextCode = '# Alpha\n\nBody text.\n\nMore.';
    mounted.props.code = nextCode;
    await flushRenders();

    // Then: a second full-document request replaces the content
    const allRequests = requestsSince(testStart);
    expect(allRequests).toHaveLength(2);
    expect(allRequests[1]?.code).toBe(nextCode);
    expect(content?.innerHTML).toBe(htmlFor(nextCode));
    expect(mounted.renderedCount()).toBe(2);

  });

  it('renders the html prop directly without touching the worker', async () => {
    // Given: a renderer driven by the html prop
    const mounted = mountMarkdownRenderer({ html: '<p>given</p>', lang: 'markdown' });
    // When: the component settles
    await settle();

    // Then: no worker request was posted and the html is shown verbatim
    expect(requestsSince(testStart)).toHaveLength(0);
    expect(mounted.target.querySelector('.message-content')?.innerHTML).toBe('<p>given</p>');
    expect(mounted.renderedCount()).toBe(1);

  });
});

describe('MarkdownRenderer streaming', () => {
  it('renders stable segments once, keeps the container node, and never re-renders grown text in full', async () => {
    // Given: a streaming markdown renderer
    const mounted = mountMarkdownRenderer({ code: '# Beta', lang: 'markdown', streaming: true });
    await flushRenders();
    const container = mounted.target.querySelector('.message-content');
    expect(container).toBeTruthy();

    // When: the text grows across paragraph boundaries
    const t2 = '# Beta\n\nFirst para.';
    mounted.props.code = t2;
    await flushRenders();
    const t3 = '# Beta\n\nFirst para.\n\nSecond para.';
    mounted.props.code = t3;
    await flushRenders();

    // Then: the worker received segment renders, never the full grown documents
    const codes = requestsSince(testStart).map((request) => request.code);
    expect(codes).not.toContain(t2);
    expect(codes).not.toContain(t3);
    expect(codes.filter((code) => code === '# Beta\n\n')).toHaveLength(1);
    expect(codes).toContain('Second para.');

    // And: the container node is managed in place (no v-html replacement)
    const current = mounted.target.querySelector('.message-content');
    expect(current).toBe(container);
    expect(current?.innerHTML).toContain('Second para.');
    expect(current?.innerHTML).toContain('First para.');

  });

  it('converges through exactly one default-path full render when streaming flips true to false', async () => {
    // Given: a streaming renderer that has been growing
    const mounted = mountMarkdownRenderer({ code: '# Gamma', lang: 'markdown', streaming: true });
    await flushRenders();
    mounted.props.code = '# Gamma\n\nFirst para.';
    await flushRenders();
    const finalText = '# Gamma\n\nFirst para.\n\nSecond para.';
    mounted.props.code = finalText;
    await flushRenders();
    // Requests are pooled round-robin across workers, so flattened order is
    // grouped by worker, not chronological. Diff by request id instead of
    // slicing at a count.
    const streamingRequestIds = new Set(requestsSince(testStart).map((request) => request.id));
    expect(streamingRequestIds.size).toBeGreaterThan(1);
    const renderedBeforeFlip = mounted.renderedCount();

    // When: the part completes (streaming flips off)
    mounted.props.streaming = false;
    await flushRenders();

    // Then: exactly one new request renders the final text in full
    const convergenceRequests = requestsSince(testStart).filter(
      (request) => !streamingRequestIds.has(request.id),
    );
    expect(convergenceRequests).toHaveLength(1);
    expect(convergenceRequests[0]).toMatchObject({
      code: finalText,
      lang: 'markdown',
      gutterMode: 'none',
    });

    // And: the resulting DOM is exactly that full render
    const content = mounted.target.querySelector('.message-content');
    expect(content?.innerHTML).toBe(htmlFor(finalText));
    // Streaming applies already emitted rendered; convergence adds exactly one.
    expect(mounted.renderedCount()).toBe(renderedBeforeFlip + 1);

  });

  it('keeps streamed DOM visible until the final full render resolves', async () => {
    // Given: streamed markdown has already produced visible content
    const finalText = '# Held\n\nExisting streamed content.';
    const mounted = mountMarkdownRenderer({ code: finalText, lang: 'markdown', streaming: true });
    await flushRenders();
    const content = mounted.target.querySelector('.message-content');
    const streamedHtml = content?.innerHTML;
    expect(streamedHtml).toContain('Existing streamed content.');

    // When: streaming ends but the final full-render worker is held
    mounted.props.streaming = false;
    await settle();
    const finalRequest = postedRequests().find(
      (request) => request.code === finalText && !respondedIds.has(request.id),
    );
    if (!finalRequest) throw new Error('final full render was not posted');

    // Then: the old DOM and its layout shell remain until the final html exists
    expect(mounted.target.querySelector('.markdown-renderer')).toBeTruthy();
    expect(mounted.target.querySelector('.message-content')).toBe(content);
    expect(content?.innerHTML).toBe(streamedHtml);

    // When: the final worker completes
    const worker = workerState.FakeWorker.instances.find((candidate) =>
      candidate.posted.some((message) => (message as PostedRequest).id === finalRequest.id),
    );
    if (!worker) throw new Error('final render worker was not found');
    respondedIds.add(finalRequest.id);
    worker.emit({ id: finalRequest.id, ok: true, html: htmlFor(finalText) });
    await settle();

    // Then: the full html replaces the streamed DOM in place, preserving the
    // browser's scroll anchor instead of swapping the content element.
    const finalizedContent = mounted.target.querySelector('.message-content');
    expect(finalizedContent).toBe(content);
    expect(finalizedContent?.innerHTML).toBe(htmlFor(finalText));
  });

  it('ignores streaming for non-markdown languages', async () => {
    // Given: a streaming flag on a non-markdown renderer
    const code = 'const delta = 1;';
    const mounted = mountMarkdownRenderer({ code, lang: 'typescript', streaming: true });
    await flushRenders();

    // Then: the default full-render path is used
    const requests = requestsSince(testStart);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ code, lang: 'typescript', gutterMode: 'none' });
    expect(mounted.target.querySelector('.message-content')?.innerHTML).toBe(htmlFor(code));

    // And: growth triggers another full render, not segment renders
    const nextCode = 'const delta = 1;\nconst more = 2;';
    mounted.props.code = nextCode;
    await flushRenders();
    const allRequests = requestsSince(testStart);
    expect(allRequests).toHaveLength(2);
    expect(allRequests[1]?.code).toBe(nextCode);

  });

  it('behaves sanely with empty or missing code and streams content when it arrives', async () => {
    // Given: a streaming renderer without any code yet
    const mounted = mountMarkdownRenderer({ lang: 'markdown', streaming: true });
    await flushRenders();

    // Then: the container is mounted and no crash occurs
    expect(mounted.target.querySelector('.markdown-renderer')).toBeTruthy();
    const content = mounted.target.querySelector('.message-content');
    expect(content).toBeTruthy();

    // When: text streams in across a paragraph boundary
    mounted.props.code = '# Epsilon';
    await flushRenders();
    const grown = '# Epsilon\n\nBody.';
    mounted.props.code = grown;
    await flushRenders();

    // Then: segment rendering kicks in (no full render of the grown text)
    const codes = requestsSince(testStart).map((request) => request.code);
    expect(codes).toContain('# Epsilon\n\n');
    expect(codes).not.toContain(grown);
    expect(content?.innerHTML).toContain('Body.');

  });
});
