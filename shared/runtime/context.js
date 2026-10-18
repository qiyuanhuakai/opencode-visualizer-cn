import { ProtocolError } from './capabilities.js';

/**
 * Context fabric contract (task 33).
 *
 * A context checkpoint is a BOUNDED projection of a long history: it carries the goal, the plan,
 * the decisions, the unresolved questions and hash-addressed references to evidence — never the
 * transcript itself. Evidence is addressed by hash and read by page, and every diff/file read is
 * re-verified against the CURRENT target, so a stale snapshot can never satisfy a read.
 *
 * Two safety rules are structural, not advisory:
 *   - secrets are redacted at the entry boundary, so a plaintext token can never enter a
 *     checkpoint (proven over the real serialized payload, not by a type-level assertion);
 *   - a prompt-injection-looking text is carried as DATA with an `untrusted` label — it is never
 *     executed, never interpreted, and never promoted to a decision (an untrusted decision is
 *     demoted to `unresolved` with a recorded count).
 *
 * This module is pure ESM with no node builtins, so the same contract runs in the bridge, in the
 * Electron main process and in a browser realm. The stateful services live in
 * bridge/runtime/threads/{contextEnvelope,checkpointService,evidenceQuery}.js.
 */

/** One schema version for the whole context fabric contract. */
export const CONTEXT_SCHEMA_VERSION = 1;
/** The fixed content classes a checkpoint may carry. */
export const CONTEXT_CLASSES = Object.freeze(['goal', 'plan', 'decision', 'diff', 'test', 'artifact', 'unresolved']);
/** Admission priority: the goal survives the budget before an artifact caption does. */
export const CONTEXT_CLASS_PRIORITY = Object.freeze({ goal: 0, plan: 1, decision: 2, unresolved: 3, diff: 4, test: 5, artifact: 6 });
/** Where a piece of evidence came from; the traceable half of origin+hash addressing. */
export const EVIDENCE_ORIGIN_KINDS = Object.freeze(['host', 'native', 'file', 'diff']);

/** Serialized checkpoint ceiling: 32 KiB. */
export const CHECKPOINT_MAX_BYTES = 32 * 1024;
/** Estimated-token ceiling for one checkpoint: 8k tokens. */
export const CHECKPOINT_MAX_ESTIMATED_TOKENS = 8000;
/** Per-entry text ceiling; a single entry may still be refused by the checkpoint budget. */
export const MAX_ENTRY_CHARS = 65536;
/** Retained entry ceiling: the byte budget stops admitting long before this on text-heavy histories. */
export const MAX_CHECKPOINT_ENTRIES = 96;
/** Default and maximum byte page served per evidence read. */
export const EVIDENCE_PAGE_BYTES = 4096;
export const MAX_EVIDENCE_PAGE_BYTES = 64 * 1024;
/** Evidence ceiling: a diff or file above this is refused at the boundary, never read into a page. */
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
/** The placeholder that replaces a secret; it can never contain the secret itself. */
export const REDACTED_PLACEHOLDER = '[redacted]';

const encoder = new TextEncoder();
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOKENS_PER_CHAR_DIVISOR = 4;
const TEXT_CLASSES = Object.freeze(['goal', 'plan', 'decision', 'unresolved']);
const EVIDENCE_CLASSES = Object.freeze(['diff', 'test', 'artifact']);
const REF_KEYS = Object.freeze(['hash', 'bytes', 'target']);
const ENTRY_KEYS = Object.freeze(['entryId', 'class', 'origin', 'text', 'untrusted', 'untrustedReason', 'redactions', 'estimatedTokens', 'hash', 'evidence']);
const CHECKPOINT_KEYS = Object.freeze([
  'checkpointId', 'schemaVersion', 'scope', 'createdAt', 'entries', 'evidence', 'digest',
  'estimatedTokens', 'entryCount', 'droppedEntries', 'droppedBytes', 'demoted', 'untrustedEntries', 'redactions', 'transcriptBytes',
]);

/**
 * Prompt-injection shapes, carried as an explicit table so the labeling is pattern-driven rather
 * than a judgement call. The first matching pattern wins; ordinary context text (transcripts with
 * `user:` / `assistant:` lines, plans, diffs, cache instructions) must not match.
 */
