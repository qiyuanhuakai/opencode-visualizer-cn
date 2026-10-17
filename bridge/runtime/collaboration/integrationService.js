import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendBoundedBuffer } from '../../boundedOutput.js';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import { detachedProcessOptions, stopProcessTree } from '../../processTree.js';
import { hashSource } from './artifactStore.js';
import { createGitRunner } from './writerLeases.js';

/**
 * Post-review integration (task 41): the serialized check → apply → tests → durable-record path
 * that turns an APPROVED artifact into a controlled fast-forward of the target branch, and that
 * preserves everything when anything goes wrong.
 *
 * The sequence, and what each step is allowed to touch:
 *
 *   1. the APPROVED artifact hash is re-hashed out of the durable object. The approval binds the
 *      hash; the bytes are hashed again here, independently, so "the approved hash matches the
 *      actual bytes" is measured rather than assumed. A mismatch refuses before anything is
 *      written. The artifact's own declared base commit is read out of the same object and must
 *      equal the base the approval bound, so a stale snapshot can never replay over newer work.
 *   2. the repository lock is acquired. Two integrations against one target are therefore
 *      serialized by the lock's data structure, not by a convention.
 *   3. the target is re-checked: HEAD must still be the reviewed base, the target ref must still
 *      be that base, the tree must still be clean, and the target branch must NOT be checked out
 *      in any worktree — advancing a checked-out branch would leave that worktree reading as a
 *      reverse modification, which is a change to the user's directory this module never makes.
 *      A dirty target, a moved HEAD or a checked-out target refuses, and NOTHING is written.
 *   4. a temporary clean integration worktree of the reviewed base is created. It belongs to this
 *      operation and to nobody else.
 *   5. the artifact is applied into that worktree, using task 40's lossless apply, and the tree
 *      that produced is recorded.
 *   6. the frozen criteria's tests run in that worktree. The child's stdin is IGNORED — the test
 *      runner's type has no member that can write to a child's stdin — and any input blob reaches
 *      the test as a temp file, which is how `bridge/workspaceCommand.js`'s stdin limitation is
 *      honoured. A failing test refuses, a runner failure (timeout, spawn error, output overflow)
 *      is recorded as a refusal rather than thrown, and a tree that the tests changed is refused:
 *      the commit may record the reviewed artifact and nothing else. Only THIS operation's temp is
 *      cleaned.
 *   7. the commit is created in that worktree, through a sink whose only member is `commit` and
 *      which is constructed from the operation's own worktree path. The sink's type has no member
 *      that accepts a directory, so it cannot be aimed at the user's original directory.
 *   8. the target is re-checked again immediately before the ref moves — the repository lock
 *      serializes this service, not the user or another git command — and then fast-forwarded
 *      with `git update-ref <ref> <new> <old>`, where `<old>` is the reviewed base. The update is
 *      atomic: if the branch moved, git refuses. There is no push, no `reset --hard`, no `stash`
 *      and no force anywhere in this module.
 *
 * What is NEVER done, and is structurally impossible here:
 *   * the user's original directory is never committed to and never pushed;
 *   * the user's files are never reset, stashed or rolled back;
 *   * the artifact object is never deleted — every failure path leaves it durable and verifiable.
 *
 * Every outcome, including every refusal, is returned as ONE frozen durable result carrying the
 * observed before/after state of the target, so "what happened" is a record rather than a claim.
 */

/**
 * The frozen integration budgets. One object, shared by every enforcing call site:
 *
 *   maxOperations         — durable results one service holds at once
 *   maxRepositoryChars    — the longest repository path
 *   maxWorktreeNameChars  — the longest worktree directory name an operation may produce
 *   maxIntegrationRootChars — the longest integration scratch root
 *   maxCommitMessageChars — the longest integration commit message
 *   maxTestSpecs          — test commands one integration may run
 *   maxCommandChars       — the longest test command
 *   maxCommandArgs        — the most argv entries one test command may carry
 *   maxTestOutputBytes    — the stdout+stderr ceiling for one test command
 *   maxTestTimeoutMs      — the longest one test command may run
 *   defaultTestTimeoutMs  — the test timeout when a caller does not ask for one
 *   maxTargetChars        — the longest integration target (a branch name)
 */
