/**
 * Dev-only streaming-vs-legacy benchmark page (feat/shiki-v4).
 *
 * Measures the two real highlight paths against the SAME fixture, SAME
 * chunking, and SAME measurement code, in a real browser with the real
 * worker(s):
 *
 *   Path A (legacy):   per chunk i, the full code-so-far goes through a
 *                      single-shot worker render (startRenderWorkerHtml —
 *                      the real round-robin worker pool) and the result
 *                      replaces the container via innerHTML.
 *   Path B (streaming): per chunk i, only the new suffix is sent through
 *                      startRenderWorkerStream (the real dedicated stream
 *                      worker + ShikiStreamTokenizer); token batches are
 *                      converted by the real batchToRows and applied by the
 *                      real createStreamPatcher.
 *
 * Both paths are driven WITHOUT Vue reactivity so the comparison isolates
 * the render mechanism (worker + DOM write) rather than framework overhead;
 * both sides skip the framework identically. The full CodeRenderer/Vue
 * surface is covered by the QA driver (stream-driver.ts); this page is for
 * timing the mechanism.
 *
 * Method notes (honesty contract):
 * - The worker emits EXACTLY ONE `tokens` batch per `chunk` op
 *   (streamHandler.runChunk posts once), so per-chunk streaming latency
 *   (sendChunk -> batch applied to DOM) is well-defined and asserted 1:1.
 * - Streaming main-thread DOM cost is measured directly around
 *   batchToRows + patcher.applyBatch (patchMs), plus a forced reflow read
 *   (reflowMs) so it is comparable to legacy's domMs (innerHTML + reflow).
 * - The 300ms close debounce is bypassed while feeding: the next chunk is
 *   sent as soon as the previous batch is applied. The final close()
 *   (converged full re-render in the worker + finalize innerHTML swap) is
 *   measured SEPARATELY and EXCLUDED from per-chunk numbers.
 * - Frame smoothness: a requestAnimationFrame counter runs only during the
 *   feed loop; delivered frames and longest inter-frame gap are reported.
 * - DOM churn: a MutationObserver counts added/removed nodes RECURSIVELY
 *   (a subtree removed by innerHTML counts all of its nodes, not just the
 *   direct child record) so legacy's full-tree replacement is visible.
 * - Each page load runs exactly ONE (path, fixture) combination, selected
 *   via ?path=legacy|stream&fixture=big|small. Warmup (excluded) primes the
 *   real worker(s) before the measured run.
 *
 *   Path C (markdown):  per delta i, the full accumulated reasoning text goes
 *                      through the SAME single-shot worker render with
 *                      lang:'markdown' (renderMarkdownHtml in the worker:
 *                      full markdown-it parse + shiki fence highlighting),
 *                      and the result replaces the container via innerHTML —
 *                      the exact mechanism MarkdownRenderer.vue uses for the
 *                      live "thinking/working" floating windows. Fed
 *                      SERIALLY so each delta's round-trip is attributable.
 *
 * Results are exposed as window.__benchResult / window.__benchDone for the
 * Playwright runner (scripts/qa/stream-bench.mjs).
 */
import { ref } from 'vue';
import { startRenderWorkerHtml } from '../utils/workerRenderer';
import { startRenderWorkerStream } from '../utils/workerStream';
import { createStreamPatcher } from '../utils/streamPatch';
import { batchToRows } from '../utils/streamRows';
import { useStreamingMarkdown } from '../composables/useStreamingMarkdown';
import {
  REASONING_DELTAS,
  REASONING_FULL_TEXT,
} from './fixtures/reasoning-sample';

// ---------------------------------------------------------------------------
// Scaled fixture generation for size-scaling analysis.
// Repeats the reasoning text structure proportionally while preserving
// fence proportions and generating deterministic deltas of similar size.
// ---------------------------------------------------------------------------
function buildScaledReasoning(multiplier: number): string {
  if (multiplier <= 1) return REASONING_FULL_TEXT;
  // Split the original into logical sections (paragraphs separated by blank lines)
  const sections = REASONING_FULL_TEXT.split(/\n\n+/);
  // Repeat sections to achieve target size
  const repeated: string[] = [];
  let totalLen = 0;
  const targetLen = REASONING_FULL_TEXT.length * multiplier;
  let sectionIdx = 0;
  while (totalLen < targetLen) {
    const section = sections[sectionIdx % sections.length];
    repeated.push(section);
    totalLen += section.length + 2; // +2 for blank line
    sectionIdx++;
  }
  return repeated.join('\n\n');
}

function buildScaledDeltas(full: string): string[] {
  // Use same PRNG seed and size distribution as the original fixture
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0x5eed5);
  const deltas: string[] = [];
  let pos = 0;
  while (pos < full.length) {
    const r = rand();
    let size: number;
    if (r < 0.75) size = 2 + Math.floor(rand() * 5);
    else if (r < 0.95) size = 7 + Math.floor(rand() * 8);
    else size = 15 + Math.floor(rand() * 22);
    size = Math.min(size, full.length - pos);
    deltas.push(full.slice(pos, pos + size));
    pos += size;
  }
  return deltas;
}