export const UNTRUSTED_PATTERNS = Object.freeze([
  Object.freeze({
    reason: 'instruction_override',
    pattern: /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?)\b/i,
  }),
  Object.freeze({
    reason: 'instruction_override',
    pattern: /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?)\b/i,
  }),
  Object.freeze({
    reason: 'instruction_override',
    pattern: /\bforget\s+(?:all\s+|any\s+|your\s+|the\s+)*(?:previous|prior|above|earlier)?\s*(?:instructions?|prompts?|rules?|training)\b/i,
  }),
  Object.freeze({
    reason: 'role_hijack',
    pattern: /\byou\s+are\s+now\s+(?:a|an|the)?\s*(?:DAN|jailbroken|unfiltered|unrestricted|evil)\b/i,
  }),
  Object.freeze({ reason: 'role_hijack', pattern: /\b(?:DAN|jailbreak)\s+mode\b/i }),
  Object.freeze({
    reason: 'restriction_removal',
    pattern: /\b(?:bypass|override|disable|remove|ignore)\s+(?:your\s+|all\s+|any\s+|the\s+)*(?:safety|content)\s*(?:filters?|restrictions?|polic(?:y|ies)|guardrails?|rules?)\b/i,
  }),
  Object.freeze({
    reason: 'restriction_removal',
    pattern: /\boverride\s+(?:your\s+|all\s+|any\s+)(?:rules?|instructions?|restrictions?)\b/i,
  }),
  Object.freeze({
    reason: 'secret_exfiltration',
    pattern: /\b(?:reveal|show|print|output|repeat|leak|exfiltrate)\s+(?:me\s+)?your\s+(?:system\s+prompt|instructions?|api[_\s-]?keys?|tokens?|secrets?|credentials?)\b/i,
  }),
  Object.freeze({
    reason: 'secret_exfiltration',
    pattern: /\b(?:reveal|leak|exfiltrate|print|output)\s+(?:the\s+|your\s+)*(?:system\s+prompt|api[_\s-]?keys?|credentials?)\b/i,
  }),
  Object.freeze({ reason: 'delimiter_impersonation', pattern: /<\|\s*(?:system|im_end|endoftext)\s*\|>/i }),
  Object.freeze({ reason: 'delimiter_impersonation', pattern: /\[\s*INST\s*\]/i }),
  Object.freeze({ reason: 'delimiter_impersonation', pattern: /###\s*(?:SYSTEM|INSTRUCTION)\b/i }),
]);

/**
 * Secret shapes redacted at the entry boundary. The replacement never contains the secret.
 *
 * The first rule's capture layout IS the replace callback's positional contract:
 * String.prototype.replace invokes the callback as (match, group1, group2, ...), so group 1 is
 * the key word and group 2 is the separator, and the value alternation is deliberately
 * NON-capturing because no receiver reads it. The emitted text is <key><separator>[redacted] on
 * every value shape (bare, double-quoted, single-quoted); the value itself is fully replaced.
 */
const SECRET_PATTERNS = Object.freeze([
  Object.freeze({
    pattern: /\b(token|secret|password|passwd|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|bridge[_-]?token|github[_-]?token|aws[_-]?access[_-]?key[_-]?id)\s*([:=])\s*(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"',;)}\]]{6,})/gi,
    replace: (_match, key, separator) => `${key}${separator}${REDACTED_PLACEHOLDER}`,
  }),
  Object.freeze({ pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replace: () => REDACTED_PLACEHOLDER }),
  Object.freeze({ pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, replace: () => REDACTED_PLACEHOLDER }),
  Object.freeze({ pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED_PLACEHOLDER }),
  Object.freeze({ pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => REDACTED_PLACEHOLDER }),
  Object.freeze({ pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED_PLACEHOLDER }),
]);

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class ContextError extends ProtocolError {
  constructor(code, reason) {
    super(code, `runtime.context.${reason}`);
    this.name = 'ContextError';
    this.reason = reason;
    this.field = reason;
  }
}

function deepFreeze(value) {
  // ArrayBuffer views (evidence byte pages) carry elements and cannot be frozen; the page view
  // object around them is frozen, which is what a consumer can hold.
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function byteLengthOf(text) {
  return encoder.encode(text).length;
}

function bytesLengthOf(bytes) {
  return typeof bytes === 'string' ? byteLengthOf(bytes) : bytes.byteLength;
}

function requireText(value, reason, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ContextError('invalid_request', reason);
  }
  return value;
}

function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure SHA-256 over a string or bytes; pinned against node:crypto by the contract tests. */
function sha256(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) & ~63) >>> 0;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const words = new DataView(padded.buffer);
  words.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  words.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = words.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + w[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const digest = new DataView(new ArrayBuffer(32));
  digest.setUint32(0, h0); digest.setUint32(4, h1); digest.setUint32(8, h2); digest.setUint32(12, h3);
  digest.setUint32(16, h4); digest.setUint32(20, h5); digest.setUint32(24, h6); digest.setUint32(28, h7);
  return toHex(new Uint8Array(digest.buffer));
}

