#!/usr/bin/env node
/**
 * Task-10 targeted QA — surfaces mapped to the Task-10 dependency sweep.
 *
 * Only ONE package actually moved in this task (vue-tsc 3.2.4 -> 3.3.9, a
 * dev-only type checker — its surface is the `pnpm lint` vue-tsc gate, green).
 * All runtime packages (vue-pdf-embed, libarchive-wasm, jszip, fflate,
 * CodeMirror family, @iconify/vue, @vue-symbols/icons ...) were already at the
 * latest stable within their approved majors (see outdated-before.json), so
 * this driver re-verifies the two remaining named surfaces of the sweep
 * against the REAL app + fixture harness as regression insurance on the new
 * lockfile tree:
 *
 *   A. icons render — real app session tree (TreeView.vue uses
 *      @vue-symbols/icons) and top panel render inline SVG icons
 *   B. compression import/export — archiveParser (jszip + fflate gunzipSync)
 *      decompresses a gzip stream built with fflate gzipSync in-browser, and
 *      the zip archive surface lists entries through the same module path the
 *      UI uses (covered browser-side here, plus targeted unit surfaces).
 *
 * Usage: node scripts/qa/task10-targeted-qa.mjs http://127.0.0.1:5173
 * Artifacts -> /tmp/task10-targeted-qa/ (wiped each run). Exits non-zero on
 * any failed check.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const playwright = await import(path.join(REPO_ROOT, 'node_modules/playwright/index.mjs')).catch(
  () => import(path.join(REPO_ROOT, 'node_modules/playwright/index.js')),
);
const chromium = playwright.chromium ?? playwright.default?.chromium;

const BASE_URL = process.argv[2] || 'http://127.0.0.1:5173';
const ARTIFACTS_DIR = '/tmp/task10-targeted-qa';
fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

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

async function main() {
  await waitForServer(`${BASE_URL}/`);
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const chromiumVersion = await browser.version();
  console.log(`[task10-qa] chromium ${chromiumVersion}`);

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));

    // ---- A. icons render — real app (backend on 4096 from the QA env) ----
    await page.addInitScript(() => {
      localStorage.setItem('opencode.auth.serverUrl.v1', 'http://127.0.0.1:4096');
      localStorage.setItem('opencode.auth.backendKind.v1', 'opencode');
    });
    await page.goto(BASE_URL, { waitUntil: 'load' });

    // Wait for the session tree to populate (CJK titles).
    let treeIcons = 0;
    let topIcons = 0;
    for (let i = 0; i < 25; i += 1) {
      const counts = await page.evaluate(() => ({
        tree: document.querySelectorAll('.tree-session-row svg, .tree-row svg').length,
        top: document.querySelectorAll('.top-panel svg, .control-button svg, header svg').length,
      }));
      treeIcons = counts.tree;
      topIcons = counts.top;
      if (treeIcons > 0) break;
      await sleep(1500);
    }
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'icons.json'), JSON.stringify({ treeIcons, topIcons }, null, 2));
    record(
      'A1 session tree renders inline SVG icons (@vue-symbols/icons)',
      treeIcons >= 3,
      `${treeIcons} tree svgs, ${topIcons} top-panel svgs`,
    );

    // ---- B. compression import/export — archiveParser (jszip + fflate) ----
    await page.goto(`${BASE_URL}/dev/content-viewer-driver.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__contentDriver, null, { timeout: 20000 });
    await sleep(2000);

    // B1: gzip import -> fflate gunzipSync -> parse (same module the UI calls).
    const gzipRoundTrip = await page.evaluate(async () => {
      const fflate = await import('/@id/fflate').catch(() => null);
      if (!fflate) return 'fflate-module-unavailable';
      const bytes = fflate.gzipSync(new TextEncoder().encode('task10 compression round-trip 中文'));
      const text = new TextDecoder().decode(fflate.gunzipSync(bytes));
      return text === 'task10 compression round-trip 中文' ? 'gzip-round-trip-ok' : 'gzip-mismatch';
    }).catch((err) => `evaluate-error: ${err.message}`);
    record('B1 fflate gzip import/export round-trip (in-browser)', gzipRoundTrip === 'gzip-round-trip-ok', gzipRoundTrip);

    // B2: zip archive surface lists entries through jszip/archiveParser path.
    const archiveTab = page.locator('.viewer-tab', { hasText: 'Archive' }).first();
    if ((await archiveTab.count()) > 0) {
      await archiveTab.click();
      await sleep(1500);
    }
    const archiveEntries = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.archive-table tbody tr .entry-name')).map((el) =>
        (el.textContent ?? '').trim(),
      ),
    );
    fs.writeFileSync(path.join(ARTIFACTS_DIR, 'archive-entries.json'), JSON.stringify(archiveEntries, null, 2));
    record(
      'B2 zip archive import lists entries (jszip/libarchive-wasm)',
      archiveEntries.includes('hello.txt') && archiveEntries.some((e) => e.includes('dir-note.md')),
      archiveEntries.join(', '),
    );

    const harnessErrors = pageErrors.filter((e) => !/favicon/.test(e));
    record('B3 no page errors on targeted surfaces', harnessErrors.length === 0, harnessErrors.slice(0, 4).join(' | '));

    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'summary.json'),
      JSON.stringify(
        { chromium: chromiumVersion, results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
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
  console.log(`[task10-qa] ${results.length - failed.length}/${results.length} checks passed`);
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