// ---------------------------------------------------------------------------
// Fixture: realistic TypeScript, exactly 300 lines (10 varied 30-line blocks),
// 60 equal chunks of 5 lines. Small variant: first 40 lines, 8 chunks.
// ---------------------------------------------------------------------------
function buildFixtureLines(blockCount: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    lines.push(
      '',
      `// ── Block ${i}: entity${i} adapter (fetch + map + reduce) ──`,
      `export interface Entity${i} {`,
      `  id: string;`,
      `  name: string;`,
      `  weight: number;`,
      `  tags: string[];`,
      `  meta: Record<string, unknown>;`,
      `}`,
      '',
      `export function createEntity${i}(name: string, weight: number = ${i} * 1.5): Entity${i} {`,
      `  const tags: string[] = ['alpha-${i}', \`tier-${i % 3}\`, 'shared'];`,
      `  const id = \`entity-${i}-\${name.toLowerCase()}\`;`,
      `  return { id, name, weight, tags, meta: { block: ${i} } };`,
      `}`,
      '',
      `export async function loadEntity${i}(id: string): Promise<Entity${i} | null> {`,
      `  // Template-literal URL with nested expressions (block ${i})`,
      `  const url = \`https://api.example.com/v${(i % 2) + 1}/blocks/${i}/entities/\${id}\`;`,
      `  const response = await fetch(url, { headers: { 'x-block-id': String(${i}) } });`,
      `  if (!response.ok) {`,
      `    console.warn(\`loadEntity${i}: HTTP \${response.status} for \${id}\`);`,
      `    return null;`,
      `  }`,
      `  const data = (await response.json()) as Partial<Entity${i}>;`,
      `  return { ...createEntity${i}('fallback-${i}'), ...data, id };`,
      `}`,
      '',
      `export const DEFAULT_ENTITY_${i}: Entity${i} = createEntity${i}('default', ${i});`,
      `export type Entity${i}Loader = typeof loadEntity${i};`,
    );
  }
  return lines;
}

const BIG_LINES = buildFixtureLines(10);
if (BIG_LINES.length !== 300) {
  throw new Error(`fixture must be exactly 300 lines, got ${BIG_LINES.length}`);
}

function chunkLines(lines: string[], size: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += size) {
    const slice = lines.slice(start, start + size);
    const isLast = start + size >= lines.length;
    // Every chunk ends at a line boundary; intermediate chunks keep their
    // trailing newline so the tokenizer sees complete lines only.
    chunks.push(slice.join('\n') + (isLast ? '' : '\n'));
  }
  return chunks;
}

const LANG = 'typescript';
const THEME = 'github-dark';

// ---------------------------------------------------------------------------
// Types + page plumbing
// ---------------------------------------------------------------------------
type ChunkMetric = {
  i: number;
  codeLen: number;
  workerMs?: number; // legacy+markdown: postMessage -> response
  domMs?: number; // legacy+markdown: innerHTML replace + forced reflow
  bytesSent?: number; // markdown: UTF-8 bytes of the accumulated text sent this delta
  sendToAppliedMs?: number; // stream: sendChunk -> batch applied (incl. reflow)
  patchMs?: number; // stream: batchToRows + applyBatch
  reflowMs?: number; // stream: forced reflow after patch
  // markdown-stream specific
  streamWorkerMs?: number; // per-delta worker render time (this delta's render calls)
  streamDomMs?: number; // DOM apply time for this delta (mutation-observed)
  streamBytesThisDelta?: number; // bytes sent in render calls triggered by this delta
  streamStableInserts?: number; // stable block DOM inserts this delta
  streamTailInserts?: number; // tail DOM inserts this delta
  streamCumulativeWorkerMs?: number; // cumulative worker render time up to this delta
  streamCumulativeBytes?: number; // cumulative bytes sent up to this delta
  // Cost breakdown instrumentation
  streamTailTextLen?: number; // tail text length at this delta
  streamTailHtmlLen?: number; // tail HTML length at this delta
  streamRenderCount?: number; // number of render calls this delta
  streamStableRenderCount?: number; // stable block renders this delta
  streamTailRenderCount?: number; // tail render this delta (0 or 1)
};

type BenchResult = {
  path: string;
  fixture: string;
  lineCount: number;
  chunkCount: number;
  perChunk: ChunkMetric[];
  totals: Record<string, number>;
  frames: { frames: number; maxGapMs: number; elapsedMs: number };
  churn: { feedAdded: number; feedRemoved: number; mutationRecords: number };
  close?: {
    workerMs: number;
    domMs: number;
    churnAdded: number;
    churnRemoved: number;
  };
  sanity: {
    batchCount?: number;
    batchPerChunk?: boolean;
    closeFlushBatches?: number;
    finalMatchesSingleShot?: boolean;
    finalTextComplete?: boolean;
  };
  consoleErrors: string[];
};

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

