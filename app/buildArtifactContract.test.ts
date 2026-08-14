import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const BUDGET_PATH = path.join(REPO_ROOT, 'artifact-budget.json');
const ENSURE_SCRIPT = path.join(REPO_ROOT, 'scripts/qa/ensure-production-dist.mjs');
const QA_SCRIPTS = [
  'scripts/qa/stream-driver-check.mjs',
  'scripts/qa/stream-md-check.mjs',
  'scripts/qa/stream-bench.mjs',
];

const ceilKiB = (bytes: number) => Math.ceil(bytes / 1024) * 1024;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// ensure-production-dist behavioral harness
//
// A REAL `vite build` is far too slow for serialization tests, so each test
// builds a throwaway project in os.tmpdir() whose `pnpm build` runs a FAKE
// builder that mimics the production build's dangerous properties:
//   - wipes dist/ recursively at the start (vite `emptyOutDir: true`) —
//     a lock living INSIDE dist/ is deleted by its own owner's build, which
//     is exactly the F3 #3 defect;
//   - optionally sleeps before writing the marker (so a concurrent caller
//     arrives mid-build);
//   - records NODE_ENV into dist/index.html (the production-env guarantee)
//     and appends a line to .build-count per invocation (build counting).
// The fake builder is written into the throwaway project, NOT into the repo.
// ---------------------------------------------------------------------------

const FAKE_BUILDER_SRC = `
import fs from 'node:fs';
import path from 'node:path';
const dist = path.join(process.cwd(), 'dist');
fs.appendFileSync(path.join(process.cwd(), '.build-count'), 'x\\n');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), '.wipe-done'), '1');
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_BUILD_SLEEP_MS ?? 0)));
fs.writeFileSync(
  path.join(dist, 'index.html'),
  '<!doctype html><html><body data-env="' + process.env.NODE_ENV + '"></body></html>',
);
fs.writeFileSync(path.join(dist, 'assets', 'entry.js'), 'console.log(1)');
`;

async function makeFakeProject(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vis-ensure-dist-proj-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'fake-dist-project', private: true, scripts: { build: 'node fake-builder.mjs' } },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, 'fake-builder.mjs'), FAKE_BUILDER_SRC);
  return dir;
}

/** Lock path outside dist/ — mirrors scripts/qa/ensure-production-dist.mjs lockPathFor. */
function tmpLockPathFor(projDir: string): string {
  const key = createHash('sha1').update(path.resolve(projDir)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'vis-ensure-dist', `${key}.lock`);
}

/** Returns a PID that is guaranteed dead (spawned, then SIGKILLed and reaped). */
async function deadPid(): Promise<number> {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(sleeper, 'spawn');
  if (sleeper.pid === undefined) throw new Error('sleeper spawn produced no pid');
  const pid = sleeper.pid;
  sleeper.kill('SIGKILL');
  await once(sleeper, 'exit');
  return pid;
}

const runningChildren = new Set<ReturnType<typeof spawn>>();
afterEach(() => {
  for (const child of runningChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGKILL'); // detached: true → whole process group
    } catch {
      child.kill('SIGKILL');
    }
  }
  runningChildren.clear();
});

function spawnEnsureCli(projDir: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    [ENSURE_SCRIPT, '--cwd', projDir],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  runningChildren.add(child);
  return child;
}

async function exitOf(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const code = await Promise.race([
    once(child, 'exit').then(([code]) => (typeof code === 'number' ? code : 1)),
    delay(timeoutMs).then(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      return -1;
    }),
  ]);
  return { code, stdout, stderr };
}

