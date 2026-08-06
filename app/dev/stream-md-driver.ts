/**
 * Dev-only streaming-markdown driver page (QA harness, branch feat/shiki-v4).
 *
 * Mounts the REAL ToolWindow/Reasoning component (entries -> MessageViewer ->
 * MarkdownRenderer -> useStreamingMarkdown) driven purely through reactive
 * props, exactly the way production drives it: growing entry text with
 * `streaming` on while the entry is incomplete, flipped off on completion.
 * Reasoning.vue requires a floating-window injection; the driver provides a
 * stub FLOATING_WINDOW_KEY (no production component is modified).
 *
 * Evidence capture:
 * - A MutationObserver over the entries host tracks node identity per
 *   `.message-content` container: a node surviving a mutation-batch boundary
 *   is "stable"; any later removal of / mutation inside a stable node is a
 *   stable-rewrite violation (S-MD-1). Per-batch fence flags
 *   (stableHasFence/tailHasFence) locate the python-fence body relative to
 *   the stable/tail split (S-MD-2) and its atomic stable commit (S-MD-3).
 * - Worker.prototype.postMessage is patched to log every real render request
 *   (cache misses only — cache hits never reach postMessage). Combined with
 *   the markdown segment cache (stable ranges only) this distinguishes
 *   stable-block renders from tail renders (S-MD-3, S-MD-5).
 * - Console/window errors are captured in-page; the runner also captures via
 *   Playwright.
 *
 * Reachable only via the Vite dev server (`/dev/stream-md-driver.html`);
 * `vite build` bundles only index.html, so this page never ships.
 */
import { createApp, h, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import '../styles/tailwind.css';
import Reasoning, { type ReasoningEntry } from '../components/ToolWindow/Reasoning.vue';
import { FLOATING_WINDOW_KEY } from '../composables/useFloatingWindow';
import { i18n } from '../i18n';
import { getMarkdownSegmentHtml } from '../utils/markdownSegmentCache';
import { startRenderWorkerHtml } from '../utils/workerRenderer';
import { pendingWorkerRenders } from '../composables/useRenderState';
import {
  REASONING_DELTAS,
  REASONING_FULL_TEXT,
  REASONING_STATS,
} from './fixtures/reasoning-sample';

// ---------------------------------------------------------------------------
// Fixture-derived constants
// ---------------------------------------------------------------------------
// Unique marker inside the python fence body (first comment line references
// estimate_parse_cost.py; `cumulative_parse_bytes` appears nowhere else).
const FENCE_BODY = 'cumulative_parse_bytes';
// Closing bytes of the python fence: last body line + closing marker.
const CLOSED_FENCE = 'main()\n```';
// Closure becomes a stable candidate only once the blank line after the
// closing fence has arrived.
const CLOSURE_READY = 'main()\n```\n\n';
// Complete fence opener (deltas may split the ``` marker; this is only
// "open" once the language tag is complete). Unique in the fixture.
const FENCE_OPEN = '```python\n';

// Shrink-replacement text for S-MD-7: a strict prefix region of the fixture
// (everything before the "## 现状代码" section) plus a NEW ending that does
// not exist in the original — shorter than the accumulated text at the
// shrink point and not a prefix of it, forcing the segmenter reset path.
const SHRINK_CUT = '## 现状代码 Current Implementation';
const SHRINK_TEXT = `${REASONING_FULL_TEXT.slice(
  0,
  REASONING_FULL_TEXT.indexOf(SHRINK_CUT),
)}## 收缩后的新结论 Shrunk Conclusion\n\nThe entry was replaced mid-stream with a shorter, different text. 替换后的最终 DOM 必须与新文本的单次渲染逐字节一致。\n`;

const WARMUP_TEXT =
  '# Warmup\n\nWarmup paragraph with `inline` code.\n\n```ts\nconst warmup = 1;\n```\n\nDone.\n';

// ---------------------------------------------------------------------------
// Console / error capture
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

const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Worker request instrumentation (render requests = postMessage cache misses)
// ---------------------------------------------------------------------------
type RenderRequestEntry = {
  seq: number;
  t: number;
  lang: string;
  theme: string;
  code: string;
};
const renderRequests: RenderRequestEntry[] = [];
let renderRequestSeq = 0;

const originalPostMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function patchedPostMessage(
  this: Worker,
  message: unknown,
  ...rest: unknown[]
) {
  if (
    typeof message === 'object' &&
    message !== null &&
    'code' in message &&
    'lang' in message &&
    'theme' in message
  ) {
    const payload = message as { code: string; lang: string; theme: string };
    renderRequests.push({
      seq: (renderRequestSeq += 1),
      t: now(),
      lang: payload.lang,
      theme: payload.theme,
      code: payload.code,
    });
  }
  return originalPostMessage.apply(this, [message as never, ...rest] as never);
};

// ---------------------------------------------------------------------------
// Mutation / stable-node tracking
// ---------------------------------------------------------------------------
type BatchEntry = {
  seq: number;
  t: number;
  entry: number;
  added: number;
  removed: number;
  stableCount: number;
  stableHTMLLen: number;
  stableHasFence: boolean;
  tailHasFence: boolean;
  violation: boolean;
};

type ContainerState = {
  prevChildren: Set<Node>;
  stable: Set<Node>;
};

const mutationLog: BatchEntry[] = [];
const trackers = new Map<HTMLElement, ContainerState>();
let mutationSeq = 0;
let lastMutationT = 0;

function nodeHTML(node: Node): string {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement).outerHTML
    : (node.textContent ?? '');
}

