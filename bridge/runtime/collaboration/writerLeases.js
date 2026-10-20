import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CollaborationError,
  parseAt,
  parseLeaseId,
  parseTaskId,
} from '../../../shared/runtime/collaboration.js';
import { detachedProcessOptions, stopProcessTree } from '../../processTree.js';

/**
 * Writer leases (task 40): the explicit allocation of a task's worktree, base commit and native
 * working directory, plus the policy a reviewer is told about it.
 *
 * Three guarantees are enforced by CONSTRUCTION rather than by a guard, following the shape task
 * 37's acceptance sink and task 38's `sendRecipient` established:
 *
 *   1. "two writers on the same repository get different cwds and different leases" — the worktree
 *      name is derived from the freshly minted lease id, never from the repository, so two
 *      allocations for one repository can never collide. The repository quota and the per-task
 *      lease are the only two conflicts, and both are explicit refusals.
 *
 *   2. "a reviewer is never told a sandbox exists" — `WRITER_ISOLATION` is ONE frozen object whose
 *      `sandbox` member is the literal `false`. Nothing in this module takes a sandbox claim as
 *      input, so no caller can promote the posture. The posture explicitly DENIES a sandbox in
 *      `notProvided` and in `reviewerStatement`.
 *
 *   3. "exiting does not automatically delete a user-unconfirmed worktree" — the RELEASE path is
 *      handed `createRetentionSink`, whose only member is `retain()`. Its type has no removal
 *      member at all. The removal authority lives in a DIFFERENT sink
 *      (`createRemovalSink`) that only `confirmWorktreeRemoval` can reach, and whose `markRemoved`
 *      refuses unless a user confirmation was recorded. So no exit path, however phrased, can
 *      delete a worktree.
 *
 * The three sinks are the boundary: the allocation slice (`worktree`, `baseCommit`, `nativeCwd`)
 * is written only by `createAllocationSink`, the retention slice only by `createRetentionSink`,
 * and the removal slice only by `createRemovalSink`.
 */

/**
 * The frozen writer budgets. One object, shared by every enforcing call site, so no caller can
 * invent its own limit:
 *
 *   maxWritersPerRepository — writers simultaneously leased against ONE repository
 *   maxActiveLeases         — leases one service holds at once
 *   maxLeaseTtlMs           — the longest lease lifetime a caller may ask for
 *   maxCwdChars             — the longest native cwd path an allocation may produce
 *   maxOwnerChars           — the longest owner identity
 *   maxRepositoryChars      — the longest repository path
 *   maxWorktreeNameChars    — the longest worktree name an allocation may produce
 */
export const WRITER_LIMITS = Object.freeze({
  maxWritersPerRepository: 8,
  maxActiveLeases: 32,
  maxLeaseTtlMs: 24 * 60 * 60 * 1000,
  maxCwdChars: 1024,
  maxOwnerChars: 128,
  maxRepositoryChars: 1024,
  maxWorktreeNameChars: 128,
});

/** The default lease lifetime when a caller does not ask for one. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** The output ceiling for one native command, matching bridge/workspaceCommand.js. */
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_ARGS = 128;
const MAX_ARG_CHARS = 32768;
const MAX_COMMAND_CHARS = 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/**
 * The reviewer posture. ONE frozen object, handed to every reviewer verbatim.
 *
 * `sandbox` is the literal `false` and its type is `false`: there is no code path in this module
 * that can produce a posture with any other value, because no function here accepts a sandbox
 * claim as input. `notProvided` and `reviewerStatement` state the denial out loud, so a reviewer
 * reading the posture is told what it does NOT have rather than left to assume.
 */
export const POSTURE_KEYS = Object.freeze([
  'isolation',
  'sandbox',
  'mechanism',
  'guarantees',
  'notProvided',
  'reviewerStatement',
]);

