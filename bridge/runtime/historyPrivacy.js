import { requireValue } from '../../shared/runtime/capabilities.js';
import { createPrivacy } from '../../shared/runtime/native/codex/boundaries.js';

export const HISTORY_PRIVACY_LIMITS = Object.freeze({ secretCount: 32, secretUnits: 4096, urlUnits: 65536 });
const privateKey = /^(?:authorization|proxy.authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|bearer[_-]?token|http[_-]?headers|env[_-]?http[_-]?headers)$/iu;
const urlPrefix = /^(?:https?|wss?):\/\//iu;
const rawText = text => Buffer.from(JSON.stringify(text).slice(1, -1));
const samePath = (left, right) => left.length === right.length && left.every((part, index) => part === right[index]);

function slice(piece, start, end = piece.text.length) {
  if (start === 0 && end === piece.text.length) return piece;
  let units = 0, offset = 0, begin = start === 0 ? 0 : -1, finish = end === 0 ? 0 : -1;
  while (offset < piece.raw.length && units < end) {
    const first = piece.raw[offset];
    const count = first === 92 ? piece.raw[offset + 1] === 117 ? 6 : 2 : first < 128 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4;
    units += first >= 240 ? 2 : 1; offset += count;
    if (units === start) begin = offset;
    if (units === end) finish = offset;
  }
  const text = piece.text.slice(start, end);
  return { text, raw: begin < 0 || finish < 0 ? rawText(text) : piece.raw.slice(begin, finish) };
}

async function* replaceSecret(source, secret) {
  let tail = { text: '', raw: new Uint8Array() };
  for await (const input of source) {
    const piece = tail.text ? { text: tail.text + input.text, raw: Buffer.concat([tail.raw, input.raw]) } : input;
    let offset = 0, found;
    while ((found = piece.text.indexOf(secret, offset)) >= 0) {
      if (found > offset) yield slice(piece, offset, found);
      yield { text: '[REDACTED]', raw: Buffer.from('[REDACTED]') };
      offset = found + secret.length;
    }
    const through = Math.max(offset, piece.text.length - secret.length + 1);
    if (through > offset) yield slice(piece, offset, through);
    tail = slice(piece, through);
  }
  if (tail.text) yield tail;
}

async function* normalizeUrl(source) {
  let decided = false, url = false, prefix = '', pieces = [], value = '';
  for await (const piece of source) {
    if (!decided) {
      pieces.push(piece); prefix += piece.text.slice(0, Math.max(0, 8 - prefix.length));
      if (prefix.length < 8) continue;
      decided = true; url = urlPrefix.test(prefix);
      if (!url) { yield* pieces; pieces = []; continue; }
      value = pieces.map(part => part.text).join(''); pieces = [];
    } else if (url) value += piece.text;
    else { yield piece; continue; }
    requireValue(value.length <= HISTORY_PRIVACY_LIMITS.urlUnits, 'history.url_policy_limit', 'unsupported');
  }
  if (!decided) {
    url = urlPrefix.test(prefix);
    if (!url) { yield* pieces; return; }
    value = pieces.map(part => part.text).join('');
  }
  if (url) {
    const cleaned = createPrivacy()(value);
    for (let offset = 0; offset < cleaned.length; offset += 4096) {
      const text = cleaned.slice(offset, offset + 4096);
      yield { text, raw: rawText(text) };
    }
  }
}

export async function* redactHistoryJson(tokens, { secrets = [], signal } = {}) {
  requireValue(Array.isArray(secrets) && secrets.length <= HISTORY_PRIVACY_LIMITS.secretCount && secrets.every(value => typeof value === 'string') && secrets.reduce((bytes, value) => bytes + value.length, 0) <= HISTORY_PRIVACY_LIMITS.secretUnits, 'history.secret_budget');
  const iterator = tokens[Symbol.asyncIterator]();
  let pending, skipping, skipDepth = 0;
  try {
    for (;;) {
      requireValue(!signal?.aborted, 'history.cancelled', 'cancelled');
      const next = await iterator.next();
      if (next.done) break;
      const token = next.value;
      if (skipping) {
        if (token.kind === 'start') skipDepth++;
        if (token.kind === 'end') { skipDepth--; if (skipDepth === 0) skipping = undefined; }
        if (skipping === 'string' && token.kind === 'string-end') skipping = undefined;
        continue;
      }
      if (pending && token.kind !== 'syntax' && samePath(token.path, pending)) {
        yield { kind: 'string-start', path: pending, raw: Uint8Array.of(34) };
        yield { kind: 'string-data', path: pending, text: '[REDACTED]', raw: Buffer.from('[REDACTED]') };
        yield { kind: 'string-end', path: pending, raw: Uint8Array.of(34) };
        pending = undefined;
        if (token.kind === 'start') { skipping = 'container'; skipDepth = 1; }
        else if (token.kind === 'string-start') skipping = 'string';
        continue;
      }
      if (token.kind === 'key' && privateKey.test(token.value)) pending = token.path;
      if (token.kind !== 'string-start') { yield token; continue; }
      yield token;
      let ending;
      const pieces = async function* () {
        for (;;) {
          requireValue(!signal?.aborted, 'history.cancelled', 'cancelled');
          const nextPiece = await iterator.next();
          requireValue(!nextPiece.done, 'history.string_end');
          if (nextPiece.value.kind === 'string-end') { ending = nextPiece.value; return; }
          requireValue(nextPiece.value.kind === 'string-data', 'history.string_token');
          yield nextPiece.value;
        }
      };
      let stream = pieces();
      for (const secret of secrets) if (secret) stream = replaceSecret(stream, secret);
      for await (const piece of normalizeUrl(stream)) yield { kind: 'string-data', path: token.path, ...piece };
      requireValue(ending, 'history.string_end');
      yield ending;
    }
    requireValue(!pending && !skipping, 'history.private_truncated');
  } finally { await iterator.return?.(); }
}
