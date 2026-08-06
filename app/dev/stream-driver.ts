/**
 * Dev-only stream driver page (QA harness).
 *
 * Mounts the REAL CodeRenderer component with `streaming` enabled and drives
 * it through reactive props, so every byte flows through the real worker
 * stream, the real useStreamCodeRender composable, and the real DOM.
 *
 * Evidence capture:
 * - A MutationObserver on the component root records every DOM mutation with
 *   timestamps (used to prove "no mutations after cancel" in S2d and to
 *   capture the finalize swap in S1/S2c).
 * - window.__streamDriver exposes hooks for the Playwright runner.
 *
 * This file is only reachable via the Vite dev server (`/dev/stream-driver.html`);
 * it is not part of the production build (vite build only bundles index.html).
 */
import { createApp, h, onMounted, ref } from 'vue';
import '../styles/tailwind.css';
import CodeRenderer from '../components/renderers/CodeRenderer.vue';
import { i18n } from '../i18n';
import { startRenderWorkerHtml } from '../utils/workerRenderer';

// Fixed 8-chunk TypeScript fixture (do not alter — mid-line splits plus a
// multi-line template literal).
const CHUNKS = [
  'const greet = (name: string): string => {\n  const msg = `Hel',
  'lo,\n${nam',
  'e}!\nWelcome back.`;\n  return msg.tri',
  'm();\n};\nconst ou',
  "t = greet('world');\nconsole.lo",
  'g(out);\nout.spl',
  "it('').forEach((ch) => ch);\nexport def",
  'ault greet;\n',
];

const FULL_CODE = CHUNKS.join('');

// ---------------------------------------------------------------------------
// Console / error capture (in-page; the runner also captures via Playwright)
// ---------------------------------------------------------------------------
const consoleErrors: string[] = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(' '));
  originalConsoleError(...args);
};
window.addEventListener('error', (event) => {
  consoleErrors.push(`window.onerror: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  consoleErrors.push(`unhandledrejection: ${String(event.reason)}`);
});

// ---------------------------------------------------------------------------
// Mutation evidence
// ---------------------------------------------------------------------------
type MutationEntry = {
  seq: number;
  t: number;
  added: number;
  removed: number;
  rowCount: number;
  finalized: boolean;
};

const mutationLog: MutationEntry[] = [];
let mutationSeq = 0;
let finalizeCaptureHTML = '';
const t0 = performance.now();

function queryStreamContainer(): HTMLElement | null {
  // The streaming container is the `.code-scroll-content` div rendered while
  // `streaming && !streamDone`. After `done`, CodeRenderer swaps it for a
  // `.code-scroll-content` wrapper containing a `.code-content` (v-html) div.
  const candidates = document.querySelectorAll<HTMLElement>('.code-scroll-content');
  for (const el of candidates) {
    if (!el.querySelector('.code-content')) return el;
  }
  return null;
}

function queryPostDoneContent(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.code-scroll-content .code-content');
}

function currentRowCount(): number {
  return document.querySelectorAll('#renderer-host .code-row').length;
}

const observer = new MutationObserver((records) => {
  let added = 0;
  let removed = 0;
  for (const record of records) {
    added += record.addedNodes.length;
    removed += record.removedNodes.length;
  }
  const streamEl = queryStreamContainer();
  if (streamEl) {
    const html = streamEl.innerHTML;
    // The patcher only ever writes `<pre class="shiki"><code>…rows…</code></pre>`.
    // A `code-host` wrapper means closeStream() performed the finalize swap.
    if (html.includes('code-host')) {
      finalizeCaptureHTML = html;
    }
  }
  mutationLog.push({
    seq: (mutationSeq += 1),
    t: Math.round(performance.now() - t0),
    added,
    removed,
    rowCount: currentRowCount(),
    finalized: finalizeCaptureHTML !== '',
  });
});

// ---------------------------------------------------------------------------
// Vue app mounting the real CodeRenderer
// ---------------------------------------------------------------------------
const code = ref('');
const theme = ref('github-dark');
const lang = ref('typescript');
const gutterMode = ref<'default' | 'none'>('none');
const hostRef = ref<HTMLElement | null>(null);

const app = createApp({
  setup() {
    onMounted(() => {
      if (hostRef.value) {
        observer.observe(hostRef.value, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      }
    });

    return () =>
      h('div', [
        h('div', { class: 'driver-status' }, [
          `stream-driver | theme=${theme.value} | code=${code.value.length} chars`,
        ]),
        h('div', { id: 'renderer-host', ref: hostRef, class: 'renderer-host' }, [
          h(CodeRenderer, {
            fileContent: code.value,
            lang: lang.value,
            theme: theme.value,
            streaming: true,
            gutterMode: gutterMode.value,
          }),
        ]),
      ]);
  },
});

app.use(i18n);
app.mount('#app');

// ---------------------------------------------------------------------------
// Driver hooks
// ---------------------------------------------------------------------------
function canonicalize(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerHTML;
}

function extractHexColors(html: string): string[] {
  return Array.from(new Set(html.match(/#[0-9a-fA-F]{6}\b/g) ?? [])).map((c) =>
    c.toLowerCase(),
  );
}

const driver = {
  CHUNKS,
  FULL_CODE,

  feed(chunk: string) {
    code.value += chunk;
  },

  switchTheme(nextTheme: string) {
    theme.value = nextTheme;
  },

  setGutterMode(nextMode: 'default' | 'none') {
    gutterMode.value = nextMode;
  },

  cancel() {
    // Empty code makes CodeRenderer's streamingRenderParams computed return
    // null, which triggers cancelActiveStream() in the composable — the same
    // cancel path production uses when a streamed block is cleared.
    code.value = '';
  },

  reset() {
    code.value = '';
    theme.value = 'github-dark';
    lang.value = 'typescript';
    gutterMode.value = 'none';
    consoleErrors.length = 0;
    mutationLog.length = 0;
    mutationSeq = 0;
    finalizeCaptureHTML = '';
  },

  getViewerHTML(): string {
    const host = document.getElementById('renderer-host');
    return host?.innerHTML ?? '';
  },

  getStreamContainerHTML(): string {
    return queryStreamContainer()?.innerHTML ?? '';
  },

  getPostDoneHTML(): string {
    return queryPostDoneContent()?.innerHTML ?? '';
  },

  getFinalizeCaptureHTML(): string {
    return finalizeCaptureHTML;
  },

  isDone(): boolean {
    return queryPostDoneContent() !== null;
  },

  async waitForDone(timeoutMs = 10000): Promise<boolean> {
    const start = Date.now();
    while (!this.isDone() && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.isDone();
  },

  getRowCount(): number {
    return currentRowCount();
  },

  getGutterTexts(): string[] {
    return Array.from(document.querySelectorAll('#renderer-host .code-gutter')).map(
      (el) => el.textContent ?? '',
    );
  },

  getMutationLog(): MutationEntry[] {
    return [...mutationLog];
  },

  getMutationCount(): number {
    return mutationLog.length;
  },

  getConsoleErrors(): string[] {
    return [...consoleErrors];
  },

  canonicalize,

  extractHexColors,

  async getSingleShotHTML(
    singleShotCode: string,
    singleShotTheme: string,
    singleShotGutterMode: 'none' | 'single' | 'double' = 'none',
  ): Promise<string> {
    const id = `qa-singleshot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const task = startRenderWorkerHtml({
      id,
      code: singleShotCode,
      lang: lang.value,
      theme: singleShotTheme,
      gutterMode: singleShotGutterMode,
    });
    return task.promise;
  },
};

Object.assign(window, { __streamDriver: driver });
