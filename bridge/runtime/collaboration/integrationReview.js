import { randomUUID } from 'node:crypto';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import { createGitRunner } from './writerLeases.js';

/**
 * The integration review (task 41): the record that BINDS the artifact hash, the base commit and
 * the integration target, and the approval that freezes that binding.
 *
 * The load-bearing property is that a binding is IMMUTABLE, which is what makes "any change forces
 * a re-review" structural rather than conditional:
 *
 *   * `create` observes the repository itself. The `base` it records is the HEAD the service read
 *     with git in the NAMED repository directory, never a caller's claim, and the cleanliness it
 *     records is the porcelain status it read at the same moment. A review therefore binds what
 *     was actually there, not what somebody said was there.
 *   * `approve` mints ONE frozen approval carrying the binding verbatim. There is no second
 *     approval for the same review — approving twice is an explicit refusal — and no function in
 *     this module accepts a new artifact hash, base or target for an existing review. So a changed
 *     artifact, a moved base or a different target can only ever be expressed as a NEW review.
 *   * the binding is `Object.freeze`d, so even a caller holding the approval cannot rewrite it.
 *
 * A review for an artifact hash that was never stored is refused at creation: the review binds a
 * durable object, and there is nothing to bind otherwise.
 */

/**
 * The frozen review budgets. One object, shared by every enforcing call site:
 *
 *   maxReviews        — reviews one service holds at once
 *   maxApprovals      — approvals one service holds at once
 *   maxRepositoryChars— the longest repository path
 *   maxTargetChars    — the longest integration target (a branch name)
 *   maxReviewerChars  — the longest reviewer identity
 */
