import {
  ContextError,
  EVIDENCE_TOOLS,
  callEvidenceTool,
  deserializeCheckpoint,
  parseCheckpoint,
} from '../../../shared/runtime/context.js';

/**
 * Evidence query service (task 33) — an MCP-compatible READ-ONLY tool server.
 *
 * It exposes exactly three tools, all reads: get one checkpoint, list its evidence references, and
 * read one byte page of evidence. Scope authorization runs before any read, and every diff/file
 * read is re-verified against the CURRENT target before a byte is served, so a stale snapshot can
 * never satisfy a read and a cross-thread or cross-environment query is unauthorized.
 *
 * The dispatch rules are pure functions from the shared contract; this service owns the checkpoint
 * store, the injected target resolver and reader, and the lifecycle.
 */
export function createEvidenceQuery({ resolveTarget, readEvidence } = {}) {
  if (typeof resolveTarget !== 'function') throw new ContextError('invalid_request', 'query_target_source');
  if (typeof readEvidence !== 'function') throw new ContextError('invalid_request', 'query_reader_source');
  const checkpointsById = new Map();
  const stats = { published: 0, calls: 0, unauthorized: 0, stale: 0, unavailable: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new ContextError('cancelled', 'query_closed');
  }

  /** Publish one checkpoint for querying; its digest and entry hashes are re-verified on arrival. */
  function publish(value) {
    assertOpen();
    // The wire form is the serialized string; a parsed object is accepted too.
    const checkpoint = typeof value === 'string' ? deserializeCheckpoint(value) : parseCheckpoint(value);
    checkpointsById.set(checkpoint.checkpointId, checkpoint);
    stats.published += 1;
    return checkpoint;
  }

  function listTools() {
    assertOpen();
    return EVIDENCE_TOOLS;
  }

  function callTool(input = {}) {
    assertOpen();
    stats.calls += 1;
    try {
      return callEvidenceTool({
        name: input.name,
        arguments: input.arguments,
        findCheckpoint: (checkpointId) => checkpointsById.get(checkpointId) ?? null,
        resolveTarget,
        readEvidence,
      });
    } catch (error) {
      if (error instanceof ContextError) {
        if (error.code === 'unauthorized') stats.unauthorized += 1;
        if (error.field === 'evidence_target_stale') stats.stale += 1;
      }
      throw error;
    }
  }

  function close() {
    closed = true;
    checkpointsById.clear();
  }

  return {
    publish,
    listTools,
    callTool,
    close,
    get state() {
      return { ...stats, closed };
    },
  };
}