/** Stable content hash of a string or bytes; the address every piece of evidence is read by. */
export function evidenceHash(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    throw new ContextError('invalid_request', 'context_hash_input');
  }
  return sha256(input);
}

/** ~4 characters per estimated token; the second bound a checkpoint must respect. */
export function estimateTokens(text) {
  if (typeof text !== 'string') throw new ContextError('invalid_request', 'context_entry_text');
  return Math.ceil(text.length / TOKENS_PER_CHAR_DIVISOR);
}

export function parseContextClass(value) {
  if (!CONTEXT_CLASSES.includes(value)) throw new ContextError('invalid_request', 'context_class');
  return value;
}

export function parseEvidenceOrigin(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextError('invalid_request', 'context_origin');
  }
  if (value.kind === 'host') {
    return Object.freeze({ kind: 'host', commandId: requireText(value.commandId, 'context_origin', 512) });
  }
  if (value.kind === 'native') {
    return Object.freeze({
      kind: 'native',
      harness: requireText(value.harness, 'context_origin', 512),
      nativeEventId: requireText(value.nativeEventId, 'context_origin', 512),
    });
  }
  if (value.kind === 'file') {
    return Object.freeze({ kind: 'file', path: requireText(value.path, 'context_origin', 1024) });
  }
  if (value.kind === 'diff') {
    return Object.freeze({
      kind: 'diff',
      repoKey: requireText(value.repoKey, 'context_origin', 512),
      path: requireText(value.path, 'context_origin', 1024),
    });
  }
  throw new ContextError('invalid_request', 'context_origin');
}

export function parseEvidenceHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new ContextError('invalid_request', 'context_hash');
  return value;
}

export function parseTarget(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'repoKey') || !Object.hasOwn(value, 'revision')) {
    throw new ContextError('invalid_request', 'context_target');
  }
  return Object.freeze({
    repoKey: requireText(value.repoKey, 'context_target', 512),
    revision: requireText(value.revision, 'context_target', 128),
  });
}

function parseUuid(value, reason) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ContextError('invalid_request', reason);
  return value.toLowerCase();
}

export function parseScope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'threadId') || !Object.hasOwn(value, 'environmentId')) {
    throw new ContextError('invalid_request', 'context_scope');
  }
  return Object.freeze({
    threadId: parseUuid(value.threadId, 'context_scope'),
    environmentId: parseUuid(value.environmentId, 'context_scope'),
  });
}

export function parseEvidenceRef(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== REF_KEYS.length
    || !REF_KEYS.every((key) => Object.hasOwn(value, key))) {
    throw new ContextError('invalid_request', 'context_evidence_ref');
  }
  const hash = parseEvidenceHash(value.hash);
  if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new ContextError('invalid_request', 'context_evidence_ref');
  }
  if (value.bytes > MAX_EVIDENCE_BYTES) throw new ContextError('invalid_request', 'evidence_too_large');
  return Object.freeze({ hash, bytes: value.bytes, target: parseTarget(value.target) });
}

function parseByteRange(offset, length) {
  const resolvedOffset = offset === undefined ? 0 : offset;
  const resolvedLength = length === undefined ? EVIDENCE_PAGE_BYTES : length;
  if (!Number.isSafeInteger(resolvedOffset) || resolvedOffset < 0
    || !Number.isSafeInteger(resolvedLength) || resolvedLength < 1 || resolvedLength > MAX_EVIDENCE_PAGE_BYTES) {
    throw new ContextError('invalid_request', 'evidence_range');
  }
  return { offset: resolvedOffset, length: resolvedLength };
}

