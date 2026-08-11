import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Characterization of the real markdown render path (markdown-it + Shiki in
// render-worker) on the CURRENT dependency tree. Captured GREEN before the
// Task-8 renderer dependency upgrade; any post-upgrade divergence must be
// proven RED here first, then adapted minimally. Do not weaken assertions.

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
  files?: string[];
};

type WorkerHarness = {
  onmessage: ((event: { data: RenderPayload }) => void) | null;
  postMessage: (message: WorkerResponse['data']) => void;
};

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
  await import(/* @vite-ignore */ `./render-worker?markdown-characterization-${moduleSuffix}`);
  harness = worker;
});

beforeEach(() => {
  // The worker's async render completion posts back through `self`, so it must
  // exist for the whole test (not just at import). Restored per test.
  if (!harness) throw new Error('worker harness not initialized');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: harness });
});

afterEach(() => {
  // Restore the ORIGINAL global `self` captured in beforeAll — never reset
  // priorSelf to undefined, or the next afterEach would DELETE the original
  // instead of restoring it.
  if (priorSelf === undefined) Reflect.deleteProperty(globalThis, 'self');
  else Object.defineProperty(globalThis, 'self', { configurable: true, value: priorSelf });
});

async function renderMarkdown(code: string, files?: string[]): Promise<string> {
  const worker = harness;
  if (!worker) throw new Error('worker harness not initialized');
  const id = `char-${waiterId++}`;
  const promise = new Promise<string>((resolve, reject) => {
    waiters.set(id, (message) => {
      if (message.ok && message.html !== undefined) resolve(message.html);
      else reject(new Error(message.error ?? 'render failed'));
    });
  });
  worker.onmessage?.({
    data: { id, code, lang: 'markdown', theme: 'github-dark', gutterMode: 'none', copyButtons: false, files },
  });
  return promise;
}

// Strip the single .markdown-host wrapper renderMarkdownHtml emits when copy
// buttons are disabled, so assertions target the markdown content itself.
function content(html: string): string {
  return html.replace(/^<div class="markdown-host">/, '').replace(/<\/div>$/, '');
}

// Shiki tokenizes fenced code into inline <span> elements, so byte-exact
// substrings of code only hold after tag stripping.
function codeText(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('markdown renderer characterization (markdown-it + shiki)', () => {
  it('renders inline code and keeps the code_inline class contract', async () => {
    const html = content(await renderMarkdown('Use `const x = 1` inline.'));
    expect(html).toContain('<code>const x = 1</code>');
    expect(html).not.toContain('<pre');
  });

  it('tags inline file references with data-file-ref and file-ref class', async () => {
    const html = content(
      await renderMarkdown('See `src/lib.ts:12-14` for details.', ['src/lib.ts', 'src/other.ts']),
    );
    expect(html).toContain('data-file-ref="src/lib.ts"');
    expect(html).toContain('data-file-lines="12-14"');
    expect(html).toContain('class="file-ref"');
    expect(html).toContain('src/lib.ts:12-14');
  });

  it('tags bare 7-40 hex refs as commit refs', async () => {
    const html = content(await renderMarkdown('The fix is in `a1b2c3d7`.'));
    expect(html).toContain('class="commit-ref"');
    expect(html).toContain('data-commit-ref="a1b2c3d7"');
  });

  it('tags hex color refs with a preview color style', async () => {
    const html = content(await renderMarkdown('Paint it `#ff8800`.'));
    expect(html).toContain('class="color-ref"');
    expect(html).toContain('--preview-color: #ff8800');
  });

  it('opens links in a new tab with noopener noreferrer', async () => {
    const html = content(await renderMarkdown('[vis](https://github.com/qiyuanhuakai/opencode-visualizer-cn)'));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>vis</a>');
  });

  it('does not auto-linkify bare URLs (linkify disabled)', async () => {
    const html = content(await renderMarkdown('Visit https://example.com/a?b=1 now.'));
    expect(html).toContain('https://example.com/a?b=1');
    expect(html).not.toContain('<a href="https://example.com/a?b=1"');
  });

  it('escapes raw HTML instead of emitting elements (html disabled)', async () => {
    const html = content(await renderMarkdown('before\n\n<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 2">\n\nafter'));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;window.pwned = 1&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;window.pwned = 2&quot;&gt;');
  });

  it('escapes raw anchor HTML but keeps markdown links working', async () => {
    const html = content(await renderMarkdown('raw <a href="https://evil.example">x</a> and [ok](https://good.example)'));
    expect(html).not.toContain('<a href="https://evil.example"');
    expect(html).toContain('target="_blank"');
  });

  it('renders CJK paragraphs, headings, inline code and fences without mangling', async () => {
    const fixture = [
      '# 中文标题',
      '',
      '段落包含简体中文、日本語のテキストと 한국어 문장。',
      '',
      '行内代码 `中文标识符` 保持不变，`変数名` 也一样。',
      '',
      '```python',
      'print("你好，世界")',
      'print("こんにちは")',
      '```',
      '',
      '结尾中文段落。',
    ].join('\n');
    const html = content(await renderMarkdown(fixture));
    expect(html).toContain('<h1>中文标题</h1>');
    expect(html).toContain('简体中文、日本語のテキストと 한국어 문장。');
    expect(html).toContain('<code>中文标识符</code>');
    expect(html).toContain('<code>変数名</code>');
    expect(codeText(html)).toContain('print("你好，世界")');
    expect(codeText(html)).toContain('print("こんにちは")');
    expect(html).toContain('结尾中文段落。');
  });

  it('renders GFM tables with header and body rows', async () => {
    const fixture = ['| 语言 | 用途 |', '| --- | --- |', '| 中文 | 界面 |', '| 日本語 | 説明 |'].join('\n');
    const html = content(await renderMarkdown(fixture));
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th>语言</th>');
    expect(html).toContain('<td>日本語</td>');
  });

  it('renders an unclosed fence as a shiki code block', async () => {
    const html = content(await renderMarkdown('```python\nprint("hi")\nx = 1'));
    expect(html).toContain('<pre class="shiki');
    expect(codeText(html)).toContain('print("hi")');
    expect(codeText(html)).toContain('x = 1');
    expect(html).not.toContain('```');
  });

  it('replaces task list markers with emoji', async () => {
    const html = content(await renderMarkdown('- [x] done\n- [ ] todo'));
    expect(html).toContain('✅');
    expect(html).toContain('⬜');
    expect(html).not.toContain('[x]');
    expect(html).not.toContain('[ ]');
  });

  it('honors breaks:true for single newlines inside paragraphs', async () => {
    const html = content(await renderMarkdown('line one\nline two'));
    expect(html).toContain('<br>');
  });

  it('highlights fenced code with shiki spans', async () => {
    const html = content(await renderMarkdown('```typescript\nconst answer: number = 42;\n```'));
    expect(html).toContain('<pre class="shiki');
    expect(codeText(html)).toContain('const answer: number = 42;');
    expect(html).toContain('</code></pre>');
    expect(html).toContain('shiki');
  });
});