function entryContainers(): Array<{ index: number; el: HTMLElement }> {
  const out: Array<{ index: number; el: HTMLElement }> = [];
  document
    .querySelectorAll<HTMLElement>('#entries-host .reasoning-entry')
    .forEach((entryEl, index) => {
      const mc = entryEl.querySelector<HTMLElement>('.message-content');
      if (mc) out.push({ index, el: mc });
    });
  return out;
}

function nodeTouchesContainer(node: Node, el: HTMLElement): boolean {
  return (
    node === el ||
    el.contains(node) ||
    (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).contains(el))
  );
}

const observer = new MutationObserver((records) => {
  lastMutationT = now();
  const containers = entryContainers();

  // Phase 0: which containers did this batch actually touch? Only touched
  // containers produce log lines, so one entry's streaming activity never
  // fabricates batch lines for a sibling entry (S-MD-4 scoping). The record
  // target counts only when it is the container or inside it: an insertion
  // at a shared ANCESTOR (e.g. a sibling entry appended to
  // .reasoning-content) must not touch the container — but an added/removed
  // node that IS or CONTAINS the container still does (container swap).
  const touched = new Set<HTMLElement>();
  for (const record of records) {
    for (const { el } of containers) {
      if (touched.has(el)) continue;
      if (record.target === el || el.contains(record.target)) {
        touched.add(el);
        continue;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (nodeTouchesContainer(node, el)) {
          touched.add(el);
          break;
        }
      }
    }
  }

  // Phase 1: update per-container stable sets. A node present in both the
  // previous and current child list survived a full mutation batch — by
  // construction of useStreamingMarkdown only stable-block nodes can survive
  // (applyTail always re-creates tail nodes; a batch with no applyTail cannot
  // exist in the normal path). A wholesale child swap (replaceChildren in
  // clearAppliedState/applyFullHtml) invalidates the stable set instead.
  // Untouched containers are skipped: their child list is unchanged, so
  // marking "survivors" there would misclassify live tail nodes as stable
  // and fabricate a violation on the next tail replacement.
  for (const { el } of containers) {
    if (!touched.has(el)) continue;
    let state = trackers.get(el);
    if (!state) {
      state = { prevChildren: new Set(), stable: new Set() };
      trackers.set(el, state);
    }
    const current = new Set<Node>(el.childNodes);
    if (state.prevChildren.size > 0) {
      let removedPrev = 0;
      for (const prev of state.prevChildren) {
        if (!current.has(prev)) removedPrev += 1;
      }
      if (removedPrev === state.prevChildren.size) {
        state.stable.clear();
      } else {
        for (const node of current) {
          if (state.prevChildren.has(node)) state.stable.add(node);
        }
      }
    }
    state.prevChildren = current;
  }

  // Phase 2: violation detection against the post-update stable sets (a
  // legit full reset therefore never flags). A violation is any removal of a
  // stable node, or any mutation whose target sits inside a stable node.
  const violatedEntries = new Set<number>();
  for (const record of records) {
    for (const { index, el } of containers) {
      const state = trackers.get(el);
      if (!state || state.stable.size === 0) continue;
      if (el !== record.target && !el.contains(record.target)) continue;
      let hit = false;
      for (const removed of record.removedNodes) {
        if (state.stable.has(removed)) {
          hit = true;
          break;
        }
      }
      if (!hit && record.target !== el) {
        let node: Node | null = record.target;
        while (node && node !== el) {
          if (state.stable.has(node)) {
            hit = true;
            break;
          }
          node = node.parentNode;
        }
      }
      if (hit) violatedEntries.add(index);
    }
  }

  // Phase 3: per-batch telemetry (touched containers only).
  const added = records.reduce((acc, r) => acc + r.addedNodes.length, 0);
  const removed = records.reduce((acc, r) => acc + r.removedNodes.length, 0);
  for (const { index, el } of containers) {
    if (!touched.has(el)) continue;
    const state = trackers.get(el);
    if (!state) continue;
    let stableHTML = '';
    let tailHTML = '';
    for (const node of el.childNodes) {
      if (state.stable.has(node)) stableHTML += nodeHTML(node);
      else tailHTML += nodeHTML(node);
    }
    mutationLog.push({
      seq: (mutationSeq += 1),
      t: lastMutationT,
      entry: index,
      added,
      removed,
      stableCount: state.stable.size,
      stableHTMLLen: stableHTML.length,
      stableHasFence: stableHTML.includes(FENCE_BODY),
      tailHasFence: tailHTML.includes(FENCE_BODY),
      violation: violatedEntries.has(index),
    });
  }
});