/** Redact every secret shape, counting each replacement. Ordinary text is untouched. */
export function redactSecrets(text) {
  if (typeof text !== 'string') throw new ContextError('invalid_request', 'context_entry_text');
  let redacted = text;
  let redactions = 0;
  for (const rule of SECRET_PATTERNS) {
    redacted = redacted.replace(rule.pattern, (...args) => {
      redactions += 1;
      return rule.replace(...args);
    });
  }
  return Object.freeze({ text: redacted, redactions });
}

/**
 * Carry text as DATA. A prompt-injection-looking text is labelled `untrusted` and preserved
 * verbatim: it is never executed, never rewritten, and never promoted to a decision here.
 * Ordinary context text is returned unlabelled.
 */
export function carryAsData(text) {
  if (typeof text !== 'string') throw new ContextError('invalid_request', 'context_entry_text');
  for (const rule of UNTRUSTED_PATTERNS) {
    if (rule.pattern.test(text)) {
      return Object.freeze({ text, untrusted: true, untrustedReason: rule.reason });
    }
  }
  return Object.freeze({ text, untrusted: false, untrustedReason: null });
}

/**
 * Wrap one raw entry into its frozen envelope: redacted text, untrusted label, estimated tokens,
 * origin and a hash that addresses the envelope's own data.
 */
export function wrapContextEntry(input = {}) {
  const entryClass = parseContextClass(input.class);
  const origin = parseEvidenceOrigin(input.origin);
  let text = null;
  if (input.text !== undefined && input.text !== null) {
    text = requireText(input.text, 'context_entry_text', MAX_ENTRY_CHARS);
  }
  let evidence = null;
  if (input.evidence !== undefined && input.evidence !== null) {
    evidence = parseEvidenceRef(input.evidence);
  }
  if (TEXT_CLASSES.includes(entryClass)) {
    if (text === null) throw new ContextError('invalid_request', 'context_entry_text');
    if (evidence !== null) throw new ContextError('invalid_request', 'context_entry_evidence');
  } else if (!EVIDENCE_CLASSES.includes(entryClass)) {
    throw new ContextError('invalid_request', 'context_class');
  } else if (evidence === null) {
    throw new ContextError('invalid_request', 'context_entry_evidence');
  }
  const redaction = redactSecrets(text ?? '');
  const carried = carryAsData(redaction.text);
  return deepFreeze({
    class: entryClass,
    origin,
    text: text === null ? null : redaction.text,
    untrusted: carried.untrusted,
    untrustedReason: carried.untrustedReason,
    redactions: redaction.redactions,
    estimatedTokens: estimateTokens(text === null ? '' : redaction.text),
    // An evidence entry's own hash addresses the referenced bytes, never its caption.
    hash: EVIDENCE_CLASSES.includes(entryClass) && evidence !== null ? evidence.hash : evidenceHash(redaction.text),
    evidence,
  });
}

/** Register evidence as a hash-addressed record. The payload is never stored, only its hash and size. */
export function registerEvidence(input = {}) {
  const bytes = input.bytes;
  if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) {
    throw new ContextError('invalid_request', 'context_evidence_bytes');
  }
  const size = bytesLengthOf(bytes);
  if (size > MAX_EVIDENCE_BYTES) throw new ContextError('invalid_request', 'evidence_too_large');
  return deepFreeze({
    hash: evidenceHash(bytes),
    bytes: size,
    origin: parseEvidenceOrigin(input.origin),
    target: parseTarget(input.target),
    at: input.at === undefined ? Date.now() : input.at,
  });
}

/**
 * Stable class-priority ordering: the goal is admitted before a plan step, a plan step before a
 * decision, and every text class before an evidence reference. Order inside a class is preserved.
 */
