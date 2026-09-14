import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('build artifact contract', () => {
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
      expect(names).toContain('at least one relative asset');
      expect(names).toContain('every relative asset reference exists on disk');
      expect(names).toContain('within cap');
      expect(names).toContain('within total cap');
    } finally {
      rmSync(reportPath, { force: true });
    }
  });
});
