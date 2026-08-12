#!/usr/bin/env node
/**
 * Ensure a REAL production build exists at <repo>/dist before dist-dependent
 * gates measure or serve it — even when `pnpm test` runs before `pnpm build`
 * on a clean checkout and even under NODE_ENV=test (vitest), which would
 * poison a bare `vite build` into a NON-production artifact.
 *
 * Contract:
 *   - Complete artifact (non-empty index.html plus ≥1 file under
 *     dist/assets) → fast path. Corrupt/partial markers are rebuilt.
 *   - Otherwise run `pnpm build` with NODE_ENV=production.
 *   - Concurrent callers are serialized with an atomic lock OUTSIDE dist/
 *     (F3 #3): the lock lives in the OS temp dir keyed by the project path,
 *     so the owner's own emptyOutDir wipe of dist/ cannot remove it.
 *     Exactly one caller builds; the rest wait for the artifact.
 *   - Acquisition is atomic WITH identity (F3 round-3): the complete lock
 *     dir (owner.json {pid, token}) is prepared in a unique sibling temp
 *     dir and acquired by a single rename() into place. rename() onto an
 *     existing non-empty dir fails atomically (ENOTEMPTY/EEXIST), so exactly
 *     one contender wins, and the winner's identity is visible from the
 *     first instant the lock path exists — there is no mkdir→publish window
 *     a waiter could exploit. Losers remove their temp dir and become
 *     waiters. A legacy EMPTY lock dir (a crashed pre-token owner) is
 *     replaced by the rename; a legacy owner.pid-only dir is taken over as
 *     stale.
 *   - Stale-lock recovery (F3 #3 round 2): a live owner gets unbounded wait
 *     time (no attempt budget — a budget would fail callers while a live
 *     owner still builds); a dead owner is taken over under a wx marker that
 *     serializes takeover agents: the stale dir is re-verified dead UNDER
 *     the marker before removal, so of N waiters exactly one deletes a stale
 *     lock and no live owner's lock is ever deleted. Markers carry the
 *     claimant's token (F3 round-3): a holder removes only a marker whose
 *     token matches its own, and a marker left by a crashed agent is
 *     reclaimed via atomic rename (single winner) after re-verifying the
 *     moved instance still names a dead holder; a live holder's marker is
 *     renamed back, never deleted. Owner cleanup is token-verified.
 *
 * Usage: node scripts/qa/ensure-production-dist.mjs [--cwd <path>]
 * Poll tuning for tests: VIS_DIST_POLL_TIMEOUT_MS / VIS_DIST_POLL_STEP_MS.
 * Contention seam for tests: VIS_DIST_ACQUIRE_PAUSE_MS (pause after
 * acquiring, before the build; 0 = disabled).
 * Exits 0 when dist is (or becomes) present; non-zero on build failure.
 */

import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const PID_FILE = 'owner.pid'; // legacy owner identity (pre-token locks)
const OWNER_FILE = 'owner.json';
const TAKEOVER_FILE = '.takeover'; // wx marker serializing takeover agents
const POLL_TIMEOUT_MS = 120_000;
const POLL_STEP_MS = 200;
const MARKER_RECLAIM_ATTEMPTS = 3;
const RESTORE_ATTEMPTS = 5;
const RESTORE_RETRY_MS = 20;

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
 * Owner identity of a lock dir: {pid, token} from owner.json (token: the
 * process-unique value an owner must match before anyone deletes the dir),
 * or a legacy {pid} lock naming only its owner.pid. null when the dir has
 * no identifiable owner — only legacy artifacts look like this, since the
 * atomic acquire makes identity visible from the lock's first instant.
 */
function readOwner(lockDir) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8'));
    if (Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') {
      return { pid: owner.pid, token: owner.token };
    }
  } catch {
    // no/invalid owner.json — fall through to the legacy pid file
  }
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(lockDir, PID_FILE), 'utf8'), 10);
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 ? { pid, token: undefined } : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // EPERM: exists but owned by another user
  }
}

/** A marker token `${pid}-${uuid}` names its holder's pid. */
function tokenAlive(token) {
  const pid = Number.parseInt(token, 10);
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
}

/**
 * Owner cleanup: remove the lock dir ONLY while it still carries our token.
 * A dir whose token is not ours was taken over while we built (or already
 * removed) — a live owner's lock is never deleted by anyone but its owner.
 */
