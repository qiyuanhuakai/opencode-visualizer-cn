import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';

/**
 * Repository locks (task 41): the mutual exclusion that SERIALIZES two integrations against one
 * target repository.
 *
 * The guarantee is structural rather than conditional. `REPOSITORY_LOCK_LIMITS.maxHolders` is the
 * literal `1`, and the holder slot is the ONLY way a lock is ever granted: `acquire` either fills
 * an empty slot or refuses/queues, and there is no code path that fills a slot that already has a
 * holder. So "two integrations are serialized" is a property of the data structure, not of an `if`
 * a caller could talk its way past.
 *
 * What a caller can OBSERVE, rather than being told:
 *
 *   grant.waited / grant.waitedMs  — whether this acquisition had to wait, and for how many real
 *                                    milliseconds. A waiter that was granted reports a non-zero
 *                                    waitedMs; a first-through acquisition reports `false` / `0`.
 *   grant.queuePosition            — how many waiters were ahead of it, 0 for a first-through.
 *   state().order                  — every grant in the order it was granted, each with its
 *                                    acquiredAt and releasedAt, so the serialization is a timeline
 *                                    a caller can read rather than a claim.
 *
 * The repository key is `path.resolve(repository)`, so two spellings of one directory collide.
 */

/**
 * The frozen lock budgets. One object, shared by every enforcing call site, so no caller can
 * invent its own limit:
 *
 *   maxLocks            — locks one service tracks at once
 *   maxWaiters          — waiters queued behind one holder
 *   maxWaitMs           — the longest a waiter may ask to wait
 *   maxKeyChars         — the longest repository path
 *   maxOperationIdChars — the longest operation identity
 *   maxHolders          — holders of ONE lock. The serialization constant.
 */
export const REPOSITORY_LOCK_LIMITS = Object.freeze({
  maxLocks: 64,
  maxWaiters: 32,
  maxWaitMs: 60000,
  maxKeyChars: 1024,
  maxOperationIdChars: 128,
  maxHolders: 1,
});

function requireText(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new CollaborationError('invalid_request', field);
  }
  return value;
}