export const WRITER_ISOLATION = Object.freeze({
  isolation: 'lease-plus-worktree',
  sandbox: false,
  mechanism: 'an exclusive writer lease over a dedicated git worktree of the pinned base commit',
  guarantees: Object.freeze([
    'one writer lease per task, and at most WRITER_LIMITS.maxWritersPerRepository per repository',
    'every writer gets its own worktree, its own base commit and its own native cwd',
    "the user's repository is read-only to every writer; no writer path may leave its own cwd",
    'a released worktree is retained until a user explicitly confirms its removal',
  ]),
  notProvided: Object.freeze([
    'no kernel-level or process-level sandbox',
    'no container, VM or namespace isolation',
    'no network isolation',
    'no guarantee that another process on the host cannot read the worktree',
  ]),
  reviewerStatement:
    'This writer ran under an exclusive writer lease in its own git worktree at a pinned base commit. There is no sandbox: the worktree shares the host filesystem, and isolation comes from the lease plus the worktree only.',
});

/* ------------------------------------------------------------------ the sinks */

/**
 * The allocation side of the boundary: the ONLY sink that may write a lease's worktree, base
 * commit and native cwd. It is constructed from the record's allocation slice; no other code in
 * this module holds a reference that can reach those three fields.
 */
export function createAllocationSink(scope) {
  if (scope === null || typeof scope !== 'object' || !Object.hasOwn(scope, 'worktree')
    || !Object.hasOwn(scope, 'baseCommit') || !Object.hasOwn(scope, 'nativeCwd')) {
    throw new CollaborationError('invalid_request', 'writer_allocation_scope');
  }
  return Object.freeze({
    assign(input = {}) {
      if (input === null || typeof input !== 'object') {
        throw new CollaborationError('invalid_request', 'writer_allocation');
      }
      const worktree = requireText(input.worktree, 'writer_worktree', WRITER_LIMITS.maxCwdChars);
      const baseCommit = input.baseCommit;
      if (typeof baseCommit !== 'string' || !COMMIT_PATTERN.test(baseCommit)) {
        throw new CollaborationError('invalid_request', 'writer_base_commit');
      }
      const nativeCwd = requireText(input.nativeCwd, 'writer_cwd', WRITER_LIMITS.maxCwdChars);
      if (nativeCwd !== worktree && !isWithin(nativeCwd, worktree)) {
        throw new CollaborationError('invalid_request', 'writer_cwd');
      }
      scope.worktree = worktree;
      scope.baseCommit = baseCommit;
      scope.nativeCwd = nativeCwd;
      return Object.freeze({ worktree, baseCommit, nativeCwd });
    },
  });
}

/**
 * The retention side of the boundary: the ONLY sink the RELEASE path is handed. Its single member
 * is `retain`. There is deliberately no removal member on this type, which is what makes "exiting
 * does not delete a user-unconfirmed worktree" structural rather than conditional.
 */
export function createRetentionSink(scope) {
  if (scope === null || typeof scope !== 'object' || !Object.hasOwn(scope, 'disposition')) {
    throw new CollaborationError('invalid_request', 'writer_retention_scope');
  }
  return Object.freeze({
    retain() {
      scope.disposition = 'retained';
      return 'retained';
    },
  });
}

/**
 * The removal side of the boundary, reachable ONLY through an explicit user confirmation. Its
 * `markRemoved` refuses unless a confirmation was recorded first, so even a caller holding this
 * sink cannot delete an unconfirmed worktree.
 */
export function createRemovalSink(scope) {
  if (scope === null || typeof scope !== 'object' || !Object.hasOwn(scope, 'userConfirmed')
    || !Object.hasOwn(scope, 'confirmedAt') || !Object.hasOwn(scope, 'removedAt')) {
    throw new CollaborationError('invalid_request', 'writer_removal_scope');
  }
  return Object.freeze({
    confirm(at) {
      if (scope.userConfirmed === true) return scope.confirmedAt;
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) {
        throw new CollaborationError('invalid_request', 'writer_time');
      }
      scope.userConfirmed = true;
      scope.confirmedAt = at;
      return at;
    },
    markRemoved(at) {
      if (scope.userConfirmed !== true) {
        throw new CollaborationError('conflict', 'writer_worktree_unconfirmed');
      }
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) {
        throw new CollaborationError('invalid_request', 'writer_time');
      }
      scope.removedAt = at;
      return at;
    },
  });
}

/* ------------------------------------------------------------------ git plumbing */

function isWithin(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireText(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new CollaborationError('invalid_request', field);
  }
  return value;
}

