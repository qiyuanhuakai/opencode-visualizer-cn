import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const BUDGET_PATH = path.join(REPO_ROOT, 'artifact-budget.json');
const CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts/qa/build-artifact-check.mjs');
const QA_SCRIPTS = [
  'scripts/qa/stream-driver-check.mjs',
  'scripts/qa/stream-md-check.mjs',
  'scripts/qa/stream-bench.mjs',
];

const ceilKiB = (bytes: number) => Math.ceil(bytes / 1024) * 1024;

// Build artifact contract (Task 7, Vite 8 migration):
//  1. artifact-budget.json is FROZEN — its caps are the pre-upgrade formula
//     (per asset: ceil(oldBytes*1.20/1024)*1024; total: ceil(old*1.10/1024)*1024)
//     applied to the recorded pre-upgrade bytes, and are NEVER recomputed.
//  2. scripts/qa/build-artifact-check.mjs measures a real build against that
//     budget (no absolute /assets in index.html, relative app://-loadable
//     refs, critical chunks present, per-asset + total caps respected).
//  3. the three stream QA scripts resolve Playwright/Chromium ONLY from the
//     repo-root node_modules and print both versions into their receipts —
//     no hardcoded Node 22 install paths, no npx cache, no global fallback.
describe('build artifact contract', () => {
  it('freezes a valid artifact budget with the pre-upgrade formula', () => {
    const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as {
      formula: { perAssetRatio: number; totalRatio: number; roundingKiB: number };
      criticalAssets: Record<string, { glob: string; oldBytes: number; cap: number }>;
      totalBytes: { oldBytes: number; cap: number };
    };
    expect(budget.formula).toEqual({
      perAssetRatio: 1.2,
      totalRatio: 1.1,
      roundingKiB: 1024,
    });
    const entries = Object.entries(budget.criticalAssets);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [, entry] of entries) {
      expect(entry.glob).toMatch(/^\S+-\*\.(js|css)$/);
      expect(entry.oldBytes).toBeGreaterThan(0);
      expect(entry.cap).toBe(ceilKiB(entry.oldBytes * 1.2));
      expect(entry.cap).toBeGreaterThan(entry.oldBytes);
    }
    expect(budget.totalBytes.oldBytes).toBeGreaterThan(0);
    expect(budget.totalBytes.cap).toBe(ceilKiB(budget.totalBytes.oldBytes * 1.1));
  });

  it('wires a check script that measures dist against the frozen budget', () => {
    const src = readFileSync(CHECK_SCRIPT, 'utf8');
    const helperSrc = readFileSync(path.join(REPO_ROOT, 'scripts/qa/ensure-production-dist.mjs'), 'utf8');
    const serverLiveSrc = readFileSync(path.join(REPO_ROOT, 'app/serverLive.integration.test.ts'), 'utf8');
    expect(src).toMatch(/^#!\/usr\/bin\/env node/);
    expect(src).toContain('artifact-budget.json');
    expect(src).toMatch(/ensure-production-dist\.mjs/); // auto-build path
    expect(src).toMatch(/\/assets\//); // absolute-ref detection
    expect(src).toMatch(/criticalAssets/);
    expect(src).toMatch(/totalBytes/);
    // The auto-build must produce the REAL production artifact: NODE_ENV=test
    // (vitest) poisons `vite build` into a different bundle that can break the
    // frozen budget (task 12 regression); the helper forces production and
    // lock-serializes concurrent builders on clean checkouts.
    expect(helperSrc).toContain('pnpm build');
    expect(helperSrc).toMatch(/NODE_ENV:\s*'production'/);
    expect(helperSrc).toContain('.ensure-dist.lock');
    // The live server contract serves real dist artifacts; on a clean checkout
    // (test before build, CI validate order) it must ensure dist first.
    expect(serverLiveSrc).toContain('ensure-production-dist.mjs');
  });

  it('produces a GREEN artifact report (index.html relative, chunks present, budget respected)', {
    timeout: 180000,
  }, () => {
    const reportPath = path.join(os.tmpdir(), `vis-artifact-report-${process.pid}.json`);
    try {
      const res = spawnSync(
        process.execPath,
        ['scripts/qa/build-artifact-check.mjs', `--report=${reportPath}`],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 170000 },
      );
      expect(res.status, res.stdout + res.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        passed: boolean;
        passCount: number;
        failCount: number;
        checks: { name: string; ok: boolean }[];
      };
      expect(report.passed).toBe(true);
      expect(report.failCount).toBe(0);
      expect(report.passCount).toBe(report.checks.length);
      const names = report.checks.map((c) => c.name).join('|');
      expect(names).toContain('no absolute /assets references');
      expect(names).toContain('every relative asset reference exists on disk');
      expect(names).toContain('within cap');
      expect(names).toContain('within total cap');
    } finally {
      rmSync(reportPath, { force: true });
    }
  });
});

describe('stream QA script browser resolution contract', () => {
  it('forbids hardcoded Node 22 install paths, npx cache and global fallbacks', () => {
    for (const rel of QA_SCRIPTS) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src, `${rel} must not contain a hardcoded node v22 path`).not.toMatch(/v22\./);
      expect(src, `${rel} must not scan the npx cache`).not.toMatch(/\.npm\/_npx/);
      expect(src, `${rel} must not query the global npm root`).not.toMatch(/npm root -g/);
      expect(src, `${rel} must not fall back to a global @playwright/cli install`).not.toMatch(/@playwright\/cli/);
    }
  });

  it('resolves Playwright ONLY from the repo-root node_modules', () => {
    for (const rel of QA_SCRIPTS) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src, `${rel} must statically resolve node_modules/playwright from the repo root`)
        .toMatch(/node_modules\/playwright/);
      expect(src, `${rel} must not resolve from a package-qualified global install`)
        .not.toMatch(/node_modules\/@playwright/);
    }
  });

  it('prints Playwright AND Chromium versions into its receipts', () => {
    for (const rel of QA_SCRIPTS) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src, `${rel} must record the playwright version`).toMatch(/playwrightVersion|pwInfo\.version/);
      expect(src, `${rel} must record the chromium version from the launched browser`)
        .toMatch(/browser\.version\(\)/);
      expect(src, `${rel} must write the chromium version into its summary receipt`)
        .toMatch(/chromiumVersion/);
    }
  });
});