export function createRepositoryLockService(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new CollaborationError('invalid_request', 'repository_lock_options');
  }
  const newLockId = typeof options.newLockId === 'function' ? options.newLockId : randomUUID;
  const limits = options.limits ?? REPOSITORY_LOCK_LIMITS;

  /** key → the live lock record. */
  const locksByKey = new Map();
  /**
   * Every grant ever made, in grant order, kept at SERVICE level so the serialization timeline
   * survives a lock being released and forgotten. Each entry is mutated in place on release and
   * re-frozen on read, so `releasedAt` is always the value it actually reached.
   */
  const orderLog = [];
  const stats = {
    acquired: 0,
    refused: 0,
    waited: 0,
    released: 0,
    maxObservedHoldMs: 0,
  };
  let sequence = 0;
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'repository_lock_service_closed');
  }

  function lockRecord(key, repository) {
    let record = locksByKey.get(key);
    if (record === undefined) {
      if (locksByKey.size >= limits.maxLocks) {
        throw new CollaborationError('conflict', 'repository_lock_capacity', {
          limit: limits.maxLocks,
          observed: locksByKey.size,
        });
      }
      record = { key, repository, holder: null, waiters: [] };
      locksByKey.set(key, record);
    }
    return record;
  }

  function grantView(record, entry, waited, waitedMs, queuePosition) {
    return Object.freeze({
      lockId: entry.lockId,
      repository: record.repository,
      operationId: entry.operationId,
      acquiredAt: entry.acquiredAt,
      waited,
      waitedMs,
      queuePosition,
      sequence: entry.sequence,
    });
  }

  function orderEntry(entry) {
    return Object.freeze({
      sequence: entry.sequence,
      operationId: entry.operationId,
      waited: entry.waited,
      waitedMs: entry.waitedMs,
      acquiredAt: entry.acquiredAt,
      releasedAt: entry.releasedAt,
    });
  }

  /**
   * Acquire the lock over one repository. An empty holder slot is filled immediately and the grant
   * reports `waited: false`. A held lock either queues the caller — and the grant it eventually
   * receives reports `waited: true` with the real elapsed milliseconds — or is refused outright
   * when the caller asked for no wait, asked for longer than `maxWaitMs`, or the waiter queue is
   * full. Every refusal names the holder it collided with.
   */
  function acquire(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'repository_lock_input');
    }
    const repository = requireText(input.repository, 'repository_lock_repository', limits.maxKeyChars);
    const operationId = requireText(
      input.operationId,
      'repository_lock_operation',
      limits.maxOperationIdChars,
    );
    const requestedWait = input.waitMs === undefined ? limits.maxWaitMs : input.waitMs;
    if (!Number.isSafeInteger(requestedWait) || requestedWait < 0 || requestedWait > limits.maxWaitMs) {
      throw new CollaborationError('invalid_request', 'repository_lock_wait');
    }
    const key = path.resolve(repository);
    const record = lockRecord(key, key);
    const startedAt = Date.now();

    if (record.holder === null) {
      sequence += 1;
      const entry = {
        lockId: newLockId(),
        operationId,
        acquiredAt: parseAt(input.at),
        sequence,
        waited: false,
        waitedMs: 0,
        releasedAt: null,
      };
      record.holder = entry;
      orderLog.push(entry);
      stats.acquired += 1;
      return Promise.resolve(grantView(record, entry, false, 0, 0));
    }

    if (requestedWait === 0) {
      stats.refused += 1;
      return Promise.reject(new CollaborationError('conflict', 'repository_lock_busy', {
        repository: record.repository,
        holder: record.holder.operationId,
        holders: 1,
        maxHolders: limits.maxHolders,
      }));
    }
    if (record.waiters.length >= limits.maxWaiters) {
      stats.refused += 1;
      return Promise.reject(new CollaborationError('conflict', 'repository_lock_queue', {
        repository: record.repository,
        holder: record.holder.operationId,
        limit: limits.maxWaiters,
        observed: record.waiters.length,
      }));
    }

    // The 1-based position in the waiting line: the first waiter behind the holder is 1.
    const queuePosition = record.waiters.length + 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = record.waiters.indexOf(waiter);
        if (index >= 0) record.waiters.splice(index, 1);
        stats.refused += 1;
        reject(new CollaborationError('timeout', 'repository_lock_wait', {
          repository: record.repository,
          holder: record.holder === null ? null : record.holder.operationId,
          limit: requestedWait,
          observed: Date.now() - startedAt,
        }));
      }, requestedWait);
      timer.unref?.();
      const waiter = {
        operationId,
        enqueuedAt: startedAt,
        queuePosition,
        grant(granted) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(granted);
        },
      };
      record.waiters.push(waiter);
    }).then((grant) => {
      stats.waited += 1;
      return grant;
    });
  }

  /**
   * Release a held lock. The grant object is the authority: a grant that is not the current holder
   * of its lock is refused, so a stale or forged grant cannot free somebody else's lock. The next
   * waiter, if any, is granted before this call returns, which is what makes the hand-off
   * observable as a strict order.
   */
  function release(input = {}) {
    if (input === null || typeof input !== 'object' || input.grant === null
      || typeof input.grant !== 'object') {
      throw new CollaborationError('invalid_request', 'repository_lock_release');
    }
    const grant = input.grant;
    const key = path.resolve(requireText(grant.repository, 'repository_lock_repository', limits.maxKeyChars));
    const record = locksByKey.get(key);
    if (record === undefined || record.holder === null) {
      throw new CollaborationError('conflict', 'repository_lock_not_held', {
        repository: key,
        lockId: typeof grant.lockId === 'string' ? grant.lockId : null,
      });
    }
    if (record.holder.lockId !== grant.lockId || record.holder.operationId !== grant.operationId) {
      throw new CollaborationError('conflict', 'repository_lock_not_held', {
        repository: key,
        lockId: grant.lockId,
        holder: record.holder.operationId,
      });
    }
    const releasedAt = parseAt(input.at);
    record.holder.releasedAt = releasedAt;
    const heldMs = Math.max(0, releasedAt - record.holder.acquiredAt);
    if (heldMs > stats.maxObservedHoldMs) stats.maxObservedHoldMs = heldMs;
    const receipt = Object.freeze({
      lockId: record.holder.lockId,
      repository: record.repository,
      operationId: record.holder.operationId,
      acquiredAt: record.holder.acquiredAt,
      releasedAt,
      heldMs,
      sequence: record.holder.sequence,
    });
    record.holder = null;
    stats.released += 1;
    const next = record.waiters.shift();
    if (next !== undefined) {
      sequence += 1;
      const entry = {
        lockId: newLockId(),
        operationId: next.operationId,
        acquiredAt: releasedAt,
        sequence,
        waited: true,
        waitedMs: Math.max(0, Date.now() - next.enqueuedAt),
        releasedAt: null,
      };
      record.holder = entry;
      orderLog.push(entry);
      stats.acquired += 1;
      next.grant(grantView(record, entry, true, entry.waitedMs, next.queuePosition));
    }
    if (record.holder === null && record.waiters.length === 0) {
      locksByKey.delete(key);
    }
    return receipt;
  }

  function held(repository) {
    const key = path.resolve(
      requireText(repository, 'repository_lock_repository', limits.maxKeyChars),
    );
    const record = locksByKey.get(key);
    if (record === undefined || record.holder === null) return Object.freeze([]);
    return Object.freeze([grantView(record, record.holder, record.holder.waited, record.holder.waitedMs, 0)]);
  }

  function grants() {
    return Object.freeze(orderLog.map(orderEntry));
  }

  function state() {
    return Object.freeze({
      acquired: stats.acquired,
      refused: stats.refused,
      waited: stats.waited,
      released: stats.released,
      held: locksByKey.size,
      maxObservedHoldMs: stats.maxObservedHoldMs,
      order: Object.freeze(orderLog.map(orderEntry)),
      closed,
    });
  }

  function close() {
    closed = true;
  }

  return {
    REPOSITORY_LOCK_LIMITS,
    acquire,
    release,
    held,
    grants,
    state,
    close,
  };
}
