#!/usr/bin/env node
/**
 * Stream bench runner — empirical benchmark of the streaming highlight path
 * vs the legacy non-streaming path (branch feat/shiki-v4).
 *
 * Drives app/dev/stream-bench.html in a real browser with the real worker(s).
 * Each (path, fixture) combination runs 3 times, each in a FRESH page load;
 * the page self-executes the benchmark and exposes window.__benchResult.
 *
 * Combinations (default scenario "code"):
 *   path    = legacy | stream
 *   fixture = big (300 lines / 60 chunks) | small (40 lines / 8 chunks)
 *
 * Scenario "markdown" (growing-markdown baseline):
 *   path    = markdown (full accumulated text -> worker full parse per delta)
 *   fixture = reasoning (app/dev/fixtures/reasoning-sample.ts, ~800-1500 deltas)
 *   Output: /tmp/stream-bench-markdown/ with per-delta p50/p95 by
 *   fixture-third, cumulative worker ms / bytes sent, DOM full-replace count.
 *   Smoke assertions fail loudly on missing/zero metric fields.
 *
 * Usage:
 *   node scripts/qa/stream-bench.mjs [baseUrl]
 *   node scripts/qa/stream-bench.mjs --scenario markdown [baseUrl]
 *   STREAM_BENCH_URL=http://127.0.0.1:5173 node scripts/qa/stream-bench.mjs
 *
 * Raw per-run JSON + aggregate summary are written to /tmp/stream-bench/
 * (code) or /tmp/stream-bench-markdown/ (markdown).
 * Exits non-zero on harness failure or sanity-check failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Playwright resolution (repo-root node_modules ONLY — the pinned dev
// dependency. No npx cache, no global install, no hardcoded paths; the
// browser is the explicitly provisioned chromium from `pnpm exec playwright
// install chromium`).
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PW_PKG_PATH = path.join(REPO_ROOT, 'node_modules/playwright/package.json');
if (!fs.existsSync(PW_PKG_PATH)) {
  throw new Error(`playwright not found at ${PW_PKG_PATH} — run pnpm install first`);
}
const playwrightVersion = JSON.parse(fs.readFileSync(PW_PKG_PATH, 'utf8')).version;
const playwright = await import(path.join(REPO_ROOT, 'node_modules/playwright/index.mjs')).catch(
  () => import(path.join(REPO_ROOT, 'node_modules/playwright/index.js')),
);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const chromiumPath = chromium.executablePath();
if (!fs.existsSync(chromiumPath)) {
  throw new Error(
    `No chromium binary found at ${chromiumPath} — run "pnpm exec playwright install chromium" first`,
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let scenario = 'code';
  let baseUrl;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') {
      scenario = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--scenario=')) {
      scenario = arg.slice('--scenario='.length);
    } else if (!arg.startsWith('--')) {
      baseUrl = arg;
    }
  }
  if (!['code', 'markdown', 'markdown-stream', 'scaling', 'detailed'].includes(scenario)) {
    throw new Error(`unknown scenario "${scenario}" (expected code|markdown|markdown-stream|scaling|detailed)`);
  }
  return { scenario, baseUrl };
}

const { scenario: SCENARIO, baseUrl: argUrl } = parseArgs(process.argv.slice(2));
const OUT_DIR =
  SCENARIO === 'markdown'
    ? '/tmp/stream-bench-markdown'
    : SCENARIO === 'markdown-stream'
      ? '/tmp/stream-bench-markdown-stream'
      : SCENARIO === 'scaling'
        ? '/tmp/stream-bench-scaling'
        : SCENARIO === 'detailed'
          ? '/tmp/stream-bench-detailed'
          : '/tmp/stream-bench';
const BASE_URL = argUrl || process.env.STREAM_BENCH_URL || 'http://127.0.0.1:5173';
const BENCH_URL = `${BASE_URL}/dev/stream-bench.html`;
const RUNS = 3;
// Ordered (fixture, path) combos, preserving the code scenario's original
// iteration order (fixture outer, path inner).
const COMBOS =
  SCENARIO === 'markdown'
    ? [{ fixture: 'reasoning', benchPath: 'markdown' }]
    : SCENARIO === 'markdown-stream'
      ? [{ fixture: 'reasoning', benchPath: 'markdown-stream' }]
      : SCENARIO === 'scaling'
        ? [1, 2, 4, 8].flatMap((size) => {
            // The page returns fixture 'reasoning' for size 1 (the unscaled
            // default path); only 2x/4x/8x are labeled 'reasoning-Nx'.
            const fixture = size === 1 ? 'reasoning' : `reasoning-${size}x`;
            return [
              { fixture, benchPath: 'markdown', size },
              { fixture, benchPath: 'markdown-stream', size },
            ];
          })
        : SCENARIO === 'detailed'
          ? [{ fixture: 'reasoning-1x', benchPath: 'markdown-stream-detailed', size: 1 }]
          : ['big', 'small'].flatMap((fixture) =>
              ['legacy', 'stream'].map((benchPath) => ({ fixture, benchPath })),
            );

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Known baseline cumulative bytes from the markdown scenario (3 runs median).
// Used for sanity-checking the streaming path.
const REASONING_BASELINE_BYTES = 3236149;

function waitForServer(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error(`bad status ${res.statusCode}`));
        else setTimeout(check, 400);
      });
      // If the server accepts the connection but never responds, destroy the
      // request so the retry/deadline logic can run instead of hanging forever.
      req.setTimeout(5000, () => {
        req.destroy();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`${url} not ready`));
        else setTimeout(check, 400);
      });
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[bench] playwright ${playwrightVersion}`);
  console.log(`[bench] chromium: ${chromiumPath}`);
  console.log(`[bench] page: ${BENCH_URL}`);

  await waitForServer(BENCH_URL);
  console.log('[bench] dev server reachable');

  // Same compositor workaround as the QA runners: chromium-1223 under
  // playwright 1.62.1 can stall rendering without these flags.
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  });
  const chromiumVersion = await browser.version();
  console.log(`[bench] chromium version: ${chromiumVersion}`);

  const allRuns = [];
  const sanityFailures = [];

  try {
    for (const { fixture, benchPath, size } of COMBOS) {
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `${benchPath}/${fixture}/run${run}`;
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
        });
        const pageErrors = [];
        try {
          // newPage INSIDE the cleanup try: a failed page creation must still
          // close the context — no leak.
          const page = await context.newPage();
          page.on('pageerror', (err) => pageErrors.push(`PAGE_ERROR: ${err.message}`));
          const sizeParam = size ? `&size=${size}` : '';
          const url = `${BENCH_URL}?path=${benchPath}&fixture=${fixture}${sizeParam}&run=${run}`;
          await page.goto(url, { waitUntil: 'load' });
          await page.waitForFunction(() => window.__benchDone === true, null, {
            timeout: 180000,
          });
          const result = await page.evaluate(() => window.__benchResult);
          result.runIndex = run;
          result.pageErrors = pageErrors;
          allRuns.push(result);
          fs.writeFileSync(
            path.join(OUT_DIR, `run-${benchPath}-${fixture}-${run}.json`),
            JSON.stringify(result, null, 2),
          );
          if (result.fatal) {
            sanityFailures.push(`${label}: fatal ${result.fatal}`);
          }
          if (benchPath === 'stream') {
            if (result.sanity?.batchPerChunk !== true) {
              sanityFailures.push(
                `${label}: batchPerChunk false (batches=${result.sanity?.batchCount}, chunks=${result.chunkCount})`,
              );
            }
            if (result.sanity?.finalMatchesSingleShot !== true) {
              sanityFailures.push(`${label}: final stream HTML != single-shot HTML`);
            }
          }
          if (benchPath === 'markdown') {
            // Smoke assertions: every metric field the baseline report relies
            // on must be present and non-zero. Any failure here means the
            // HARNESS is broken — fail loudly instead of writing a silently
            // empty baseline.
            const t = result.totals ?? {};
            if (!(t.workerMs > 0)) sanityFailures.push(`${label}: totals.workerMs missing/zero (${t.workerMs})`);
            if (!(t.domMs > 0)) sanityFailures.push(`${label}: totals.domMs missing/zero (${t.domMs})`);
            if (!(t.bytesSent > 0)) sanityFailures.push(`${label}: totals.bytesSent missing/zero (${t.bytesSent})`);
            if (!(t.domReplaces > 0)) {
              sanityFailures.push(`${label}: totals.domReplaces missing/zero (${t.domReplaces})`);
            } else if (t.domReplaces !== result.chunkCount) {
              sanityFailures.push(
                `${label}: domReplaces ${t.domReplaces} != chunkCount ${result.chunkCount} (expected one full replace per delta)`,
              );
            }
            if (result.sanity?.finalTextComplete !== true) {
              sanityFailures.push(`${label}: accumulated text != REASONING_FULL_TEXT (broken delta loop)`);
            }
            const perChunk = result.perChunk ?? [];
            // The 800-1500 sanity bound applies to the 1x reasoning fixture only.
            // Scaled fixtures (2x, 4x, 8x) produce proportionally more deltas,
            // so skip the bound check for non-1x scaling runs.
            const chunkCountOk = size
              ? perChunk.length === result.chunkCount
              : perChunk.length === result.chunkCount &&
                result.chunkCount >= 800 &&
                result.chunkCount <= 1500;
            if (!chunkCountOk) {
              sanityFailures.push(
                `${label}: perChunk length ${perChunk.length} / chunkCount ${result.chunkCount} invalid (expected 800-1500 deltas for 1x, or matching perChunk for scaled)`,
              );
            }
            const badChunk = perChunk.findIndex(
              (m) =>
                !(typeof m.workerMs === 'number' && Number.isFinite(m.workerMs) && m.workerMs > 0) ||
                !(typeof m.domMs === 'number' && Number.isFinite(m.domMs) && m.domMs >= 0) ||
                !(typeof m.bytesSent === 'number' && m.bytesSent > 0) ||
                !(typeof m.codeLen === 'number' && m.codeLen > 0),
            );
            if (badChunk !== -1) {
              sanityFailures.push(`${label}: perChunk[${badChunk}] has missing/zero metric fields`);
            }
            const nonMonotonic = perChunk.findIndex((m, i) => i > 0 && m.bytesSent <= perChunk[i - 1].bytesSent);
            if (nonMonotonic !== -1) {
              sanityFailures.push(`${label}: bytesSent not strictly increasing at delta ${nonMonotonic}`);
            }
          }
          if (benchPath === 'markdown-stream') {
            // Smoke assertions for the streaming markdown path:
            const t = result.totals ?? {};
            if (!(t.workerMs > 0)) sanityFailures.push(`${label}: totals.workerMs missing/zero (${t.workerMs})`);
            if (!(t.domMs >= 0)) sanityFailures.push(`${label}: totals.domMs missing (${t.domMs})`);
            if (!(t.bytesSent > 0)) sanityFailures.push(`${label}: totals.bytesSent missing/zero (${t.bytesSent})`);
            if (result.sanity?.finalTextComplete !== true) {
              sanityFailures.push(`${label}: accumulated text != REASONING_FULL_TEXT (broken delta loop)`);
            }
            const perChunk = result.perChunk ?? [];
            // The 800-1500 sanity bound applies to the 1x reasoning fixture only.
            // Scaled fixtures (2x, 4x, 8x) produce proportionally more deltas,
            // so skip the bound check for non-1x scaling runs.
            const msChunkCountOk = size
              ? perChunk.length === result.chunkCount
              : perChunk.length === result.chunkCount &&
                result.chunkCount >= 800 &&
                result.chunkCount <= 1500;
            if (!msChunkCountOk) {
              sanityFailures.push(
                `${label}: perChunk length ${perChunk.length} / chunkCount ${result.chunkCount} invalid (expected 800-1500 deltas for 1x, or matching perChunk for scaled)`,
              );
            }
            const badChunk = perChunk.findIndex(
              (m) =>
                !(typeof m.streamWorkerMs === 'number' && Number.isFinite(m.streamWorkerMs) && m.streamWorkerMs >= 0) ||
                !(typeof m.streamDomMs === 'number' && Number.isFinite(m.streamDomMs) && m.streamDomMs >= 0) ||
                !(typeof m.bytesSent === 'number' && m.bytesSent > 0) ||
                !(typeof m.codeLen === 'number' && m.codeLen > 0),
            );
            if (badChunk !== -1) {
              sanityFailures.push(`${label}: perChunk[${badChunk}] has missing/zero metric fields`);
            }
            // Sanity: cumulative bytes should be dramatically lower than baseline.
            // Baseline scales O(n·K) i.e. quadratically with size; streaming
            // scales linearly, so the 50%-of-baseline bound holds at every scale
            // (1x streaming is ~11% of baseline) while a full-render regression
            // (~100% of baseline) fails.
            const scaledBaseline = REASONING_BASELINE_BYTES * (size ?? 1) ** 2;
            if (t.bytesSent >= scaledBaseline * 0.5) {
              sanityFailures.push(
                `${label}: cumulative bytes ${t.bytesSent} too close to baseline ${scaledBaseline} (expected dramatic reduction)`,
              );
            }
          }
          if ((result.consoleErrors ?? []).length > 0 || pageErrors.length > 0) {
            sanityFailures.push(
              `${label}: console/page errors: ${[...(result.consoleErrors ?? []), ...pageErrors].join(' | ')}`,
            );
          }
          const tot = Object.entries(result.totals ?? {})
            .map(([k, v]) => `${k}=${round(v, 1)}${k.endsWith('Ms') ? 'ms' : ''}`)
            .join(' ');
          console.log(`[bench] ${label} done — ${tot}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  // -------------------------------------------------------------------------
  // Aggregate: per (path, fixture), per-run per-chunk stats, then median
  // across runs. Also pool all per-chunk samples across runs for p95.
  // -------------------------------------------------------------------------
  const summary = {
    generatedAt: new Date().toISOString(),
    scenario: SCENARIO,
    baseUrl: BENCH_URL,
    playwright: playwrightVersion,
    chromium: chromiumPath,
    chromiumVersion,
    runs: RUNS,
    combos: {},
  };

  for (const { fixture, benchPath } of COMBOS) {
    const runs = allRuns.filter((r) => r.path === benchPath && r.fixture === fixture);
    if (runs.length === 0) continue;

    const latencyKey =
      benchPath === 'stream'
        ? 'sendToAppliedMs'
        : benchPath === 'markdown-stream' || benchPath === 'markdown-stream-detailed'
          ? 'streamWorkerMs'
          : 'workerMs';
    const domKey =
      benchPath === 'stream'
        ? 'patchMs'
        : benchPath === 'markdown-stream' || benchPath === 'markdown-stream-detailed'
          ? 'streamDomMs'
          : 'domMs';

    // Per-run per-chunk aggregates
    const perRunMean = runs.map((r) => mean(r.perChunk.map((m) => m[latencyKey])));
    const perRunP95 = runs.map((r) => percentile(r.perChunk.map((m) => m[latencyKey]), 95));
    const domPerRunMean = runs.map((r) => mean(r.perChunk.map((m) => m[domKey])));
    const domPerRunP95 = runs.map((r) => percentile(r.perChunk.map((m) => m[domKey]), 95));

    // Pooled samples across the 3 runs
    const pooledLatency = runs.flatMap((r) => r.perChunk.map((m) => m[latencyKey]));
    const pooledDom = runs.flatMap((r) => r.perChunk.map((m) => m[domKey]));

    // Growth shape: latency of first third vs last third of chunks (pooled)
    const third = Math.floor(runs[0].chunkCount / 3);
    const firstThird = runs.flatMap((r) => r.perChunk.slice(0, third).map((m) => m[latencyKey]));
    const lastThird = runs.flatMap((r) => r.perChunk.slice(-third).map((m) => m[latencyKey]));

    // Per-chunk metrics use path-specific names, but totals always store
    // cumulative worker/dom under workerMs/domMs (sendToAppliedMs/patchMs for
    // the code stream path) — the totals lookup must not reuse the per-chunk key.
    const totalsWorkerKey = benchPath === 'stream' ? 'sendToAppliedMs' : 'workerMs';
    const totalsDomKey = benchPath === 'stream' ? 'patchMs' : 'domMs';

    summary.combos[`${benchPath}/${fixture}`] = {
      runs: runs.length,
      chunkCount: runs[0].chunkCount,
      lineCount: runs[0].lineCount,
      latencyMetric: latencyKey,
      latency: {
        meanOfRunMeans: round(median(perRunMean)),
        medianOfRunP95: round(median(perRunP95)),
        pooledMean: round(mean(pooledLatency)),
        pooledP50: round(percentile(pooledLatency, 50)),
        pooledP95: round(percentile(pooledLatency, 95)),
        firstThirdMean: round(mean(firstThird)),
        lastThirdMean: round(mean(lastThird)),
      },
      domMetric: domKey,
      domMainThread: {
        meanOfRunMeans: round(median(domPerRunMean)),
        medianOfRunP95: round(median(domPerRunP95)),
        pooledMean: round(mean(pooledDom)),
        pooledP95: round(percentile(pooledDom, 95)),
        cumulativeMedianMs: round(median(runs.map((r) => r.totals[totalsDomKey] ?? 0)), 1),
      },
      cumulative: {
        roundTripMedianMs: round(median(runs.map((r) => r.totals[totalsWorkerKey] ?? 0)), 1),
        ...(benchPath === 'stream'
          ? { reflowMedianMs: round(median(runs.map((r) => r.totals.reflowMs ?? 0)), 1) }
          : {}),
      },
      frames: {
        deliveredMedian: median(runs.map((r) => r.frames.frames)),
        longestGapMedianMs: round(median(runs.map((r) => r.frames.maxGapMs)), 1),
        longestGapMaxMs: round(Math.max(...runs.map((r) => r.frames.maxGapMs)), 1),
        feedElapsedMedianMs: round(median(runs.map((r) => r.frames.elapsedMs)), 1),
      },
      churn: {
        nodesAddedMedian: median(runs.map((r) => r.churn.feedAdded)),
        nodesRemovedMedian: median(runs.map((r) => r.churn.feedRemoved)),
        mutationRecordsMedian: median(runs.map((r) => r.churn.mutationRecords)),
      },
      ...(benchPath === 'stream'
        ? {
            closeExcluded: {
              workerMsMedian: round(median(runs.map((r) => r.close.workerMs)), 1),
              domMsMedian: round(median(runs.map((r) => r.close.domMs)), 1),
              churnAddedMedian: median(runs.map((r) => r.close.churnAdded)),
              churnRemovedMedian: median(runs.map((r) => r.close.churnRemoved)),
            },
          }
        : {}),
      ...(benchPath === 'markdown'
        ? {
            // Baseline-specific: per-delta p50/p95 within each fixture third
            // (pooled across runs), plus the O(n^2) evidence totals.
            perThird: [0, 1, 2].map((ti) => {
              const lo = ti * third;
              const hi = ti === 2 ? runs[0].chunkCount : lo + third;
              const lat = runs.flatMap((r) => r.perChunk.slice(lo, hi).map((m) => m[latencyKey]));
              const dom = runs.flatMap((r) => r.perChunk.slice(lo, hi).map((m) => m[domKey]));
              return {
                third: ['first', 'middle', 'last'][ti],
                deltaRange: [lo, hi - 1],
                workerP50: round(percentile(lat, 50)),
                workerP95: round(percentile(lat, 95)),
                workerMean: round(mean(lat)),
                domP50: round(percentile(dom, 50)),
                domP95: round(percentile(dom, 95)),
                domMean: round(mean(dom)),
              };
            }),
            markdown: {
              finalChars: runs[0].perChunk[runs[0].perChunk.length - 1].codeLen,
              finalUtf8Bytes: runs[0].perChunk[runs[0].perChunk.length - 1].bytesSent,
              cumulativeBytesSentMedian: median(runs.map((r) => r.totals.bytesSent)),
              domFullReplaceCountMedian: median(runs.map((r) => r.totals.domReplaces)),
              cumulativeWorkerMsMedian: round(median(runs.map((r) => r.totals.workerMs)), 1),
              cumulativeDomMsMedian: round(median(runs.map((r) => r.totals.domMs)), 1),
            },
          }
        : {}),
      ...(benchPath === 'markdown-stream'
        ? {
            // Streaming markdown specific: per-delta p50/p95 by third, plus
            // the key comparison metrics (cumulative bytes, insert counts).
            perThird: [0, 1, 2].map((ti) => {
              const lo = ti * third;
              const hi = ti === 2 ? runs[0].chunkCount : lo + third;
              const lat = runs.flatMap((r) => r.perChunk.slice(lo, hi).map((m) => m[latencyKey]));
              const dom = runs.flatMap((r) => r.perChunk.slice(lo, hi).map((m) => m[domKey]));
              return {
                third: ['first', 'middle', 'last'][ti],
                deltaRange: [lo, hi - 1],
                workerP50: round(percentile(lat, 50)),
                workerP95: round(percentile(lat, 95)),
                workerMean: round(mean(lat)),
                domP50: round(percentile(dom, 50)),
                domP95: round(percentile(dom, 95)),
                domMean: round(mean(dom)),
              };
            }),
            markdownStream: {
              finalChars: runs[0].perChunk[runs[0].perChunk.length - 1].codeLen,
              cumulativeBytesSentMedian: median(runs.map((r) => r.totals.bytesSent)),
              domInsertCountMedian: median(runs.map((r) => r.totals.domInserts ?? 0)),
              cumulativeWorkerMsMedian: round(median(runs.map((r) => r.totals.workerMs)), 1),
              cumulativeDomMsMedian: round(median(runs.map((r) => r.totals.domMs)), 1),
            },
          }
        : {}),
      sanity: runs.map((r) => r.sanity),
    };

    // Growth sanity for the baseline: per-delta latency MUST grow with text
    // size (full re-parse per delta). A flat curve means the harness is
    // accidentally serving cached HTML or skipping renders.
    if (benchPath === 'markdown' && !(mean(lastThird) > mean(firstThird))) {
      sanityFailures.push(
        `markdown/${fixture}: last-third worker latency ${round(mean(lastThird))}ms not greater than first-third ${round(mean(firstThird))}ms — harness bug suspected`,
      );
    }
  }

  summary.sanityFailures = sanityFailures;
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  // -------------------------------------------------------------------------
  // Console table
  // -------------------------------------------------------------------------
  console.log('\n===== AGGREGATE (median of 3 fresh-page runs) =====');
  for (const [combo, s] of Object.entries(summary.combos)) {
    console.log(`\n--- ${combo} (${s.lineCount} lines, ${s.chunkCount} chunks) ---`);
    console.log(`  per-chunk latency [${s.latencyMetric}]: mean=${s.latency.meanOfRunMeans}ms p95=${s.latency.medianOfRunP95}ms (first-third=${s.latency.firstThirdMean}ms, last-third=${s.latency.lastThirdMean}ms)`);
    console.log(`  per-chunk DOM      [${s.domMetric}]: mean=${s.domMainThread.meanOfRunMeans}ms p95=${s.domMainThread.medianOfRunP95}ms cumulative=${s.domMainThread.cumulativeMedianMs}ms`);
    console.log(`  cumulative round-trip: ${s.cumulative.roundTripMedianMs}ms`);
    console.log(`  frames: delivered=${s.frames.deliveredMedian} longestGap=${s.frames.longestGapMedianMs}ms (max ${s.frames.longestGapMaxMs}ms) feedElapsed=${s.frames.feedElapsedMedianMs}ms`);
    console.log(`  churn: added=${s.churn.nodesAddedMedian} removed=${s.churn.nodesRemovedMedian} records=${s.churn.mutationRecordsMedian}`);
    if (s.closeExcluded) {
      console.log(`  close (EXCLUDED from per-chunk): worker=${s.closeExcluded.workerMsMedian}ms dom=${s.closeExcluded.domMsMedian}ms churn +${s.closeExcluded.churnAddedMedian}/-${s.closeExcluded.churnRemovedMedian}`);
    }
    if (s.markdown) {
      console.log(`  markdown baseline: final=${s.markdown.finalChars}chars/${s.markdown.finalUtf8Bytes}B cumulativeBytes=${s.markdown.cumulativeBytesSentMedian} domFullReplaces=${s.markdown.domFullReplaceCountMedian} cumulativeWorker=${s.markdown.cumulativeWorkerMsMedian}ms cumulativeDom=${s.markdown.cumulativeDomMsMedian}ms`);
      for (const t of s.perThird) {
        console.log(`    ${t.third} third (deltas ${t.deltaRange[0]}-${t.deltaRange[1]}): worker p50=${t.workerP50}ms p95=${t.workerP95}ms | dom p50=${t.domP50}ms p95=${t.domP95}ms`);
      }
    }
    if (s.markdownStream) {
      console.log(`  markdown-stream: final=${s.markdownStream.finalChars}chars cumulativeBytes=${s.markdownStream.cumulativeBytesSentMedian} domInserts=${s.markdownStream.domInsertCountMedian} cumulativeWorker=${s.markdownStream.cumulativeWorkerMsMedian}ms cumulativeDom=${s.markdownStream.cumulativeDomMsMedian}ms`);
      for (const t of s.perThird) {
        console.log(`    ${t.third} third (deltas ${t.deltaRange[0]}-${t.deltaRange[1]}): worker p50=${t.workerP50}ms p95=${t.workerP95}ms | dom p50=${t.domP50}ms p95=${t.domP95}ms`);
      }
    }
  }

  console.log(`\n[bench] raw runs + summary: ${OUT_DIR}`);
  if (sanityFailures.length > 0) {
    console.log('[bench] SANITY FAILURES:');
    for (const f of sanityFailures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('[bench] all sanity checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