export const INTEGRATION_LIMITS = Object.freeze({
  maxOperations: 256,
  maxRepositoryChars: 1024,
  maxWorktreeNameChars: 128,
  maxIntegrationRootChars: 1024,
  maxCommitMessageChars: 512,
  maxTestSpecs: 32,
  maxCommandChars: 1024,
  maxCommandArgs: 128,
  maxTestOutputBytes: 2 * 1024 * 1024,
  maxTestTimeoutMs: 120000,
  defaultTestTimeoutMs: 30000,
  maxTargetChars: 256,
});

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const MAX_ARG_CHARS = 32768;
const EMPTY_DIRTY_PATHS = Object.freeze([]);

function requireText(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new CollaborationError('invalid_request', field);
  }
  return value;
}

/**
 * The test runner. `stdio` is `['ignore', 'pipe', 'pipe']` — the same shape
 * `bridge/workspaceCommand.js` uses — so a child's stdin is IGNORED, and the plan's stdin
 * limitation is honoured by the runner's TYPE rather than by a rule: there is no `input` member,
 * so no caller can write to a child's stdin through this object. A test that needs a blob reads it
 * from the temp file the service writes and names in `VIS_INTEGRATION_INPUT`.
 *
 * Exported so the runner's own stop guarantee (a timeout or an output overflow STOPS the child,
 * exactly once) is directly observable rather than only observable through a full integration.
 */
export function createTestRunner(options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const stopChild = options.stopChild ?? stopProcessTree;
  const outputLimit = Number.isSafeInteger(options.outputLimit) && options.outputLimit > 0
    ? options.outputLimit
    : INTEGRATION_LIMITS.maxTestOutputBytes;
  const defaultTimeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : INTEGRATION_LIMITS.defaultTestTimeoutMs;

  return async function runTest(input = {}) {
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'integration_test_input');
    }
    const command = requireText(
      input.command,
      'integration_test_command',
      INTEGRATION_LIMITS.maxCommandChars,
    );
    const args = input.args;
    if (!Array.isArray(args) || args.length === 0
      || args.length > INTEGRATION_LIMITS.maxCommandArgs
      || !args.every((arg) => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')
        && Buffer.byteLength(arg) <= MAX_ARG_CHARS)) {
      throw new CollaborationError('invalid_request', 'integration_test_args');
    }
    const cwd = requireText(
      input.cwd,
      'integration_test_cwd',
      INTEGRATION_LIMITS.maxRepositoryChars,
    );
    const timeoutMs = input.timeoutMs === undefined
      ? defaultTimeout
      : (() => {
        if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0
          || input.timeoutMs > INTEGRATION_LIMITS.maxTestTimeoutMs) {
          throw new CollaborationError('invalid_request', 'integration_test_timeout');
        }
        return input.timeoutMs;
      })();
    const startedAt = Date.now();
    const child = spawnProcess(command, [...args], {
      cwd,
      env: input.env ?? {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...detachedProcessOptions(),
    });
    const sizes = { stdout: 0, stderr: 0 };
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let failure = null;
    // The memoized stop: null until the first stop request, so the child is stopped AT MOST once
    // no matter how many times a timeout or an output overflow asks for it. It must start null —
    // a `false` initializer would make `??=` a no-op and the child would never be stopped at all.
    let stopping = null;
    const stop = () => (stopping ??= Promise.resolve(stopChild(child)).catch(() => undefined));
    const done = new Promise((resolve) => {
      child.once('error', (error) => {
        failure = new CollaborationError('source_unavailable', 'integration_test_spawn', {
          command,
          code: error?.code ?? null,
        });
      });
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          if (failure !== null) return;
          sizes[stream] += chunk.length;
          const appended = appendBoundedBuffer(buffers[stream], chunk, outputLimit);
          if (appended.overflow) {
            failure = new CollaborationError('conflict', 'integration_test_output', {
              stream,
              limit: outputLimit,
              observed: sizes[stream],
            });
            void stop();
            return;
          }
          buffers[stream] = appended.buffer;
        });
      }
      child.once('close', (exitCode, signal) => {
        resolve({
          exitCode: typeof exitCode === 'number' ? exitCode : -1,
          signal: signal ?? null,
          stdout: buffers.stdout.toString('utf8'),
          stderr: buffers.stderr.toString('utf8'),
          failure,
        });
      });
    });
    const timer = setTimeout(() => {
      if (failure === null) {
        failure = new CollaborationError('timeout', 'integration_test_timeout', {
          command,
          limit: timeoutMs,
        });
        void stop();
      }
    }, timeoutMs);
    timer.unref?.();
    const { failure: error, ...result } = await done;
    clearTimeout(timer);
    if (error !== null) throw error;
    return Object.freeze({
      ...result,
      durationMs: Date.now() - startedAt,
      stdoutBytes: sizes.stdout,
      stderrBytes: sizes.stderr,
      outputLimitBytes: outputLimit,
    });
  };
}

