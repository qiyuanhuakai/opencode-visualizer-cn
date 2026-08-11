#!/usr/bin/env node
/**
 * Visual-noise freeze/compare for Task 8 (renderer dependency upgrade).
 *
 * freeze mode (default): capture each fixed surface 3× in a FIXED
 * environment — fixed viewports (1440×900, 390×844), fixed locale/TZ,
 * fixed font stack injection, animations disabled — and store the max
 * pairwise pixel-diff ratio per surface in `visual-noise.json`. The ratio is
 * the inherent capture noise of the CURRENT dependency tree.
 *
 * compare mode (--compare): read `visual-noise.json` READ-ONLY (never
 * recomputed), capture 3 actual captures per surface in the same fixed
 * environment, compute the max ratio over all 9 reference-vs-actual pairs,
 * and assert it does not exceed the frozen ratio. Also writes per-pair diff
 * images for review.
 *
 * Pixel comparison runs INSIDE the same chromium that captured the frames
 * (canvas getImageData) — no image library dependency, deterministic across
 * runs and machines with the same browser build.
 *
 * Usage:
 *   node scripts/qa/visual-noise-freeze.mjs <baseUrl>            # freeze
 *   node scripts/qa/visual-noise-freeze.mjs <baseUrl> --compare  # compare
 *
 * Env:
 *   VIS_QA_OUT_DIR    artifacts dir (default .omo/evidence/.../task-8/visual-qa)
 *   VIS_QA_NOISE_FILE noise json (default .omo/evidence/.../task-8/visual-noise.json)
 *
 * Surfaces are fixture-driven dev pages (real components + real render
 * worker): md-stream = streaming markdown with CJK/code/tables/links,
 * code-stream = streamed shiki code highlight.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

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

const BASE_URL = process.argv[2] || process.env.STREAM_QA_URL || 'http://127.0.0.1:5173';
const COMPARE = process.argv.includes('--compare');
const EVIDENCE_ROOT = path.join(
  REPO_ROOT,
  '.omo/evidence/electron-major-upgrade/task-8',
);
const OUT_DIR = process.env.VIS_QA_OUT_DIR || path.join(EVIDENCE_ROOT, 'visual-qa');
const NOISE_FILE =
  process.env.VIS_QA_NOISE_FILE || path.join(EVIDENCE_ROOT, 'visual-noise.json');
const REFS_DIR = path.join(OUT_DIR, 'refs');
const ACTUALS_DIR = path.join(OUT_DIR, 'actuals');
const DIFFS_DIR = path.join(OUT_DIR, 'diffs');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

// Fixed environment: fonts pinned to locally-installed families so glyphs are
// identical across captures; animations/transitions disabled; stable locale
// and timezone so any locale/TZ-affected rendering is frozen.
const FONT_CSS = [
  '* { font-family: "Noto Sans CJK SC", "DejaVu Sans", sans-serif !important; }',
  'pre, code, .code-content, .cm-content, .shiki { font-family: "DejaVu Sans Mono", monospace !important; }',
].join('\n');
const ANIM_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }';

const SURFACES = {
  'md-stream': async (page, ev) => {
    await ev(() => window.__mdDriver.addEntry('main', '', false));
    await ev(() => window.__mdDriver.feedFull('main', 8));
    return ev(() => window.__mdDriver.waitForQuiescence(600, 120000));
  },
  'code-stream': async (page, ev) => {
    await ev(() => window.__streamDriver.reset());
    await ev(() => window.__streamDriver.setGutterMode('none'));
    await ev(() => window.__streamDriver.feed(window.__streamDriver.FULL_CODE));
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const rows = await ev(() => window.__streamDriver.getRowCount());
      await new Promise((resolve) => setTimeout(resolve, 200));
      const rows2 = await ev(() => window.__streamDriver.getRowCount());
      if (rows === rows2 && rows > 0) return true;
    }
    return false;
  },
};

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
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`${url} not ready`));
        else setTimeout(check, 400);
      });
    };
    check();
  });
}

const DIFF_HELPERS = `
  window.__visDiff = async function (b64a, b64b) {
    async function load(b64) {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
    }
    const a = await load(b64a);
    const b = await load(b64b);
    if (a.width !== b.width || a.height !== b.height) return { ratio: 1, image: '' };
    let diff = 0;
    const total = a.width * a.height;
    for (let i = 0; i < a.data.length; i += 4) {
      if (
        a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]
      ) diff += 1;
    }
    const canvas = document.createElement('canvas');
    canvas.width = a.width;
    canvas.height = a.height;
    const ctx = canvas.getContext('2d');
    const imgA = new Image();
    imgA.src = 'data:image/png;base64,' + b64a;
    await new Promise((res, rej) => { imgA.onload = res; imgA.onerror = rej; });
    ctx.drawImage(imgA, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < a.data.length; i += 4) {
      const same = a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2];
      if (same) {
        const x = (i / 4) % a.width;
        const y = Math.floor((i / 4) / a.width);
        ctx.clearRect(x, y, 1, 1);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255, 0, 0, 0.6)';
    for (let i = 0; i < a.data.length; i += 4) {
      const same = a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2];
      if (!same) {
        const x = (i / 4) % a.width;
        const y = Math.floor((i / 4) / a.width);
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return { ratio: diff / total, image: canvas.toDataURL('image/png').split(',')[1] };
  };
`;

async function main() {
  console.log(`[visual-qa] playwright ${playwrightVersion}`);
  console.log(`[visual-qa] chromium: ${chromiumPath}`);
  console.log(`[visual-qa] mode: ${COMPARE ? 'compare' : 'freeze'}`);
  console.log(`[visual-qa] base URL: ${BASE_URL}`);

  await waitForServer(`${BASE_URL}/dev/stream-md-driver.html`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  });
  const chromiumVersion = await browser.version();

  let frozen = null;
  if (COMPARE) {
    frozen = JSON.parse(fs.readFileSync(NOISE_FILE, 'utf8'));
    console.log(`[visual-qa] frozen noise: ${JSON.stringify(frozen.surfaces)}`);
  }

  const results = [];

  for (const viewport of VIEWPORTS) {
    const viewportLabel = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({
      viewport,
      locale: 'en-US',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.addStyleTag({ content: FONT_CSS });
    await page.addStyleTag({ content: ANIM_CSS });

    for (const [surfaceId, settle] of Object.entries(SURFACES)) {
      const surfaceLabel = `${surfaceId}@${viewportLabel}`;
      const url = `${BASE_URL}/dev/${surfaceId === 'md-stream' ? 'stream-md-driver' : 'stream-driver'}.html`;
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate(DIFF_HELPERS);
      const ev = (fn, arg) => page.evaluate(fn, arg);
      if (surfaceId === 'md-stream') {
        await page.waitForFunction(() => !!window.__mdDriver, null, { timeout: 20000 });
        await ev(() => window.__mdDriver.warmup());
      } else {
        await page.waitForFunction(() => !!window.__streamDriver, null, { timeout: 20000 });
      }
      await ev(() => document.fonts?.ready);
      const settled = await settle(page, ev);
      await ev(() => document.fonts?.ready);

      const modeDir = COMPARE ? ACTUALS_DIR : REFS_DIR;
      fs.mkdirSync(modeDir, { recursive: true });
      const shots = [];
      for (let i = 0; i < 3; i += 1) {
        const buf = await page.screenshot({ fullPage: true });
        const file = path.join(modeDir, `${surfaceLabel}-${i + 1}.png`);
        fs.writeFileSync(file, buf);
        shots.push(buf.toString('base64'));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      if (!COMPARE) {
        const pairs = [
          [0, 1],
          [0, 2],
          [1, 2],
        ];
        let maxRatio = 0;
        for (const [a, b] of pairs) {
          const r = await ev(([x, y]) => window.__visDiff(x, y), [shots[a], shots[b]]);
          maxRatio = Math.max(maxRatio, r.ratio);
        }
        results.push({ surface: surfaceLabel, settled, captures: 3, maxPairwiseDiffRatio: maxRatio });
        console.log(`[visual-qa] freeze ${surfaceLabel}: max pairwise diff = ${maxRatio.toFixed(6)}${settled ? '' : ' (UNSETTLED)'}`);
      } else {
        const refs = [];
        for (let i = 1; i <= 3; i += 1) {
          const file = path.join(REFS_DIR, `${surfaceLabel}-${i}.png`);
          if (!fs.existsSync(file)) throw new Error(`missing frozen reference ${file}`);
          refs.push(fs.readFileSync(file).toString('base64'));
        }
        const frozenRatio = frozen.surfaces[surfaceLabel]?.maxPairwiseDiffRatio ?? 1;
        let maxRatio = 0;
        let worstPair = '';
        fs.mkdirSync(DIFFS_DIR, { recursive: true });
        for (let i = 0; i < 3; i += 1) {
          for (let j = 0; j < 3; j += 1) {
            const r = await ev(([x, y]) => window.__visDiff(x, y), [refs[i], shots[j]]);
            if (r.ratio > maxRatio) {
              maxRatio = r.ratio;
              worstPair = `ref${i + 1}-actual${j + 1}`;
            }
            fs.writeFileSync(path.join(DIFFS_DIR, `${surfaceLabel}-ref${i + 1}-actual${j + 1}.png`), Buffer.from(r.image, 'base64'));
          }
        }
        const pass = maxRatio <= frozenRatio;
        results.push({ surface: surfaceLabel, settled, maxPairwiseDiffRatio: maxRatio, frozenRatio, pass, worstPair });
        console.log(
          `[visual-qa] compare ${surfaceLabel}: max ref-vs-actual = ${maxRatio.toFixed(6)} (frozen ${frozenRatio.toFixed(6)}) ${pass ? 'PASS' : 'FAIL'}${worstPair ? ` — worst ${worstPair}` : ''}`,
        );
      }
    }
    await context.close();
  }

  if (!COMPARE) {
    const noise = {
      mode: 'freeze',
      frozenAt: new Date().toISOString(),
      environment: {
        playwright: playwrightVersion,
        chromium: chromiumVersion,
        locale: 'en-US',
        timezone: 'UTC',
        deviceScaleFactor: 1,
        animations: 'disabled',
        fonts: 'Noto Sans CJK SC / DejaVu Sans / DejaVu Sans Mono (injected)',
        surfaces: 'stream-md-driver.html (markdown+CJK) and stream-driver.html (shiki code)',
      },
      surfaces: Object.fromEntries(
        results.map((r) => [
          r.surface,
          { maxPairwiseDiffRatio: r.maxPairwiseDiffRatio, captures: r.captures, settled: r.settled },
        ]),
      ),
    };
    fs.mkdirSync(path.dirname(NOISE_FILE), { recursive: true });
    fs.writeFileSync(NOISE_FILE, `${JSON.stringify(noise, null, 2)}\n`);
    console.log(`[visual-qa] frozen noise written to ${NOISE_FILE}`);
    console.log(`[visual-qa] ${results.length} surfaces frozen`);
  } else {
    const failed = results.filter((r) => !r.pass);
    console.log(`[visual-qa] ${results.length - failed.length}/${results.length} surfaces within frozen noise`);
    if (failed.length > 0) {
      for (const f of failed) console.log(`[FAIL] ${f.surface}: ${f.maxPairwiseDiffRatio.toFixed(6)} > ${f.frozenRatio.toFixed(6)}`);
      await browser.close();
      process.exit(1);
    }
  }
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