const statusEl = document.createElement('div');
statusEl.className = 'driver-status';
statusEl.textContent = 'stream-bench | booting';
const container = document.createElement('div');
container.className = 'renderer-host';
const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app missing');
appEl.appendChild(statusEl);
appEl.appendChild(container);

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------
function startFrameCounter() {
  let frames = 0;
  let first = 0;
  let last = 0;
  let maxGap = 0;
  let running = true;
  function tick(t: number) {
    if (!running) return;
    if (first === 0) first = t;
    if (last !== 0) {
      const gap = t - last;
      if (gap > maxGap) maxGap = gap;
    }
    last = t;
    frames += 1;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
      // Record the pending gap between the last rAF tick and stop() so the
      // idle period after the feed loop ends is counted in maxGap.
      const stopTime = performance.now();
      if (last !== 0) {
        const gap = stopTime - last;
        if (gap > maxGap) maxGap = gap;
      }
    },
    stats() {
      return {
        frames,
        maxGapMs: Math.round(maxGap * 100) / 100,
        elapsedMs: Math.round((last - first) * 100) / 100,
      };
    },
  };
}

function countNodesRecursive(node: Node): number {
  let n = 1;
  node.childNodes.forEach((child) => {
    n += countNodesRecursive(child);
  });
  return n;
}

function startChurnObserver(target: HTMLElement) {
  let feedAdded = 0;
  let feedRemoved = 0;
  let closeAdded = 0;
  let closeRemoved = 0;
  let mutationRecords = 0;
  let phase: 'feed' | 'close' = 'feed';
  const observer = new MutationObserver((records) => {
    mutationRecords += records.length;
    for (const record of records) {
      let added = 0;
      let removed = 0;
      record.addedNodes.forEach((n) => {
        added += countNodesRecursive(n);
      });
      record.removedNodes.forEach((n) => {
        removed += countNodesRecursive(n);
      });
      if (phase === 'feed') {
        feedAdded += added;
        feedRemoved += removed;
      } else {
        closeAdded += added;
        closeRemoved += removed;
      }
    }
  });
  observer.observe(target, { subtree: true, childList: true });
  return {
    markClosePhase() {
      phase = 'close';
    },
    stop() {
      // Consume any pending mutation records before disconnecting so the
      // final mutations (e.g. close-phase finalize swap) are counted.
      observer.takeRecords();
      observer.disconnect();
    },
    stats() {
      return { feedAdded, feedRemoved, mutationRecords, closeAdded, closeRemoved };
    },
  };
}

function forceReflow() {
  void container.offsetHeight;
}

function canonicalize(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Warmup (excluded from measurements)
// ---------------------------------------------------------------------------
async function warmupLegacyPool() {
  // The pool has min(4, max(2, cores)) workers. Warm every worker with
  // REALISTIC ~150-line code, 3 rounds each: a tiny snippet compiles shiki
  // but leaves V8's optimizing tier cold, which confounds per-chunk latency
  // (observed: cold workers mask the code-size growth curve). Codes are
  // distinct to avoid the completed-html cache.
  const base = BIG_LINES.slice(0, 150).join('\n');
  const codes = Array.from(
    { length: 24 },
    (_, k) => `// warmup variant ${k}\n${base}\nexport const warmTail${k} = ${k};\n`,
  );
  await Promise.all(
    codes.map(
      (code, k) =>
        startRenderWorkerHtml({
          id: `bench-warm-${k}`,
          code,
          lang: LANG,
          theme: THEME,
          gutterMode: 'none',
        }).promise,
    ),
  );
}

async function warmupStreamWorker() {
  // Symmetric steady-state warmup: stream ~150 lines through the dedicated
  // stream worker in realistic 5-line chunks, then close.
  const stream = startRenderWorkerStream({ lang: LANG, theme: THEME, gutterMode: 'none' });
  let batchCount = 0;
  let resolveWait: (() => void) | null = null;
  stream.onBatch(() => {
    batchCount += 1;
    resolveWait?.();
  });
  const warmChunks = chunkLines(BIG_LINES.slice(0, 150), 5);
  for (const chunk of warmChunks) {
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve;
      // If the stream errors or stalls, this timeout ensures we don't hang
      // forever waiting for a batch that never arrives.
      setTimeout(resolve, 10000);
    });
    stream.sendChunk(chunk);
    await wait;
  }
  await stream.close();
}