/* ------------------------------------------------------------------ observation */

async function pathExists(fsLike, target) {
  try {
    await fsLike.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The observed on-disk shape of a directory: a file count and a digest over (relative path,
 * content hash). `.git` is skipped — in a repository it is a directory, in a worktree it is a
 * gitfile, and neither is part of the user's content (the task-40 tree-comparison lesson).
 *
 * A symlink is observed by its RAW link target, read with readlink: git allows a committed link
 * whose target does not exist, and resolving one (realpath) would both throw ENOENT on a legal
 * tree and record a host-absolute path that changes when the repository moves.
 */
async function observeTree(fsLike, root) {
  const files = {};
  async function walk(relative) {
    const absolute = relative === '' ? root : path.join(root, relative);
    for (const entry of await fsLike.readdir(absolute, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const info = await fsLike.lstat(path.join(root, child));
      if (info.isDirectory()) {
        await walk(child);
        continue;
      }
      if (info.isSymbolicLink()) {
        files[child] = `symlink:${await fsLike.readlink(path.join(root, child))}`;
        continue;
      }
      files[child] = createHash('sha256').update(await fsLike.readFile(path.join(root, child)))
        .digest('hex');
    }
  }
  await walk('');
  const names = Object.keys(files).sort();
  const hash = createHash('sha256');
  for (const name of names) hash.update(`${name}\0${files[name]}\0`);
  return Object.freeze({ fileCount: names.length, treeDigest: hash.digest('hex') });
}

/**
 * The branches that are CHECKED OUT in any worktree of a repository, read with git in the NAMED
 * repository directory. `git worktree list --porcelain -z` reports the main worktree and every
 * linked one, each with its `branch refs/heads/<name>` line, so this is the complete set.
 */
async function checkedOutBranches(runGit, repository) {
  const listed = await runGit({ cwd: repository, args: ['worktree', 'list', '--porcelain', '-z'] });
  if (listed.exitCode !== 0) {
    throw new CollaborationError('source_unavailable', 'integration_worktree_list', {
      repository,
      stderr: listed.stderr.slice(0, 512),
    });
  }
  const fields = listed.stdout.split('\0');
  const branches = [];
  let current = null;
  for (const field of fields) {
    if (field.startsWith('worktree ')) {
      current = field.slice('worktree '.length);
      continue;
    }
    if (field.startsWith('branch ') && current !== null) {
      branches.push(Object.freeze({ worktree: current, branch: field.slice('branch '.length) }));
    }
  }
  return Object.freeze(branches);
}

/* ------------------------------------------------------------------ the service */

export function createIntegrationService(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new CollaborationError('invalid_request', 'integration_options');
  }
  for (const [field, value] of [
    ['integration_store', options.store],
    ['integration_artifacts', options.artifacts],
    ['integration_reviews', options.reviews],
    ['integration_locks', options.locks],
  ]) {
    if (value === null || typeof value !== 'object') {
      throw new CollaborationError('invalid_request', field);
    }
  }
  const store = options.store;
  const artifacts = options.artifacts;
  const reviews = options.reviews;
  const locks = options.locks;
  const integrationsRoot = requireText(
    options.integrationsRoot,
    'integration_root',
    INTEGRATION_LIMITS.maxIntegrationRootChars,
  );
  const fsLike = options.fs ?? fs;
  const runGit = options.runGit ?? createGitRunner(options);
  const runTest = options.runTest ?? createTestRunner(options);
  const newOperationId = typeof options.newOperationId === 'function'
    ? options.newOperationId
    : randomUUID;
  const limits = INTEGRATION_LIMITS;
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );

  /** operationId → the frozen durable result. */
  const resultsById = new Map();
  const stats = { operations: 0, integrated: 0, refused: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'integration_service_closed');
  }

  function validateCriteria(criteria) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
      throw new CollaborationError('invalid_request', 'integration_criteria');
    }
    const seen = new Set();
    for (const criterion of criteria) {
      if (criterion === null || typeof criterion !== 'object' || typeof criterion.id !== 'string'
        || criterion.id.length === 0 || typeof criterion.required !== 'boolean') {
        throw new CollaborationError('invalid_request', 'integration_criteria');
      }
      if (seen.has(criterion.id)) {
        throw new CollaborationError('conflict', 'integration_criteria', { id: criterion.id });
      }
      seen.add(criterion.id);
    }
    return seen;
  }

  function validateTests(tests, criteriaIds) {
    if (!Array.isArray(tests) || tests.length === 0 || tests.length > limits.maxTestSpecs) {
      throw new CollaborationError('invalid_request', 'integration_tests');
    }
    const covered = new Set();
    for (const spec of tests) {
      if (spec === null || typeof spec !== 'object' || typeof spec.criterionId !== 'string'
        || spec.criterionId.length === 0) {
        throw new CollaborationError('invalid_request', 'integration_tests');
      }
      if (!criteriaIds.has(spec.criterionId)) {
        throw new CollaborationError('invalid_request', 'integration_tests', {
          criterionId: spec.criterionId,
        });
      }
      requireText(spec.command, 'integration_test_command', limits.maxCommandChars);
      if (!Array.isArray(spec.args) || spec.args.length === 0
        || spec.args.length > limits.maxCommandArgs) {
        throw new CollaborationError('invalid_request', 'integration_test_args');
      }
      if (spec.input !== undefined && spec.input !== null && !Buffer.isBuffer(spec.input)) {
        throw new CollaborationError('invalid_request', 'integration_test_input_blob');
      }
      covered.add(spec.criterionId);
    }
    const missing = [...criteriaIds].filter((id) => !covered.has(id));
    if (missing.length > 0) {
      throw new CollaborationError('invalid_request', 'integration_criteria', {
        missing: Object.freeze(missing),
      });
    }
    return tests;
  }

  /** Read the target's HEAD, the target branch's tip, the porcelain status and the tree shape. */
  async function observeTarget(repository, target) {
    const head = await runGit({ cwd: repository, args: ['rev-parse', '--verify', 'HEAD'] });
    if (head.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'integration_target_head', {
        repository,
        stderr: head.stderr.slice(0, 512),
      });
    }
    const headCommit = head.stdout.trim();
    if (!COMMIT_PATTERN.test(headCommit)) {
      throw new CollaborationError('conflict', 'integration_target_head', { repository });
    }
    const ref = await runGit({
      cwd: repository,
      args: ['rev-parse', '--verify', `refs/heads/${target}`],
    });
    if (ref.exitCode !== 0) {
      throw new CollaborationError('conflict', 'integration_target_missing', {
        repository,
        target,
        stderr: ref.stderr.slice(0, 512),
      });
    }
    const targetCommit = ref.stdout.trim();
    const status = await runGit({
      cwd: repository,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    });
    if (status.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'integration_target_status', {
        repository,
        stderr: status.stderr.slice(0, 512),
      });
    }
    const dirtyPaths = status.stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(3));
    const tree = await observeTree(fsLike, repository);
    return Object.freeze({
      head: headCommit,
      targetHead: targetCommit,
      clean: dirtyPaths.length === 0,
      dirtyPaths: Object.freeze(dirtyPaths),
      fileCount: tree.fileCount,
      treeDigest: tree.treeDigest,
    });
  }

  /**
   * The commit side of the boundary. It is constructed from the operation's OWN temporary
   * integration worktree and nothing else, and its only member is `commit`. There is deliberately
   * no member that accepts a directory, so this sink cannot be aimed at the user's original
   * directory — "never auto-commit the user's original directory" is structural, not conditional.
   */
  function createCommitSink(scope) {
    return Object.freeze({
      async commit(message) {
        const add = await runGit({ cwd: scope.worktree, args: ['add', '-A'] });
        if (add.exitCode !== 0) {
          throw new CollaborationError('source_unavailable', 'integration_commit', {
            worktree: scope.worktree,
            stderr: add.stderr.slice(0, 512),
          });
        }
        const commit = await runGit({
          cwd: scope.worktree,
          args: [
            '-c', 'user.name=vis-integration',
            '-c', 'user.email=vis-integration@example.invalid',
            'commit', '-q', '-m', message,
          ],
        });
        if (commit.exitCode !== 0) {
          throw new CollaborationError('source_unavailable', 'integration_commit', {
            worktree: scope.worktree,
            stderr: commit.stderr.slice(0, 512),
          });
        }
        const head = await runGit({ cwd: scope.worktree, args: ['rev-parse', '--verify', 'HEAD'] });
        if (head.exitCode !== 0) {
          throw new CollaborationError('source_unavailable', 'integration_commit', {
            worktree: scope.worktree,
            stderr: head.stderr.slice(0, 512),
          });
        }
        const sha = head.stdout.trim();
        if (!COMMIT_PATTERN.test(sha)) {
          throw new CollaborationError('conflict', 'integration_commit', { worktree: scope.worktree });
        }
        return sha;
      },
    });
  }

  /** Re-hash the durable object's ACTUAL bytes and compare them with the approved hash. */
  async function verifyArtifactBytes(artifactHash) {
    const reader = await store.open(artifactHash);
    const digest = await hashSource({ async open() { return reader; } });
    return Object.freeze({
      artifactHash: digest.artifactHash,
      bytes: digest.bytes,
      chunks: digest.chunks,
      peakBufferedBytes: digest.peakBufferedBytes,
      ok: digest.artifactHash === artifactHash,
    });
  }

  function refusal(code, field, detail = {}) {
    return Object.freeze({ code, field, detail: Object.freeze({ ...detail }) });
  }

  /**
   * Run one integration. Every outcome — success and every refusal — is returned as ONE frozen
   * durable result. Only a malformed CALL throws, and then as a CollaborationError carrying an
   * explicit code and field, never a bare throw.
   */
  async function integrate(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'integration_input');
    }
    const approvalId = requireText(input.approvalId, 'integration_approval_id', 128);
    const approval = reviews.approval(approvalId);
    const binding = approval.binding;
    const repository = binding.repository;
    const target = binding.target;
    const artifactHash = binding.artifactHash;
    const base = binding.base;
    const startedAt = parseAt(input.at);
    const criteriaIds = validateCriteria(input.criteria);
    const tests = validateTests(input.tests, criteriaIds);
    const commitMessage = input.commitMessage === undefined
      ? `vis: integrate ${artifactHash.slice(0, 12)}`
      : requireText(input.commitMessage, 'integration_commit_message', limits.maxCommitMessageChars);
    const testTimeoutMs = input.testTimeoutMs === undefined
      ? limits.defaultTestTimeoutMs
      : (() => {
        if (!Number.isSafeInteger(input.testTimeoutMs) || input.testTimeoutMs <= 0
          || input.testTimeoutMs > limits.maxTestTimeoutMs) {
          throw new CollaborationError('invalid_request', 'integration_test_timeout');
        }
        return input.testTimeoutMs;
      })();
    if (resultsById.size >= limits.maxOperations) {
      throw new CollaborationError('conflict', 'integration_capacity', {
        limit: limits.maxOperations,
        observed: resultsById.size,
      });
    }

    const operationId = newOperationId();
    const operationRoot = path.join(integrationsRoot, operationId);
    const worktreePath = path.join(operationRoot, 'worktree');
    const inputRoot = path.join(operationRoot, 'input');

    const state = {
      outcome: 'integrated',
      rejection: null,
      observedArtifactHash: artifactHash,
      artifactBytes: 0,
      artifactChunks: 0,
      artifactPeakBufferedBytes: 0,
      artifactVerified: false,
      targetBefore: Object.freeze({
        head: '', targetHead: '', clean: false, dirtyPaths: EMPTY_DIRTY_PATHS,
        fileCount: 0, treeDigest: '',
      }),
      targetAfter: null,
      testRecords: [],
      worktreeCreated: false,
      worktreeRemoved: false,
      removedAt: null,
      commitSha: null,
      fastForwardTo: null,
      fastForwardApplied: false,
      fastForwardIsFF: false,
      grant: null,
      lockHeldMs: 0,
      worktreeAfterApply: null,
    };

    async function run() {
      // 1 — the approved hash against the actual bytes.
      try {
        const digest = await verifyArtifactBytes(artifactHash);
        state.observedArtifactHash = digest.artifactHash;
        state.artifactBytes = digest.bytes;
        state.artifactChunks = digest.chunks;
        state.artifactPeakBufferedBytes = digest.peakBufferedBytes;
        state.artifactVerified = digest.ok;
        if (!digest.ok) {
          state.outcome = 'artifact_mismatch';
          state.rejection = refusal('conflict', 'integration_artifact_bytes', {
            approved: artifactHash,
            observed: digest.artifactHash,
            bytes: digest.bytes,
          });
          return;
        }
      } catch (error) {
        if (error instanceof CollaborationError && error.field === 'artifact_missing') {
          state.outcome = 'artifact_mismatch';
          state.rejection = refusal('invalid_request', 'integration_artifact_missing', {
            artifactHash,
          });
          return;
        }
        throw error;
      }

      // 1b — the artifact's OWN declared base must be the base this approval bound. An artifact
      // captured against an older commit would otherwise replay its whole-file content over
      // whatever landed since, silently reverting newer work (a full-file overwrite is not a
      // three-way merge, so a stale snapshot is refused rather than "applied cleanly").
      const declaredBase = artifacts.deserialize(await store.read(artifactHash)).baseCommit;
      if (declaredBase !== base) {
        state.outcome = 'base_mismatch';
        state.rejection = refusal('conflict', 'integration_artifact_base', {
          artifactHash,
          artifactBase: declaredBase,
          base,
        });
        return;
      }

      // 2 — the repository lock: two integrations against one target are serialized here.
      state.grant = await locks.acquire({ repository, operationId });

      // 3 — the target-clean / HEAD re-check, before anything is written.
      state.targetBefore = await observeTarget(repository, target);
      if (state.targetBefore.head !== base) {
        state.outcome = 'head_moved';
        state.rejection = refusal('conflict', 'integration_head_moved', {
          expected: base,
          observed: state.targetBefore.head,
        });
        return;
      }
      if (state.targetBefore.targetHead !== base) {
        state.outcome = 'head_moved';
        state.rejection = refusal('conflict', 'integration_head_moved', {
          expected: base,
          observed: state.targetBefore.targetHead,
          ref: `refs/heads/${target}`,
        });
        return;
      }
      if (!state.targetBefore.clean) {
        state.outcome = 'target_dirty';
        state.rejection = refusal('conflict', 'integration_target_dirty', {
          repository,
          target,
          dirtyPaths: state.targetBefore.dirtyPaths,
        });
        return;
      }
      // A target branch that is CHECKED OUT somewhere is refused: moving its ref leaves that
      // worktree's HEAD, index and files at the old commit, so the workspace reads as a reverse
      // modification of everything the integration just landed, and the next commit there would
      // revert it. Advancing such a branch means updating the user's directory, which this module
      // structurally never does, so the integration refuses and names the worktrees that hold it.
      const holders = (await checkedOutBranches(runGit, repository))
        .filter((entry) => entry.branch === `refs/heads/${target}`);
      if (holders.length > 0) {
        state.outcome = 'target_checked_out';
        state.rejection = refusal('conflict', 'integration_target_checked_out', {
          repository,
          target,
          worktrees: Object.freeze(holders.map((entry) => entry.worktree)),
        });
        return;
      }

      // 4 — this operation's own temporary clean integration worktree.
      await fsLike.mkdir(operationRoot, { recursive: true });
      const added = await runGit({
        cwd: repository,
        args: ['worktree', 'add', '--detach', '--', worktreePath, base],
      });
      if (added.exitCode !== 0) {
        state.outcome = 'worktree_failed';
        state.rejection = refusal('source_unavailable', 'integration_worktree', {
          repository,
          worktree: worktreePath,
          base,
          stderr: added.stderr.slice(0, 512),
        });
        return;
      }
      state.worktreeCreated = true;

      // 5 — the artifact is applied into the operation's own worktree, losslessly.
      try {
        await artifacts.apply({ artifactHash }, worktreePath);
      } catch (error) {
        if (error instanceof CollaborationError) {
          state.outcome = 'worktree_failed';
          state.rejection = refusal(error.code, `integration_${error.field}`, {
            worktree: worktreePath,
            detail: error.detail,
          });
          return;
        }
        throw error;
      }
      // The approved content is the applied artifact and nothing else. The tree the artifact
      // produced is recorded here, so step 6 can prove the tests did not add to it.
      state.worktreeAfterApply = await observeTree(fsLike, worktreePath);

      // 6 — the frozen criteria's tests, in the worktree, with stdin IGNORED. A runner failure
      // (a timeout, a spawn error, an output overflow) is a REFUSAL recorded here, never an
      // exception that escapes without a durable result: "every failure has a result" is the
      // module's own contract, and a test that must be stopped is exactly such a failure.
      for (const spec of tests) {
        const inputFile = Buffer.isBuffer(spec.input) && spec.input.length > 0
          ? path.join(inputRoot, `${spec.criterionId}.bin`)
          : null;
        if (inputFile !== null) {
          await fsLike.mkdir(inputRoot, { recursive: true });
          await fsLike.writeFile(inputFile, spec.input);
        }
        let record;
        try {
          record = await runTest({
            command: spec.command,
            args: [...spec.args],
            cwd: worktreePath,
            env: {
              ...gitEnv,
              LC_ALL: 'C',
              VIS_INTEGRATION_WORKTREE: worktreePath,
              VIS_INTEGRATION_ARTIFACT_HASH: artifactHash,
              VIS_INTEGRATION_INPUT: inputFile ?? '',
            },
            timeoutMs: testTimeoutMs,
          });
        } catch (error) {
          if (error instanceof CollaborationError) {
            state.outcome = 'test_runner_failed';
            // The runner's own fields are already integration_-prefixed, so they travel verbatim.
            state.rejection = refusal(error.code, error.field, {
              criterionId: spec.criterionId,
              command: spec.command,
              detail: error.detail ?? null,
            });
            return;
          }
          throw error;
        }
        state.testRecords.push(Object.freeze({
          criterionId: spec.criterionId,
          command: spec.command,
          args: Object.freeze([...spec.args]),
          exitCode: record.exitCode,
          durationMs: record.durationMs,
          stdoutBytes: record.stdoutBytes,
          stderrBytes: record.stderrBytes,
          inputFile,
          outputLimitBytes: record.outputLimitBytes,
        }));
        if (record.exitCode !== 0) {
          state.outcome = 'tests_failed';
          state.rejection = refusal('conflict', 'integration_tests', {
            failed: spec.criterionId,
            exitCode: record.exitCode,
            command: spec.command,
            stderr: record.stderr.slice(0, 512),
          });
          return;
        }
      }
      // 6b — the tree the commit will record must be exactly the tree the artifact produced. A
      // test that writes into the worktree would otherwise be swept into the commit by `add -A`
      // and land on the target under the reviewed artifact's hash, un-reviewed.
      const afterTests = await observeTree(fsLike, worktreePath);
      if (afterTests.treeDigest !== state.worktreeAfterApply.treeDigest) {
        state.outcome = 'tree_changed';
        state.rejection = refusal('conflict', 'integration_tree_changed', {
          artifactHash,
          expectedTreeDigest: state.worktreeAfterApply.treeDigest,
          observedTreeDigest: afterTests.treeDigest,
          expectedFileCount: state.worktreeAfterApply.fileCount,
          observedFileCount: afterTests.fileCount,
        });
        return;
      }

      // 7 — the commit, in the operation's own worktree and nowhere else.
      const commitSink = createCommitSink({ worktree: worktreePath });
      state.commitSha = await commitSink.commit(commitMessage);

      // 8a — the target is re-checked immediately before the ref moves. The pre-check at step 3
      // is not a lock: the repository can be dirtied or its HEAD moved by the user or by another
      // git command while the tests run, and the repository lock only serializes THIS service.
      // Anything that changed since the review means the approval no longer describes reality,
      // so the integration stops here and the target ref never advances.
      const rechecked = await observeTarget(repository, target);
      if (rechecked.head !== state.targetBefore.head
        || rechecked.targetHead !== state.targetBefore.targetHead
        || rechecked.clean !== state.targetBefore.clean) {
        state.outcome = 'target_moved';
        state.rejection = refusal('conflict', 'integration_target_moved', {
          repository,
          target,
          before: Object.freeze({
            head: state.targetBefore.head,
            targetHead: state.targetBefore.targetHead,
            clean: state.targetBefore.clean,
          }),
          after: Object.freeze({
            head: rechecked.head,
            targetHead: rechecked.targetHead,
            clean: rechecked.clean,
            dirtyPaths: rechecked.dirtyPaths,
          }),
        });
        return;
      }

      // 8 — the controlled fast-forward: atomic, forward only, never a push.
      const ancestor = await runGit({
        cwd: repository,
        args: ['merge-base', '--is-ancestor', base, state.commitSha],
      });
      if (ancestor.exitCode !== 0) {
        state.outcome = 'fast_forward_failed';
        state.rejection = refusal('conflict', 'integration_fast_forward', {
          ref: `refs/heads/${target}`,
          from: base,
          to: state.commitSha,
          reason: 'not-a-descendant',
        });
        return;
      }
      state.fastForwardIsFF = true;
      state.fastForwardTo = state.commitSha;
      const updated = await runGit({
        cwd: repository,
        args: ['update-ref', `refs/heads/${target}`, state.commitSha, base],
      });
      if (updated.exitCode !== 0) {
        state.outcome = 'fast_forward_failed';
        state.rejection = refusal('conflict', 'integration_fast_forward', {
          ref: `refs/heads/${target}`,
          from: base,
          to: state.commitSha,
          stderr: updated.stderr.slice(0, 512),
        });
        return;
      }
      state.fastForwardApplied = true;
      state.outcome = 'integrated';
    }

    try {
      await run();
    } finally {
      // Only THIS operation's temp is ever removed. The user's files are never touched here.
      if (state.worktreeCreated) {
        await runGit({
          cwd: repository,
          args: ['worktree', 'remove', '--force', '--', worktreePath],
        }).catch(() => undefined);
      }
      if (await pathExists(fsLike, operationRoot)) {
        await fsLike.rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      state.worktreeRemoved = state.worktreeCreated && !(await pathExists(fsLike, worktreePath));
      state.removedAt = state.worktreeRemoved ? Date.now() : null;
      if (state.grant !== null) {
        state.lockHeldMs = locks.release({ grant: state.grant }).heldMs;
      }
      try {
        state.targetAfter = await observeTarget(repository, target);
      } catch {
        state.targetAfter = state.targetBefore;
      }
    }

    const result = Object.freeze({
      ok: state.rejection === null,
      operationId,
      approvalId,
      reviewId: approval.reviewId,
      repository,
      target,
      artifactHash,
      observedArtifactHash: state.observedArtifactHash,
      artifactBytes: state.artifactBytes,
      artifactChunks: state.artifactChunks,
      artifactPeakBufferedBytes: state.artifactPeakBufferedBytes,
      base,
      outcome: state.outcome,
      rejection: state.rejection,
      targetBefore: state.targetBefore,
      targetAfter: state.targetAfter,
      worktree: Object.freeze({
        path: worktreePath,
        created: state.worktreeCreated,
        removed: state.worktreeRemoved,
        removedAt: state.removedAt,
        treeAfterApply: state.worktreeAfterApply,
      }),
      commit: Object.freeze({
        created: state.commitSha !== null,
        sha: state.commitSha,
        worktree: worktreePath,
      }),
      fastForward: Object.freeze({
        ref: `refs/heads/${target}`,
        from: base,
        to: state.fastForwardTo,
        applied: state.fastForwardApplied,
        isFastForward: state.fastForwardIsFF,
      }),
      tests: Object.freeze(state.testRecords),
      lock: Object.freeze({
        lockId: state.grant === null ? '' : state.grant.lockId,
        waited: state.grant === null ? false : state.grant.waited,
        waitedMs: state.grant === null ? 0 : state.grant.waitedMs,
        queuePosition: state.grant === null ? 0 : state.grant.queuePosition,
        heldMs: state.lockHeldMs,
      }),
      artifact: Object.freeze({ preserved: true, verified: state.artifactVerified }),
      startedAt,
      completedAt: Date.now(),
    });
    if (result.ok) stats.integrated += 1;
    else stats.refused += 1;
    stats.operations += 1;
    resultsById.set(operationId, result);
    return result;
  }

  function operation(operationId) {
    const id = requireText(operationId, 'integration_operation_id', 128);
    const found = resultsById.get(id);
    if (found === undefined) {
      throw new CollaborationError('invalid_request', 'integration_operation_unknown', {
        operationId: id,
      });
    }
    return found;
  }

  function operations() {
    return Object.freeze([...resultsById.values()]);
  }

  function state() {
    return Object.freeze({ ...stats, closed });
  }

  function close() {
    closed = true;
  }

  return {
    INTEGRATION_LIMITS,
    integrate,
    operation,
    operations,
    state,
    close,
  };
}
