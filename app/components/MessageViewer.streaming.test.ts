import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MessageViewer from './MessageViewer.vue';

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

vi.mock('../workers/render-worker?worker', () => ({ default: workerState.FakeWorker }));

type PostedRequest = {
  id: string;
  code: string;
  lang: string;
  theme: string;
  gutterMode?: string;
  copyButtonLabel?: string;
  copiedLabel?: string;
  copyCodeAriaLabel?: string;
  copyMarkdownAriaLabel?: string;
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

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
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

function createMessages() {
  return {
    en: {
      messageViewer: { rendered: 'Rendered', source: 'Source' },
      render: {
        copyCode: 'Copy code',
        copied: 'Copied',
        copyCodeAria: 'Copy code aria',
        copyMarkdownAria: 'Copy markdown aria',
      },
      common: { loading: 'Loading' },
    },
  };
}

type MountedViewer = {
  readonly target: HTMLElement;
  readonly props: Record<string, unknown>;
};

const mountedApps: Array<() => void> = [];

function mountMessageViewer(initialProps: Record<string, unknown>): MountedViewer {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = reactive({ ...initialProps });
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(MessageViewer, props);
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
  app.mount(target);
  mountedApps.push(() => {
    app.unmount();
    target.remove();
  });
  return {
    target,
    props,
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

describe('MessageViewer characterization (default path, no streaming)', () => {
  it('routes markdown lang to MarkdownRenderer with localized copy labels', async () => {
    // Given: a markdown message without the streaming prop
    const code = '# Zeta\n\nText.';
    const mounted = mountMessageViewer({ code, lang: 'markdown' });
    // When: the render completes
    await flushRenders();

    // Then: one full markdown request carries the localized labels
    const requests = requestsSince(testStart);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      code,
      lang: 'markdown',
      gutterMode: 'none',
      copyButtonLabel: 'Copy code',
      copiedLabel: 'Copied',
      copyCodeAriaLabel: 'Copy code aria',
      copyMarkdownAriaLabel: 'Copy markdown aria',
    });

    // And: the markdown renderer shows the html
    const content = mounted.target.querySelector('.markdown-renderer .message-content');
    expect(content?.innerHTML).toBe(htmlFor(code));
    expect(mounted.target.querySelector('.code-renderer-content')).toBeNull();

  });
});

describe('MessageViewer streaming forwarding', () => {
  it('forwards streaming to MarkdownRenderer for markdown messages', async () => {
    // Given: a streaming markdown message
    const mounted = mountMessageViewer({ code: '# Eta', lang: 'markdown', streaming: true });
    await flushRenders();

    // When: the text grows across a paragraph boundary
    const grown = '# Eta\n\nBody.';
    mounted.props.code = grown;
    await flushRenders();

    // Then: MarkdownRenderer took the streaming segment path
    const codes = requestsSince(testStart).map((request) => request.code);
    expect(codes).toContain('# Eta\n\n');
    expect(codes).not.toContain(grown);
    const content = mounted.target.querySelector('.markdown-renderer .message-content');
    expect(content?.innerHTML).toContain('Body.');

  });

  it('ignores streaming for non-markdown languages and keeps the CodeRenderer path untouched', async () => {
    // Given: a streaming flag on a non-markdown message
    const code = 'const theta = 1;';
    const mounted = mountMessageViewer({ code, lang: 'typescript', streaming: true });
    await flushRenders();

    // Then: CodeRenderer mounted, MarkdownRenderer did not
    expect(mounted.target.querySelector('.code-renderer-content')).toBeTruthy();
    expect(mounted.target.querySelector('.markdown-renderer')).toBeNull();

    // And: no markdown render request was issued
    const requests = requestsSince(testStart);
    expect(requests.filter((request) => request.lang === 'markdown')).toHaveLength(0);

  });
});