/**
 * The shared git runner for the writer-lease / artifact pair. The working directory is a REQUIRED
 * named argument: a call without `{ cwd }` is an explicit refusal, never an inherited ambient cwd.
 * Every git invocation in this module goes through here.
 */
export function createGitRunner(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const stopChild = options.stopChild ?? stopProcessTree;
  const gitBinary = typeof options.gitBinary === 'string' && options.gitBinary.length > 0
    ? options.gitBinary
    : 'git';
  const outputLimit = Number.isSafeInteger(options.outputLimit) && options.outputLimit > 0
    ? options.outputLimit
    : OUTPUT_LIMIT_BYTES;
  const defaultTimeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : COMMAND_TIMEOUT_MS;

  return async function runGit(input = {}) {
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_git_input');
    }
    const cwd = requireText(input.cwd, 'writer_git_cwd', WRITER_LIMITS.maxCwdChars);
    const args = input.args;
    if (!Array.isArray(args) || args.length === 0 || args.length > MAX_COMMAND_ARGS
      || !args.every((arg) => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')
        && Buffer.byteLength(arg) <= MAX_ARG_CHARS)) {
      throw new CollaborationError('invalid_request', 'writer_git_args');
    }
    const timeoutMs = input.timeoutMs === undefined
      ? defaultTimeout
      : (() => {
        if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0
          || input.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
          throw new CollaborationError('invalid_request', 'writer_git_timeout');
        }
        return input.timeoutMs;
      })();
    // Git must never prompt or inherit host configuration that changes its output shape.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const child = spawnProcess(gitBinary, [...args], {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...detachedProcessOptions(),
    });
    const sizes = { stdout: 0, stderr: 0 };
    const buffers = { stdout: [], stderr: [] };
    let failure = null;
    // The memoized stop: null until the first stop request, so the child is stopped AT MOST once
    // no matter how many times a timeout or an output overflow asks for it. It must start null —
    // a `false` initializer would make `??=` a no-op and the child would never be stopped at all.
    let stopping = null;
    const stop = () => (stopping ??= Promise.resolve(stopChild(child)).catch(() => undefined));
    const done = new Promise((resolve) => {
      child.once('error', (error) => {
        failure = new CollaborationError(
          error?.code === 'ENOENT' ? 'source_unavailable' : 'source_unavailable',
          'writer_git_spawn',
        );
      });
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          if (failure !== null) return;
          sizes[stream] += chunk.length;
          if (sizes[stream] > outputLimit) {
            failure = new CollaborationError('conflict', 'writer_git_output');
            void stop();
            return;
          }
          buffers[stream].push(chunk);
        });
      }
      child.once('close', (exitCode, signal) => {
        resolve({
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
          signal: signal ?? null,
          stdout: Buffer.concat(buffers.stdout).toString('utf8'),
          stderr: Buffer.concat(buffers.stderr).toString('utf8'),
          failure,
        });
      });
    });
    const timer = setTimeout(() => {
      if (failure === null) {
        failure = new CollaborationError('source_unavailable', 'writer_git_timeout');
        void stop();
      }
    }, timeoutMs);
    timer.unref?.();
    const { failure: error, ...result } = await done;
    clearTimeout(timer);
    if (error !== null) throw error;
    return result;
  };
}

/** The default base-commit resolver: the repository HEAD, read in the NAMED repository directory. */
export function createBaseCommitResolver(runGit) {
  return async function resolveBaseCommit({ repository }) {
    const result = await runGit({ cwd: repository, args: ['rev-parse', '--verify', 'HEAD'] });
    if (result.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'writer_base_commit', {
        repository,
        stderr: result.stderr.slice(0, 512),
      });
    }
    const commit = result.stdout.trim();
    if (!COMMIT_PATTERN.test(commit)) {
      throw new CollaborationError('conflict', 'writer_base_commit', { repository });
    }
    return commit;
  };
}

/**
 * The default dirty-base guard. A repository with uncommitted changes cannot serve as a writer
 * base: the base commit would not describe the tree the writer diffs against.
 */
