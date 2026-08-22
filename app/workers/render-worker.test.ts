import { afterEach, describe, expect, it, vi } from 'vitest';
import { ByteWeightedLruCache } from '../utils/byteWeightedLru';

type WorkerResponse = {
  data: {
    id: string;
    ok: boolean;
    html?: string;
    error?: string;
  };
};

type RenderPayload = {
  id: string;
  code: string;
  lang: string;
  theme: string;
  gutterMode: 'none';
  copyButtons?: boolean;
};

type WorkerHarness = {
  onmessage: ((event: { data: RenderPayload }) => void) | null;
  postMessage: (message: WorkerResponse['data']) => void;
};

let priorSelf: unknown;

function request(id: string, theme: string): RenderPayload {
  return {
    id,
    code: 'const answer: number = 42;',
    lang: 'typescript',
    theme,
    gutterMode: 'none' as const,
  };
}

async function startWorker(
  moduleSuffix: 'dark-baseline' | 'light-baseline' | 'overlap' | 'copy-controls' | 'oversized',
) {
  const messages: WorkerResponse['data'][] = [];
  const waiters = new Map<string, (message: WorkerResponse['data']) => void>();
  const worker: WorkerHarness = {
    onmessage: null,
    postMessage: vi.fn((message) => {
      messages.push(message);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }),
  };
  priorSelf ??= Reflect.get(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: worker });
  await import(/* @vite-ignore */ `./render-worker?theme-regression-${moduleSuffix}`);
  const cache = Reflect.get(globalThis, '__visRenderWorkerCacheForTests');
  if (!(cache instanceof ByteWeightedLruCache)) {
    throw new Error('render worker test cache is unavailable');
  }
  cache.clear();

  function render(payload: ReturnType<typeof request>) {
    return new Promise<string>((resolve, reject) => {
      waiters.set(payload.id, (message) => {
        if (message.ok && message.html !== undefined) resolve(message.html);
        else reject(new Error(message.error ?? 'render failed'));
      });
      worker.onmessage?.({ data: payload });
    });
  }

  return { messages, render, cache };
}

describe('render worker theme isolation', () => {
  afterEach(() => {
    if (priorSelf === undefined) Reflect.deleteProperty(globalThis, 'self');
    else Object.defineProperty(globalThis, 'self', { configurable: true, value: priorSelf });
    priorSelf = undefined;
  });

  it('keeps overlapping different-theme renders on their own theme', async () => {
    // Given: two requests begin before either theme transition has settled
    const darkBaseline = await startWorker('dark-baseline');
    const darkAlone = await darkBaseline.render(request('dark-baseline', 'github-dark'));
    const lightBaseline = await startWorker('light-baseline');
    const lightAlone = await lightBaseline.render(request('light-baseline', 'github-light'));
    const { render } = await startWorker('overlap');
    const dark = request('dark', 'github-dark');
    const light = request('light', 'github-light');

    // When: the requests are submitted back-to-back
    const [darkHtml, lightHtml] = await Promise.all([render(dark), render(light)]);

    // Then: each response has the colors selected by its request's theme
    expect(darkHtml).toBe(darkAlone);
    expect(lightHtml).toBe(lightAlone);
  });

  it('omits markdown copy controls when the caller disables them', async () => {
    const { render } = await startWorker('copy-controls');
    const html = await render({
      ...request('without-copy-controls', 'github-dark'),
      code: '# Result\n\n```text\noutput\n```',
      lang: 'markdown',
      copyButtons: false,
    });

    expect(html).toContain('Result');
    expect(html).not.toContain('md-copy-btn');
    expect(html).not.toContain('COPY');
    expect(html).not.toContain('Copied');
  });

  it('shares one byte budget across code and markdown entries with LRU promotion', async () => {
    const { cache } = await startWorker('overlap');
    const codeKey = `code:${'x'.repeat(10)}`;
    const markdownKey = `markdown:${'y'.repeat(10)}`;
    cache.set(codeKey, 'a'.repeat(1.5 * 1024 * 1024));
    cache.set(markdownKey, 'b'.repeat(1.5 * 1024 * 1024));
    expect(cache.get(codeKey)).toHaveLength(1.5 * 1024 * 1024);

    cache.set('code:new', 'c'.repeat(2 * 1024 * 1024));

    expect(cache.has(codeKey)).toBe(true);
    expect(cache.has(markdownKey)).toBe(false);
    expect(cache.get('code:new')).toHaveLength(2 * 1024 * 1024);
  });

  it('rejects an oversized worker cache entry without changing retained output', async () => {
    const { cache, render } = await startWorker('oversized');
    const oversized = 'z'.repeat(5 * 1024 * 1024);
    cache.set('code:oversized', oversized);

    expect(cache.has('code:oversized')).toBe(false);
    await expect(render(request('exact-output', 'github-dark'))).resolves.toContain('42');
  });
});