export const INTEGRATION_REVIEW_LIMITS = Object.freeze({
  maxReviews: 256,
  maxApprovals: 256,
  maxRepositoryChars: 1024,
  maxTargetChars: 256,
  maxReviewerChars: 128,
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
/** A branch name: no leading dash, no `..`, no control characters, no ref-delimiter collisions. */
const TARGET_PATTERN = /^(?![-.])[A-Za-z0-9._/-]+$/;

function requireText(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new CollaborationError('invalid_request', field);
  }
  return value;
}

export function createIntegrationReviewService(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new CollaborationError('invalid_request', 'integration_review_options');
  }
  const limits = options.limits ?? INTEGRATION_REVIEW_LIMITS;
  const newReviewId = typeof options.newReviewId === 'function' ? options.newReviewId : randomUUID;
  const newApprovalId = typeof options.newApprovalId === 'function' ? options.newApprovalId : randomUUID;
  // The git runner is task 40's own, whose cwd is a REQUIRED named argument, so none of this
  // module's reads can run anywhere but the repository it was handed.
  const runGit = options.runGit ?? createGitRunner(options);
  const store = options.store ?? null;
  const hasArtifact = options.hasArtifact ?? (store === null
    ? null
    : async (artifactHash) => store.has(artifactHash));

  if (typeof runGit !== 'function') {
    throw new CollaborationError('invalid_request', 'integration_review_git');
  }
  if (typeof hasArtifact !== 'function') {
    throw new CollaborationError('invalid_request', 'integration_review_artifact_probe');
  }

  /** reviewId → the frozen review record. */
  const reviewsById = new Map();
  /** approvalId → the frozen approval record. */
  const approvalsById = new Map();
  const stats = { created: 0, approved: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'integration_review_closed');
  }

  function validateTarget(target) {
    const name = requireText(target, 'integration_target', limits.maxTargetChars);
    if (!TARGET_PATTERN.test(name) || name.includes('..') || name.endsWith('.lock')
      || name.endsWith('/') || name.includes('//') || name.includes('@{')) {
      throw new CollaborationError('invalid_request', 'integration_target');
    }
    return name;
  }

  function validateArtifactHash(artifactHash) {
    if (typeof artifactHash !== 'string' || !HASH_PATTERN.test(artifactHash)) {
      throw new CollaborationError('invalid_request', 'integration_artifact_hash');
    }
    return artifactHash;
  }

  /**
   * Read the repository's HEAD, the target branch's tip and the porcelain status, all in the NAMED
   * repository directory. Every call goes through the injected runner, whose cwd is a required
   * named argument, so none of these can run anywhere else.
   */
  async function observeRepository(repository, target) {
    const head = await runGit({ cwd: repository, args: ['rev-parse', '--verify', 'HEAD'] });
    if (head.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'integration_review_head', {
        repository,
        stderr: head.stderr.slice(0, 512),
      });
    }
    const headCommit = head.stdout.trim();
    if (!COMMIT_PATTERN.test(headCommit)) {
      throw new CollaborationError('conflict', 'integration_review_head', { repository });
    }
    const targetRef = await runGit({
      cwd: repository,
      args: ['rev-parse', '--verify', `refs/heads/${target}`],
    });
    if (targetRef.exitCode !== 0) {
      throw new CollaborationError('conflict', 'integration_review_target', {
        repository,
        target,
        stderr: targetRef.stderr.slice(0, 512),
      });
    }
    const targetCommit = targetRef.stdout.trim();
    if (!COMMIT_PATTERN.test(targetCommit)) {
      throw new CollaborationError('conflict', 'integration_review_target', { repository, target });
    }
    const status = await runGit({
      cwd: repository,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    });
    if (status.exitCode !== 0) {
      throw new CollaborationError('source_unavailable', 'integration_review_status', {
        repository,
        stderr: status.stderr.slice(0, 512),
      });
    }
    const dirtyPaths = status.stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(3));
    return Object.freeze({
      head: headCommit,
      targetHead: targetCommit,
      clean: dirtyPaths.length === 0,
      dirtyPaths: Object.freeze(dirtyPaths),
    });
  }

  function reviewView(record) {
    return Object.freeze({
      reviewId: record.reviewId,
      repository: record.repository,
      target: record.target,
      artifactHash: record.artifactHash,
      base: record.base,
      state: record.state,
      headAtReview: record.headAtReview,
      targetHeadAtReview: record.targetHeadAtReview,
      targetCleanAtReview: record.targetCleanAtReview,
      dirtyPathsAtReview: record.dirtyPathsAtReview,
      createdAt: record.createdAt,
      approvedAt: record.approvedAt,
      reviewerId: record.reviewerId,
    });
  }

  /**
   * Create one review. The repository is observed here, so the base the review binds is the HEAD
   * that was really there, and the cleanliness it records is the status that was really there.
   */
  async function create(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'integration_review');
    }
    const repository = requireText(
      input.repository,
      'integration_repository',
      limits.maxRepositoryChars,
    );
    const target = validateTarget(input.target);
    const artifactHash = validateArtifactHash(input.artifactHash);
    if (reviewsById.size >= limits.maxReviews) {
      throw new CollaborationError('conflict', 'integration_review_capacity', {
        limit: limits.maxReviews,
        observed: reviewsById.size,
      });
    }
    if (!(await hasArtifact(artifactHash))) {
      throw new CollaborationError('invalid_request', 'integration_artifact_missing', { artifactHash });
    }
    const observed = await observeRepository(repository, target);
    const record = {
      reviewId: newReviewId(),
      repository,
      target,
      artifactHash,
      base: observed.head,
      state: 'pending',
      headAtReview: observed.head,
      targetHeadAtReview: observed.targetHead,
      targetCleanAtReview: observed.clean,
      dirtyPathsAtReview: observed.dirtyPaths,
      createdAt: parseAt(input.at),
      approvedAt: null,
      reviewerId: null,
    };
    reviewsById.set(record.reviewId, record);
    stats.created += 1;
    return reviewView(record);
  }

  /**
   * Approve one pending review. The returned approval carries the binding verbatim and is frozen;
   * the review it came from can never be approved again, so the binding is minted exactly once.
   */
  function approve(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'integration_approval');
    }
    const reviewId = requireText(input.reviewId, 'integration_review_id', 128);
    const reviewerId = requireText(input.reviewerId, 'integration_reviewer', limits.maxReviewerChars);
    const record = reviewsById.get(reviewId);
    if (record === undefined) {
      throw new CollaborationError('invalid_request', 'integration_review_unknown', { reviewId });
    }
    if (record.state === 'approved') {
      throw new CollaborationError('conflict', 'integration_review_approved', {
        reviewId,
        approvedAt: record.approvedAt,
        reviewerId: record.reviewerId,
      });
    }
    record.state = 'approved';
    record.approvedAt = parseAt(input.at);
    record.reviewerId = reviewerId;
    const approval = Object.freeze({
      approvalId: newApprovalId(),
      reviewId,
      repository: record.repository,
      target: record.target,
      artifactHash: record.artifactHash,
      base: record.base,
      reviewerId,
      approvedAt: record.approvedAt,
      binding: Object.freeze({
        artifactHash: record.artifactHash,
        base: record.base,
        target: record.target,
        repository: record.repository,
      }),
    });
    approvalsById.set(approval.approvalId, approval);
    stats.approved += 1;
    return approval;
  }

  function review(reviewId) {
    const id = requireText(reviewId, 'integration_review_id', 128);
    const record = reviewsById.get(id);
    if (record === undefined) {
      throw new CollaborationError('invalid_request', 'integration_review_unknown', { reviewId: id });
    }
    return reviewView(record);
  }

  function approval(approvalId) {
    const id = requireText(approvalId, 'integration_approval_id', 128);
    const found = approvalsById.get(id);
    if (found === undefined) {
      throw new CollaborationError('invalid_request', 'integration_approval_unknown', { approvalId: id });
    }
    return found;
  }

  function reviews() {
    return Object.freeze([...reviewsById.values()].map(reviewView));
  }

  function approvals() {
    return Object.freeze([...approvalsById.values()]);
  }

  function state() {
    return Object.freeze({ created: stats.created, approved: stats.approved, closed });
  }

  function close() {
    closed = true;
  }

  return {
    INTEGRATION_REVIEW_LIMITS,
    create,
    approve,
    review,
    approval,
    reviews,
    approvals,
    state,
    close,
  };
}
