import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';

export const HISTORY_JSON_LIMITS = Object.freeze({ inputBytes: 65536, tokenBytes: 16384, depth: 64, keyBytes: 4096, activeKeyBytes: 65536, numberBytes: 128, objectKeys: 1024 });
const byte = value => Uint8Array.of(value);
const whitespace = value => value === 32 || value === 9 || value === 10 || value === 13;
const delimiter = value => whitespace(value) || value === 44 || value === 93 || value === 125;
const decoder = new TextDecoder('utf-8', { fatal: true });
function decoded(raw) {
  try { return decoder.decode(raw); }
  catch { throw new ProtocolError('invalid_request', 'history.utf8'); }
}

export async function* tokenizeHistoryJson(source, { signal } = {}) {
  const stack = [];
  const buffer = new Uint8Array(HISTORY_JSON_LIMITS.tokenBytes);
  let root = false, mode = 'syntax', length = 0, path = [], key = false, escape = 0, continuation = 0, activeKeyBytes = 0;
  const check = () => requireValue(!signal?.aborted, 'history.cancelled', 'cancelled');
  function valuePath() {
    const parent = stack.at(-1);
    if (!parent) { requireValue(!root, 'history.trailing'); root = true; return []; }
    requireValue(parent.phase === 'value' || parent.phase === 'first-value', 'history.value');
    parent.phase = 'comma';
    return [...parent.path, parent.container === 'array' ? parent.index++ : parent.key];
  }
  function stringPiece() {
    const raw = buffer.slice(0, length);
    let text;
    try { text = JSON.parse(`"${decoded(raw)}"`); }
    catch (error) { if (error instanceof SyntaxError) throw new ProtocolError('invalid_request', 'history.string'); throw error; }
    length = 0;
    return { kind: 'string-data', path, text, raw };
  }
  function scalar() {
    const raw = buffer.slice(0, length), text = decoded(raw);
    requireValue(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(text), 'history.scalar');
    const value = JSON.parse(text);
    requireValue(typeof value !== 'number' || Number.isFinite(value), 'history.number');
    mode = 'syntax'; length = 0;
    return { kind: 'scalar', path, value, raw };
  }
  for await (const input of source) {
    check();
    requireValue(input instanceof Uint8Array && input.byteLength <= HISTORY_JSON_LIMITS.inputBytes && input.buffer.byteLength <= HISTORY_JSON_LIMITS.inputBytes, 'history.input_bytes');
    for (let index = 0; index < input.length;) {
      const value = input[index];
      if (mode === 'scalar') {
        if (delimiter(value)) { yield scalar(); continue; }
        requireValue(length < HISTORY_JSON_LIMITS.numberBytes, 'history.scalar_bytes');
        buffer[length++] = value; index++; continue;
      }
      if (mode === 'string') {
        if (value === 34 && escape === 0) {
          requireValue(continuation === 0, 'history.utf8');
          if (key) {
            const piece = stringPiece();
            const parent = stack.at(-1);
            requireValue(parent?.container === 'object' && !parent.keys.has(piece.text), 'history.duplicate_key');
            const size = 64 + 2 * piece.text.length;
            requireValue(parent.keys.size < HISTORY_JSON_LIMITS.objectKeys && activeKeyBytes + size <= HISTORY_JSON_LIMITS.activeKeyBytes, 'history.keys');
            parent.keys.add(piece.text); parent.keyBytes += size; activeKeyBytes += size;
            parent.key = piece.text; parent.phase = 'colon';
            yield { kind: 'key', path: [...parent.path, piece.text], value: piece.text, raw: Buffer.concat([byte(34), piece.raw, byte(34)]) };
          } else {
            if (length) yield stringPiece();
            yield { kind: 'string-end', path, raw: byte(34) };
          }
          mode = 'syntax'; index++; continue;
        }
        requireValue(value >= 32, 'history.string_control');
        if (escape > 1) {
          requireValue((value >= 48 && value <= 57) || (value >= 65 && value <= 70) || (value >= 97 && value <= 102), 'history.escape');
          escape--;
          if (escape === 1) escape = 0;
        } else if (escape === 1) {
          requireValue([34, 92, 47, 98, 102, 110, 114, 116, 117].includes(value), 'history.escape');
          escape = value === 117 ? 5 : 0;
        } else if (continuation > 0) {
          requireValue(value >= 128 && value <= 191, 'history.utf8'); continuation--;
        } else if (value === 92) escape = 1;
        else if (value >= 128) {
          requireValue(value >= 194 && value <= 244, 'history.utf8');
          continuation = value < 224 ? 1 : value < 240 ? 2 : 3;
        }
        requireValue(length < buffer.length, 'history.token_bytes');
        buffer[length++] = value;
        requireValue(!key || length <= HISTORY_JSON_LIMITS.keyBytes, 'history.key_bytes');
        index++;
        if (!key && length >= buffer.length - 8 && escape === 0 && continuation === 0) yield stringPiece();
        continue;
      }
      const parent = stack.at(-1);
      if (whitespace(value)) {
        const start = index++;
        while (index < input.length && whitespace(input[index])) index++;
        yield { kind: 'syntax', path: parent?.path ?? [], raw: input.slice(start, index) }; continue;
      }
      if (value === 125 || value === 93) {
        const container = value === 125 ? 'object' : 'array';
        requireValue(parent?.container === container && (parent.phase === 'comma' || parent.phase === 'first-key' || parent.phase === 'first-value'), 'history.container_end');
        stack.pop(); activeKeyBytes -= parent.keyBytes;
        yield { kind: 'end', container, path: parent.path, raw: byte(value) }; index++; continue;
      }
      if (value === 58 || value === 44) {
        requireValue(parent, 'history.separator');
        if (value === 58) { requireValue(parent.container === 'object' && parent.phase === 'colon', 'history.colon'); parent.phase = 'value'; }
        else { requireValue(parent.phase === 'comma', 'history.comma'); parent.phase = parent.container === 'object' ? 'key' : 'value'; }
        yield { kind: 'syntax', path: parent.path, raw: byte(value) }; index++; continue;
      }
      if (parent?.container === 'object' && (parent.phase === 'key' || parent.phase === 'first-key')) {
        requireValue(value === 34, 'history.object_key');
        mode = 'string'; path = parent.path; key = true; length = 0; escape = 0; continuation = 0; index++; continue;
      }
      path = valuePath();
      if (value === 123 || value === 91) {
        requireValue(stack.length < HISTORY_JSON_LIMITS.depth, 'history.depth');
        const container = value === 123 ? 'object' : 'array';
        stack.push({ container, path, phase: container === 'object' ? 'first-key' : 'first-value', index: 0, key: null, keys: new Set(), keyBytes: 0 });
        yield { kind: 'start', container, path, raw: byte(value) }; index++; continue;
      }
      if (value === 34) {
        mode = 'string'; key = false; length = 0; escape = 0; continuation = 0;
        yield { kind: 'string-start', path, raw: byte(value) }; index++; continue;
      }
      mode = 'scalar'; length = 0;
    }
  }
  check();
  if (mode === 'scalar') yield scalar();
  requireValue(root && stack.length === 0 && mode === 'syntax', 'history.truncated');
}