// ---------------------------------------------------------------------------
// Path A — legacy: full single-shot render + innerHTML replace per chunk
// ---------------------------------------------------------------------------
async function runLegacy(chunks: string[]): Promise<BenchResult> {
  container.replaceChildren();
  const churn = startChurnObserver(container);
  const frames = startFrameCounter();
  const perChunk: ChunkMetric[] = [];
  let code = '';

  for (let i = 0; i < chunks.length; i += 1) {
    code += chunks[i];
    const t0 = performance.now();
    const task = startRenderWorkerHtml({
      id: `bench-legacy-${i}-${Date.now()}`,
      code,
      lang: LANG,
      theme: THEME,
      gutterMode: 'none',
    });
    const html = await task.promise;
    const t1 = performance.now();
    container.innerHTML = html;
    forceReflow();
    const t2 = performance.now();
    perChunk.push({
      i,
      codeLen: code.length,
      workerMs: t1 - t0,
      domMs: t2 - t1,
    });
  }
  frames.stop();
  churn.stop();

  return {
    path: 'legacy',
    fixture: `${chunks.length * 5}lines`,
    lineCount: chunks.length * 5,
    chunkCount: chunks.length,
    perChunk,
    totals: {
      workerMs: perChunk.reduce((s, m) => s + (m.workerMs ?? 0), 0),
      domMs: perChunk.reduce((s, m) => s + (m.domMs ?? 0), 0),
    },
    frames: frames.stats(),
    churn: {
      feedAdded: churn.stats().feedAdded,
      feedRemoved: churn.stats().feedRemoved,
      mutationRecords: churn.stats().mutationRecords,
    },
    sanity: {},
    consoleErrors: [...consoleErrors],
  };
}

// ---------------------------------------------------------------------------
// Path B — streaming: incremental worker tokens + streamPatch per chunk
// ---------------------------------------------------------------------------
async function runStream(chunks: string[]): Promise<BenchResult> {
  container.replaceChildren();
  const patcher = createStreamPatcher(container);
  const stream = startRenderWorkerStream({ lang: LANG, theme: THEME, gutterMode: 'none' });

  let lineOffset = 0;
  let batchCount = 0;
  let lastAppliedAt = 0;
  let lastPatchMs = 0;
  let lastReflowMs = 0;
  const batchWaiters: Array<{ target: number; resolve: () => void }> = [];

  stream.onBatch((batch) => {
    // This callback is exactly what useStreamCodeRender does on the main
    // thread: token batch -> row HTML -> patcher.applyBatch.
    const p0 = performance.now();
    const streamBatch = batchToRows(batch, 'none', undefined, lineOffset);
    lineOffset += streamBatch.stableRows.length;
    patcher.applyBatch(streamBatch);
    const p1 = performance.now();
    // Forced reflow so the number is comparable to legacy's domMs (which
    // includes layout of the replaced tree).
    forceReflow();
    const p2 = performance.now();
    lastPatchMs = p1 - p0;
    lastReflowMs = p2 - p1;
    batchCount += 1;
    lastAppliedAt = p2;
    for (let w = batchWaiters.length - 1; w >= 0; w -= 1) {
      if (batchCount >= batchWaiters[w].target) {
        batchWaiters[w].resolve();
        batchWaiters.splice(w, 1);
      }
    }
  });

  function waitForBatch(target: number): Promise<void> {
    if (batchCount >= target) return Promise.resolve();
    return new Promise((resolve) => {
      batchWaiters.push({ target, resolve });
    });
  }

  const churn = startChurnObserver(container);
  const frames = startFrameCounter();
  const perChunk: ChunkMetric[] = [];
  let code = '';

  for (let i = 0; i < chunks.length; i += 1) {
    code += chunks[i];
    const wait = waitForBatch(i + 1);
    const t0 = performance.now();
    stream.sendChunk(chunks[i]);
    await wait; // resolved synchronously inside the worker-message handler
    perChunk.push({
      i,
      codeLen: code.length,
      sendToAppliedMs: lastAppliedAt - t0,
      patchMs: lastPatchMs,
      reflowMs: lastReflowMs,
    });
  }
  frames.stop();
  churn.markClosePhase();
  // The final chunk leaves one incomplete line (no trailing newline); close()
  // flushes it as one extra trailing `tokens` batch before the final render
  // (streamHandler.runClose). That batch belongs to the close phase, not the
  // feed loop, so feed-phase batches are snapshotted here for the 1:1 check.
  const feedBatchCount = batchCount;

  // Close: converged full render in the worker + finalize swap. Measured
  // separately and EXCLUDED from the per-chunk numbers above. (In production
  // this fires after the 300ms debounce; the debounce itself is idle time
  // and not measured.)
  const c0 = performance.now();
  const finalHtml = await stream.close();
  const c1 = performance.now();
  patcher.finalize(finalHtml);
  forceReflow();
  const c2 = performance.now();
  churn.stop();

  // Correctness sanity (post-measurement): the converged stream output must
  // equal a single-shot render of the same full code.
  const singleShot = await startRenderWorkerHtml({
    id: `bench-verify-${Date.now()}`,
    code,
    lang: LANG,
    theme: THEME,
    gutterMode: 'none',
  }).promise;

  return {
    path: 'stream',
    fixture: `${chunks.length * 5}lines`,
    lineCount: chunks.length * 5,
    chunkCount: chunks.length,
    perChunk,
    totals: {
      sendToAppliedMs: perChunk.reduce((s, m) => s + (m.sendToAppliedMs ?? 0), 0),
      patchMs: perChunk.reduce((s, m) => s + (m.patchMs ?? 0), 0),
      reflowMs: perChunk.reduce((s, m) => s + (m.reflowMs ?? 0), 0),
    },
    frames: frames.stats(),
    churn: {
      feedAdded: churn.stats().feedAdded,
      feedRemoved: churn.stats().feedRemoved,
      mutationRecords: churn.stats().mutationRecords,
    },
    close: {
      workerMs: c1 - c0,
      domMs: c2 - c1,
      churnAdded: churn.stats().closeAdded,
      churnRemoved: churn.stats().closeRemoved,
    },
    sanity: {
      batchCount,
      batchPerChunk: feedBatchCount === chunks.length,
      closeFlushBatches: batchCount - feedBatchCount,
      finalMatchesSingleShot: canonicalize(finalHtml) === canonicalize(singleShot),
    },
    consoleErrors: [...consoleErrors],
  };
}

