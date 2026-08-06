#!/usr/bin/env node
/**
 * Streaming-markdown QA — real-surface Playwright check for the streaming
 * markdown path (branch feat/shiki-v4).
 *
 * Drives the dev-only page app/dev/stream-md-driver.html — which mounts the
 * REAL ToolWindow/Reasoning component (entries -> MessageViewer ->
 * MarkdownRenderer -> useStreamingMarkdown) in a real browser with the real
 * render Web Worker — and captures binary pass/fail evidence for:
 *
 *   S-MD-1 happy path: full 848-delta sequence fed to one entry; a mutation
 *     observer proves the stable prefix is NEVER rewritten once it appears
 *     (node-identity tracking; any removal of / mutation inside a stable
 *     node is a violation); final streaming DOM is byte-identical to the
 *     single-shot full render under CONTENT canonicalization (see below).
 *   S-MD-2 unclosed fence at every delta: while the python fence is open,
 *     no stable split contains fence content; whenever fence content is in
 *     the DOM pre-commit it lives in the tail; no console errors.
 *   S-MD-3 fence closes mid-stream (shares the S-MD-2 session): after the
 *     closing fence + following blank line arrive, the fence block becomes
 *     stable atomically and is never re-rendered. METHOD: the driver patches
 *     Worker.prototype.postMessage, so every REAL worker request is logged
 *     (cache hits never reach postMessage). A request is a stable-block
 *     render iff its code is present in the markdown segment cache
 *     (useStreamingMarkdown only caches stable ranges there; tails never).
 *     Assertions: exactly one stable-block render carries the closed fence;
 *     zero worker requests contain the fence body after the commit batch;
 *     the commit happens only after the closure+blank-line arrived.
 *   S-MD-4 multiple entries: a completed entry (default path) and a growing
 *     entry (streaming) in one Reasoning window; the completed entry's DOM
 *     is never mutated after its initial render settles; both converge.
 *   S-MD-5 part end convergence: after completeEntry flips streaming off,
 *     the DOM is RAW byte-identical (browser-canonicalized) to the
 *     single-shot render of the final text, the streaming container element
 *     is swapped for the v-html container, and exactly one full worker
 *     render carries the final text.
 *   S-MD-6 theme switch mid-stream (github-dark -> dark-plus at 40%): final
 *     content byte-identical to dark-plus single-shot; zero stale
 *     github-dark colors (hex forensics like S2c).
 *   S-MD-7 shrink mid-stream: entry text replaced with a shorter different
 *     text at 40%; final content byte-identical to single-shot of the new
 *     text; discarded content gone.
 *   RED deliberate-failure proof: corrupt the single-shot reference, capture
 *     the FAILING diff, restore, capture PASS (proves the byte-identity
 *     comparison is not vacuous).
 *
 * CONTENT canonicalization (driver canonicalizeContent): the real worker
 * wraps EVERY markdown render (stable range, tail, or single-shot) in its
 * own .markdown-host with template.md-raw-source + copy buttons/indicator,
 * so raw byte-identity between segmented streaming DOM (N wrappers) and a
 * single-shot render (1 wrapper) is structurally impossible. The meaningful
 * contract — exactly what app/composables/useStreamingMarkdown.test.ts
 * asserts as `innerHTML === markdown.render(finalText)` — is that the
 * markdown CONTENT node sequence is identical. canonicalizeContent strips
 * precisely the per-render scaffolding (templates, buttons, indicators,
 * host wrappers) plus top-level whitespace-only text nodes (block
 * separators markdown-it emits, which segment seams lack), then serializes
 * through the browser. S-MD-5 uses RAW canonicalization because the
 * post-completion default path inserts the identical worker string.
 *
 * The runner assumes a dev server is already running:
 *   STREAM_QA_URL=http://127.0.0.1:5173 node scripts/qa/stream-md-check.mjs
 *   node scripts/qa/stream-md-check.mjs http://127.0.0.1:5173
 *
 * Artifacts are written to /tmp/stream-md-qa/ (wiped each run).
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
  // Resolve global playwright dynamically so other users' installs work.
  try {
    const globalRoot = require('child_process')
      .execSync('npm root -g', { encoding: 'utf8' })
      .trim();
    const globalDir = path.join(globalRoot, '@playwright/cli/node_modules/playwright');
    if (fs.existsSync(path.join(globalDir, 'package.json'))) {
      const version = JSON.parse(
        fs.readFileSync(path.join(globalDir, 'package.json'), 'utf8'),
      ).version;
      candidates.push({ pkgDir: globalDir, version });
    }
  } catch {
    // npm root -g unavailable; fall back to the hard-coded path for this machine.
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
  // Guard against a missing cache directory so we emit the intended
  // 'No chromium binary found' error instead of a raw ENOENT from readdirSync.
  if (!fs.existsSync(browsersPath)) {
    throw new Error(`No chromium binary found under ${browsersPath}`);
  }
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
const ARTIFACTS_DIR = '/tmp/stream-md-qa';
const BASE_URL = process.argv[2] || process.env.STREAM_QA_URL || 'http://127.0.0.1:5173';
const DRIVER_URL = `${BASE_URL}/dev/stream-md-driver.html`;

// Per-delta feed pace. Small enough to exercise per-delta reactivity, large
// enough that the worker loop renders most intermediate states (coalescing
// under load is realistic and does not weaken the mutation-level invariants,
// which are evaluated over every observed batch, not per delta).
const PACE_MS = 8;
const THEME_A = 'github-dark';
const THEME_B = 'dark-plus';

fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
for (const sub of ['s-md-1', 's-md-2', 's-md-3', 's-md-4', 's-md-5', 's-md-6', 's-md-7', 'red']) {
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
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[stream-md-qa] playwright ${pwInfo.version} (${pwInfo.pkgDir})`);
  console.log(`[stream-md-qa] chromium: ${chromiumPath}`);
  console.log(`[stream-md-qa] driver: ${DRIVER_URL}`);

  await waitForServer(DRIVER_URL);
  console.log('[stream-md-qa] dev server reachable');

  // --disable-gpu/--disable-software-rasterizer: with the fallback chromium
  // builds in this environment, page.screenshot hangs in the GPU/swiftshader
  // compositing path (fonts load, then capture never completes). DOM/worker
  // behavior is unaffected; every DOM assertion above is independent of it.
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  });
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

  // Fresh page state per scenario session: reloads reset module-level caches
  // (workerRenderer completedCache, markdown segment cache) so request-count
  // assertions are exact. Worker processes stay warm across reloads.
  async function freshDriverPage() {
    await page.goto(DRIVER_URL, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__mdDriver, null, { timeout: 20000 });
    await ev(() => window.__mdDriver.warmup());
    await ev(() => window.__mdDriver.resetTelemetry());
    pageErrors.length = 0;
  }

  try {
    // =====================================================================
    // Session A: S-MD-1 happy path (+ RED reuses its captures)
    // =====================================================================
    console.log('--- S-MD-1: happy path ---');
    await freshDriverPage();
    await ev(() => window.__mdDriver.addEntry('main', '', false));
    await ev((pace) => window.__mdDriver.feedFull('main', pace), PACE_MS);
    const s1Quiesced = await ev(() => window.__mdDriver.waitForQuiescence(600, 120000));
    record('S-MD-1', 'full delta sequence fed and streaming settled', s1Quiesced);

    const s1FeedEvents = await ev(() => window.__mdDriver.getFeedEvents('main'));
    const s1DeltaCount = await ev(() => window.__mdDriver.DELTA_COUNT);
    artifact('s-md-1', 'feed-events.json', s1FeedEvents);
    record('S-MD-1', 'all deltas delivered to the entry', s1FeedEvents?.fed === s1DeltaCount, `fed=${s1FeedEvents?.fed}/${s1DeltaCount}`);

    const s1MutLog = await ev(() => window.__mdDriver.getMutationLog());
    artifact('s-md-1', 'mutation-log.json', s1MutLog);
    record('S-MD-1', 'streaming produced many mutation batches (non-vacuous)', s1MutLog.length >= 30, `${s1MutLog.length} batches`);

    const s1MaxStable = Math.max(0, ...s1MutLog.map((b) => b.stableCount));
    record('S-MD-1', 'segmentation engaged (stable blocks committed)', s1MaxStable >= 2, `max stable nodes=${s1MaxStable}`);

    const s1Violations = s1MutLog.filter((b) => b.violation);
    artifact('s-md-1', 'stable-rewrite-violations.json', s1Violations);
    record('S-MD-1', 'stable prefix NEVER rewritten after first appearance', s1Violations.length === 0, `${s1Violations.length} violating batches`);

    const s1Final = await ev(() => window.__mdDriver.getEntryHTML(0));
    const s1Single = await ev((theme) => window.__mdDriver.getSingleShotHTML(window.__mdDriver.FULL_TEXT, theme), THEME_A);
    const s1FinalContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s1Final);
    const s1SingleContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s1Single);

    artifact('s-md-1', 'final-streaming.html', s1Final);
    artifact('s-md-1', 'single-shot.html', s1Single);
    artifact('s-md-1', 'final-streaming-content.html', s1FinalContent);
    artifact('s-md-1', 'single-shot-content.html', s1SingleContent);

    const s1Diff = computeDiff(s1FinalContent, s1SingleContent);
    artifact('s-md-1', 'diff.txt', s1Diff);
    record('S-MD-1', 'final streaming DOM byte-identical to single-shot (content canonicalization)', s1Diff === '');

    const s1CanonTwice = await ev((html) => window.__mdDriver.canonicalizeContent(html), s1SingleContent);
    record('S-MD-1', 'content canonicalization idempotent (comparison is sound)', s1CanonTwice === s1SingleContent);

    // Transparency: the RAW (unstripped) comparison is expected to differ
    // only by per-render scaffolding; the diff is archived for review.
    const s1RawCanonFinal = await ev((html) => window.__mdDriver.canonicalize(html), s1Final);
    const s1RawCanonSingle = await ev((html) => window.__mdDriver.canonicalize(html), s1Single);
    artifact('s-md-1', 'raw-canonical-diff.txt', computeDiff(s1RawCanonFinal, s1RawCanonSingle));

    const s1Errors = await ev(() => window.__mdDriver.getConsoleErrors());
    artifact('s-md-1', 'console-errors.json', { inPage: s1Errors, playwright: pageErrors });
    record('S-MD-1', 'no console errors during happy path', s1Errors.length === 0 && pageErrors.length === 0, [...s1Errors, ...pageErrors].join(' | '));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's-md-1/screenshot.png'), fullPage: true });

    // =====================================================================
    // RED — deliberate-failure proof (reuses S-MD-1 captures)
    // =====================================================================
    console.log('--- RED: deliberate-failure proof ---');
    const redCorrupt = await ev(
      (theme) => window.__mdDriver.getSingleShotHTML(`${window.__mdDriver.FULL_TEXT}\n\nCorrupted trailing paragraph Q.`, theme),
      THEME_A,
    );
    const redCorruptContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), redCorrupt);
    const redDiff = computeDiff(s1FinalContent, redCorruptContent);
    artifact('red', 'corrupted-single-shot-content.html', redCorruptContent);
    artifact('red', 'diff.txt', redDiff);
    record('RED', 'corrupted reference produces FAILING diff (check is not vacuous)', redDiff !== '', `${redDiff.split('\n').length - 1} diff lines captured in red/diff.txt`);

    const redRestoredDiff = computeDiff(s1FinalContent, s1SingleContent);
    artifact('red', 'restored-diff.txt', redRestoredDiff);
    record('RED', 'restored reference produces PASS', redRestoredDiff === '');

    // =====================================================================
    // Session B: S-MD-2 unclosed fence + S-MD-3 fence closure
    // =====================================================================
    console.log('--- S-MD-2/S-MD-3: fence lifecycle ---');
    await freshDriverPage();
    await ev(() => window.__mdDriver.addEntry('main', '', false));
    await ev((pace) => window.__mdDriver.feedFull('main', pace), PACE_MS);
    const s2Quiesced = await ev(() => window.__mdDriver.waitForQuiescence(600, 120000));
    record('S-MD-2', 'full delta sequence fed and streaming settled', s2Quiesced);

    const s2MutLog = await ev(() => window.__mdDriver.getMutationLog());
    const s2FeedEvents = await ev(() => window.__mdDriver.getFeedEvents('main'));
    const s2Requests = await ev(() => window.__mdDriver.getRenderRequestInfo());
    artifact('s-md-2', 'mutation-log.json', s2MutLog);
    artifact('s-md-2', 'feed-events.json', s2FeedEvents);
    artifact('s-md-3', 'render-requests.json', s2Requests.map((r) => ({ ...r })));

    // The commit batch = first batch whose stable HTML contains the fence body.
    const commitBatch = s2MutLog.find((b) => b.stableHasFence);
    const commitSeq = commitBatch?.seq ?? -1;
    record('S-MD-2', 'fence body eventually becomes stable (commit batch exists)', commitBatch !== undefined, commitBatch ? `seq=${commitBatch.seq} t=${commitBatch.t}ms` : 'none');

    const preCommitBatches = s2MutLog.filter((b) => b.seq < commitSeq);
    const stableFenceBeforeCommit = preCommitBatches.filter((b) => b.stableHasFence);
    record('S-MD-2', 'no stable split contains fence content while fence unclosed', stableFenceBeforeCommit.length === 0 && commitBatch !== undefined, `${preCommitBatches.length} pre-commit batches checked`);

    // Tail ownership: in every pre-commit batch where the fence body is
    // present anywhere in the entry DOM, it must live in the tail region.
    const fenceInDomPreCommit = preCommitBatches.filter((b) => b.stableHasFence || b.tailHasFence);
    const fenceOutsideTail = fenceInDomPreCommit.filter((b) => !b.tailHasFence);
    record('S-MD-2', 'fence content present in DOM always lives in the tail pre-commit', fenceOutsideTail.length === 0 && fenceInDomPreCommit.length >= 5, `${fenceInDomPreCommit.length} batches with fence in DOM`);

    record('S-MD-2', 'fence-open window exercised (tail held open fence over many batches)', fenceInDomPreCommit.length >= 5, `${fenceInDomPreCommit.length} batches`);

    const s2Errors = await ev(() => window.__mdDriver.getConsoleErrors());
    artifact('s-md-2', 'console-errors.json', { inPage: s2Errors, playwright: pageErrors });
    record('S-MD-2', 'no console errors while fence unclosed', s2Errors.length === 0 && pageErrors.length === 0, [...s2Errors, ...pageErrors].join(' | '));

    // S-MD-3 — render-count instrumentation (method documented in header).
    const tClosureReady = s2FeedEvents?.firstClosureReadyT ?? null;
    artifact('s-md-3', 'commit-evidence.json', { commitBatch, tClosureReady, fenceOpenT: s2FeedEvents?.firstFenceOpenT ?? null });
    record('S-MD-3', 'closure+blank-line arrived in text before commit', tClosureReady !== null && commitBatch !== undefined && commitBatch.t >= tClosureReady, `closureReady=${tClosureReady}ms commit=${commitBatch?.t}ms`);

    const closedFenceStableRenders = s2Requests.filter((r) => r.hasClosedFence && r.isSegCached);
    record('S-MD-3', 'exactly one stable-block render carries the closed fence', closedFenceStableRenders.length === 1, `found ${closedFenceStableRenders.length}`);

    const tCommit = commitBatch?.t ?? 0;
    const postCommitFenceRequests = s2Requests.filter((r) => r.hasFenceBody && r.t > tCommit);
    artifact('s-md-3', 'post-commit-fence-requests.json', postCommitFenceRequests);
    record('S-MD-3', 'zero worker requests contain the fence body after commit (never re-rendered)', postCommitFenceRequests.length === 0, `${postCommitFenceRequests.length} requests after t=${tCommit}ms`);

    const preCommitFenceRequests = s2Requests.filter((r) => r.hasFenceBody && r.t <= tCommit);
    record('S-MD-3', 'sanity: fence body was actually rendered repeatedly while open (tails)', preCommitFenceRequests.length >= 2, `${preCommitFenceRequests.length} requests with fence body up to commit`);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's-md-2/screenshot.png'), fullPage: true });

    // =====================================================================
    // Session C: S-MD-4 multiple entries
    // =====================================================================
    console.log('--- S-MD-4: multiple entries ---');
    await freshDriverPage();
    await ev(() => window.__mdDriver.addEntry('done-entry', window.__mdDriver.FULL_TEXT, true));

    // Wait for the completed entry's initial default-path render to settle.
    let entryAReady = false;
    for (let i = 0; i < 120; i += 1) {
      const len = await ev(() => window.__mdDriver.getEntryHTML(0).length);
      if (len > 1000) {
        entryAReady = true;
        break;
      }
      await sleep(250);
    }
    await ev(() => window.__mdDriver.waitForQuiescence(600, 30000));
    record('S-MD-4', 'completed entry rendered via default path before baseline', entryAReady);

    const s4Baseline = await ev(() => window.__mdDriver.getMutationLog().length);
    const s4BaselineHTML = await ev(() => window.__mdDriver.getEntryHTML(0));

    await ev(() => window.__mdDriver.addEntry('grow-entry', '', false));
    await ev((pace) => window.__mdDriver.feedFull('grow-entry', pace), PACE_MS);
    await ev(() => window.__mdDriver.waitForQuiescence(600, 120000));

    const s4MutLog = await ev(() => window.__mdDriver.getMutationLog());
    artifact('s-md-4', 'mutation-log.json', s4MutLog);
    const s4AfterBaseline = s4MutLog.slice(s4Baseline);
    const entryABatches = s4AfterBaseline.filter((b) => b.entry === 0);
    const entryBBatches = s4AfterBaseline.filter((b) => b.entry === 1);
    artifact('s-md-4', 'entry-a-batches-after-baseline.json', entryABatches);
    record('S-MD-4', 'completed entry DOM never mutated after completion', entryABatches.length === 0, `${entryABatches.length} entry-A batches after baseline`);
    record('S-MD-4', 'growing entry actively streamed (non-vacuous)', entryBBatches.length >= 20, `${entryBBatches.length} entry-B batches`);

    const s4AFinal = await ev(() => window.__mdDriver.getEntryHTML(0));
    const s4ASingle = await ev((theme) => window.__mdDriver.getSingleShotHTML(window.__mdDriver.FULL_TEXT, theme), THEME_A);
    const s4ACanonFinal = await ev((html) => window.__mdDriver.canonicalize(html), s4AFinal);
    const s4ACanonSingle = await ev((html) => window.__mdDriver.canonicalize(html), s4ASingle);
    record('S-MD-4', 'completed entry DOM unchanged by the sibling stream', s4AFinal === s4BaselineHTML);
    const s4ADiff = computeDiff(s4ACanonFinal, s4ACanonSingle);
    artifact('s-md-4', 'entry-a-diff.txt', s4ADiff);
    record('S-MD-4', 'completed entry DOM RAW byte-identical to single-shot (default path)', s4ADiff === '');

    const s4BFinal = await ev(() => window.__mdDriver.getEntryHTML(1));
    const s4BContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s4BFinal);
    const s4BSingleContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s4ASingle);
    const s4BDiff = computeDiff(s4BContent, s4BSingleContent);
    artifact('s-md-4', 'entry-b-diff.txt', s4BDiff);
    record('S-MD-4', 'streaming entry converges to single-shot (content)', s4BDiff === '');

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's-md-4/screenshot.png'), fullPage: true });

    // =====================================================================
    // Session D: S-MD-5 part end convergence
    // =====================================================================
    console.log('--- S-MD-5: part end convergence ---');
    await freshDriverPage();
    await ev(() => window.__mdDriver.addEntry('main', '', false));
    await ev((pace) => window.__mdDriver.feedFull('main', pace), PACE_MS);
    await ev(() => window.__mdDriver.waitForQuiescence(600, 120000));

    const s5PreCount = await ev(() => window.__mdDriver.countRequestsExact(window.__mdDriver.FULL_TEXT, 0));
    record('S-MD-5', 'sanity: no full-text worker request during streaming (cache cold)', s5PreCount === 0, `${s5PreCount}`);

    const s5TokenBefore = await ev(() => window.__mdDriver.getEntryContainerToken(0));
    const s5TComplete = await ev(() => window.__mdDriver.now());
    await ev(() => window.__mdDriver.completeEntry('main'));
    const s5Quiesced = await ev(() => window.__mdDriver.waitForQuiescence(600, 60000));
    record('S-MD-5', 'post-completion render settled', s5Quiesced);

    const s5TokenAfter = await ev(() => window.__mdDriver.getEntryContainerToken(0));
    record('S-MD-5', 'streaming container swapped for v-html container on completion', s5TokenBefore !== s5TokenAfter && s5TokenAfter > 0, `token ${s5TokenBefore} -> ${s5TokenAfter}`);

    const s5FullCount = await ev((since) => window.__mdDriver.countRequestsExact(window.__mdDriver.FULL_TEXT, since), s5TComplete);
    record('S-MD-5', 'exactly one full worker render for the final text', s5FullCount === 1, `${s5FullCount}`);

    const s5Final = await ev(() => window.__mdDriver.getEntryHTML(0));
    const s5Single = await ev((theme) => window.__mdDriver.getSingleShotHTML(window.__mdDriver.FULL_TEXT, theme), THEME_A);
    const s5CanonFinal = await ev((html) => window.__mdDriver.canonicalize(html), s5Final);
    const s5CanonSingle = await ev((html) => window.__mdDriver.canonicalize(html), s5Single);
    artifact('s-md-5', 'final-container.html', s5Final);
    artifact('s-md-5', 'single-shot.html', s5Single);
    const s5Diff = computeDiff(s5CanonFinal, s5CanonSingle);
    artifact('s-md-5', 'diff.txt', s5Diff);
    record('S-MD-5', 'post-completion DOM RAW byte-identical to single-shot', s5Diff === '');

    const s5Errors = await ev(() => window.__mdDriver.getConsoleErrors());
    artifact('s-md-5', 'console-errors.json', { inPage: s5Errors, playwright: pageErrors });
    record('S-MD-5', 'no console errors around completion', s5Errors.length === 0 && pageErrors.length === 0, [...s5Errors, ...pageErrors].join(' | '));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's-md-5/screenshot.png'), fullPage: true });

    // =====================================================================
    // Session E: S-MD-6 theme switch mid-stream
    // =====================================================================
    console.log('--- S-MD-6: theme switch mid-stream ---');
    await freshDriverPage();
    await ev(() => window.__mdDriver.addEntry('main', '', false));
    await ev((pace) => window.__mdDriver.feedRange('main', 0, 0.4, pace), PACE_MS);
    artifact('s-md-6', 'mid-stream-theme-a.html', await ev(() => window.__mdDriver.getEntryHTML(0)));
    await ev((theme) => window.__mdDriver.switchTheme(theme), THEME_B);
    await ev((pace) => window.__mdDriver.feedRange('main', 0.4, 1, pace), PACE_MS);
    const s6Quiesced = await ev(() => window.__mdDriver.waitForQuiescence(600, 120000));
    record('S-MD-6', 'theme switch mid-feed and streaming settled', s6Quiesced);

    const s6Final = await ev(() => window.__mdDriver.getEntryHTML(0));
    const s6SingleB = await ev((theme) => window.__mdDriver.getSingleShotHTML(window.__mdDriver.FULL_TEXT, theme), THEME_B);
    const s6SingleA = await ev((theme) => window.__mdDriver.getSingleShotHTML(window.__mdDriver.FULL_TEXT, theme), THEME_A);
    const s6FinalContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s6Final);
    const s6SingleBContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s6SingleB);
    artifact('s-md-6', 'final-streaming.html', s6Final);
    artifact('s-md-6', 'single-shot-dark-plus.html', s6SingleB);
    const s6Diff = computeDiff(s6FinalContent, s6SingleBContent);
    artifact('s-md-6', 'diff.txt', s6Diff);
    record('S-MD-6', 'final DOM byte-identical to dark-plus single-shot (content)', s6Diff === '');

    const colorsA = await ev((html) => window.__mdDriver.extractHexColors(html), s6SingleA);
    const colorsB = await ev((html) => window.__mdDriver.extractHexColors(html), s6SingleB);
    const colorsFinal = await ev((html) => window.__mdDriver.extractHexColors(html), s6Final);
    const staleColors = colorsFinal.filter((c) => !colorsB.includes(c));
    artifact('s-md-6', 'colors.json', { singleShotThemeA: colorsA, singleShotThemeB: colorsB, finalColors: colorsFinal, staleColors });
    record('S-MD-6', 'themes actually differ (sanity)', colorsA.join() !== colorsB.join(), `A=${colorsA.length} colors, B=${colorsB.length} colors`);
    record('S-MD-6', 'no stale github-dark colors remain in final output', staleColors.length === 0, staleColors.length ? `stale: ${staleColors.join(', ')}` : `final uses only dark-plus colors (${colorsFinal.length})`);

    const s6Errors = await ev(() => window.__mdDriver.getConsoleErrors());
    artifact('s-md-6', 'console-errors.json', { inPage: s6Errors, playwright: pageErrors });
    record('S-MD-6', 'no console errors during theme switch', s6Errors.length === 0 && pageErrors.length === 0, [...s6Errors, ...pageErrors].join(' | '));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's-md-6/screenshot.png'), fullPage: true });

    // =====================================================================
    // Session F: S-MD-7 shrink mid-stream
    // =====================================================================
    console.log('--- S-MD-7: shrink mid-stream ---');
    await freshDriverPage();
    await ev(() => window.__mdDriver.addEntry('main', '', false));
    await ev((pace) => window.__mdDriver.feedRange('main', 0, 0.4, pace), PACE_MS);
    const s7TextBefore = await ev(() => window.__mdDriver.getEntryHTML(0).length);
    artifact('s-md-7', 'mid-stream-before-shrink.html', await ev(() => window.__mdDriver.getEntryHTML(0)));
    await ev(() => window.__mdDriver.shrinkEntry('main', window.__mdDriver.SHRINK_TEXT));
    const s7Quiesced = await ev(() => window.__mdDriver.waitForQuiescence(600, 120000));
    record('S-MD-7', 'shrink applied mid-feed and streaming settled', s7Quiesced);

    const s7Final = await ev(() => window.__mdDriver.getEntryHTML(0));
    const s7Single = await ev((theme) => window.__mdDriver.getSingleShotHTML(window.__mdDriver.SHRINK_TEXT, theme), THEME_A);
    const s7FinalContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s7Final);
    const s7SingleContent = await ev((html) => window.__mdDriver.canonicalizeContent(html), s7Single);
    artifact('s-md-7', 'final-streaming.html', s7Final);
    artifact('s-md-7', 'single-shot-shrunk.html', s7Single);
    const s7Diff = computeDiff(s7FinalContent, s7SingleContent);
    artifact('s-md-7', 'diff.txt', s7Diff);
    record('S-MD-7', 'final DOM byte-identical to single-shot of the new text (content)', s7Diff === '', `before=${s7TextBefore}B`);

    record('S-MD-7', 'discarded pre-shrink content is gone from the DOM', !s7Final.includes('现状代码'), 'unique pre-shrink heading absent');

    const s7Errors = await ev(() => window.__mdDriver.getConsoleErrors());
    artifact('s-md-7', 'console-errors.json', { inPage: s7Errors, playwright: pageErrors });
    record('S-MD-7', 'no console errors during shrink', s7Errors.length === 0 && pageErrors.length === 0, [...s7Errors, ...pageErrors].join(' | '));

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 's-md-7/screenshot.png'), fullPage: true });
  } catch (err) {
    record('HARNESS', 'unexpected runner error', false, String(err?.stack ?? err));
  } finally {
    artifact('.', 'console-log.json', consoleLog);
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
  console.log(`[stream-md-qa] ${summary_line()}`);
  console.log(`[stream-md-qa] artifacts: ${ARTIFACTS_DIR}`);
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
