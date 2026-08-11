#!/usr/bin/env node
/**
 * Ensure a REAL production build exists at <repo>/dist before dist-dependent
 * gates (build-artifact-check, serverLive integration tests) measure or serve
 * it — even when `pnpm test` runs before `pnpm build` on a clean checkout
 * (CI validate job order) and even when the test runner's own environment
 * carries NODE_ENV=test (vitest), which would poison a bare `vite build`
 * into a NON-production artifact (task 12 regression: vendor-vue-i18n chunk
 * 69486B under NODE_ENV=test vs 56001B production, budget 65536B).
 *
 * Contract:
 *   - If dist/ already holds a COMPLETE artifact (non-empty index.html plus
 *     at least one file under dist/assets): return immediately (fast path).
 *     An empty index.html or an index.html without assets is a corrupt or
 *     partial build and is rebuilt.
 *   - Otherwise run `pnpm build` with NODE_ENV=production so the produced
 *     artifact is byte-identical to a standalone production build.
 *   - Concurrent callers (multiple vitest forks on a clean checkout) are
 *     serialized with an atomic mkdir lock OUTSIDE dist/ (F3 #3): the lock
 *     lives in the OS temp dir keyed by the project path, so vite's
 *     `emptyOutDir: true` wipe of dist/ — which would delete a lock living
 *     inside the output — can never remove it. Exactly one caller builds,
 *     the rest wait for the artifact (bounded poll), then proceed.
 *   - Stale-lock recovery: if the lock holder never produces an artifact
 *     within the poll budget, its recorded PID is checked for liveness. A
 *     dead owner (SIGKILL/crash) leaves a stale lock — it is removed and the
 *     lock re-acquired (takeover). A live owner gets another poll round.
 *
 * Usage: node scripts/qa/ensure-production-dist.mjs [--cwd <path>]
 * Poll tuning for tests: VIS_DIST_POLL_TIMEOUT_MS / VIS_DIST_POLL_STEP_MS.
 * Exits 0 when dist is (or becomes) present; non-zero on build failure.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const PID_FILE = 'owner.pid';
const POLL_TIMEOUT_MS = 120_000;
const POLL_STEP_MS = 200;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Default lock root: OS temp dir, shared by all checkouts of this user. */
export function defaultLockRoot() {
  return path.join(os.tmpdir(), 'vis-ensure-dist');
}

/**
 * Lock location for a project: OUTSIDE the build output, keyed by the
 * resolved project path so different checkouts never contend. dist/ is
 * wiped by vite's emptyOutDir on every build — a lock inside it would be
 * deleted by the owner's own build, letting a concurrent caller start a
 * second build (F3 #3 defect).
 */
export function lockPathFor(cwd, lockRoot = defaultLockRoot()) {
  const key = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(lockRoot, `${key}.lock`);
}

/** A usable artifact: non-empty index.html plus at least one asset file. */
function isCompleteDist(indexHtml) {
  let stat;
  try {
    stat = fs.statSync(indexHtml);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  try {
    return fs.readdirSync(path.join(path.dirname(indexHtml), 'assets')).length > 0;
  } catch {
    return false;
  }
}

/**
 * Stale-lock detection: the holder is alive iff its owner.pid names a live
 * process. A missing pid file means the owner died between mkdir and the pid
 * write — the only plausible explanation after a full poll timeout.
 */
function ownerPidAlive(lockDir) {
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(lockDir, PID_FILE), 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // EPERM: exists but owned by another user
  }
}

export async function ensureProductionDist(cwd = REPO_ROOT, options = {}) {
  const {
    lockRoot = defaultLockRoot(),
    pollTimeoutMs = envMs('VIS_DIST_POLL_TIMEOUT_MS', POLL_TIMEOUT_MS),
    pollStepMs = envMs('VIS_DIST_POLL_STEP_MS', POLL_STEP_MS),
    buildCommand = 'pnpm build',
  } = options;

  const distDir = path.join(cwd, 'dist');
  const indexHtml = path.join(distDir, 'index.html');
  if (isCompleteDist(indexHtml)) return false;

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const lockDir = lockPathFor(cwd, lockRoot);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let owner = false;
    try {
      fs.mkdirSync(lockDir);
      owner = true;
    } catch {
      owner = false; // someone else holds the lock (or a stale one)
    }

    if (owner) {
      try {
        fs.writeFileSync(path.join(lockDir, PID_FILE), `${process.pid}\n`);
        execSync(buildCommand, {
          cwd,
          env: { ...process.env, NODE_ENV: 'production' },
          stdio: 'inherit',
        });
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
      if (!isCompleteDist(indexHtml)) {
        throw new Error(`${buildCommand} finished but dist artifact is incomplete`);
      }
      return true;
    }

    // Not the owner: wait for the owner's build (bounded).
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      if (isCompleteDist(indexHtml)) return false;
      await sleep(pollStepMs);
    }
    if (isCompleteDist(indexHtml)) return false;
    // The lock holder never produced an artifact. If its PID is gone the
    // lock is stale (owner crashed mid-build) — remove it and take over on
    // the next attempt. If the owner is still alive, give it another round.
    if (!ownerPidAlive(lockDir)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  throw new Error(`could not ensure a production dist after ${MAX_ATTEMPTS} attempts`);
}

// CLI entry — runnable so test files can spawn it without importing ESM.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwdArg = process.argv.indexOf('--cwd');
  const cwd = cwdArg !== -1 ? path.resolve(process.argv[cwdArg + 1] ?? REPO_ROOT) : REPO_ROOT;
  const built = await ensureProductionDist(cwd);
  console.log(built ? '[ensure-production-dist] built production dist' : '[ensure-production-dist] dist already present');
}