// ---------------------------------------------------------------------------
// Vue app mounting the real Reasoning component
// ---------------------------------------------------------------------------
type DriverEntry = ReasoningEntry & { text: string };

const state = reactive({
  entries: [] as DriverEntry[],
});
const theme = ref('github-dark');
let notifyContentChangeCount = 0;
let copyLabels = {
  copyButtonLabel: '',
  copiedLabel: '',
  copyCodeAriaLabel: '',
  copyMarkdownAriaLabel: '',
};

const app = createApp({
  setup() {
    const { t } = useI18n();
    copyLabels = {
      copyButtonLabel: t('render.copyCode'),
      copiedLabel: t('render.copied'),
      copyCodeAriaLabel: t('render.copyCodeAria'),
      copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
    };
    return () =>
      h('div', [
        h('div', { class: 'driver-status' }, [
          `stream-md-driver | theme=${theme.value} | entries=${state.entries.length}`,
        ]),
        h('div', { id: 'entries-host', class: 'entries-host' }, [
          h(Reasoning, { entries: state.entries, theme: theme.value }),
        ]),
      ]);
  },
});

// Stub floating-window context required by Reasoning.vue (no-op outside a
// real floating window; notifyContentChange is counted for evidence).
app.provide(FLOATING_WINDOW_KEY, {
  key: 'stream-md-driver',
  content: ref(''),
  html: ref(''),
  title: ref(''),
  status: ref(''),
  notifyContentChange: () => {
    notifyContentChangeCount += 1;
  },
  setContent: () => {},
  appendContent: () => {},
  setTitle: () => {},
  setStatus: () => {},
  setColor: () => {},
  bringToFront: () => {},
  minimize: () => {},
  close: () => {},
  onResize: () => {},
});

app.use(i18n);
app.mount('#app');

observer.observe(document.getElementById('entries-host') as HTMLElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
});

// ---------------------------------------------------------------------------
// Driver state helpers
// ---------------------------------------------------------------------------
type FeedEvents = {
  fed: number;
  firstFenceOpenT: number | null;
  firstClosureReadyT: number | null;
  doneT: number | null;
};
const feedEventsById = new Map<string, FeedEvents>();

