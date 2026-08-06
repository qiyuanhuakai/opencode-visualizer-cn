#!/usr/bin/env node
/**
 * Stream bench runner — empirical benchmark of the streaming highlight path
 * vs the legacy non-streaming path (branch feat/shiki-v4).
 *
 * Drives app/dev/stream-bench.html in a real browser with the real worker(s).
 * Each (path, fixture) combination runs 3 times, each in a FRESH page load;
 * the page self-executes the benchmark and exposes window.__benchResult.
 *
 * Combinations:
 *   path    = legacy | stream
 *   fixture = big (300 lines / 60 chunks) | small (40 lines / 8 chunks)
 *
 * Usage:
 *   node scripts/qa/stream-bench.mjs [baseUrl]
 *   STREAM_BENCH_URL=http://127.0.0.1:5173 node scripts/qa/stream-bench.mjs
 *
 * Raw per-run JSON + aggregate summary are written to /tmp/stream-bench/.
 * Exits non-zero on harness failure or sanity-check failure.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Playwright resolution (same approach as stream-driver-check.mjs)
// ---------------------------------------------------------------------------
function resolvePlaywrightDir() {
  const candidates = [];
  const npxRoot = path.join(os.homedir(), '.npm/_npx');
  if (fs.existsSync(npxRoot)) {
    for (const dir of fs.readdirSync(npxRoot)) {
      const pkgDir = path.join(npxRoot, dir, 'node_modules/playwright');
      const pkgJson = path.join(pkgDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        try {
          const version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
          candidates.push({ pkgDir, version });
        } catch {
          /* ignore */
        }
      }
    }
  }
  const globalDir =
    '/home/qiyuaner/.nvm/versions/node/v22.22.2/lib/node_modules/@playwright/cli/node_modules/playwright';
  if (fs.existsSync(path.join(globalDir, 'package.json'))) {
    try {
      const version = JSON.parse(
        fs.readFileSync(path.join(globalDir, 'package.json'), 'utf8'),
      ).version;
      candidates.push({ pkgDir: globalDir, version });
    } catch {
      /* ignore */
    }
  }
  if (candidates.length === 0) {
    throw new Error('playwright not found in npx cache or global @playwright/cli');
  }
  candidates.sort((a, b) => {
    if (a.version === '1.62.1') return -1;
    if (b.version === '1.62.1') return 1;
    return b.version.localeCompare(a.version, undefined, { numeric: true });
  });
  return candidates[0];
}

function resolveChromiumExecutable(chromium) {
  const browsersPath = path.join(os.homedir(), '.cache/ms-playwright');
  const preferred = chromium.executablePath();
  if (fs.existsSync(preferred)) return preferred;
  const revisions = fs
    .readdirSync(browsersPath)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const rev of revisions) {
    const bin = path.join(browsersPath, rev, 'chrome-linux64/chrome');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error(`No chromium binary found under ${browsersPath}`);
}

const pwInfo = resolvePlaywrightDir();
const playwright = await import(`${pwInfo.pkgDir}/index.mjs`).catch(() =>
  import(`${pwInfo.pkgDir}/index.js`),
);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const chromiumPath = resolveChromiumExecutable(chromium);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OUT_DIR = '/tmp/stream-bench';
const BASE_URL = process.argv[2] || process.env.STREAM_BENCH_URL || 'http://127.0.0.1:5173';
const BENCH_URL = `${BASE_URL}/dev/stream-bench.html`;
const RUNS = 3;
const PATHS = ['legacy', 'stream'];
const FIXTURES = ['big', 'small'];

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

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
  console.log(`[bench] playwright ${pwInfo.version}`);
  console.log(`[bench] chromium: ${chromiumPath}`);
  console.log(`[bench] page: ${BENCH_URL}`);

  await waitForServer(BENCH_URL);
  console.log('[bench] dev server reachable');

  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });

  const allRuns = [];
  const sanityFailures = [];

  try {
    for (const fixture of FIXTURES) {
      for (const benchPath of PATHS) {
        for (let run = 1; run <= RUNS; run += 1) {
          const label = `${benchPath}/${fixture}/run${run}`;
          const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
          });
          const page = await context.newPage();
          const pageErrors = [];
          page.on('pageerror', (err) => pageErrors.push(`PAGE_ERROR: ${err.message}`));
          try {
            const url = `${BENCH_URL}?path=${benchPath}&fixture=${fixture}&run=${run}`;
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
            if ((result.consoleErrors ?? []).length > 0 || pageErrors.length > 0) {
              sanityFailures.push(
                `${label}: console/page errors: ${[...(result.consoleErrors ?? []), ...pageErrors].join(' | ')}`,
              );
            }
            const tot = Object.entries(result.totals ?? {})
              .map(([k, v]) => `${k}=${round(v, 1)}ms`)
              .join(' ');
            console.log(`[bench] ${label} done — ${tot}`);
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  // -------------------------------------------------------------------------
  // Aggregate: per (path, fixture), per-run per-chunk stats, then median
  // across runs. Also pool all per-chunk samples across runs for p95.
  // ---------------------------------------------------------------------------
  const summary = { generatedAt: new Date().toISOString(), baseUrl: BENCH_URL, runs: RUNS, combos: {} };

  for (const fixture of FIXTURES) {
    for (const benchPath of PATHS) {
      const runs = allRuns.filter((r) => r.path === benchPath && r.fixture === fixture);
      if (runs.length === 0) continue;

      const latencyKey = benchPath === 'legacy' ? 'workerMs' : 'sendToAppliedMs';
      const domKey = benchPath === 'legacy' ? 'domMs' : 'patchMs';

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

      summary.combos[`${benchPath}/${fixture}`] = {
        runs: runs.length,
        chunkCount: runs[0].chunkCount,
        lineCount: runs[0].lineCount,
        latencyMetric: latencyKey,
        latency: {
          meanOfRunMeans: round(median(perRunMean)),
          medianOfRunP95: round(median(perRunP95)),
          pooledMean: round(mean(pooledLatency)),
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
          cumulativeMedianMs: round(median(runs.map((r) => r.totals[domKey] ?? 0)), 1),
        },
        cumulative: {
          roundTripMedianMs: round(median(runs.map((r) => r.totals[latencyKey] ?? 0)), 1),
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
        sanity: runs.map((r) => r.sanity),
      };
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
