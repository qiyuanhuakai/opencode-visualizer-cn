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
 *   - If dist/index.html already exists: return immediately (fast path).
 *   - Otherwise run `pnpm build` with NODE_ENV=production so the produced
 *     artifact is byte-identical to a standalone production build.
 *   - Concurrent callers (multiple vitest forks on a clean checkout) are
 *     serialized with an atomic mkdir lock (dist/.ensure-dist.lock): exactly
 *     one caller builds, the rest wait for dist/index.html (bounded poll),
 *     then proceed. A stale lock (owner crashed) is recovered by retrying
 *     the lock acquisition after the poll times out.
 *
 * Usage: node scripts/qa/ensure-production-dist.mjs [--cwd <path>]
 * Exits 0 when dist is (or becomes) present; non-zero on build failure.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const LOCK_NAME = '.ensure-dist.lock';
const POLL_TIMEOUT_MS = 120_000;
const POLL_STEP_MS = 200;
const MAX_ATTEMPTS = 3;

export async function ensureProductionDist(cwd = REPO_ROOT) {
  const distDir = path.join(cwd, 'dist');
  const indexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) return false;

  fs.mkdirSync(distDir, { recursive: true });
  const lockDir = path.join(distDir, LOCK_NAME);

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
        execSync('pnpm build', {
          cwd,
          env: { ...process.env, NODE_ENV: 'production' },
          stdio: 'inherit',
        });
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
      if (!fs.existsSync(indexHtml)) {
        throw new Error('pnpm build finished but dist/index.html is missing');
      }
      return true;
    }

    // Not the owner: wait for the owner's build to finish (bounded).
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(indexHtml)) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS));
    }
    if (fs.existsSync(indexHtml)) return false;
    // Lock holder looks gone (crashed between lock and build) — retry and
    // take the lock ourselves rather than failing the gate.
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