function findEntry(id: string): DriverEntry {
  const entry = state.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no entry with id ${id}`);
  return entry;
}

async function feedDeltas(id: string, deltas: readonly string[], paceMs: number): Promise<void> {
  const entry = findEntry(id);
  let events = feedEventsById.get(id);
  if (!events) {
    events = { fed: 0, firstFenceOpenT: null, firstClosureReadyT: null, doneT: null };
    feedEventsById.set(id, events);
  }
  for (const delta of deltas) {
    entry.text += delta;
    events.fed += 1;
    if (events.firstFenceOpenT === null && entry.text.includes(FENCE_OPEN)) {
      events.firstFenceOpenT = now();
    }
    if (events.firstClosureReadyT === null && entry.text.includes(CLOSURE_READY)) {
      events.firstClosureReadyT = now();
    }
    if (paceMs > 0) await sleep(paceMs);
  }
  events.doneT = now();
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------
// Raw browser canonicalization: parse + serialize through the same engine.
function canonicalize(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerHTML;
}

// Content canonicalization for streaming-vs-single-shot equivalence.
// Rationale (grounded in the real worker output, render-worker.ts
// renderMarkdownHtml): EVERY markdown render — whether a stable-range render,
// a tail render, or a single-shot full render — wraps its output in its own
// `<div class="markdown-host">` with a `template.md-raw-source`, a host-level
// copy button and a copied indicator, and splices an extra copy button after
// the LAST `</pre>` of that render. Segmented rendering therefore produces N
// host wrappers where the single-shot produces 1, so RAW byte-identity
// between streaming DOM and single-shot is structurally impossible. The
// meaningful contract — the one the unit test
// useStreamingMarkdown.test.ts asserts as `innerHTML === markdown.render(fullText)`
// — is CONTENT equivalence: the sequence of markdown block nodes is
// identical. This function strips exactly the per-render scaffolding
// (templates, copy buttons, indicators, host wrappers) and normalizes
// top-level whitespace-only text nodes (markdown-it separates blocks with
// "\n" text nodes; segment seams have none), then serializes through the
// browser. Applied identically to both sides, byte-equality of the results
// means the rendered markdown content is byte-identical.
function canonicalizeContent(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  div
    .querySelectorAll('template.md-raw-source, .md-copy-btn, .md-copied-indicator')
    .forEach((node) => node.remove());
  for (const host of Array.from(div.querySelectorAll('.markdown-host'))) {
    host.replaceWith(...Array.from(host.childNodes));
  }
  for (const node of Array.from(div.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') {
      node.remove();
    }
  }
  return div.innerHTML;
}

function extractHexColors(html: string): string[] {
  return Array.from(new Set(html.match(/#[0-9a-fA-F]{6}\b/g) ?? [])).map((c) =>
    c.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Driver hooks
// ---------------------------------------------------------------------------
const containerTokens = new WeakMap<HTMLElement, number>();
let containerTokenSeq = 0;

const driver = {
  FULL_TEXT: REASONING_FULL_TEXT,
  DELTA_COUNT: REASONING_DELTAS.length,
  STATS: REASONING_STATS,
  SHRINK_TEXT,
  FENCE_BODY,
  CLOSED_FENCE,

  addEntry(id: string, text = '', completed = false) {
    if (state.entries.some((entry) => entry.id === id)) {
      throw new Error(`duplicate entry id ${id}`);
    }
    state.entries.push({ id, text, completed });
  },

  clearEntries() {
    state.entries.splice(0, state.entries.length);
  },

  appendDelta(id: string, text: string) {
    findEntry(id).text += text;
  },

  async feedFull(id: string, paceMs = 8): Promise<void> {
    await feedDeltas(id, REASONING_DELTAS, paceMs);
  },

  async feedRange(id: string, fromFrac: number, toFrac: number, paceMs = 8): Promise<void> {
    const from = Math.floor(REASONING_DELTAS.length * fromFrac);
    const to = Math.floor(REASONING_DELTAS.length * toFrac);
    await feedDeltas(id, REASONING_DELTAS.slice(from, to), paceMs);
  },

  completeEntry(id: string) {
    findEntry(id).completed = true;
  },

  switchTheme(nextTheme: string) {
    theme.value = nextTheme;
  },

  shrinkEntry(id: string, newText: string) {
    findEntry(id).text = newText;
  },

  getEntryCount(): number {
    return state.entries.length;
  },

  getEntryHTML(index: number): string {
    const entries = document.querySelectorAll<HTMLElement>('#entries-host .reasoning-entry');
    const entryEl = entries[index];
    if (!entryEl) return '';
    return entryEl.querySelector<HTMLElement>('.message-content')?.innerHTML ?? '';
  },

  // Unique token per `.message-content` element instance: proves the
  // streaming container was swapped for the v-html container on completion.
  getEntryContainerToken(index: number): number {
    const entries = document.querySelectorAll<HTMLElement>('#entries-host .reasoning-entry');
    const mc = entries[index]?.querySelector<HTMLElement>('.message-content');
    if (!mc) return -1;
    let token = containerTokens.get(mc);
    if (token === undefined) {
      token = (containerTokenSeq += 1);
      containerTokens.set(mc, token);
    }
    return token;
  },

  async getSingleShotHTML(code: string, singleShotTheme: string): Promise<string> {
    const task = startRenderWorkerHtml({
      id: `qa-md-singleshot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      code,
      lang: 'markdown',
      theme: singleShotTheme,
      gutterMode: 'none',
      copyButtonLabel: copyLabels.copyButtonLabel,
      copiedLabel: copyLabels.copiedLabel,
      copyCodeAriaLabel: copyLabels.copyCodeAriaLabel,
      copyMarkdownAriaLabel: copyLabels.copyMarkdownAriaLabel,
    });
    return task.promise;
  },

  getLabels() {
    return { ...copyLabels };
  },

  getMutationLog(): BatchEntry[] {
    return [...mutationLog];
  },

  getFeedEvents(id: string): FeedEvents | null {
    const events = feedEventsById.get(id);
    return events ? { ...events } : null;
  },

  getRenderRequestInfo() {
    return renderRequests.map((request) => ({
      seq: request.seq,
      t: request.t,
      lang: request.lang,
      theme: request.theme,
      codeLen: request.code.length,
      hasFenceBody: request.code.includes(FENCE_BODY),
      hasClosedFence: request.code.includes(CLOSED_FENCE),
      // Only stable-range renders are stored in the markdown segment cache
      // (useStreamingMarkdown.resolveStableBlocks); tail renders never are.
      // Context must match MarkdownRenderer's renderContext (no files here).
      isSegCached:
        getMarkdownSegmentHtml(
          request.theme,
          [
            '',
            copyLabels.copyButtonLabel,
            copyLabels.copiedLabel,
            copyLabels.copyCodeAriaLabel,
            copyLabels.copyMarkdownAriaLabel,
          ].join(' '),
          request.code,
        ) !== undefined,
    }));
  },

  countRequestsExact(code: string, sinceT: number): number {
    return renderRequests.filter(
      (request) => request.code === code && request.t >= sinceT,
    ).length;
  },

  getNotifyCount(): number {
    return notifyContentChangeCount;
  },

  getConsoleErrors(): string[] {
    return [...consoleErrors];
  },

  now,

  // Resolves when no mutation batch has been observed for `quietMs`
  // AND there are no pending worker renders — quiescence requires both
  // DOM quiet and the worker pool to have settled. Rejects on timeout.
  async waitForQuiescence(quietMs = 500, timeoutMs = 60000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      const marker = lastMutationT;
      await sleep(quietMs);
      const domQuiet = lastMutationT === marker;
      const workersIdle = pendingWorkerRenders.value === 0;
      if (domQuiet && workersIdle) return true;
      if (Date.now() - start > timeoutMs) return false;
    }
  },

  async warmup(): Promise<void> {
    state.entries.push({ id: '__warmup__', text: WARMUP_TEXT, completed: false });
    await this.waitForQuiescence(800, 90000);
    state.entries.splice(0, state.entries.length);
    await sleep(200);
  },

  resetTelemetry() {
    mutationLog.length = 0;
    mutationSeq = 0;
    renderRequests.length = 0;
    renderRequestSeq = 0;
    consoleErrors.length = 0;
    feedEventsById.clear();
  },

  canonicalize,
  canonicalizeContent,
  extractHexColors,
};

Object.assign(window, { __mdDriver: driver });
