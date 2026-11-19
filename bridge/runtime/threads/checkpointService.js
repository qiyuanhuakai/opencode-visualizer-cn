import { randomUUID } from 'node:crypto';
import {
  ContextError,
  buildContextCheckpoint,
  deserializeCheckpoint,
  parseCheckpoint,
  parseScope,
} from '../../../shared/runtime/context.js';

/**
 * Canonical Checkpoint service (task 33).
 *
 * A checkpoint is a BOUNDED projection of a long history: 32 KiB / 8k estimated tokens, the fixed
 * content classes, secrets redacted at the entry boundary and prompt-injection-looking text
 * carried as DATA with an `untrusted` label. The transcript itself is never copied — everything
 * the budget excludes is counted and dropped, and evidence is referenced by hash only.
 *
 * The bounds, the redaction, the untrusted labelling and the serialization all come from the pure
 * shared contract; this service owns the id, the store, the frozen read models and the lifecycle.
 */
export function createCheckpointService() {
  const checkpointsById = new Map();
  const stats = { created: 0, bytes: 0, entries: 0, dropped: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new ContextError('cancelled', 'checkpoint_closed');
  }

  /**
   * Build one bounded checkpoint. `checkpointId` may be supplied for restart rebuild; otherwise a
   * fresh canonical id is minted here (the bridge side owns identity, the shared contract stays
   * free of node builtins).
   */
  function create(input = {}) {
    assertOpen();
    const scope = parseScope(input.scope);
    const checkpoint = buildContextCheckpoint({
      checkpointId: input.checkpointId === undefined ? randomUUID() : input.checkpointId,
      scope,
      entries: input.entries,
      at: input.at,
    });
    checkpointsById.set(checkpoint.checkpointId, checkpoint);
    stats.created += 1;
    stats.bytes += checkpoint.bytes;
    stats.entries += checkpoint.entryCount;
    stats.dropped += checkpoint.droppedEntries;
    return checkpoint;
  }

  /** Re-admit a checkpoint received over the wire; its digest and entry hashes are re-verified. */
  function admit(value) {
    assertOpen();
    // The wire form is the serialized string; a parsed object is accepted too.
    const checkpoint = typeof value === 'string' ? deserializeCheckpoint(value) : parseCheckpoint(value);
    checkpointsById.set(checkpoint.checkpointId, checkpoint);
    stats.created += 1;
    stats.bytes += checkpoint.bytes;
    stats.entries += checkpoint.entryCount;
    return checkpoint;
  }

  function get(checkpointId) {
    assertOpen();
    const key = typeof checkpointId === 'string' ? checkpointId.toLowerCase() : checkpointId;
    const checkpoint = checkpointsById.get(key);
    if (checkpoint === undefined) throw new ContextError('invalid_request', 'checkpoint_unknown');
    return checkpoint;
  }

  function checkpoints() {
    assertOpen();
    return Object.freeze([...checkpointsById.values()]);
  }

  function close() {
    closed = true;
    checkpointsById.clear();
  }

  return {
    create,
    admit,
    get,
    checkpoints,
    close,
    get state() {
      return { ...stats, closed };
    },
  };
}
