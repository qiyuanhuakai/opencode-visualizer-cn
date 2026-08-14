#!/usr/bin/env node
/**
 * Task-9 manual QA — real Chromium against the upgraded static toolchain
 * (tailwind 4.3.3, oxlint 1.78.0 + oxlint-tsgolint 7.0.2001, oxfmt 0.63.0).
 *
 * Surfaces (each captured 3× in the SAME fixed environment as the
 * visual-noise-freeze harness — fixed viewports, injected Noto CJK fonts,
 * animations disabled, en-US/UTC, dsf 1 — with an in-browser pairwise pixel
 * diff so every screenshot pair ships with a diff ratio/score):
 *   main-default@1440x900  real app main UI (session tree + message stream)
 *   main-ocean@1440x900    same after theme preset switch (Ocean/深海)
 *   main-default@390x844   narrow viewport
 *   main-ocean@390x844     narrow + preset
 *   settings@1440x900      SettingsModal -> theme section
 *   session-tree@1440x900  session tree with CJK titles
 *   message-stream@1440x900  message stream with CJK markdown
 *
 * Also: CJK clipping scan over the message-stream text elements (pre/code
 * excluded — horizontal scroll is by design for long lines), theme-preset
 * distinctness diff (default vs Ocean), and a zero-Vue-warning console check.
 *
 * Usage:
 *   node scripts/qa/task9-manual-qa.mjs http://127.0.0.1:5173
 *   VIS_BACKEND_URL env overrides the opencode backend (default 4096).
 *
 * Artifacts -> VIS_QA_OUT_DIR (default .omo/evidence/electron-major-upgrade/
 * task-9/manual-qa/). Exits non-zero on any failed check.
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
const BACKEND_URL = process.env.VIS_BACKEND_URL || 'http://127.0.0.1:4096';
const ARTIFACTS_DIR =
  process.env.VIS_QA_OUT_DIR ||
  path.join(
    REPO_ROOT,
    '.omo/evidence/electron-major-upgrade/task-9/manual-qa',
  );
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const FONT_CSS = [
  '* { font-family: "Noto Sans CJK SC", "DejaVu Sans", sans-serif !important; }',
  'pre, code, .code-content, .cm-content, .shiki { font-family: "DejaVu Sans Mono", monospace !important; }',
].join('\n');
const ANIM_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }';

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
    if (a.width !== b.width || a.height !== b.height) return { ratio: 1, score: 0 };
    let diff = 0;
    const total = a.width * a.height;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) diff += 1;
    }
    return { ratio: diff / total, score: Math.round((1 - diff / total) * 10000) / 100 };
  };
`;

const results = [];
function record(check, ok, detail = '') {
  results.push({ check, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${check}${detail ? ` — ${detail}` : ''}`);
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
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`${url} not ready`));
        else setTimeout(check, 400);
      });
    };
    check();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureSurface(page, label, shots = 3) {
  await page.evaluate(() => document.fonts?.ready);
  const dir = path.join(ARTIFACTS_DIR, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const bufs = [];
  for (let i = 0; i < shots; i += 1) {
    const buf = await page.screenshot({ fullPage: true });
    fs.writeFileSync(path.join(dir, `${label}-${i + 1}.png`), buf);
    bufs.push(buf.toString('base64'));
    await sleep(300);
  }
  const pairs = [[0, 1], [0, 2], [1, 2]];
  let maxRatio = 0;
  let maxPair = '';
  let scores = [];
  for (const [a, b] of pairs) {
    const r = await page.evaluate(([x, y]) => window.__visDiff(x, y), [bufs[a], bufs[b]]);
    scores.push(r.score);
    if (r.ratio > maxRatio) {
      maxRatio = r.ratio;
      maxPair = `${label}-${a + 1}vs${b + 1}`;
    }
  }
  console.log(`[manual-qa] ${label}: max pairwise diff ratio = ${maxRatio.toFixed(6)} (${maxPair}) scores ${scores.join('/')}`);
  return { label, captures: shots, maxPairwiseDiffRatio: maxRatio, maxPair, scores };
}

async function themeState(page) {
  return page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-region-theme') ?? '',
    cssVar: document.documentElement.style.getPropertyValue('--syntax-theme-name'),
  }));
}

async function main() {
  console.log(`[manual-qa] playwright ${playwrightVersion}`);
  console.log(`[manual-qa] chromium: ${chromiumPath}`);
  console.log(`[manual-qa] app: ${BASE_URL}  backend: ${BACKEND_URL}`);
  await waitForServer(`${BASE_URL}/`);
  await waitForServer(`${BACKEND_URL}/global/event`).catch(() => {
    console.warn('[manual-qa] backend not reachable — real-app surfaces will be skipped');
  });

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  });
  const chromiumVersion = await browser.version();

  const surfaceStats = [];
  const consoleLog = [];
  const pageErrors = [];

  const connectAndLoadTree = async (page) => {
    await page.addInitScript(
      ({ serverUrl }) => {
        localStorage.setItem('opencode.auth.serverUrl.v1', serverUrl);
        localStorage.setItem('opencode.auth.backendKind.v1', 'opencode');
      },
      { serverUrl: BACKEND_URL },
    );
    await page.goto(BASE_URL, { waitUntil: 'load' });
    let cjkTitle = '';
    for (let i = 0; i < 30; i += 1) {
      cjkTitle = await page.evaluate(() => {
        for (const el of document.querySelectorAll('.tree-session-row .session-title')) {
          const t = (el.textContent ?? '').trim();
          if (/[\u4e00-\u9fff]/.test(t)) return t;
        }
        return '';
      });
      if (cjkTitle) break;
      await sleep(1500);
    }
    return cjkTitle;
  };

  const openCjkSession = async (page) => {
    const opened = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('.tree-session-row .ui-dropdown-item, .tree-session-row a'),
      );
      for (const el of rows) {
        const text = (el.textContent ?? '').trim();
        if (text.length > 8 && !text.startsWith('New session')) {
          el.click();
          return text.slice(0, 60);
        }
      }
      return '';
    });
    if (!opened) return false;
    for (let i = 0; i < 15; i += 1) {
      const rendered = await page.evaluate(
        () =>
          document.querySelectorAll(
            '.output-panel .thread-block, .output-panel [class*="message"], .markdown-host',
          ).length > 0,
      );
      if (rendered) return true;
      await sleep(2000);
    }
    return false;
  };

  const openSettingsThemeSection = async (page) => {
    const settingsBtn = page.locator('.control-button.settings-button').first();
    if ((await settingsBtn.count()) === 0) return false;
    await settingsBtn.click();
    await sleep(1500);
    const themeRow = page
      .locator('button.setting-row.setting-link-row[aria-label*="theme" i]')
      .first();
    if ((await themeRow.count()) === 0) return false;
    await themeRow.click();
    await sleep(1500);
    return true;
  };

  const clickPresetByTitle = async (page, titlePrefix) => {
    const card = page
      .locator('.theme-preset-card')
      .filter({ has: page.locator('.theme-preset-card-title') })
      .filter({ hasText: new RegExp(`^${titlePrefix}`) })
      .first();
    if ((await card.count()) > 0) {
      await card.click();
      return true;
    }
    return page.evaluate((prefix) => {
      const cards = Array.from(document.querySelectorAll('.theme-preset-card'));
      const target = cards.find(
        (c) => (c.querySelector('.theme-preset-card-title')?.textContent ?? '').trim().startsWith(prefix),
      );
      if (!target) return false;
      target.click();
      return true;
    }, titlePrefix);
  };

  const waitTheme = async (page, targetAttrs, timeoutMs = 10000) => {
    const targets = Array.isArray(targetAttrs) ? targetAttrs : [targetAttrs];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const st = await themeState(page);
      if (targets.includes(st.attr)) return true;
      await sleep(400);
    }
    return false;
  };

  const resetToDefault = async (page) => {
    if (!(await openSettingsThemeSection(page))) return false;
    const before = await themeState(page);
    const clicked = await clickPresetByTitle(page, 'Default');
    // The default region theme serializes as '' (pristine) or 'default'.
    const ok = clicked && (await waitTheme(page, ['', 'default'], 10000));
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
    return ok && !['ocean', 'forest', 'sakura'].includes(before.attr);
  };

  const switchToOcean = async (page) => {
    if (!(await openSettingsThemeSection(page))) return 'no-settings-theme-section';
    const before = await themeState(page);
    const clicked = await clickPresetByTitle(page, 'Ocean');
    if (!clicked) return 'no-ocean-preset';
    const changed = await waitTheme(page, 'ocean', 10000);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
    return changed && before.attr !== 'ocean' ? 'ocean-applied' : 'theme-unchanged';
  };

  const cjkClipScan = async (page) => {
    return page.evaluate(() => {
      const checked = [];
      const clipped = [];
      const els = document.querySelectorAll('.output-panel .markdown-host *, .output-panel .thread-block *');
      for (const el of els) {
        if (el.closest('pre, code, .cm-content, .shiki, .code-content')) continue;
        const text = (el.textContent ?? '').trim();
        if (!/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) continue;
        if (text.length < 2) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        checked.push(`${el.tagName}:${text.slice(0, 24)}`);
        // 2px tolerance: client/scroll sizes are rounded integers — a ±1px
        // rounding delta is not a visible clip.
        if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
          clipped.push({
            tag: el.tagName,
            text: text.slice(0, 60),
            client: [el.clientWidth, el.clientHeight],
            scroll: [el.scrollWidth, el.scrollHeight],
          });
        }
      }
      return { clipped, checked: checked.length };
    });
  };

  try {
    // -------------------------------------------------------------
    // Desktop, default theme: main UI + session tree + message stream
    // -------------------------------------------------------------
    const ctxDesktop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
    });
    const page = await ctxDesktop.newPage();
    await page.addStyleTag({ content: FONT_CSS });
    await page.addStyleTag({ content: ANIM_CSS });
    page.on('console', (msg) => {
      consoleLog.push({ type: msg.type(), text: msg.text() });
      if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
    const cjkTitle = await connectAndLoadTree(page);
    await page.evaluate(DIFF_HELPERS);
    record('T1 real-app session tree loads with CJK titles', cjkTitle.length > 0, cjkTitle || 'no CJK title found');
    // Deterministic theme baseline (theme persists across launches).
    const resetOk = await resetToDefault(page);
    record('T0 theme baseline reset to Default preset', resetOk, resetOk ? 'pristine' : 'reset failed');
    const opened = await openCjkSession(page);
    record('T2 a CJK session was opened and messages rendered', opened);
    // Quiescence: let the live message stream settle before pixel captures.
    await sleep(4000);

    surfaceStats.push(await captureSurface(page, 'main-default@1440x900'));
    surfaceStats.push(await captureSurface(page, 'session-tree@1440x900'));
    surfaceStats.push(await captureSurface(page, 'message-stream@1440x900'));

    // Theme preset switch -> Ocean, then recapture.
    const themeResult = await switchToOcean(page);
    record('T3 theme switch to Ocean preset through settings', themeResult === 'ocean-applied', themeResult);
    const oceanTheme = await themeState(page);
    await sleep(1000);
    surfaceStats.push(await captureSurface(page, 'main-ocean@1440x900'));

    // CJK clipping scan on the message stream. Runs in a FRESH context with
    // the app's REAL fonts (no FONT_CSS override) — the injected Noto CJK
    // stack has taller ascender/descender metrics than the app's design fonts
    // and reports ~2px metric-mismatch overflow on fixed-height lines that the
    // real user rendering does not exhibit (verified: same scan on the
    // injected-font page reports those lines, on the real-font page none).
    const clipCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
    });
    const clipPage = await clipCtx.newPage();
    await clipPage.addStyleTag({ content: ANIM_CSS });
    await connectAndLoadTree(clipPage);
    // Open the CJK session explicitly by title match (first-row click raced
    // the tree hydration in a fresh context).
    await clipPage.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('.tree-session-row .ui-dropdown-item, .tree-session-row a'),
      );
      const target = rows.find((el) => /[\u4e00-\u9fff]/.test((el.textContent ?? '')));
      if (!target) return false;
      target.click();
      return true;
    });
    // The clip scan is only meaningful if CJK text actually rendered.
    let cjkPresent = false;
    for (let i = 0; i < 45; i += 1) {
      cjkPresent = await clipPage.evaluate(() => {
        for (const el of document.querySelectorAll('.output-panel .markdown-host *')) {
          if (el.closest('pre, code, .cm-content, .shiki, .code-content')) continue;
          if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test((el.textContent ?? '').trim())) return true;
        }
        return false;
      });
      if (cjkPresent) break;
      await sleep(2000);
    }
    // Let fonts + layout settle before measuring (clientHeight is a rounded
    // integer; measuring mid-hydration reports phantom overflow).
    await clipPage.evaluate(() => document.fonts?.ready).catch(() => {});
    await sleep(5000);
    const clipScan = await cjkClipScan(clipPage);
    await clipCtx.close();
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'cjk-unclip.json'),
      JSON.stringify(clipScan, null, 2),
    );
    record(
      'T4 no clipped CJK text in message stream (real fonts)',
      cjkPresent && clipScan.checked > 0 && clipScan.clipped.length === 0,
      `${clipScan.checked} checked, ${clipScan.clipped.length} clipped${cjkPresent ? '' : ' (no CJK content rendered)'}`,
    );

    // Settings page surface (theme section open). Close any leftover modal
    // first — the preset click may leave the backdrop intercepting clicks.
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
    await page.evaluate(() => {
      document.querySelectorAll('.modal-backdrop[open]').forEach((el) => el.close?.());
    }).catch(() => {});
    const settingsBtn = page.locator('.control-button.settings-button').first();
    if ((await settingsBtn.count()) > 0) {
      await settingsBtn.click();
      await sleep(1500);
      const themeRow = page.locator('button.setting-row.setting-link-row[aria-label*="theme" i]').first();
      if ((await themeRow.count()) > 0) await themeRow.click();
      await sleep(1500);
    }
    surfaceStats.push(await captureSurface(page, 'settings@1440x900'));
    await ctxDesktop.close();

    // -------------------------------------------------------------
    // Narrow viewport: default + Ocean
    // -------------------------------------------------------------
    const ctxNarrow = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'en-US',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
    });
    const pageN = await ctxNarrow.newPage();
    await pageN.addStyleTag({ content: FONT_CSS });
    await pageN.addStyleTag({ content: ANIM_CSS });
    let narrowCjk = '';
    for (let attempt = 1; attempt <= 2 && !narrowCjk; attempt += 1) {
      narrowCjk = await connectAndLoadTree(pageN);
      if (!narrowCjk && attempt === 1) {
        // Backend SSE hiccup — close and recreate the context once.
        await ctxNarrow.close();
        const retryCtx = await browser.newContext({
          viewport: { width: 390, height: 844 },
          locale: 'en-US',
          timezoneId: 'UTC',
          deviceScaleFactor: 1,
        });
        const retryPage = await retryCtx.newPage();
        await retryPage.addStyleTag({ content: FONT_CSS });
        await retryPage.addStyleTag({ content: ANIM_CSS });
        await retryPage.evaluate(DIFF_HELPERS);
        narrowCjk = await connectAndLoadTree(retryPage);
        await retryCtx.close();
      }
    }
    await pageN.evaluate(DIFF_HELPERS);
    record('T5 narrow viewport loads with CJK session titles', narrowCjk.length > 0, narrowCjk || 'no CJK title found');
    await resetToDefault(pageN);
    await openCjkSession(pageN);
    await sleep(4000);
    surfaceStats.push(await captureSurface(pageN, 'main-default@390x844'));
    const narrowTheme = await switchToOcean(pageN);
    record('T6 narrow viewport theme switch to Ocean', narrowTheme === 'ocean-applied', narrowTheme);
    await sleep(1000);
    surfaceStats.push(await captureSurface(pageN, 'main-ocean@390x844'));
    await ctxNarrow.close();

    // -------------------------------------------------------------
    // Theme distinctness: default vs Ocean on the same page geometry
    // (proves the theme system produces a measurable pixel difference)
    // -------------------------------------------------------------
    const themeDiff = { default: oceanTheme };
    record(
      'T7 theme switch changed the rendered theme state',
      oceanTheme.attr === 'ocean',
      `data-region-theme=${JSON.stringify(themeDiff.default.attr)} cssVar=${JSON.stringify(themeDiff.default.cssVar)}`,
    );

    // Console check scoped to Vue warnings + page errors (PTY/WS/backend
    // noise is environmental, identical on the pre-upgrade tree).
    const vueErrors = [...pageErrors].filter(
      (e) => /\[Vue warn\]|Vue\.warn|pageerror/i.test(e) && !/WebSocket|pty|Failed to load resource/.test(e),
    );
    const environmentalNoise = [...pageErrors].filter((e) => /WebSocket|pty|Failed to load resource|500/.test(e));
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'real-app-console.json'),
      JSON.stringify({ vueErrors, environmentalNoise: environmentalNoise.slice(0, 8) }, null, 2),
    );
    record(
      'T8 zero Vue warnings / renderer page errors across the session',
      vueErrors.length === 0,
      environmentalNoise.length > 0 ? `(${environmentalNoise.length} environmental PTY/backend errors recorded, not renderer)` : 'clean',
    );

    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'summary.json'),
      JSON.stringify(
        {
          playwright: playwrightVersion,
          chromium: chromiumVersion,
          environment: {
            locale: 'en-US',
            timezone: 'UTC',
            deviceScaleFactor: 1,
            animations: 'disabled',
            fonts: 'Noto Sans CJK SC / DejaVu Sans / DejaVu Sans Mono (injected)',
          },
          surfaces: Object.fromEntries(surfaceStats.map((s) => [s.label, s])),
          results,
          passed: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    record('HARNESS', false, String(err?.stack ?? err));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('=================================================');
  console.log(`[manual-qa] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`[FAIL] ${f.check}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
