import { nextTick, ref } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { clearMarkdownSegmentCache } from '../utils/markdownSegmentCache';
import { useStreamingMarkdown } from './useStreamingMarkdown';

// Characterization of the full incremental streaming path — real segmenter +
// real useStreamingMarkdown composable + real render Web Worker (markdown-it
// + Shiki) — on the CURRENT dependency tree. Captured GREEN before the Task-8
// renderer dependency upgrade; post-upgrade divergence must show RED here
// first, then be adapted minimally.

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

const FIXTURE = [
  '# 流式标题 Stream Heading',
  '',
  '段落一包含简体中文、日本語のテキスト与 한국어 문장，还有 inline `代码段`。',
  '',
  '<script>window.task8pwn = 1</script>',
  '',
  '## 表格 Table',
  '',
  '| 语言 | 用途 |',
  '| --- | --- |',
  '| 中文 | 界面 |',
  '| Python | 数据处理 |',
  '',
  '```python',
  'def greet():',
  '    print("你好，世界")',
  '```',
  '',
  '- [x] 已完成任务',
  '- [ ] 待办事项',
  '',
  '[项目链接](https://github.com/qiyuanhuakai/opencode-visualizer-cn)',
  '',
  '结尾段落 ending paragraph。',
].join('\n');

let priorSelf: unknown;
let harness: WorkerHarness | null = null;
let waiterId = 0;
const moduleSuffix = 'v1';
const waiters = new Map<string, (message: WorkerResponse['data']) => void>();

beforeAll(async () => {
  priorSelf ??= Reflect.get(globalThis, 'self');
  const worker: WorkerHarness = {
    onmessage: null,
    postMessage: (message) => {
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    },
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: worker });
  await import(/* @vite-ignore */ `../workers/render-worker?streaming-characterization-${moduleSuffix}`);
  harness = worker;
});

beforeEach(() => {
  clearMarkdownSegmentCache();
  if (!harness) throw new Error('worker harness not initialized');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: harness });
});

afterEach(() => {
  if (priorSelf === undefined) Reflect.deleteProperty(globalThis, 'self');
  else Object.defineProperty(globalThis, 'self', { configurable: true, value: priorSelf });
  priorSelf = undefined;
});

function renderMarkdown(code: string): Promise<string> {
  const worker = harness;
  if (!worker) throw new Error('worker harness not initialized');
  const id = `stream-char-${waiterId++}`;
  const promise = new Promise<string>((resolve, reject) => {
    waiters.set(id, (message) => {
      if (message.ok && message.html !== undefined) resolve(message.html);
      else reject(new Error(message.error ?? 'render failed'));
    });
  });
  worker.onmessage?.({
    data: { id, code, lang: 'markdown', theme: 'github-dark', gutterMode: 'none', copyButtons: false },
  });
  return promise;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((resolve) => setTimeout(resolve, 15));
}

function unwrapHosts(root: Element): void {
  for (const host of Array.from(root.querySelectorAll('div.markdown-host'))) {
    const parent = host.parentNode;
    while (host.firstChild) parent?.insertBefore(host.firstChild, host);
    parent?.removeChild(host);
  }
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() === '') {
      child.parentNode?.removeChild(child);
    }
  }
}

function canonicalize(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  unwrapHosts(clone);
  return clone.innerHTML;
}

describe('useStreamingMarkdown with the real render worker', () => {
  it('converges to the single-shot render with no duplication, leakage, or CJK mangling', async () => {
    const text = ref('');
    const theme = ref('github-dark');
    const context = ref('');
    const enabled = ref(false);
    const container = ref<HTMLElement | null>(document.createElement('div'));
    let appliedCount = 0;
    const { dispose } = useStreamingMarkdown({
      text,
      theme,
      renderContext: context,
      enabled,
      containerRef: container,
      render: renderMarkdown,
      onApplied: () => {
        appliedCount += 1;
      },
    });
    enabled.value = true;
    await settle();

    let offset = 0;
    let seed = 0x1234abcd;
    const nextRandom = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    while (offset < FIXTURE.length) {
      const size = Math.max(1, Math.floor(nextRandom() * 6));
      text.value += FIXTURE.slice(offset, offset + size);
      offset += size;
      await settle();
    }
    await settle();

    const finalContainer = container.value;
    if (!finalContainer) throw new Error('container ref lost');

    expect(appliedCount).toBeGreaterThanOrEqual(2);

    const leaked = finalContainer.querySelectorAll('script,iframe,embed,object');
    expect(leaked.length).toBe(0);
    expect(finalContainer.querySelectorAll('h1').length).toBe(1);
    expect(finalContainer.querySelectorAll('h2').length).toBe(1);
    expect(finalContainer.querySelectorAll('table').length).toBe(1);
    expect(finalContainer.querySelectorAll('pre.shiki').length).toBe(1);
    expect(finalContainer.textContent ?? '').toContain('简体中文、日本語のテキスト与 한국어 문장');
    expect(finalContainer.textContent ?? '').toContain('你好，世界');
    expect(finalContainer.textContent ?? '').toContain('✅');
    expect(finalContainer.textContent ?? '').toContain('⬜');
    expect(finalContainer.querySelector('a[target="_blank"][rel="noopener noreferrer"]')).not.toBeNull();

    const singleShot = await renderMarkdown(FIXTURE);
    const singleShotHost = document.createElement('div');
    singleShotHost.innerHTML = singleShot;

    expect(canonicalize(finalContainer)).toBe(canonicalize(singleShotHost));

    dispose();
  });
});