function removeOwnLock(lockDir, token) {
  const owner = readOwner(lockDir);
  if (owner?.token === token) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Remove the takeover marker only while it still carries OUR token. */
function removeOwnMarker(lockDir, myToken) {
  const markerPath = path.join(lockDir, TAKEOVER_FILE);
  let holderToken = null;
  try {
    holderToken = fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    return; // marker already gone
  }
  if (holderToken === myToken) {
    fs.rmSync(markerPath, { force: true });
  }
  // A marker that is not ours belongs to a concurrent claimant — a holder
  // never deletes another holder's marker.
}

/**
 * wx-acquire the takeover marker inside the lock dir: one takeover agent at
 * a time per dir instance, so a re-verify done under the marker cannot race
 * another agent's takeover. The marker carries the claimant's token; a
 * marker left by a crashed agent (dead holder pid) is reclaimed atomically —
 * rename() moves the marker instance away, a single winner among concurrent
 * reclaimants — and the moved instance is discarded only after re-verifying
 * it still names a dead holder; a live holder's marker is renamed back,
 * never deleted.
 */
function acquireTakeoverMarker(lockDir, myToken) {
  const markerPath = path.join(lockDir, TAKEOVER_FILE);
  for (let attempt = 0; attempt < MARKER_RECLAIM_ATTEMPTS; attempt++) {
    try {
      fs.writeFileSync(markerPath, `${myToken}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false; // lock dir vanished — re-poll
    }
    // Held by another claimant. Reclaim only a provably dead holder: rename
    // the marker instance away (a single winner), then discard it only if
    // the moved instance still names a dead holder.
    const deadPath = `${markerPath}.dead-${randomUUID()}`;
    try {
      fs.renameSync(markerPath, deadPath);
    } catch {
      return false; // another reclaimant won (or the dir vanished) — re-poll
    }
    let holderToken = null;
    try {
      holderToken = fs.readFileSync(deadPath, 'utf8').trim();
    } catch {
      holderToken = null;
    }
    if (holderToken === null || !tokenAlive(holderToken)) {
      fs.rmSync(deadPath, { force: true }); // dead/unknown holder — reclaimed
      continue; // retry the wx
    }
    // Live holder's marker — restore it, never delete.
    try {
      fs.renameSync(deadPath, markerPath);
    } catch {
      // a fresh instance appeared — ours stays at deadPath, never deleted
    }
    return false; // live holder mid-takeover — re-poll
  }
  return false;
}

/**
 * Stale-lock takeover (F3 #3 round 2). Under the wx marker, re-verify the
 * lock dir still holds a dead (or unidentifiable-after-grace) owner, then
 * remove it. The final identity check runs AFTER the dir is moved to a
 * claimant-unique path: a dir replaced in the check→rename window (only a
 * broken marker reclaim can allow) is renamed back, never deleted.
 *
 * Returns true when the stale dir was removed (the next attempt acquires),
 * false when the race was lost or the dir was left alone (re-poll instead).
 */
async function takeOverStaleLock(lockDir, observed, pollStepMs, myToken) {
  if (!acquireTakeoverMarker(lockDir, myToken)) return false; // another takeover in flight
  try {
    let current = fs.existsSync(lockDir) ? readOwner(lockDir) : null;
    if (current === null && fs.existsSync(lockDir)) {
      // No identifiable owner: with atomic acquire this can only be a legacy
      // artifact (a pre-token owner crashed before publishing). Give any
      // in-flight publish one poll step, then treat a persisted absence as
      // stale.
      await sleep(pollStepMs);
      current = fs.existsSync(lockDir) ? readOwner(lockDir) : null;
      if (current === null && !fs.existsSync(lockDir)) return false; // owner finished
    }
    if (current !== null && pidAlive(current.pid)) return false; // live owner — back off
    const claimPath = `${lockDir}.takeover-${randomUUID()}`;
    try {
      fs.renameSync(lockDir, claimPath);
    } catch {
      return false; // lock dir vanished — re-poll
    }
    const moved = readOwner(claimPath);
    const sameStaleOwner =
      (moved?.token ?? null) === (observed?.token ?? null) &&
      (moved?.pid ?? null) === (observed?.pid ?? null);
    if (sameStaleOwner) {
      fs.rmSync(claimPath, { recursive: true, force: true });
      return true;
    }
    // The moved dir is not the stale owner's — restore it, never delete.
    for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(claimPath, lockDir);
        return false;
      } catch {
        await sleep(RESTORE_RETRY_MS);
      }
    }
    return false; // stranded at the claim path (inert) rather than destroyed
  } finally {
    removeOwnMarker(lockDir, myToken);
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
  const myToken = `${process.pid}-${randomUUID()}`;

  // Acquire the lock WITH identity in one atomic step: prepare the complete
  // lock dir (owner.json) in a unique sibling temp dir, then rename it into
  // place. rename() onto an existing non-empty dir fails atomically
  // (ENOTEMPTY/EEXIST), so exactly one contender wins and the winner's
  // identity is visible from the first instant the lock path exists — there
  // is no mkdir→publish window (F3 round-3). The loop is UNBOUNDED: a live
  // owner may legitimately build for minutes and a stale lock is always
  // takeable (a crashed agent's marker is reclaimed on sight), so no fixed
  // attempt budget is needed — a budget would let a caller fail while a
  // live owner is still building (F3 #3 round 3 regression).
  for (;;) {
    if (isCompleteDist(indexHtml)) return false; // never rebuild a completed dist
    let owner = false;
    const prepDir = `${lockDir}.prep-${randomUUID()}`;
    try {
      fs.mkdirSync(prepDir);
      fs.writeFileSync(
        path.join(prepDir, OWNER_FILE),
        JSON.stringify({ pid: process.pid, token: myToken }),
      );
      fs.renameSync(prepDir, lockDir); // atomic acquire-with-identity
      owner = true;
    } catch (err) {
      fs.rmSync(prepDir, { recursive: true, force: true });
      if (err.code !== 'EEXIST' && err.code !== 'ENOTEMPTY') throw err; // real fs error
      owner = false; // someone else holds the lock (or a stale one)
    }

    if (owner) {
      // Contention seam for tests: pause after acquiring (identity already
      // published), before the build.
      const pauseMs = envMs('VIS_DIST_ACQUIRE_PAUSE_MS', 0);
      if (pauseMs > 0) await sleep(pauseMs);
      try {
        execSync(buildCommand, {
          cwd,
          env: { ...process.env, NODE_ENV: 'production' },
          stdio: 'inherit',
        });
      } finally {
        removeOwnLock(lockDir, myToken);
      }
      if (!isCompleteDist(indexHtml)) {
        throw new Error(`${buildCommand} finished but dist artifact is incomplete`);
      }
      return true;
    }

    // Not the owner: wait for the owner's build. A stale lock is taken over
    // INSIDE this loop, so a takeover that loses to a concurrent agent (or
    // a winner preempted mid-takeover) re-polls without any budget being
    // consumed — races with concurrent acquirers are the norm.
    const waitStart = Date.now();
    for (;;) {
      if (isCompleteDist(indexHtml)) return false;
      if (!fs.existsSync(lockDir)) break; // owner finished and cleaned up → re-acquire
      const observed = readOwner(lockDir);
      let stale = false;
      if (observed === null) {
        // Identity-less dir: with atomic acquire this is a legacy artifact
        // (a pre-token owner crashed before publishing). After a full poll
        // budget of persisted absence, take it over.
        stale = Date.now() - waitStart >= pollTimeoutMs;
      } else if (!pidAlive(observed.pid)) {
        stale = true;
      }
      if (stale) {
        // Await the takeover: a stale dir whose removal is still in flight
        // must not be re-acquired concurrently (and the takeover's work must
        // not run detached from this caller).
        if (await takeOverStaleLock(lockDir, observed, pollStepMs, myToken)) break; // stale removed → re-acquire
        await sleep(pollStepMs); // lost to another takeover agent → re-poll
        continue;
      }
      await sleep(pollStepMs);
    }
  }
}

// CLI entry — runnable so test files can spawn it without importing ESM.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwdArg = process.argv.indexOf('--cwd');
  const cwd = cwdArg !== -1 ? path.resolve(process.argv[cwdArg + 1] ?? REPO_ROOT) : REPO_ROOT;
  const built = await ensureProductionDist(cwd);
  console.log(built ? '[ensure-production-dist] built production dist' : '[ensure-production-dist] dist already present');
}