// ---------------------------------------------------------------------------
// Path C — markdown baseline: per delta, FULL accumulated reasoning text goes
// through startRenderWorkerHtml with lang:'markdown' (the exact mechanism
// MarkdownRenderer.vue uses for live thinking/working windows: full
// markdown-it parse + shiki fence highlighting in the worker, then a single
// innerHTML replace on the main thread). Fed SERIALLY so each delta's
// worker round-trip and DOM replace are individually attributable — this is
// the optimistic floor for the current path (production additionally wastes
// pool CPU on cancelled overlapping renders, which this bench does not
// reproduce; see report limitations).
// ---------------------------------------------------------------------------
const MD_LANG = 'markdown';
const MD_THEME = 'github-dark';

async function warmupMarkdownPool() {
  // Same steady-state philosophy as warmupLegacyPool: every pool worker gets
  // REALISTIC markdown (~55% of the fixture, so markdown-it + the shiki
  // fence highlighters and V8's optimizing tier are all warm), distinct
  // texts to dodge the completed-html cache.
  const base = REASONING_FULL_TEXT.slice(0, Math.floor(REASONING_FULL_TEXT.length * 0.55));
  const codes = Array.from(
    { length: 24 },
    (_, k) => `<!-- warmup variant ${k} -->\n${base}\n\nwarm tail ${k}\n`,
  );
  await Promise.all(
    codes.map(
      (code, k) =>
        startRenderWorkerHtml({
          id: `bench-md-warm-${k}`,
          code,
          lang: MD_LANG,
          theme: MD_THEME,
          gutterMode: 'none',
        }).promise,
    ),
  );
}

async function runMarkdown(deltas: string[]): Promise<BenchResult> {
  container.replaceChildren();
  const churn = startChurnObserver(container);
  const frames = startFrameCounter();
  const perChunk: ChunkMetric[] = [];
  const encoder = new TextEncoder();
  let code = '';
  let cumulativeBytes = 0;

  for (let i = 0; i < deltas.length; i += 1) {
    code += deltas[i];
    const bytesSent = encoder.encode(code).length;
    cumulativeBytes += bytesSent;
    const t0 = performance.now();
    const task = startRenderWorkerHtml({
      id: `bench-md-${i}-${Date.now()}`,
      code,
      lang: MD_LANG,
      theme: MD_THEME,
      gutterMode: 'none',
    });
    const html = await task.promise;
    const t1 = performance.now();
    container.innerHTML = html;
    forceReflow();
    const t2 = performance.now();
    perChunk.push({
      i,
      codeLen: code.length,
      bytesSent,
      workerMs: t1 - t0,
      domMs: t2 - t1,
    });
  }
  frames.stop();
  churn.stop();

  return {
    path: 'markdown',
    fixture: 'reasoning',
    lineCount: code.split('\n').length,
    chunkCount: deltas.length,
    perChunk,
    totals: {
      workerMs: perChunk.reduce((s, m) => s + (m.workerMs ?? 0), 0),
      domMs: perChunk.reduce((s, m) => s + (m.domMs ?? 0), 0),
      bytesSent: cumulativeBytes,
      // One full innerHTML replace per delta — the O(K) full-tree swaps that
      // a future streaming markdown path must eliminate.
      domReplaces: deltas.length,
    },
    frames: frames.stats(),
    churn: {
      feedAdded: churn.stats().feedAdded,
      feedRemoved: churn.stats().feedRemoved,
      mutationRecords: churn.stats().mutationRecords,
    },
    sanity: {
      // The last delta rendered the complete text; its HTML must equal a
      // fresh single-shot render of REASONING_FULL_TEXT. This is trivially
      // true here (same mechanism) but catches a broken accumulation loop.
      finalTextComplete: code === REASONING_FULL_TEXT,
    },
    consoleErrors: [...consoleErrors],
  };
}

