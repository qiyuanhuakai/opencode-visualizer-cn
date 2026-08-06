import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Subagent from './Subagent.vue';
import { FLOATING_WINDOW_KEY } from '../../composables/useFloatingWindow';

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

const mockFloatingWindow = {
  key: 'test-subagent',
  content: { value: '' },
  html: { value: '' },
  title: { value: '' },
  status: { value: '' },
  notifyContentChange: vi.fn(),
  setContent: vi.fn(),
  appendContent: vi.fn(),
  setTitle: vi.fn(),
  setStatus: vi.fn(),
  setColor: vi.fn(),
  bringToFront: vi.fn(),
  minimize: vi.fn(),
  close: vi.fn(),
  onResize: vi.fn(),
};

const mountedApps: Array<() => void> = [];

function mountSubagent(initialEntries: Array<{ id: string; text: string; completed?: boolean }>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(Subagent, { entries: initialEntries });
      },
    }),
  );
  app.provide(FLOATING_WINDOW_KEY, mockFloatingWindow);
  app.use(createI18n({ legacy: false, locale: 'en', messages: createMessages() }));
  app.mount(target);
  mountedApps.push(() => {
    app.unmount();
    target.remove();
  });
  return target;
}

beforeEach(() => {
  testStart = cursor();
  for (const request of postedRequests()) respondedIds.add(request.id);
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Subagent streaming prop', () => {
  it('takes streaming segment path for incomplete entries (completed=false)', async () => {
    // Given: an entry marked as still growing
    const entries = reactive([{ id: 'part-1', text: '# Start', completed: false }]);
    mountSubagent(entries);
    await flushRenders();

    // When: the text grows across a paragraph boundary
    entries[0].text = '# Start\n\nBody.';
    await flushRenders();

    // Then: streaming segment path taken — partial segment appears, not full code
    const codes = requestsSince(testStart).map((r) => r.code);
    expect(codes).toContain('# Start\n\n');
    expect(codes).not.toContain('# Start\n\nBody.');
  });

  it('takes full code path for completed entries (completed=true)', async () => {
    // Given: an entry marked completed
    mountSubagent([
      { id: 'part-1', text: '# Complete thought', completed: true },
    ]);
    await flushRenders();

    // Then: full code path — the complete text is rendered as one request
    const requests = requestsSince(testStart);
    expect(requests).toHaveLength(1);
    expect(requests[0].code).toBe('# Complete thought');
  });

  it('flips from streaming to non-streaming when entry completes (convergence)', async () => {
    // Given: an incomplete entry
    const entries = reactive([{ id: 'part-1', text: '# Start', completed: false }]);
    mountSubagent(entries);
    await flushRenders();
    const beforeCursor = cursor();

    // When: the entry completes with more text
    entries[0].completed = true;
    entries[0].text = '# Start\n\nFinished.';
    await flushRenders();

    // Then: new requests reflect non-streaming (full code)
    const newRequests = requestsSince(beforeCursor);
    const newCodes = newRequests.map((r) => r.code);
    expect(newCodes).toContain('# Start\n\nFinished.');
  });
});
