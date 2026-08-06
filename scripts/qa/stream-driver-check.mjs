#!/usr/bin/env node
/**
 * Stream driver QA — real-surface Playwright check for the streaming
 * code-highlight path (branch feat/shiki-v4).
 *
 * Drives the dev-only page app/dev/stream-driver.html (which mounts the REAL
 * CodeRenderer with streaming=true) in a real browser with the real Web
 * Worker, and captures binary pass/fail evidence for:
 *
 *   S1  — happy path: 8 fixed chunks; row count non-decreasing per chunk;
 *         after close the container's final HTML is byte-identical to the
 *         single-shot render of the same full code via the existing
 *         single-shot worker path (identical lang/theme/gutterMode).
 *   S1g — gutter continuity: same 8 chunks with gutterMode 'single'; final
 *         container HTML byte-identical to single-shot with identical params;
 *         per-chunk gutter numbers strictly sequential (no batch restart).
 *   S2c — theme switch mid-stream (github-dark -> dark-plus): composable
 *         cancels + reopens; final HTML byte-identical to single-shot in
 *         dark-plus; no stale theme-A colors.
 *   S2d — cancel mid-stream: no console errors, no further DOM mutations
 *         (two snapshots ~1s apart identical), stream never finalizes.
 *   RED — deliberate-failure proof: corrupt the single-shot reference
 *         (append a character), capture the FAILING diff, then restore and
 *         capture PASS.
 *
 * The runner assumes a dev server is already running:
 *   STREAM_QA_URL=http://127.0.0.1:5173 node scripts/qa/stream-driver-check.mjs
 *   node scripts/qa/stream-driver-check.mjs http://127.0.0.1:5173
 *
 * Artifacts are written to /tmp/stream-qa-artifacts/ (wiped each run).
 * Exits non-zero if any scenario fails.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Playwright resolution (no repo dependency; use npx cache or global install)
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
  // Fall back to the newest available full chromium binary.
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
// Config / artifacts
// ---------------------------------------------------------------------------
const ARTIFACTS_DIR = '/tmp/stream-qa-artifacts';
const BASE_URL = process.argv[2] || process.env.STREAM_QA_URL || 'http://127.0.0.1:5173';
const DRIVER_URL = `${BASE_URL}/dev/stream-driver.html`;

// The composable auto-closes after 300ms idle. Per-chunk settle time must
// stay below the debounce so the whole fixture streams through ONE session
// (exactly one finalize) while still leaving room to observe incremental
// DOM batches between chunks.
const SETTLE_MS = 250;

fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
for (const sub of ['s1', 's1g', 's2c', 's2d', 'red']) {
  fs.mkdirSync(path.join(ARTIFACTS_DIR, sub), { recursive: true });
}

const results = [];
function record(scenario, check, ok, detail = '') {
  results.push({ scenario, check, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${scenario}: ${check}${detail ? ` — ${detail}` : ''}`);
}
function artifact(sub, name, content) {
  const p = path.join(ARTIFACTS_DIR, sub, name);
  fs.writeFileSync(p, content);
  return p;
}

function computeDiff(a, b) {
  if (a === b) return '';
  const out = [`BYTE-IDENTICAL: NO (a=${a.length}B, b=${b.length}B)`];
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let count = 0;
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    const al = aLines[i] ?? '(missing)';
    const bl = bLines[i] ?? '(missing)';
    if (al !== bl) {
      count += 1;
      if (count <= 10) {
        out.push(`Line ${i + 1}:`, `  stream    < ${al.slice(0, 220)}`, `  singleshot> ${bl.slice(0, 220)}`);
      }
    }
  }
  if (count > 10) out.push(`... and ${count - 10} more differing lines`);
  return out.join('\n');
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[stream-qa] playwright ${pwInfo.version} (${pwInfo.pkgDir})`);
  console.log(`[stream-qa] chromium: ${chromiumPath}`);
  console.log(`[stream-qa] driver: ${DRIVER_URL}`);

  await waitForServer(DRIVER_URL);
  console.log('[stream-qa] dev server reachable');

  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleLog = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    consoleLog.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(`PAGE_ERROR: ${err.message}`));

  const ev = (fn, arg) => page.evaluate(fn, arg);

  try {
    await page.goto(DRIVER_URL, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__streamDriver, null, { timeout: 15000 });
    console.log('[stream-qa] driver page mounted (window.__streamDriver ready)');

    const CHUNKS = await ev(() => window.__streamDriver.CHUNKS);
    const FULL_CODE = await ev(() => window.__streamDriver.FULL_CODE);

    // Warm up the stream worker (shiki init + TS grammar + github-dark theme)
    // so per-chunk batches arrive promptly during the measured scenarios.
    // The close request is always queued behind all chunks in the worker, so
    // a slow batch cannot split the stream as long as feeds keep a <300ms
    // cadence (each feed resets the close debounce).
    console.log('[stream-qa] warming up stream worker...');
    await ev(() => window.__streamDriver.reset());
    await sleep(300);
    await ev(() => window.__streamDriver.feed('const warmup = 1;\n'));
    const warmDone = await ev(() => window.__streamDriver.waitForDone(20000));
    console.log(`[stream-qa] warmup done=${warmDone}`);
    await ev(() => window.__streamDriver.reset());
    await sleep(400);

    const feedChunk = async (chunk) => {
      await ev((c) => window.__streamDriver.feed(c), chunk);
      await sleep(SETTLE_MS);
    };

    // =====================================================================
    // S1 — happy path
    // =====================================================================
    console.log('--- S1: happy path ---');
    await ev(() => window.__streamDriver.reset());
    await sleep(300);

    const rowCounts = [];
    for (let i = 0; i < CHUNKS.length; i++) {
      await feedChunk(CHUNKS[i]);
      const count = await ev(() => window.__streamDriver.getRowCount());
      rowCounts.push(count);
      const snap = await ev(() => window.__streamDriver.getViewerHTML());
      artifact('s1', `chunk-${String(i + 1).padStart(2, '0')}.html`, snap);
    }
    artifact('s1', 'row-counts.json', JSON.stringify(rowCounts, null, 2));

    const growthOk = rowCounts.every((c, i) => i === 0 || c >= rowCounts[i - 1]);
    record('S1', 'completed-row count non-decreasing per chunk', growthOk, `[${rowCounts.join(', ')}]`);

    const s1Done = await ev(() => window.__streamDriver.waitForDone(10000));
    record('S1', 'stream closed (exactly one finalize, done)', s1Done);
    await sleep(300);

    // Post-done DOM: CodeRenderer renders the converged html through
    // CodeContent (v-html) — this is the container's final HTML.
    const s1Final = await ev(() => window.__streamDriver.getPostDoneHTML());
    const s1FinalizeCapture = await ev(() => window.__streamDriver.getFinalizeCaptureHTML());
    const s1Single = await ev(
      (code) => window.__streamDriver.getSingleShotHTML(code, 'github-dark'),
      FULL_CODE,
    );
    const s1CanonSingle = await ev((html) => window.__streamDriver.canonicalize(html), s1Single);

    artifact('s1', 'final-container.html', s1Final);
    artifact('s1', 'finalize-capture.html', s1FinalizeCapture);
    artifact('s1', 'single-shot.html', s1Single);
    artifact('s1', 'single-shot-canonical.html', s1CanonSingle);

    const s1Diff = computeDiff(s1Final, s1CanonSingle);
    artifact('s1', 'diff.txt', s1Diff);
    record('S1', 'final container HTML byte-identical to single-shot', s1Diff === '');

    const s1FinDiff = computeDiff(s1FinalizeCapture, s1CanonSingle);
    artifact('s1', 'finalize-capture-diff.txt', s1FinDiff);
    record('S1', 'finalize-swap capture byte-identical to single-shot', s1FinDiff === '');

    // Soundness of the DOM comparison: canonicalization (parse -> serialize
    // through the same browser engine) must be idempotent, so byte-equality
    // of canonical forms means byte-equality of DOM content. Raw strings may
    // differ only by inert escaping (e.g. `>` -> `&gt;` in text nodes).
    const s1CanonTwice = await ev((html) => window.__streamDriver.canonicalize(html), s1CanonSingle);
    record('S1', 'canonicalization idempotent (DOM comparison is sound)', s1CanonTwice === s1CanonSingle);
    console.log(`[stream-qa] info: raw single-shot vs final container byte-equal: ${s1Single === s1Final} (inert escaping may differ; canonical comparison above is the authoritative one)`);

    // Exactly one finalize: the finalized flag must flip false->true once and
    // stay true for the rest of the log.
    const s1MutLog = await ev(() => window.__streamDriver.getMutationLog());
    artifact('s1', 'mutation-log.json', JSON.stringify(s1MutLog, null, 2));
    let finalizeTransitions = 0;
    for (let i = 1; i < s1MutLog.length; i++) {
      if (!s1MutLog[i - 1].finalized && s1MutLog[i].finalized) finalizeTransitions += 1;
    }
    const firstFin = s1MutLog.findIndex((m) => m.finalized);
    const staysFinalized = firstFin >= 0 && s1MutLog.slice(firstFin).every((m) => m.finalized);
    record('S1', 'exactly one finalize in mutation log', finalizeTransitions === 1 && staysFinalized, `${finalizeTransitions} transition(s), ${s1MutLog.length} entries`);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's1/screenshot.png'), fullPage: true });

    // =====================================================================
    // S1g — gutter continuity (gutterMode 'single' across batch boundaries)
    // =====================================================================
    console.log('--- S1g: gutter mode single ---');
    await ev(() => window.__streamDriver.reset());
    await ev(() => window.__streamDriver.setGutterMode('default'));
    await sleep(300);

    const gutterSnapshots = [];
    for (let i = 0; i < CHUNKS.length; i++) {
      await feedChunk(CHUNKS[i]);
      const gutters = await ev(() => window.__streamDriver.getGutterTexts());
      gutterSnapshots.push(gutters);
      artifact('s1g', `chunk-${String(i + 1).padStart(2, '0')}-gutters.json`, JSON.stringify(gutters));
      const snap = await ev(() => window.__streamDriver.getViewerHTML());
      artifact('s1g', `chunk-${String(i + 1).padStart(2, '0')}.html`, snap);
    }
    artifact('s1g', 'gutter-snapshots.json', JSON.stringify(gutterSnapshots, null, 2));

    // No restarted line number: within each per-chunk snapshot the gutter
    // numbers in DOM order must be exactly 1..N (a batch-local restart would
    // produce e.g. 1,2,1,2,3), and the visible maximum must never decrease.
    let prevMax = 0;
    let sequentialOk = true;
    let monotonicMaxOk = true;
    for (const gutters of gutterSnapshots) {
      const nums = gutters.map(Number);
      if (nums.some((n, idx) => !Number.isInteger(n) || n !== idx + 1)) sequentialOk = false;
      const max = nums.length > 0 ? Math.max(...nums) : 0;
      if (max < prevMax) monotonicMaxOk = false;
      prevMax = Math.max(prevMax, max);
    }
    record('S1g', 'per-chunk gutter numbers strictly sequential (1..N, no restart)', sequentialOk,
      gutterSnapshots.map((g) => g.join(',')).join(' | '));
    record('S1g', 'max visible line number non-decreasing across chunks', monotonicMaxOk);

    const s1gDone = await ev(() => window.__streamDriver.waitForDone(10000));
    record('S1g', 'stream closed (done)', s1gDone);
    await sleep(300);

    const s1gFinal = await ev(() => window.__streamDriver.getPostDoneHTML());
    const s1gSingle = await ev(
      (code) => window.__streamDriver.getSingleShotHTML(code, 'github-dark', 'single'),
      FULL_CODE,
    );
    const s1gCanonSingle = await ev((html) => window.__streamDriver.canonicalize(html), s1gSingle);

    artifact('s1g', 'final-container.html', s1gFinal);
    artifact('s1g', 'single-shot.html', s1gSingle);
    artifact('s1g', 'single-shot-canonical.html', s1gCanonSingle);

    const s1gDiff = computeDiff(s1gFinal, s1gCanonSingle);
    artifact('s1g', 'diff.txt', s1gDiff);
    record('S1g', 'final container HTML byte-identical to single-shot (gutter single)', s1gDiff === '');

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's1g/screenshot.png'), fullPage: true });

    // =====================================================================
    // S2c — theme switch mid-stream (github-dark -> dark-plus)
    // =====================================================================
    console.log('--- S2c: theme switch mid-stream ---');
    await ev(() => window.__streamDriver.reset());
    await sleep(300);

    for (let i = 0; i < 4; i++) await feedChunk(CHUNKS[i]);
    const s2cThemeAColors = await ev(() =>
      window.__streamDriver.extractHexColors(window.__streamDriver.getStreamContainerHTML()),
    );
    artifact('s2c', 'mid-stream-theme-a.html', await ev(() => window.__streamDriver.getViewerHTML()));

    await ev(() => window.__streamDriver.switchTheme('dark-plus'));
    await sleep(SETTLE_MS);
    artifact('s2c', 'after-theme-switch.html', await ev(() => window.__streamDriver.getViewerHTML()));

    for (let i = 4; i < CHUNKS.length; i++) await feedChunk(CHUNKS[i]);

    const s2cDone = await ev(() => window.__streamDriver.waitForDone(10000));
    record('S2c', 'stream closed after theme switch', s2cDone);
    await sleep(300);

    const s2cFinal = await ev(() => window.__streamDriver.getPostDoneHTML());
    const s2cSingle = await ev(
      (code) => window.__streamDriver.getSingleShotHTML(code, 'dark-plus'),
      FULL_CODE,
    );
    const s2cSingleA = await ev(
      (code) => window.__streamDriver.getSingleShotHTML(code, 'github-dark'),
      FULL_CODE,
    );
    const s2cCanonSingle = await ev((html) => window.__streamDriver.canonicalize(html), s2cSingle);

    artifact('s2c', 'final-container.html', s2cFinal);
    artifact('s2c', 'single-shot-dark-plus.html', s2cSingle);
    const s2cDiff = computeDiff(s2cFinal, s2cCanonSingle);
    artifact('s2c', 'diff.txt', s2cDiff);
    record('S2c', 'final HTML byte-identical to single-shot in dark-plus', s2cDiff === '');

    const colorsA = await ev((html) => window.__streamDriver.extractHexColors(html), s2cSingleA);
    const colorsB = await ev((html) => window.__streamDriver.extractHexColors(html), s2cSingle);
    const colorsFinal = await ev((html) => window.__streamDriver.extractHexColors(html), s2cFinal);
    const staleColors = colorsFinal.filter((c) => !colorsB.includes(c));
    const colorEvidence = { midStreamThemeAColors: s2cThemeAColors, singleShotThemeA: colorsA, singleShotThemeB: colorsB, finalColors: colorsFinal, staleColors };
    artifact('s2c', 'colors.json', JSON.stringify(colorEvidence, null, 2));
    record('S2c', 'themes actually differ (sanity)', colorsA.join() !== colorsB.join(), `A=${colorsA.length} colors, B=${colorsB.length} colors`);
    record('S2c', 'no stale theme-A colors remain in final output', staleColors.length === 0, staleColors.length ? `stale: ${staleColors.join(', ')}` : `final uses only dark-plus colors (${colorsFinal.length})`);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's2c/screenshot.png'), fullPage: true });

    // =====================================================================
    // S2d — cancel mid-stream
    // =====================================================================
    console.log('--- S2d: cancel mid-stream ---');
    await ev(() => window.__streamDriver.reset());
    await sleep(300);
    pageErrors.length = 0;

    for (let i = 0; i < 3; i++) {
      await ev((c) => window.__streamDriver.feed(c), CHUNKS[i]);
      await sleep(150);
    }

    artifact('s2d', 'snapshot-before-cancel.html', await ev(() => window.__streamDriver.getViewerHTML()));
    await ev(() => window.__streamDriver.cancel());
    await sleep(500);
    const s2dSnap1 = await ev(() => window.__streamDriver.getViewerHTML());
    artifact('s2d', 'snapshot-after-cancel-0.5s.html', s2dSnap1);
    // Baseline AFTER the cancel has fully settled: the composable's cancel
    // path legitimately clears the container once (replaceChildren), and that
    // mutation must not count — the check targets stream-driven mutations
    // arriving after the cancel (late token batches, stray finalize).
    const mutationsAfterCancelSettled = await ev(() => window.__streamDriver.getMutationCount());
    await sleep(1000);
    const s2dSnap2 = await ev(() => window.__streamDriver.getViewerHTML());
    artifact('s2d', 'snapshot-after-cancel-1.5s.html', s2dSnap2);
    const mutationsAtEnd = await ev(() => window.__streamDriver.getMutationCount());
    const s2dMutLog = await ev(() => window.__streamDriver.getMutationLog());
    artifact('s2d', 'mutation-log.json', JSON.stringify(s2dMutLog, null, 2));

    record('S2d', 'DOM snapshots 1s apart identical (no further mutations)', s2dSnap1 === s2dSnap2);
    record('S2d', 'zero DOM mutation entries after cancel settled', mutationsAtEnd === mutationsAfterCancelSettled, `after cancel settled=${mutationsAfterCancelSettled}, end=${mutationsAtEnd}`);

    const s2dDone = await ev(() => window.__streamDriver.isDone());
    record('S2d', 'stream never finalized after cancel', !s2dDone);

    const s2dInPageErrors = await ev(() => window.__streamDriver.getConsoleErrors());
    artifact('s2d', 'console-errors.json', JSON.stringify({ inPage: s2dInPageErrors, playwright: pageErrors }, null, 2));
    record('S2d', 'no in-page console errors', s2dInPageErrors.length === 0, s2dInPageErrors.join(' | '));
    record('S2d', 'no page errors via Playwright', pageErrors.length === 0, pageErrors.join(' | '));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's2d/screenshot.png'), fullPage: true });

    // =====================================================================
    // RED — deliberate-failure proof for the S1 comparison
    // =====================================================================
    console.log('--- RED: deliberate-failure proof ---');
    // Corrupt the EXPECTED single-shot reference (append a character) and
    // verify the comparison FAILS; then restore and verify it PASSES.
    const redCorruptSingle = await ev(
      (code) => window.__streamDriver.getSingleShotHTML(code, 'github-dark'),
      `${FULL_CODE}Q`,
    );
    const redCanonCorrupt = await ev((html) => window.__streamDriver.canonicalize(html), redCorruptSingle);
    const redDiff = computeDiff(s1Final, redCanonCorrupt);
    artifact('red', 'corrupted-single-shot.html', redCorruptSingle);
    artifact('red', 'diff.txt', redDiff);
    record('RED', 'corrupted reference produces FAILING diff (check is not vacuous)', redDiff !== '', `${redDiff.split('\n').length - 1} diff lines captured in red/diff.txt`);

    const restoredDiff = computeDiff(s1Final, s1CanonSingle);
    artifact('red', 'restored-diff.txt', restoredDiff);
    record('RED', 'restored reference produces PASS', restoredDiff === '');

  } catch (err) {
    record('HARNESS', 'unexpected runner error', false, String(err?.stack ?? err));
  } finally {
    artifact('.', 'console-log.json', JSON.stringify(consoleLog, null, 2));
    const summary = {
      driverUrl: DRIVER_URL,
      playwright: pwInfo.version,
      chromium: chromiumPath,
      results,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    await browser.close();
  }

  console.log('=================================================');
  console.log(`[stream-qa] ${summary_line()}`);
  console.log(`[stream-qa] artifacts: ${ARTIFACTS_DIR}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    for (const f of failed) console.log(`[FAIL] ${f.scenario}: ${f.check}`);
    process.exit(1);
  }
  process.exit(0);
}

function summary_line() {
  const p = results.filter((r) => r.ok).length;
  const f = results.length - p;
  return `${p} passed, ${f} failed`;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