// ---------------------------------------------------------------------------
// Path D — markdown-stream: uses useStreamingMarkdown composable to render
// only new/changed segments incrementally. Each delta is fed serially
// (awaiting the render callback + brief settling) so per-delta worker
// round-trip and DOM apply time are individually attributable — same
// serialized philosophy as the markdown baseline.
//
// Metrics tracked per delta:
//   streamWorkerMs   — per-delta worker render time (this delta's render calls)
//   streamDomMs      — time from text update to render settling
//   streamBytesThisDelta — bytes sent in render() calls triggered by this delta
//   streamStableInserts   — stable block DOM inserts this delta
//   streamCumulativeWorkerMs — cumulative worker render time up to this delta
//   streamCumulativeBytes    — cumulative bytes sent up to this delta
//
// Cumulative bytes sent to worker should drop from O(n·K/2) toward O(n) +
// tail re-renders, since stable segments are rendered once and cached.
// ---------------------------------------------------------------------------

async function warmupMarkdownStream() {
  // Steady-state warmup: stream ~55% of the fixture through the real
  // useStreamingMarkdown composable so the worker pool, segment cache, and
  // Vue watch machinery are all warm before the measured run.
  const warmContainer = document.createElement('div');
  const textRef = ref('');
  const render = async (markdown: string, theme: string) =>
    startRenderWorkerHtml({
      id: `bench-ms-warm-${Math.random()}`,
      code: markdown,
      lang: MD_LANG,
      theme,
      gutterMode: 'none',
    }).promise;
  const streamMd = useStreamingMarkdown({
    text: textRef,
    theme: ref(MD_THEME),
    enabled: ref(true),
    render,
    containerRef: ref(warmContainer),
  });
  const base = REASONING_FULL_TEXT.slice(0, Math.floor(REASONING_FULL_TEXT.length * 0.55));
  textRef.value = base;
  await new Promise((resolve) => setTimeout(resolve, 200));
  streamMd.dispose();
}

