import { ProtocolError, requireValue } from './capabilities.js';

// Bounded lexical pre-decode scanner for wire frames. It walks the raw text once
// and reports readonly envelope primitives plus representation metrics for the
// result and typedError values, so a preflight classifier can reject structurally
// amplified bodies BEFORE JSON.parse materializes them.
//
// It NEVER reconstructs a body or materializes an object graph: there are no
// arrays or maps sized by the number of body nodes, the nesting stack is bounded
// by the generic depth limit, UTF-8 bytes are counted without allocating another
// unbounded buffer, and only schema-known envelope fields are retained (never
// arbitrary keys or token lists). Duplicate decoded envelope keys (including
// escaped-equivalent names) are rejected as ambiguous wire encodings.

// Mirrors protocol.js / capabilities.js; duplicated here to avoid an import cycle
// (protocol.js imports the preflight type from this module).
const PROTOCOL_VERSION = 1;
const MAX_DEPTH = 64;
const RESULT_PHASES = Object.freeze(['read', 'durable-accepted', 'native-executed']);
const FRAME_KINDS = new Set(['hello', 'request', 'result', 'event', 'snapshot', 'replay']);
// Union of every top-level envelope key across all frame kinds (base + per-kind +
// result/request optionals). Any other top-level key is flagged as an unknown field.
const ENVELOPE_KEYS = new Set([
  'kind', 'version', 'target', 'epoch', 'generation',
  'instanceId', 'capabilities',
  'id', 'method', 'params', 'idempotencyKey',
  'ok', 'phase', 'result', 'typedError',
  'seq', 'entityRevision', 'scope', 'type', 'payload',
  'token', 'revision', 'watermark', 'expiresAt', 'items', 'cursor',
  'after', 'through', 'events',
]);
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
function isDigit(code) { return code >= 0x30 && code <= 0x39; }
function hexValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}
// UTF-8 byte length of text[start, end) without allocating a substring/buffer.
// Lone surrogates encode as the 3-byte replacement character, matching TextEncoder.
function utf8Length(text, start, end) {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < end ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; index++; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Readonly representation metrics for one span (the result or typedError value). */
// RawFrameSpan = { utf8Bytes, nodes, depth, stringUnits, keyUnits }
function emptySpan() { return { utf8Bytes: 0, nodes: 0, depth: 0, stringUnits: 0, keyUnits: 0 }; }

export function scanRawFrame(text) {
  if (typeof text !== 'string') throw new ProtocolError('invalid_request', 'json');
  const length = text.length;
  let pos = 0;
  const peek = () => (pos < length ? text.charCodeAt(pos) : -1);
  function skipWhitespace() { while (pos < length && WHITESPACE.has(text.charCodeAt(pos))) pos++; }
  function syntax() { throw new ProtocolError('invalid_request', 'json'); }

  // scanString: pos at the opening quote. When collect is true the decoded string
  // is returned (used only for bounded envelope fields/keys); otherwise the decoded
  // UTF-16 code-unit length is returned without allocating (span strings/keys).
  function scanString(collect) {
    pos++;
    let value = '';
    let units = 0;
    for (;;) {
      if (pos >= length) syntax();
      const code = text.charCodeAt(pos);
      if (code === 0x22) { pos++; break; }
      if (code === 0x5c) {
        pos++;
        if (pos >= length) syntax();
        const escape = text.charCodeAt(pos);
        if (escape === 0x75) {
          if (pos + 5 > length) syntax();
          let unit = 0;
          for (let step = 1; step <= 4; step++) {
            const digit = hexValue(text.charCodeAt(pos + step));
            if (digit < 0) syntax();
            unit = (unit << 4) | digit;
          }
          pos += 5;
          units += 1;
          if (collect) value += String.fromCharCode(unit);
          continue;
        }
        let ch;
        switch (escape) {
          case 0x22: ch = '"'; break;
          case 0x5c: ch = '\\'; break;
          case 0x2f: ch = '/'; break;
          case 0x62: ch = '\b'; break;
          case 0x66: ch = '\f'; break;
          case 0x6e: ch = '\n'; break;
          case 0x72: ch = '\r'; break;
          case 0x74: ch = '\t'; break;
          default: syntax();
        }
        pos += 2;
        units += 1;
        if (collect) value += ch;
        continue;
      }
      if (code < 0x20) syntax();
      if (collect) value += text.charAt(pos);
      pos++;
      units += 1;
    }
    return collect ? value : units;
  }
  // Strict JSON number grammar so invalid numbers fail preparse (JSON.parse stays
  // the authority on any accepted frame).
  function scanNumber() {
    const start = pos;
    if (peek() === 0x2d) pos++;
    if (peek() === 0x30) pos++;
    else if (peek() >= 0x31 && peek() <= 0x39) { pos++; while (isDigit(peek())) pos++; }
    else syntax();
    if (peek() === 0x2e) { pos++; if (!isDigit(peek())) syntax(); while (isDigit(peek())) pos++; }
    const exponent = peek();
    if (exponent === 0x65 || exponent === 0x45) {
      pos++;
      const sign = peek();
      if (sign === 0x2b || sign === 0x2d) pos++;
      if (!isDigit(peek())) syntax();
      while (isDigit(peek())) pos++;
    }
    const value = Number(text.slice(start, pos));
    if (!Number.isFinite(value)) throw new ProtocolError('invalid_request', 'json.number');
    return value;
  }
  function scanBoolean() {
    if (text.startsWith('true', pos)) { pos += 4; return true; }
    if (text.startsWith('false', pos)) { pos += 5; return false; }
    syntax();
  }
  // scanValue: scan one JSON value at the given depth, validating syntax and the
  // generic depth bound, returning span metrics (nodes/depth/stringUnits/keyUnits).
  function scanValue(depth) {
    if (depth > MAX_DEPTH) throw new ProtocolError('invalid_request', 'json.depth');
    skipWhitespace();
    const code = peek();
    if (code === 0x7b) return scanObject(depth);
    if (code === 0x5b) return scanArray(depth);
    if (code === 0x22) { const units = scanString(false); return { nodes: 1, depth: 0, stringUnits: units, keyUnits: 0 }; }
    if (code === 0x74) { scanBoolean(); return { nodes: 1, depth: 0, stringUnits: 0, keyUnits: 0 }; }
    if (code === 0x66) { scanBoolean(); return { nodes: 1, depth: 0, stringUnits: 0, keyUnits: 0 }; }
    if (code === 0x6e) { if (!text.startsWith('null', pos)) syntax(); pos += 4; return { nodes: 1, depth: 0, stringUnits: 0, keyUnits: 0 }; }
    if (code === 0x2d || isDigit(code)) { scanNumber(); return { nodes: 1, depth: 0, stringUnits: 0, keyUnits: 0 }; }
    syntax();
  }
  function scanObject(depth) {
    pos++;
    let nodes = 1, maxDepth = 0, stringUnits = 0, keyUnits = 0;
    skipWhitespace();
    if (peek() === 0x7d) { pos++; return { nodes, depth: maxDepth, stringUnits, keyUnits }; }
    for (;;) {
      skipWhitespace();
      if (peek() !== 0x22) syntax();
      keyUnits += scanString(false);
      skipWhitespace();
      if (peek() !== 0x3a) syntax();
      pos++;
      const child = scanValue(depth + 1);
      nodes += child.nodes;
      if (child.depth + 1 > maxDepth) maxDepth = child.depth + 1;
      stringUnits += child.stringUnits;
      skipWhitespace();
      const next = peek();
      if (next === 0x7d) { pos++; break; }
      if (next !== 0x2c) syntax();
      pos++;
    }
    return { nodes, depth: maxDepth, stringUnits, keyUnits };
  }
  function scanArray(depth) {
    pos++;
    let nodes = 1, maxDepth = 0, stringUnits = 0;
    skipWhitespace();
    if (peek() === 0x5d) { pos++; return { nodes, depth: maxDepth, stringUnits, keyUnits: 0 }; }
    for (;;) {
      const child = scanValue(depth + 1);
      nodes += child.nodes;
      if (child.depth + 1 > maxDepth) maxDepth = child.depth + 1;
      stringUnits += child.stringUnits;
      skipWhitespace();
      const next = peek();
      if (next === 0x5d) { pos++; break; }
      if (next !== 0x2c) syntax();
      pos++;
    }
    return { nodes, depth: maxDepth, stringUnits, keyUnits: 0 };
  }

  // Envelope accumulators: only schema-known bounded fields are retained.
  let kind, version, id, target, epoch, generation, ok, phase;
  let hasResult = false, hasTypedError = false, hasPhase = false;
  let duplicateKeys = false, unknownFields = false;
  const result = emptySpan();
  const typedError = emptySpan();
  const seen = new Set();

  function recordSpan(span, start) {
    const end = pos;
    span.utf8Bytes += utf8Length(text, start, end);
  }
  function applyEnvelopeValue(key) {
    switch (key) {
      case 'kind': kind = scanString(true); break;
      case 'version': version = scanNumber(); break;
      case 'id': id = scanString(true); break;
      case 'target': target = scanString(true); break;
      case 'epoch': epoch = scanString(true); break;
      case 'generation': generation = scanNumber(); break;
      case 'ok': ok = scanBoolean(); break;
      case 'phase': hasPhase = true; phase = scanString(true); break;
      case 'result': {
        hasResult = true;
        skipWhitespace();
        const start = pos;
        const metrics = scanValue(0);
        result.nodes += metrics.nodes;
        if (metrics.depth > result.depth) result.depth = metrics.depth;
        result.stringUnits += metrics.stringUnits;
        result.keyUnits += metrics.keyUnits;
        recordSpan(result, start);
        break;
      }
      case 'typedError': {
        hasTypedError = true;
        skipWhitespace();
        const start = pos;
        const metrics = scanValue(0);
        typedError.nodes += metrics.nodes;
        if (metrics.depth > typedError.depth) typedError.depth = metrics.depth;
        typedError.stringUnits += metrics.stringUnits;
        typedError.keyUnits += metrics.keyUnits;
        recordSpan(typedError, start);
        break;
      }
      default: scanValue(0); break;
    }
  }

  skipWhitespace();
  if (peek() !== 0x7b) throw new ProtocolError('invalid_request', 'frame');
  pos++;
  skipWhitespace();
  if (peek() !== 0x7d) {
    for (;;) {
      skipWhitespace();
      if (peek() !== 0x22) syntax();
      const key = scanString(true);
      if (seen.has(key)) duplicateKeys = true;
      else seen.add(key);
      if (!ENVELOPE_KEYS.has(key)) unknownFields = true;
      skipWhitespace();
      if (peek() !== 0x3a) syntax();
      pos++;
      applyEnvelopeValue(key);
      skipWhitespace();
      const next = peek();
      if (next === 0x7d) { pos++; break; }
      if (next !== 0x2c) syntax();
      pos++;
    }
  } else pos++;
  skipWhitespace();
  if (pos !== length) syntax();

  // Minimal complete envelope validation so malformed frames retain a typed
  // connection failure instead of disappearing as an unknown id.
  requireValue(version === PROTOCOL_VERSION, 'version', 'version_mismatch');
  requireValue(typeof kind === 'string' && FRAME_KINDS.has(kind), 'kind');
  if (kind === 'result') {
    requireValue(typeof id === 'string' && id.length > 0 && id.length <= 1024 && !id.includes('\0'), 'id');
    requireValue(typeof ok === 'boolean', 'ok');
    if (ok) {
      requireValue(hasResult && !hasTypedError, 'result');
      requireValue(hasPhase && RESULT_PHASES.includes(phase), 'phase');
    } else {
      requireValue(!hasResult && !hasPhase && hasTypedError, 'typedError');
    }
  }

  return Object.freeze({
    kind, version, id, target, epoch, generation, ok, phase,
    duplicateKeys, unknownFields,
    result: Object.freeze(result), typedError: Object.freeze(typedError),
  });
}