function buildCount(projDir: string): number {
  try {
    return readFileSync(path.join(projDir, '.build-count'), 'utf8').trim().split('\n').filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function readIndexEnv(projDir: string): string {
  const html = readFileSync(path.join(projDir, 'dist', 'index.html'), 'utf8');
  const match = html.match(/data-env="([^"]+)"/);
  return match?.[1] ?? '';
}

function indexComplete(projDir: string): boolean {
  try {
    if (statSync(path.join(projDir, 'dist', 'index.html')).size === 0) return false;
    return readdirSync(path.join(projDir, 'dist', 'assets')).length > 0;
  } catch {
    return false;
  }
}

// Build artifact contract (Task 7, Vite 8 migration):
//  1. artifact-budget.json is FROZEN — its caps are the pre-upgrade formula
//     (per asset: ceil(oldBytes*1.20/1024)*1024; total: ceil(old*1.10/1024)*1024)
//     applied to the recorded pre-upgrade bytes, and are NEVER recomputed.
//  2. scripts/qa/build-artifact-check.mjs measures a real build against that
//     budget (no absolute /assets in index.html, ≥1 relative app://-loadable
//     ref and every ref resolvable, critical chunks present, per-asset +
//     total caps respected).
//  3. scripts/qa/ensure-production-dist.mjs serializes concurrent builders
//     on a clean checkout with a lock OUTSIDE dist/ (survives the owner's
//     own emptyOutDir wipe), recovers a stale lock left by a crashed owner
//     (dead PID → take over), rebuilds partial/corrupt markers, and always
//     builds with NODE_ENV=production.
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

// F3 #3: the lock must survive the owner's own build (vite emptyOutDir wipes
// dist/), stale locks from crashed owners must be taken over, and partial or
// corrupt markers must trigger a rebuild — all while forcing NODE_ENV=
// production regardless of the caller's environment (vitest NODE_ENV=test).
describe('ensure-production-dist build serialization', () => {
  it('serializes concurrent callers on a wiped dist (exactly one build, both succeed)', {
    timeout: 60000,
  }, async () => {
    const projDir = await makeFakeProject();
    const outputs: Record<string, string> = {};
    try {
      const first = spawnEnsureCli(projDir, { FAKE_BUILD_SLEEP_MS: '2000' });
      // Wait until the fake builder has performed its emptyOutDir wipe —
      // the concurrent caller must arrive AFTER the wipe (when a lock inside
      // dist/ has just been deleted by its owner) but BEFORE the marker write.
      const wipeDeadline = Date.now() + 15000;
      while (!existsSync(path.join(projDir, '.wipe-done'))) {
        if (Date.now() > wipeDeadline) {
          throw new Error('fake builder never reached its wipe marker');
        }
        await delay(50);
      }
      const second = spawnEnsureCli(projDir, { FAKE_BUILD_SLEEP_MS: '2000' });

      const [firstRes, secondRes] = await Promise.all([
        exitOf(first, 45000),
        exitOf(second, 45000),
      ]);
      outputs.first = firstRes.stdout + firstRes.stderr;
      outputs.second = secondRes.stdout + secondRes.stderr;
      expect(firstRes.code, `first caller: ${outputs.first}`).toBe(0);
      expect(secondRes.code, `second caller: ${outputs.second}`).toBe(0);
      // RED (pre-fix): the owner's emptyOutDir wipe deletes its own lock, so
      // the second caller re-acquires it and builds again → 2 builds.
      expect(buildCount(projDir), outputs.first + outputs.second).toBe(1);
      // The serialized build must be the REAL production artifact.
      expect(indexComplete(projDir)).toBe(true);
      expect(readIndexEnv(projDir)).toBe('production');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('takes over a stale lock left by a crashed owner (dead PID)', {
    timeout: 60000,
  }, async () => {
    const projDir = await makeFakeProject();
    const pid = await deadPid();
    // A crashed owner leaves its lock dir + owner.pid (dead PID) behind.
    // Create it at BOTH known locations so the RED phase (lock inside dist/)
    // and the fixed phase (lock outside dist/) both see a stale lock.
    const staleLocks = [
      path.join(projDir, 'dist', '.ensure-dist.lock'),
      tmpLockPathFor(projDir),
    ];
    for (const lock of staleLocks) {
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        path.join(lock, 'owner.json'),
        JSON.stringify({ pid, token: 'stale-test-owner' }),
      );
    }
    try {
      const child = spawnEnsureCli(projDir, { VIS_DIST_POLL_TIMEOUT_MS: '300' });
      const res = await exitOf(child, 30000);
      // RED (pre-fix): stale locks are never removed — the caller waits
      // through the full poll budget and fails. Fixed: the dead owner is
      // detected, its lock removed, and the build proceeds.
      expect(res.code, res.stdout + res.stderr).toBe(0);
      expect(indexComplete(projDir)).toBe(true);
      expect(readIndexEnv(projDir)).toBe('production');
      expect(buildCount(projDir)).toBe(1);
    } finally {
      for (const lock of staleLocks) {
        rmSync(lock, { recursive: true, force: true });
      }
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('acquires over a lock dir whose owner identity is unidentifiable (no owner.json)', {
    timeout: 30000,
  }, async () => {
    // An owner that crashed between mkdir and the atomic owner.json publish
    // (pre-token code) leaves a lock dir with NO identity. With the atomic
    // acquire-with-identity (F3 round-3), an EMPTY lock dir is replaced by
    // the acquire's rename itself — the winner's identity is visible from
    // the lock's first instant, so an identity-less dir can never be a live
    // owner's. Asserts the full contract after the CLI exits 0: exactly one
    // build, complete production artifact, lock dir gone.
    const projDir = await makeFakeProject();
    const lockPath = tmpLockPathFor(projDir);
    mkdirSync(lockPath, { recursive: true }); // no owner.json, no owner.pid
    try {
      const child = spawnEnsureCli(projDir, {
        VIS_DIST_POLL_TIMEOUT_MS: '300',
        VIS_DIST_POLL_STEP_MS: '50',
        FAKE_BUILD_SLEEP_MS: '500',
      });
      const res = await exitOf(child, 20000);
      expect(res.code, res.stdout + res.stderr).toBe(0);
      expect(buildCount(projDir)).toBe(1);
      expect(indexComplete(projDir)).toBe(true);
      expect(readIndexEnv(projDir)).toBe('production');
      expect(existsSync(lockPath)).toBe(false);
      const key = createHash('sha1').update(path.resolve(projDir)).digest('hex').slice(0, 16);
      const leftovers = readdirSync(path.join(os.tmpdir(), 'vis-ensure-dist')).filter(
        (f) => f.startsWith(`${key}.lock`),
      );
      expect(leftovers, JSON.stringify(leftovers)).toEqual([]);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
      rmSync(lockPath, { recursive: true, force: true });
    }
  });

  it('builds exactly once when a caller is slowed after acquiring (no publish window)', {
    timeout: 60000,
  }, async () => {
    // F3 round-3 deterministic repro: acquisition (mkdir) and identity
    // publication (owner.json) were separate operations. A caller paused
    // after its mkdir left an ownerless lock dir; a waiter with a short
    // ownerless timeout took it over, deleted the live-but-unpublished
    // owner's lock, and BOTH callers built (duplicate builds, both exit 0).
    // The slowed caller here pauses VIS_DIST_ACQUIRE_PAUSE_MS after
    // acquiring; the contender uses a 100ms ownerless timeout so it ages
    // out the window while the slow caller is still paused.
    const projDir = await makeFakeProject();
    try {
      const slow = spawnEnsureCli(projDir, {
        VIS_DIST_ACQUIRE_PAUSE_MS: '3000',
        FAKE_BUILD_SLEEP_MS: '500',
      });
      // Arrive after the slow caller has acquired but long before it
      // resumes from its pause.
      await delay(500);
      const fast = spawnEnsureCli(projDir, {
        VIS_DIST_POLL_TIMEOUT_MS: '100',
        VIS_DIST_POLL_STEP_MS: '50',
        FAKE_BUILD_SLEEP_MS: '500',
      });
      const [slowRes, fastRes] = await Promise.all([exitOf(slow, 30000), exitOf(fast, 30000)]);
      expect(slowRes.code, slowRes.stdout + slowRes.stderr).toBe(0);
      expect(fastRes.code, fastRes.stdout + fastRes.stderr).toBe(0);
      expect(buildCount(projDir), slowRes.stdout + fastRes.stderr).toBe(1);
      expect(indexComplete(projDir)).toBe(true);
      expect(readIndexEnv(projDir)).toBe('production');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('takes over a stale lock race-free under N concurrent waiters (one build, all succeed)', {
    timeout: 180000,
  }, async () => {
    // Round-2 reviewer reproduction: 8 concurrent callers against ONE stale
    // lock (dead owner PID) produced caller failures AND duplicate builds —
    // every waiter polled the dead owner, then each rmSync'd the lock based
    // on its stale observation; a waiter whose rmSync landed after the new
    // owner's mkdir deleted the LIVE owner's lock and a third caller rebuilt.
    // The fix must make the takeover atomic: exactly one builder invocation,
    // every caller exits 0, and no live owner's lock is ever deleted. The
    // race is probabilistic, so the scenario repeats CONSECUTIVE_ROUNDS with
    // a fresh project and a freshly killed owner PID each time.
    const rounds = 5;
    for (let round = 0; round < rounds; round++) {
      const projDir = await makeFakeProject();
      const pid = await deadPid();
      const lockPath = tmpLockPathFor(projDir);
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ pid, token: `stale-${round}` }),
      );
      try {
        const children = Array.from({ length: 8 }, () =>
          spawnEnsureCli(projDir, {
            VIS_DIST_POLL_TIMEOUT_MS: '500',
            VIS_DIST_POLL_STEP_MS: '50',
            FAKE_BUILD_SLEEP_MS: '2000',
          }),
        );
        const results = await Promise.all(children.map((c) => exitOf(c, 30000)));
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          expect(
            res.code,
            `caller ${i} of round ${round}: ${res.stdout + res.stderr}`,
          ).toBe(0);
        }
        // Exactly one builder invocation. A second build means a waiter
        // deleted the new owner's lock from a stale observation and a third
        // caller re-acquired — the RED pre-fix symptom.
        expect(buildCount(projDir), `round ${round}`).toBe(1);
        expect(indexComplete(projDir)).toBe(true);
        expect(readIndexEnv(projDir)).toBe('production');
        // The winner cleaned up its own lock; a takeover that displaced a
        // live lock would have left it (or a `.takeover-*` claim dir) behind.
        expect(existsSync(lockPath), `round ${round}`).toBe(false);
        const key = createHash('sha1').update(path.resolve(projDir)).digest('hex').slice(0, 16);
        const leftovers = readdirSync(path.join(os.tmpdir(), 'vis-ensure-dist')).filter(
          (f) => f.startsWith(`${key}.lock`),
        );
        expect(leftovers, `round ${round}: ${JSON.stringify(leftovers)}`).toEqual([]);
      } finally {
        rmSync(projDir, { recursive: true, force: true });
        rmSync(lockPath, { recursive: true, force: true });
      }
    }
  });

  it('rebuilds when the dist marker is missing', {
    timeout: 30000,
  }, async () => {
    const projDir = await makeFakeProject();
    try {
      mkdirSync(path.join(projDir, 'dist'), { recursive: true });
      writeFileSync(path.join(projDir, 'dist', 'stray.txt'), 'leftover');
      const res = await exitOf(spawnEnsureCli(projDir), 20000);
      expect(res.code, res.stdout + res.stderr).toBe(0);
      expect(buildCount(projDir)).toBe(1);
      expect(indexComplete(projDir)).toBe(true);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('rebuilds when the marker is corrupt (empty index.html)', {
    timeout: 30000,
  }, async () => {
    const projDir = await makeFakeProject();
    try {
      mkdirSync(path.join(projDir, 'dist'), { recursive: true });
      writeFileSync(path.join(projDir, 'dist', 'index.html'), '');
      const res = await exitOf(spawnEnsureCli(projDir), 20000);
      expect(res.code, res.stdout + res.stderr).toBe(0);
      // RED (pre-fix): an existing (but empty) index.html satisfies the
      // existence fast path → no rebuild, unusable artifact left behind.
      expect(buildCount(projDir)).toBeGreaterThanOrEqual(1);
      expect(indexComplete(projDir)).toBe(true);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('rebuilds when the build is partial (index.html without assets)', {
    timeout: 30000,
  }, async () => {
    const projDir = await makeFakeProject();
    try {
      mkdirSync(path.join(projDir, 'dist'), { recursive: true });
      writeFileSync(path.join(projDir, 'dist', 'index.html'), '<html></html>');
      const res = await exitOf(spawnEnsureCli(projDir), 20000);
      expect(res.code, res.stdout + res.stderr).toBe(0);
      // RED (pre-fix): an existing non-empty index.html short-circuits even
      // though every referenced asset is missing.
      expect(buildCount(projDir)).toBeGreaterThanOrEqual(1);
      expect(indexComplete(projDir)).toBe(true);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('does not rebuild an already-complete dist', {
    timeout: 30000,
  }, async () => {
    const projDir = await makeFakeProject();
    try {
      mkdirSync(path.join(projDir, 'dist', 'assets'), { recursive: true });
      writeFileSync(path.join(projDir, 'dist', 'index.html'), '<html></html>');
      writeFileSync(path.join(projDir, 'dist', 'assets', 'entry.js'), 'x');
      const res = await exitOf(spawnEnsureCli(projDir), 20000);
      expect(res.code, res.stdout + res.stderr).toBe(0);
      expect(buildCount(projDir)).toBe(0);
    } finally {
      rmSync(projDir, { recursive: true, force: true });
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