async function runMarkdownStream(deltas: string[]): Promise<BenchResult> {
  container.replaceChildren();
  const churn = startChurnObserver(container);
  const frames = startFrameCounter();
  const perChunk: ChunkMetric[] = [];
  const encoder = new TextEncoder();

  const textRef = ref('');
  let cumulativeWorkerMs = 0;
  let code = '';
  let cumulativeBytes = 0;

  // Detailed instrumentation
  let totalRenderCalls = 0;
  let totalTailRenders = 0;
  let totalStableRenders = 0;
  let cumulativeTailBytes = 0;
  let cumulativeStableBytes = 0;
  const tailSizes: number[] = [];
  const tailHtmlSizes: number[] = [];

  // Track render promises for the current delta so we can await them all.
  let currentDeltaRenders: Promise<unknown>[] = [];
  let currentDeltaRenderCount = 0;
  let currentDeltaTailRender = false;
  let currentDeltaStableRenderCount = 0;
  let currentDeltaTailTextLen = 0;
  let currentDeltaTailHtmlLen = 0;

  const render = async (markdown: string, theme: string): Promise<string> => {
    const bytes = encoder.encode(markdown).length;
    cumulativeBytes += bytes;
    totalRenderCalls++;
    currentDeltaRenderCount++;

    // Detect if this is a tail render: tail is always a suffix of current code.
    // We check if markdown is a suffix of code (the accumulated text).
    const isTail = code.length > 0 && code.endsWith(markdown);

    if (isTail) {
      totalTailRenders++;
      currentDeltaTailRender = true;
      currentDeltaTailTextLen = markdown.length;
      cumulativeTailBytes += bytes;
    } else {
      totalStableRenders++;
      currentDeltaStableRenderCount++;
      cumulativeStableBytes += bytes;
    }

    const t0 = performance.now();
    // Wrap the full render operation (worker promise + post-processing) in an
    // IIFE so we can push the COMPLETE promise — not just the raw worker
    // promise — to currentDeltaRenders. This ensures the bench loop awaits
    // full render() settlement (E11).
    const fullRender = (async () => {
      const html = await startRenderWorkerHtml({
        id: `bench-ms-${Date.now()}-${Math.random()}`,
        code: markdown,
        lang: MD_LANG,
        theme,
        gutterMode: 'none',
      }).promise;
      if (isTail) {
        currentDeltaTailHtmlLen = html.length;
        tailSizes.push(markdown.length);
        tailHtmlSizes.push(html.length);
      }
      const t1 = performance.now();
      cumulativeWorkerMs += t1 - t0;
      return html;
    })();
    currentDeltaRenders.push(fullRender);
    return fullRender;
  };

  const streamMd = useStreamingMarkdown({
    text: textRef,
    theme: ref(MD_THEME),
    enabled: ref(true),
    render,
    containerRef: ref(container),
  });

  for (let i = 0; i < deltas.length; i += 1) {
    code += deltas[i];
    const workerBefore = cumulativeWorkerMs;
    const mutationsBefore = churn.stats().mutationRecords;
    const bytesBefore = cumulativeBytes;
    currentDeltaRenders = [];
    currentDeltaRenderCount = 0;
    currentDeltaTailRender = false;
    currentDeltaStableRenderCount = 0;
    currentDeltaTailTextLen = 0;
    currentDeltaTailHtmlLen = 0;
    const t0 = performance.now();
    textRef.value = code;
    // Vue's watch fires synchronously and calls runLoop() (async, not awaited).
    // runLoop's body is scheduled as a microtask, and inside it render() calls
    // are also async. Yield enough times for the full chain to start.
    for (let y = 0; y < 20; y++) await Promise.resolve();
    // Now wait for all renders triggered by this text update.
    await Promise.all(currentDeltaRenders);
    const t1 = performance.now();
    const domMs = t1 - t0;
    const workerMsThisDelta = cumulativeWorkerMs - workerBefore;
    const mutationsAfter = churn.stats().mutationRecords;
    // streamBytesThisDelta: bytes actually sent in render() calls for this
    // delta, derived from the render callback's cumulativeBytes delta (E12).
    const streamBytesThisDelta = cumulativeBytes - bytesBefore;
    perChunk.push({
      i,
      codeLen: code.length,
      bytesSent: streamBytesThisDelta,
      streamWorkerMs: workerMsThisDelta,
      streamDomMs: domMs,
      streamBytesThisDelta,
      streamStableInserts: mutationsAfter - mutationsBefore > 0 ? 1 : 0,
      streamTailInserts: 0,
      streamCumulativeWorkerMs: cumulativeWorkerMs,
      streamCumulativeBytes: cumulativeBytes,
      // Cost breakdown
      streamTailTextLen: currentDeltaTailTextLen,
      streamTailHtmlLen: currentDeltaTailHtmlLen,
      streamRenderCount: currentDeltaRenderCount,
      streamStableRenderCount: currentDeltaStableRenderCount,
      streamTailRenderCount: currentDeltaTailRender ? 1 : 0,
    });
  }

  streamMd.dispose();
  frames.stop();
  churn.stop();

  const totalDomMs = perChunk.reduce((s, m) => s + (m.streamDomMs ?? 0), 0);
  const totalStableInserts = perChunk.reduce((s, m) => s + (m.streamStableInserts ?? 0), 0);

  const result: BenchResult = {
    path: 'markdown-stream',
    fixture: 'reasoning',
    lineCount: code.split('\n').length,
    chunkCount: deltas.length,
    perChunk,
    totals: {
      workerMs: cumulativeWorkerMs,
      domMs: totalDomMs,
      bytesSent: cumulativeBytes,
      domReplaces: 0,
      domInserts: totalStableInserts,
    },
    frames: frames.stats(),
    churn: {
      feedAdded: churn.stats().feedAdded,
      feedRemoved: churn.stats().feedRemoved,
      mutationRecords: churn.stats().mutationRecords,
    },
    sanity: {
      finalTextComplete: code === REASONING_FULL_TEXT,
    },
    consoleErrors: [...consoleErrors],
  };

  // Add detailed instrumentation to totals
  result.totals.totalRenderCalls = totalRenderCalls;
  result.totals.totalTailRenders = totalTailRenders;
  result.totals.totalStableRenders = totalStableRenders;
  result.totals.cumulativeTailBytes = cumulativeTailBytes;
  result.totals.cumulativeStableBytes = cumulativeStableBytes;
  result.totals.avgTailSize = tailSizes.length > 0 ? tailSizes.reduce((a, b) => a + b, 0) / tailSizes.length : 0;
  result.totals.avgTailHtmlSize = tailHtmlSizes.length > 0 ? tailHtmlSizes.reduce((a, b) => a + b, 0) / tailHtmlSizes.length : 0;

  return result;
}

