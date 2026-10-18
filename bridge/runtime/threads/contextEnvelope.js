import {
  ContextError,
  parseEvidenceHash,
  registerEvidence,
  wrapContextEntry,
} from '../../../shared/runtime/context.js';

/**
 * Context envelope service (task 33).
 *
 * The envelope is the SAFE CARRIER for context content: `wrap` turns one raw entry into a frozen
 * envelope whose text is redacted and whose prompt-injection-looking content is labelled
 * `untrusted` — carried as DATA, never as an instruction. `register` addresses evidence by hash
 * and keeps only the hash and the size, never the payload.
 *
 * Both halves are pure rules from the shared contract; this service owns the store, the read
 * models and the lifecycle. Every returned model is frozen, so a consumer can never hold a live
 * mutable internal record.
 */
export function createContextEnvelope() {
  const envelopes = [];
  const evidenceByHash = new Map();
  const stats = { wrapped: 0, registered: 0, bytes: 0, redactions: 0, untrusted: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new ContextError('cancelled', 'envelope_closed');
  }

  /** Wrap one raw entry into its frozen, redacted, untrusted-labelled envelope. */
  function wrap(input = {}) {
    assertOpen();
    const envelope = wrapContextEntry(input);
    envelopes.push(envelope);
    stats.wrapped += 1;
    stats.redactions += envelope.redactions;
    if (envelope.untrusted === true) stats.untrusted += 1;
    return envelope;
  }

  /** Register evidence as a hash-addressed record; the payload is never stored. */
  function register(input = {}) {
    assertOpen();
    const record = registerEvidence(input);
    if (evidenceByHash.has(record.hash)) {
      throw new ContextError('conflict', 'envelope_evidence_duplicate');
    }
    evidenceByHash.set(record.hash, record);
    stats.registered += 1;
    stats.bytes += record.bytes;
    return record;
  }

  function get(hash) {
    assertOpen();
    const parsed = parseEvidenceHash(hash);
    const record = evidenceByHash.get(parsed);
    if (record === undefined) throw new ContextError('invalid_request', 'evidence_unknown');
    return record;
  }

  function evidence() {
    assertOpen();
    return Object.freeze([...evidenceByHash.values()]);
  }

  function envelopes_() {
    assertOpen();
    return Object.freeze([...envelopes]);
  }

  function close() {
    closed = true;
    envelopes.length = 0;
    evidenceByHash.clear();
  }

  return {
    wrap,
    register,
    get,
    evidence,
    envelopes: envelopes_,
    close,
    get state() {
      return { ...stats, closed };
    },
  };
}