export function createRepositoryCleanGuard(runGit) {
  return async function assertRepositoryClean({ repository }) {
    const result = await runGit({
      cwd: repository,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    });
    if (result.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'writer_base_status', {
        repository,
        stderr: result.stderr.slice(0, 512),
      });
    }
    const dirty = result.stdout.split('\0').filter((entry) => entry.length > 0);
    if (dirty.length > 0) {
      throw new CollaborationError('conflict', 'writer_base_dirty', {
        repository,
        paths: Object.freeze(dirty.slice(0, 8)),
      });
    }
  };
}

/** The default worktree creator: a detached git worktree of the pinned base commit. */
export function createWorktreeCreator(runGit) {
  return async function createWorktree({ repository, worktree, baseCommit }) {
    const result = await runGit({
      cwd: repository,
      args: ['worktree', 'add', '--detach', '--', worktree, baseCommit],
    });
    if (result.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'writer_worktree_create', {
        repository,
        worktree,
        baseCommit,
        stderr: result.stderr.slice(0, 512),
      });
    }
  };
}

/* ------------------------------------------------------------------ the service */

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export function createWriterLeaseService(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new CollaborationError('invalid_request', 'writer_service_options');
  }
  const writersRoot = requireText(options.writersRoot, 'writer_root', WRITER_LIMITS.maxCwdChars);
  const fsLike = options.fs ?? fs;
  const runGit = options.runGit ?? createGitRunner(options);
  const resolveBaseCommit = options.resolveBaseCommit ?? createBaseCommitResolver(runGit);
  const assertRepositoryClean = options.assertRepositoryClean ?? createRepositoryCleanGuard(runGit);
  const createWorktree = options.createWorktree ?? createWorktreeCreator(runGit);
  const removeWorktreeFn = options.removeWorktree ?? (async ({ worktree }) => {
    await fsLike.rm(worktree, { recursive: true, force: true });
  });
  const spawnProcess = options.spawnProcess ?? spawn;
  const stopChild = options.stopChild ?? stopProcessTree;
  const newLeaseId = typeof options.newLeaseId === 'function' ? options.newLeaseId : randomUUID;

  /** leaseId → the live record. */
  const leasesById = new Map();
  /** normalized repository path → the lease ids currently held against it. */
  const byRepository = new Map();
  /** taskId → the lease id. One lease per task, forever. */
  const byTask = new Map();
  /**
   * The IN-FLIGHT allocations: a task and repository quota reserved before the first await of
   * `allocate` and released when it settles. Every quota check consults these alongside the live
   * maps, so a concurrent allocation can never pass a check a synchronous one would have failed.
   */
  const reservedByTask = new Map();
  const reservedByRepository = new Map();
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'writer_service_closed');
  }

  function requireLease(leaseId) {
    const id = parseLeaseId(leaseId);
    const record = leasesById.get(id);
    if (record === undefined) throw new CollaborationError('invalid_request', 'writer_lease_unknown', { leaseId: id });
    return record;
  }

  function repositoryKey(repository) {
    return path.resolve(repository);
  }

  function leaseView(record) {
    return Object.freeze({
      leaseId: record.leaseId,
      taskId: record.taskId,
      repository: record.repository,
      ownerId: record.ownerId,
      worktree: record.allocation.worktree,
      baseCommit: record.allocation.baseCommit,
      nativeCwd: record.allocation.nativeCwd,
      snapshot: Object.freeze({
        baseCommit: record.allocation.baseCommit,
        worktree: record.allocation.worktree,
        createdAt: record.snapshot.createdAt,
      }),
      policy: Object.freeze({
        worktreeAccess: record.policy.worktreeAccess,
        userRepository: record.policy.userRepository,
      }),
      state: record.state,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      releasedAt: record.releasedAt,
      removedAt: record.removedAt,
    });
  }

  function releaseView(record) {
    return Object.freeze({
      leaseId: record.leaseId,
      state: 'released',
      releasedAt: record.releasedAt,
      worktree: Object.freeze({
        path: record.allocation.worktree,
        disposition: record.retention.disposition,
      }),
      userConfirmed: false,
    });
  }

  async function retentionView(record) {
    return Object.freeze({
      leaseId: record.leaseId,
      path: record.allocation.worktree,
      userConfirmed: record.removal.userConfirmed,
      confirmedAt: record.removal.confirmedAt,
      removedAt: record.removal.removedAt,
      exists: await pathExists(record.allocation.worktree),
    });
  }

  /**
   * Allocate one writer. The worktree, the base commit and the native cwd are ALL three assigned
   * here, explicitly, and recorded in the lease: nothing downstream is left to infer them.
   *
   * The worktree name is derived from the freshly minted lease id, never from the repository, so
   * two writers on the same repository can never share a cwd. A duplicate task lease, a repository
   * over its writer quota, a service over its lease capacity and a dirty base are each an explicit
   * refusal BEFORE anything is created. The task and repository quotas are RESERVED before the
   * first await and rolled back if any later step refuses, so two concurrent allocations for one
   * task cannot both pass the conflict check and mint two live leases.
   */
  async function allocate(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_allocate');
    }
    const repository = requireText(
      typeof input.repository === 'string' ? input.repository.trim() : input.repository,
      'writer_repository',
      WRITER_LIMITS.maxRepositoryChars,
    );
    const taskId = parseTaskId(input.taskId);
    const ownerId = requireText(input.ownerId, 'writer_owner', WRITER_LIMITS.maxOwnerChars);
    const ttlMs = input.ttlMs === undefined
      ? DEFAULT_TTL_MS
      : (() => {
        if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0
          || input.ttlMs > WRITER_LIMITS.maxLeaseTtlMs) {
          throw new CollaborationError('invalid_request', 'writer_ttl');
        }
        return input.ttlMs;
      })();
    if (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') {
      throw new CollaborationError('invalid_request', 'writer_read_only');
    }
    const readOnly = input.readOnly === true;
    const at = parseAt(input.at);

    // --- the four explicit conflicts, all before anything is created ---
    if (byTask.has(taskId) || reservedByTask.has(taskId)) {
      throw new CollaborationError('conflict', 'writer_lease_task', { taskId });
    }
    if (leasesById.size + reservedByTask.size >= WRITER_LIMITS.maxActiveLeases) {
      throw new CollaborationError('conflict', 'writer_lease_capacity', {
        limit: WRITER_LIMITS.maxActiveLeases,
      });
    }
    const key = repositoryKey(repository);
    const held = byRepository.get(key) ?? [];
    const reservedForRepository = reservedByRepository.get(key) ?? [];
    if (held.length + reservedForRepository.length >= WRITER_LIMITS.maxWritersPerRepository) {
      throw new CollaborationError('conflict', 'writer_lease_repository', {
        repository,
        limit: WRITER_LIMITS.maxWritersPerRepository,
      });
    }

    // --- the explicit allocation ---
    const leaseId = newLeaseId();
    if (!UUID_PATTERN.test(leaseId)) {
      throw new CollaborationError('invalid_request', 'writer_lease_id');
    }
    // Reserve the task and repository quotas BEFORE the first await: the checks above are
    // synchronous, so without a reservation two concurrent allocations for one task would both
    // pass them, both create a worktree, and both register — two live leases for one task, with
    // byTask keeping only the last. The reservation is dropped again if any step below refuses.
    const reservation = Object.freeze({ leaseId, taskId, key });
    reservedByTask.set(taskId, reservation);
    reservedForRepository.push(reservation);
    reservedByRepository.set(key, reservedForRepository);
    try {
      await assertRepositoryClean({ repository });
      const baseCommit = await resolveBaseCommit({ repository });
      const worktree = path.join(writersRoot, `writer-${leaseId}`);
      if (worktree.length > WRITER_LIMITS.maxCwdChars) {
        throw new CollaborationError('conflict', 'writer_cwd', { limit: WRITER_LIMITS.maxCwdChars });
      }
      await fsLike.mkdir(writersRoot, { recursive: true });
      await createWorktree({ repository, worktree, baseCommit });

      const record = {
        leaseId,
        taskId,
        repository: key,
        ownerId,
        allocation: { worktree: null, baseCommit: null, nativeCwd: null },
        retention: { disposition: 'retained' },
        removal: { userConfirmed: false, confirmedAt: null, removedAt: null },
        snapshot: { createdAt: at },
        policy: {
          worktreeAccess: readOnly ? 'read-only' : 'read-write',
          userRepository: 'read-only',
        },
        state: 'active',
        createdAt: at,
        expiresAt: at + ttlMs,
        releasedAt: null,
        removedAt: null,
      };
      createAllocationSink(record.allocation).assign({ worktree, baseCommit, nativeCwd: worktree });
      leasesById.set(leaseId, record);
      byTask.set(taskId, leaseId);
      // Re-read the repository bucket at registration: a concurrent allocation may have published
      // its own bucket in the meantime, and pushing into a stale array would lose its entry.
      const registered = byRepository.get(key) ?? [];
      registered.push(leaseId);
      byRepository.set(key, registered);
      return leaseView(record);
    } finally {
      reservedByTask.delete(taskId);
      const pending = reservedByRepository.get(key) ?? [];
      const at_ = pending.indexOf(reservation);
      if (at_ >= 0) pending.splice(at_, 1);
      if (pending.length === 0) reservedByRepository.delete(key);
    }
  }

  function lease(leaseId) {
    assertOpen();
    return leaseView(requireLease(leaseId));
  }

  function leases() {
    assertOpen();
    return Object.freeze([...leasesById.values()].map(leaseView));
  }

  function leasesByRepository(repository) {
    assertOpen();
    const key = repositoryKey(requireText(repository, 'writer_repository', WRITER_LIMITS.maxRepositoryChars));
    const ids = byRepository.get(key) ?? [];
    return Object.freeze(ids.map((id) => leaseView(leasesById.get(id))));
  }

  /** The ONLY way to obtain a writer's cwd. There is no API here that accepts a caller's cwd. */
  function nativeCwd(leaseId) {
    assertOpen();
    return requireLease(leaseId).allocation.nativeCwd;
  }

  /**
   * Resolve a candidate path against a lease, refusing anything that leaves the lease's own native
   * cwd. This is what makes a worker's cross-cwd reach an explicit refusal: the user's repository
   * and every sibling writer's worktree are outside every lease.
   */
  function assertPathWithinLease(leaseId, candidate) {
    assertOpen();
    const record = requireLease(leaseId);
    const root = record.allocation.nativeCwd;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new CollaborationError('invalid_request', 'writer_lease_path');
    }
    const resolved = path.resolve(root, candidate.trim());
    if (!isWithin(resolved, root)) {
      throw new CollaborationError('unauthorized', 'writer_lease_cwd', {
        leaseId: record.leaseId,
        candidate,
      });
    }
    return resolved;
  }

  /** The reviewer posture: the one frozen object, which denies a sandbox. */
  function posture(leaseId) {
    assertOpen();
    requireLease(leaseId);
    return WRITER_ISOLATION;
  }

  /**
   * Run one native command INSIDE a lease's native cwd. The cwd is always the lease's own and is
   * never taken from the caller, so a native process launched through here cannot be aimed at
   * another writer's directory or at the user's repository.
   */
  function run(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_run');
    }
    const record = requireLease(input.leaseId);
    if (record.state !== 'active') {
      throw new CollaborationError('conflict', 'writer_lease_state', {
        leaseId: record.leaseId,
        state: record.state,
      });
    }
    const command = requireText(input.command, 'writer_command', MAX_COMMAND_CHARS);
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > MAX_COMMAND_ARGS
      || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0')
        && Buffer.byteLength(arg) <= MAX_ARG_CHARS)) {
      throw new CollaborationError('invalid_request', 'writer_run_args');
    }
    const timeoutMs = input.timeoutMs === undefined
      ? COMMAND_TIMEOUT_MS
      : (() => {
        if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0
          || input.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
          throw new CollaborationError('invalid_request', 'writer_run_timeout');
        }
        return input.timeoutMs;
      })();

    return new Promise((resolve, reject) => {
      const child = spawnProcess(command, [...args], {
        cwd: record.allocation.nativeCwd,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...detachedProcessOptions(),
      });
      const sizes = { stdout: 0, stderr: 0 };
      const buffers = { stdout: [], stderr: [] };
      let failure = null;
      let stopping = false;
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const stop = () => {
        if (stopping) return;
        stopping = true;
        Promise.resolve(stopChild(child)).catch(() => undefined);
      };
      const timer = setTimeout(() => {
        if (failure === null) {
          failure = new CollaborationError('source_unavailable', 'writer_run_timeout');
          stop();
        }
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (error) => {
        failure = new CollaborationError('source_unavailable', 'writer_run_spawn');
        finish(() => reject(failure ?? error));
      });
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          if (failure !== null) return;
          sizes[stream] += chunk.length;
          if (sizes[stream] > OUTPUT_LIMIT_BYTES) {
            failure = new CollaborationError('conflict', 'writer_run_output');
            stop();
            return;
          }
          buffers[stream].push(chunk);
        });
      }
      child.once('close', (exitCode, signal) => {
        finish(() => {
          if (failure !== null) {
            reject(failure);
            return;
          }
          resolve(Object.freeze({
            exitCode: typeof exitCode === 'number' ? exitCode : -1,
            signal: signal ?? null,
            stdout: Buffer.concat(buffers.stdout).toString('utf8'),
            stderr: Buffer.concat(buffers.stderr).toString('utf8'),
          }));
        });
      });
    });
  }

  /**
   * Release a lease. The worktree is RETAINED: the returned read model has no member that can
   * delete anything, and the only sink this path is handed is the retention sink, whose sole
   * member is `retain`. Idempotent for an already-released lease; a removed lease is a conflict.
   */
  function release(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_release');
    }
    const record = requireLease(input.leaseId);
    if (record.state === 'removed') {
      throw new CollaborationError('conflict', 'writer_lease_state', {
        leaseId: record.leaseId,
        state: record.state,
      });
    }
    if (record.state === 'released') return releaseView(record);
    const at = parseAt(input.at);
    record.state = 'released';
    record.releasedAt = at;
    createRetentionSink(record.retention).retain();
    return releaseView(record);
  }

  /**
   * Record an explicit USER confirmation that a released worktree may be removed. This is the only
   * path that reaches the removal sink, and it refuses while the lease is still live.
   */
  function confirmWorktreeRemoval(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_confirm');
    }
    const record = requireLease(input.leaseId);
    if (record.state !== 'released') {
      throw new CollaborationError('conflict', 'writer_lease_state', {
        leaseId: record.leaseId,
        state: record.state,
      });
    }
    createRemovalSink(record.removal).confirm(parseAt(input.at));
    return retentionView(record);
  }

  /** Remove a released worktree. Without a user confirmation this is an explicit refusal. */
  async function removeWorktree(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_remove');
    }
    const record = requireLease(input.leaseId);
    if (record.removal.userConfirmed !== true) {
      throw new CollaborationError('conflict', 'writer_worktree_unconfirmed', {
        leaseId: record.leaseId,
      });
    }
    if (record.removal.removedAt !== null) return retentionView(record);
    const at = parseAt(input.at);
    await removeWorktreeFn({
      worktree: record.allocation.worktree,
      repository: record.repository,
    });
    createRemovalSink(record.removal).markRemoved(at);
    record.state = 'removed';
    record.removedAt = at;
    return retentionView(record);
  }

  function retention(leaseId) {
    assertOpen();
    return retentionView(requireLease(leaseId));
  }

  function state() {
    let active = 0;
    let released = 0;
    let removed = 0;
    let worktreesRetained = 0;
    let worktreesRemoved = 0;
    for (const record of leasesById.values()) {
      if (record.state === 'active') active += 1;
      if (record.state === 'released') released += 1;
      if (record.state === 'removed') removed += 1;
      if (record.removal.removedAt === null) worktreesRetained += 1;
      else worktreesRemoved += 1;
    }
    return Object.freeze({
      active,
      released,
      removed,
      total: leasesById.size,
      worktreesRetained,
      worktreesRemoved,
      closed,
    });
  }

  /**
   * Close the service. NOTHING is deleted: an unconfirmed worktree outlives the service that
   * created it, because the retention sink is the only sink this module hands to an exit path.
   */
  function close() {
    closed = true;
    leasesById.clear();
    byRepository.clear();
    byTask.clear();
  }

  return {
    WRITER_LIMITS,
    allocate,
    lease,
    leases,
    leasesByRepository,
    nativeCwd,
    assertPathWithinLease,
    posture,
    run,
    release,
    confirmWorktreeRemoval,
    removeWorktree,
    retention,
    state,
    close,
  };
}