export function orderContextEntries(entries) {
  if (!Array.isArray(entries)) throw new ContextError('invalid_request', 'checkpoint_entries');
  return entries
    .map((entry, index) => ({ entry, index, priority: CONTEXT_CLASS_PRIORITY[parseContextClass(entry === null || entry === undefined ? undefined : entry.class)] }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.entry);
}

function canonicalOf(view) {
  return {
    checkpointId: view.checkpointId,
    schemaVersion: view.schemaVersion,
    scope: view.scope,
    createdAt: view.createdAt,
    entries: view.entries,
    evidence: view.evidence,
    estimatedTokens: view.estimatedTokens,
    entryCount: view.entryCount,
    droppedEntries: view.droppedEntries,
    droppedBytes: view.droppedBytes,
    demoted: view.demoted,
    untrustedEntries: view.untrustedEntries,
    redactions: view.redactions,
    transcriptBytes: view.transcriptBytes,
  };
}

/** Deterministic serialized form of a checkpoint; the `bytes` read model is derived from it. */
export function serializeCheckpoint(view) {
  return JSON.stringify({ ...canonicalOf(view), digest: view.digest });
}

/**
 * Build a bounded checkpoint from a (possibly very long) entry list.
 *
 * The bounds are enforced on REAL numbers: the observed serialized byte size, the observed
 * estimated-token count and the observed retained entry count. A single entry that alone cannot
 * fit the budget is refused with an explicit code — never silently truncated. Everything the
 * budget excludes is counted in `droppedEntries` / `droppedBytes` and is absent from the payload.
 */
export function buildContextCheckpoint(input = {}) {
  const checkpointId = parseUuid(input.checkpointId, 'checkpoint_id');
  const scope = parseScope(input.scope);
  const at = input.at === undefined ? Date.now() : input.at;
  if (!Number.isSafeInteger(at) || at <= 0) throw new ContextError('invalid_request', 'checkpoint_time');
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new ContextError('invalid_request', 'checkpoint_entries');
  }

  const wrapped = [];
  let demoted = 0;
  const ordered = orderContextEntries(input.entries);
  for (let index = 0; index < ordered.length; index += 1) {
    const envelope = wrapContextEntry(ordered[index]);
    const demote = envelope.class === 'decision' && envelope.untrusted === true;
    if (demote) demoted += 1;
    // The entryId is assigned before any cost is measured, so the budget accounting, the dropped
    // byte counts and the real serialized size are all measured on the same shape.
    wrapped.push(deepFreeze({
      entryId: `${checkpointId}:${index + 1}`,
      ...envelope,
      class: demote ? 'unresolved' : envelope.class,
    }));
  }
  const costOf = (entry) => byteLengthOf(JSON.stringify(entry));
  for (const entry of wrapped) {
    if (costOf(entry) > CHECKPOINT_MAX_BYTES || entry.estimatedTokens > CHECKPOINT_MAX_ESTIMATED_TOKENS) {
      throw new ContextError('invalid_request', 'checkpoint_entry_too_large');
    }
  }
  const transcriptBytes = wrapped.reduce((total, entry) => total + costOf(entry), 0);

  const admitted = [];
  let admittedBytes = 0;
  let admittedTokens = 0;
  let droppedEntries = 0;
  let droppedBytes = 0;
  for (const entry of wrapped) {
    const cost = costOf(entry);
    const overEntries = admitted.length >= MAX_CHECKPOINT_ENTRIES;
    const overBytes = admitted.length > 0 && admittedBytes + cost > CHECKPOINT_MAX_BYTES;
    const overTokens = admitted.length > 0 && admittedTokens + entry.estimatedTokens > CHECKPOINT_MAX_ESTIMATED_TOKENS;
    if (overEntries || overBytes || overTokens) {
      droppedEntries += 1;
      droppedBytes += cost;
      continue;
    }
    admitted.push(entry);
    admittedBytes += cost;
    admittedTokens += entry.estimatedTokens;
  }

  const measure = (list) => {
    const entries = list;
    const evidence = [];
    const seen = new Set();
    for (const entry of entries) {
      if (entry.evidence !== null && !seen.has(entry.evidence.hash)) {
        seen.add(entry.evidence.hash);
        evidence.push(entry.evidence);
      }
    }
    const canonical = {
      checkpointId,
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      scope,
      createdAt: at,
      entries,
      evidence,
      estimatedTokens: entries.reduce((total, entry) => total + entry.estimatedTokens, 0),
      entryCount: entries.length,
      droppedEntries,
      droppedBytes,
      demoted,
      untrustedEntries: entries.filter((entry) => entry.untrusted === true).length,
      redactions: entries.reduce((total, entry) => total + entry.redactions, 0),
      transcriptBytes,
    };
    return { canonical, digest: evidenceHash(JSON.stringify(canonical)) };
  };

  let current = measure(admitted);
  // The bound is enforced on the REAL serialized size, so trailing entries are dropped until it holds.
  while (admitted.length > 1
    && byteLengthOf(JSON.stringify({ ...current.canonical, digest: current.digest })) > CHECKPOINT_MAX_BYTES) {
    const dropped = admitted.pop();
    droppedEntries += 1;
    droppedBytes += costOf(dropped);
    current = measure(admitted);
  }
  const serialized = JSON.stringify({ ...current.canonical, digest: current.digest });
  return deepFreeze({ ...current.canonical, digest: current.digest, bytes: byteLengthOf(serialized) });
}

function parseCheckpointEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((key) => Object.hasOwn(raw, key))) {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  const entryClass = parseContextClass(raw.class);
  const origin = parseEvidenceOrigin(raw.origin);
  if (raw.text !== null && typeof raw.text !== 'string') throw new ContextError('invalid_request', 'checkpoint_schema');
  if (typeof raw.untrusted !== 'boolean') throw new ContextError('invalid_request', 'checkpoint_schema');
  if (raw.untrustedReason !== null && typeof raw.untrustedReason !== 'string') {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  if (!Number.isSafeInteger(raw.redactions) || raw.redactions < 0
    || !Number.isSafeInteger(raw.estimatedTokens) || raw.estimatedTokens < 0) {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  if (typeof raw.entryId !== 'string' || raw.entryId.length === 0) throw new ContextError('invalid_request', 'checkpoint_schema');
  const hash = parseEvidenceHash(raw.hash);
  const evidence = raw.evidence === null ? null : parseEvidenceRef(raw.evidence);
  if (TEXT_CLASSES.includes(entryClass) && raw.text === null) throw new ContextError('invalid_request', 'checkpoint_schema');
  if (EVIDENCE_CLASSES.includes(entryClass) && evidence === null) throw new ContextError('invalid_request', 'checkpoint_schema');
  if (raw.text === null && evidence === null) throw new ContextError('invalid_request', 'checkpoint_schema');
  // Every entry re-derives its own hash: a tampered entry is caught before anything is served.
  // An evidence entry's hash addresses the referenced bytes; a text entry's hash its own text.
  const expected = EVIDENCE_CLASSES.includes(entryClass) && evidence !== null
    ? evidence.hash
    : evidenceHash(raw.text);
  if (expected !== hash) throw new ContextError('conflict', 'checkpoint_entry_hash');
  return deepFreeze({
    entryId: raw.entryId,
    class: entryClass,
    origin,
    text: raw.text,
    untrusted: raw.untrusted,
    untrustedReason: raw.untrustedReason,
    redactions: raw.redactions,
    estimatedTokens: raw.estimatedTokens,
    hash,
    evidence,
  });
}

/** Validate a wire checkpoint object into a frozen read model, verifying every entry hash and the digest. */
export function parseCheckpoint(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== CHECKPOINT_KEYS.length
    || !CHECKPOINT_KEYS.every((key) => Object.hasOwn(value, key))) {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  if (value.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
    throw new ContextError('version_mismatch', 'checkpoint_schema');
  }
  const checkpointId = parseUuid(value.checkpointId, 'checkpoint_id');
  const scope = parseScope(value.scope);
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  for (const counter of ['estimatedTokens', 'entryCount', 'droppedEntries', 'droppedBytes', 'demoted', 'untrustedEntries', 'redactions', 'transcriptBytes']) {
    if (!Number.isSafeInteger(value[counter]) || value[counter] < 0) {
      throw new ContextError('invalid_request', 'checkpoint_schema');
    }
  }
  if (!Array.isArray(value.entries) || value.entries.length !== value.entryCount || !Array.isArray(value.evidence)) {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  const entries = value.entries.map(parseCheckpointEntry);
  const evidence = value.evidence.map((item) => parseEvidenceRef(item));
  const digest = parseEvidenceHash(value.digest);
  const canonical = {
    checkpointId,
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    scope,
    createdAt: value.createdAt,
    entries,
    evidence,
    estimatedTokens: value.estimatedTokens,
    entryCount: value.entryCount,
    droppedEntries: value.droppedEntries,
    droppedBytes: value.droppedBytes,
    demoted: value.demoted,
    untrustedEntries: value.untrustedEntries,
    redactions: value.redactions,
    transcriptBytes: value.transcriptBytes,
  };
  if (evidenceHash(JSON.stringify(canonical)) !== digest) {
    throw new ContextError('conflict', 'checkpoint_digest');
  }
  return deepFreeze({
    ...canonical,
    digest,
    bytes: byteLengthOf(JSON.stringify({ ...canonical, digest })),
  });
}

export function deserializeCheckpoint(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ContextError('invalid_request', 'checkpoint_schema');
  }
  return parseCheckpoint(parsed);
}

/** Scope authorization: a cross-thread or cross-environment query is unauthorized, never served. */
export function authorizeScope(queryScope, checkpointScope) {
  const query = parseScope(queryScope);
  const checkpoint = parseScope(checkpointScope);
  if (query.threadId !== checkpoint.threadId) throw new ContextError('unauthorized', 'context_scope_thread');
  if (query.environmentId !== checkpoint.environmentId) throw new ContextError('unauthorized', 'context_scope_environment');
}

/**
 * Re-verify an evidence target against the CURRENT target. A stale snapshot can never satisfy a
 * diff/file read: the recorded target must equal the live one before any byte is served.
 */
export function verifyCurrentTarget(recordedTarget, currentTarget) {
  const recorded = parseTarget(recordedTarget);
  const current = parseTarget(currentTarget);
  if (recorded.repoKey !== current.repoKey || recorded.revision !== current.revision) {
    throw new ContextError('conflict', 'evidence_target_stale');
  }
}

/**
 * Read one byte page of evidence. The bytes are re-read from the CURRENT target, re-hashed against
 * the reference hash and only then sliced: a stale target is refused, changed content is refused,
 * and a deleted artifact is marked unavailable instead of fabricated.
 */
export function readEvidencePage(input = {}) {
  const evidenceRef = parseEvidenceRef(input.ref);
  const currentTarget = parseTarget(input.currentTarget);
  const range = parseByteRange(input.offset, input.length);
  verifyCurrentTarget(evidenceRef.target, currentTarget);
  if (typeof input.readEvidence !== 'function') throw new ContextError('invalid_request', 'evidence_reader');
  // Evidence is addressed by hash inside the target: the reader re-reads by hash, never by a
  // snapshot the checkpoint happened to hold.
  const live = input.readEvidence({ target: currentTarget, hash: evidenceRef.hash, bytes: evidenceRef.bytes });
  if (live === null || live === undefined) {
    return deepFreeze({ available: false, unavailableReason: 'evidence_missing' });
  }
  if (typeof live !== 'object' || Array.isArray(live) || !(live.bytes instanceof Uint8Array)
    || !Number.isSafeInteger(live.totalBytes) || live.totalBytes < 0 || live.bytes.length !== live.totalBytes) {
    throw new ContextError('invalid_request', 'evidence_reader');
  }
  if (live.totalBytes > MAX_EVIDENCE_BYTES) throw new ContextError('invalid_request', 'evidence_too_large');
  if (live.totalBytes !== evidenceRef.bytes || evidenceHash(live.bytes) !== evidenceRef.hash) {
    throw new ContextError('conflict', 'evidence_changed');
  }
  // A page that starts inside the evidence is clamped to what remains; one that starts at or past
  // the end has nothing to read and is rejected, never silently answered with zero bytes.
  if (range.offset >= live.bytes.length) throw new ContextError('invalid_request', 'evidence_range');
  const length = Math.min(range.length, live.bytes.length - range.offset);
  return deepFreeze({
    available: true,
    hash: evidenceRef.hash,
    offset: range.offset,
    length,
    totalBytes: live.totalBytes,
    bytes: live.bytes.subarray(range.offset, range.offset + length),
    nextOffset: range.offset + length < live.totalBytes ? range.offset + length : null,
    target: currentTarget,
  });
}

function scopeArgumentSchema() {
  return deepFreeze({
    type: 'object',
    description: 'Caller scope: thread id plus environment id.',
    properties: { threadId: { type: 'string' }, environmentId: { type: 'string' } },
    required: ['threadId', 'environmentId'],
  });
}

/** MCP-compatible read-only tool descriptors. Every tool is a read; there is no write tool. */
export const EVIDENCE_TOOLS = Object.freeze([
  Object.freeze({
    name: 'context.checkpoint.get',
    description: 'Read one bounded context checkpoint by id within the caller scope.',
    inputSchema: deepFreeze({
      type: 'object',
      properties: { checkpointId: { type: 'string' }, scope: scopeArgumentSchema() },
      required: ['checkpointId', 'scope'],
      additionalProperties: false,
    }),
    readOnly: true,
  }),
  Object.freeze({
    name: 'context.evidence.list',
    description: 'List the hash-addressed evidence references of one checkpoint within the caller scope.',
    inputSchema: deepFreeze({
      type: 'object',
      properties: { checkpointId: { type: 'string' }, scope: scopeArgumentSchema() },
      required: ['checkpointId', 'scope'],
      additionalProperties: false,
    }),
    readOnly: true,
  }),
  Object.freeze({
    name: 'context.evidence.page',
    description: 'Read one byte page of checkpoint evidence, re-verified against the current target.',
    inputSchema: deepFreeze({
      type: 'object',
      properties: {
        checkpointId: { type: 'string' },
        scope: scopeArgumentSchema(),
        hash: { type: 'string', description: 'Evidence hash addressing the bytes.' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 1 },
      },
      required: ['checkpointId', 'scope', 'hash'],
      additionalProperties: false,
    }),
    readOnly: true,
  }),
]);

const TOOL_ARGUMENT_KEYS = Object.freeze({
  'context.checkpoint.get': Object.freeze(['checkpointId', 'scope']),
  'context.evidence.list': Object.freeze(['checkpointId', 'scope']),
  'context.evidence.page': Object.freeze(['checkpointId', 'scope', 'hash']),
});

export function describeEvidenceTool(name) {
  const tool = EVIDENCE_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new ContextError('invalid_request', 'evidence_tool_unknown');
  return tool;
}

/**
 * The pure MCP-compatible dispatcher. Scope authorization runs BEFORE any read, and the current
 * target is re-verified before any byte page is served, so a cross-scope caller or a stale target
 * can never reach evidence. The stateful wiring lives in bridge evidenceQuery.js.
 */
export function callEvidenceTool(input = {}) {
  const tool = describeEvidenceTool(input.name);
  const args = input.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ContextError('invalid_request', 'evidence_tool_arguments');
  }
  const required = TOOL_ARGUMENT_KEYS[tool.name];
  if (!required.every((key) => Object.hasOwn(args, key))
    || !Object.keys(args).every((key) => required.includes(key))) {
    throw new ContextError('invalid_request', 'evidence_tool_arguments');
  }
  for (const key of ['offset', 'length']) {
    if (Object.hasOwn(args, key) && !Number.isSafeInteger(args[key])) {
      throw new ContextError('invalid_request', 'evidence_tool_arguments');
    }
  }
  if (typeof input.findCheckpoint !== 'function') throw new ContextError('invalid_request', 'evidence_tool_source');
  const checkpointId = parseUuid(args.checkpointId, 'checkpoint_id');
  const checkpoint = input.findCheckpoint(checkpointId);
  if (checkpoint === null || checkpoint === undefined) {
    throw new ContextError('invalid_request', 'checkpoint_unknown');
  }
  authorizeScope(args.scope, checkpoint.scope);
  if (tool.name === 'context.checkpoint.get') return checkpoint;
  if (tool.name === 'context.evidence.list') {
    return deepFreeze({ checkpointId: checkpoint.checkpointId, evidence: checkpoint.evidence });
  }
  if (typeof input.resolveTarget !== 'function' || typeof input.readEvidence !== 'function') {
    throw new ContextError('invalid_request', 'evidence_tool_source');
  }
  const hash = parseEvidenceHash(args.hash);
  const evidenceRef = checkpoint.evidence.find((item) => item.hash === hash);
  if (evidenceRef === undefined) throw new ContextError('invalid_request', 'evidence_unknown');
  return readEvidencePage({
    ref: evidenceRef,
    currentTarget: input.resolveTarget(),
    readEvidence: input.readEvidence,
    offset: args.offset,
    length: args.length,
  });
}