// ---------------------------------------------------------------------------
// Boot: run one (path, fixture) per page load, chosen via query params.
// ---------------------------------------------------------------------------
async function main() {
  const params = new URLSearchParams(window.location.search);
  const path = params.get('path') ?? 'stream';
  const sizeMultiplier = parseInt(params.get('size') ?? '1', 10);

  // Scaled fixtures: markdown and markdown-stream at 2x, 4x, 8x sizes
  if (sizeMultiplier > 1) {
    const scaledText = buildScaledReasoning(sizeMultiplier);
    const scaledDeltas = buildScaledDeltas(scaledText);
    const fixtureLabel = `reasoning-${sizeMultiplier}x`;

    if (path === 'markdown') {
      statusEl.textContent = `stream-bench | path=markdown size=${sizeMultiplier}x deltas=${scaledDeltas.length} | warming up…`;
      await warmupMarkdownPool();
      statusEl.textContent = `stream-bench | path=markdown size=${sizeMultiplier}x | running…`;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await runMarkdown(scaledDeltas);
      result.fixture = fixtureLabel;
      statusEl.textContent = `stream-bench | path=markdown size=${sizeMultiplier}x | done`;
      Object.assign(window, { __benchResult: result, __benchDone: true });
      return;
    }

    if (path === 'markdown-stream') {
      statusEl.textContent = `stream-bench | path=markdown-stream size=${sizeMultiplier}x deltas=${scaledDeltas.length} | warming up…`;
      await warmupMarkdownStream();
      statusEl.textContent = `stream-bench | path=markdown-stream size=${sizeMultiplier}x | running…`;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await runMarkdownStream(scaledDeltas);
      result.fixture = fixtureLabel;
      statusEl.textContent = `stream-bench | path=markdown-stream size=${sizeMultiplier}x | done`;
      Object.assign(window, { __benchResult: result, __benchDone: true });
      return;
    }

    if (path === 'markdown-stream-detailed') {
      statusEl.textContent = `stream-bench | path=markdown-stream-detailed size=${sizeMultiplier}x deltas=${scaledDeltas.length} | warming up…`;
      await warmupMarkdownStream();
      statusEl.textContent = `stream-bench | path=markdown-stream-detailed size=${sizeMultiplier}x | running…`;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await runMarkdownStream(scaledDeltas);
      result.path = 'markdown-stream-detailed';
      result.fixture = fixtureLabel;
      statusEl.textContent = `stream-bench | path=markdown-stream-detailed size=${sizeMultiplier}x | done`;
      Object.assign(window, { __benchResult: result, __benchDone: true });
      return;
    }
  }

  // 1x fixtures (default)
  if (path === 'markdown') {
    statusEl.textContent = `stream-bench | path=markdown deltas=${REASONING_DELTAS.length} | warming up…`;
    await warmupMarkdownPool();
    statusEl.textContent = 'stream-bench | path=markdown | running…';
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await runMarkdown(REASONING_DELTAS);
    statusEl.textContent = 'stream-bench | path=markdown | done';
    Object.assign(window, { __benchResult: result, __benchDone: true });
    return;
  }

  if (path === 'markdown-stream') {
    statusEl.textContent = `stream-bench | path=markdown-stream deltas=${REASONING_DELTAS.length} | warming up…`;
    await warmupMarkdownStream();
    statusEl.textContent = 'stream-bench | path=markdown-stream | running…';
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await runMarkdownStream(REASONING_DELTAS);
    statusEl.textContent = 'stream-bench | path=markdown-stream | done';
    Object.assign(window, { __benchResult: result, __benchDone: true });
    return;
  }

  if (path === 'markdown-stream-detailed') {
    statusEl.textContent = `stream-bench | path=markdown-stream-detailed deltas=${REASONING_DELTAS.length} | warming up…`;
    await warmupMarkdownStream();
    statusEl.textContent = 'stream-bench | path=markdown-stream-detailed | running…';
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await runMarkdownStream(REASONING_DELTAS);
    result.path = 'markdown-stream-detailed';
    statusEl.textContent = 'stream-bench | path=markdown-stream-detailed | done';
    Object.assign(window, { __benchResult: result, __benchDone: true });
    return;
  }

  const fixture = params.get('fixture') ?? 'big';
  const lines = fixture === 'small' ? BIG_LINES.slice(0, 40) : BIG_LINES;
  const chunks = chunkLines(lines, 5);

  statusEl.textContent = `stream-bench | path=${path} fixture=${fixture} chunks=${chunks.length} | warming up…`;
  if (path === 'legacy') await warmupLegacyPool();
  else await warmupStreamWorker();

  statusEl.textContent = `stream-bench | path=${path} fixture=${fixture} | running…`;
  // Let warmup microtasks/rendering fully settle before the measured run.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const result = path === 'legacy' ? await runLegacy(chunks) : await runStream(chunks);
  result.fixture = fixture;
  result.lineCount = lines.length;

  statusEl.textContent = `stream-bench | path=${path} fixture=${fixture} | done`;
  Object.assign(window, { __benchResult: result, __benchDone: true });
}

main().catch((err) => {
  consoleErrors.push(`bench fatal: ${String(err?.stack ?? err)}`);
  Object.assign(window, {
    __benchResult: { fatal: String(err?.stack ?? err), consoleErrors },
    __benchDone: true,
  });
});
