#!/usr/bin/env node
/**
 * Build artifact contract checker — Task 7 (Vite 8 migration).
 *
 * Verifies that a production build of dist/ satisfies the FROZEN artifact
 * budget (artifact-budget.json at the repo root):
 *
 *   - dist/index.html contains NO absolute /assets references — every asset
 *     URL is relative (./assets/...) so the app:// protocol handler and
 *     GitHub Pages both load it; every referenced file must exist on disk.
 *   - every critical asset (entry JS/CSS, vendor chunks, worker chunks) stays
 *     within its per-asset cap (ceil(oldBytes * 1.20 / 1024) * 1024).
 *   - the sum of ALL files under dist/assets stays within the total cap
 *     (ceil(oldTotalBytes * 1.10 / 1024) * 1024).
 *
 * The budget is FROZEN from the pre-upgrade build and is NEVER recomputed
 * from post-upgrade output — this script only measures and compares.
 *
 * Usage:
 *   node scripts/qa/build-artifact-check.mjs [--no-build] [--report <path>]
 *
 * If dist/index.html is missing (clean checkout) the script runs `pnpm build`
 * first unless --no-build is given. The report is written to the --report
 * path, defaulting to <repo>/artifact-report.json. Exits non-zero on any
 * failed check.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const BUDGET_PATH = path.join(REPO_ROOT, 'artifact-budget.json');
const INDEX_PATH = path.join(DIST_DIR, 'index.html');

const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const reportArg = argv.find((a) => a.startsWith('--report='));
const REPORT_PATH = reportArg
  ? path.resolve(reportArg.slice('--report='.length))
  : path.join(REPO_ROOT, 'artifact-report.json');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function pkgVersion(name) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8'),
    ).version;
  } catch {
    return 'unknown';
  }
}

function globToRegex(glob) {
  return new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`);
}

function main() {
  if (!fs.existsSync(INDEX_PATH)) {
    if (noBuild) {
      console.error('[build-artifact-check] dist/index.html missing and --no-build given');
      process.exit(2);
    }
    console.log('[build-artifact-check] dist missing — running pnpm build');
    execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }

  if (!fs.existsSync(BUDGET_PATH)) {
    console.error(`[build-artifact-check] frozen budget missing: ${BUDGET_PATH}`);
    process.exit(2);
  }
  const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));
  const { perAssetRatio, totalRatio, roundingKiB } = budget.formula;
  const ceilKiB = (bytes) => Math.ceil(bytes / roundingKiB) * roundingKiB;

  // Budget self-consistency: caps must equal the frozen formula applied to the
  // recorded pre-upgrade bytes (never recomputed from current dist).
  for (const [label, entry] of Object.entries(budget.criticalAssets)) {
    const expected = ceilKiB(entry.oldBytes * perAssetRatio);
    check(`budget ${label} cap frozen by formula`, entry.cap === expected,
      `cap=${entry.cap} formula=${expected} old=${entry.oldBytes}`);
  }
  {
    const expected = ceilKiB(budget.totalBytes.oldBytes * totalRatio);
    check('budget total cap frozen by formula', budget.totalBytes.cap === expected,
      `cap=${budget.totalBytes.cap} formula=${expected} old=${budget.totalBytes.oldBytes}`);
  }

  // dist/index.html: no absolute asset references; every relative ref exists.
  const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  const absoluteRefs = indexHtml.match(/(?:src|href)="\/assets\//g) ?? [];
  check('index.html has no absolute /assets references', absoluteRefs.length === 0,
    absoluteRefs.length ? absoluteRefs.join(', ') : 'all refs relative');
  const relativeRefs = indexHtml.match(/(?:src|href)="(\.\/assets\/[^"]+)"/g) ?? [];
  const missingRefs = [];
  for (const ref of relativeRefs) {
    const file = ref.match(/(?:src|href)="(\.\/assets\/[^"]+)"/)[1];
    if (!fs.existsSync(path.join(DIST_DIR, file))) missingRefs.push(file);
  }
  check('every relative asset reference exists on disk (app:// loadable)', missingRefs.length === 0,
    missingRefs.length ? missingRefs.join(', ') : `${relativeRefs.length} refs resolved`);

  // Critical assets within their per-asset caps.
  const assetSizes = new Map(
    fs.readdirSync(ASSETS_DIR).map((f) => [f, fs.statSync(path.join(ASSETS_DIR, f)).size]),
  );
  const criticalActual = {};
  for (const [label, entry] of Object.entries(budget.criticalAssets)) {
    const re = globToRegex(entry.glob);
    const matches = [...assetSizes.keys()].filter((f) => re.test(f));
    if (matches.length === 0) {
      check(`critical chunk "${entry.glob}" exists`, false, 'no file matches');
      continue;
    }
    const max = Math.max(...matches.map((f) => assetSizes.get(f)));
    criticalActual[label] = { files: matches, maxBytes: max };
    check(`critical chunk "${entry.glob}" within cap`, max <= entry.cap,
      `${max}B <= ${entry.cap}B (files: ${matches.join(', ')})`);
  }

  // Total of all assets within the total cap.
  const totalActual = [...assetSizes.values()].reduce((s, n) => s + n, 0);
  check('total assets within total cap', totalActual <= budget.totalBytes.cap,
    `${totalActual}B <= ${budget.totalBytes.cap}B (${assetSizes.size} files)`);

  const failed = checks.filter((c) => !c.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    builtWith: {
      vite: pkgVersion('vite'),
      vitest: pkgVersion('vitest'),
      'happy-dom': pkgVersion('happy-dom'),
    },
    budgetPath: path.relative(REPO_ROOT, BUDGET_PATH),
    frozenFrom: budget.frozenFrom,
    checks,
    passCount: checks.length - failed.length,
    failCount: failed.length,
    passed: failed.length === 0,
    totalBytes: { actual: totalActual, cap: budget.totalBytes.cap },
    criticalAssets: criticalActual,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[build-artifact-check] report: ${REPORT_PATH}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
