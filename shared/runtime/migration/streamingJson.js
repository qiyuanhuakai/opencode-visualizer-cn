export class LegacyExportError extends Error {
  constructor(code) { super(code); this.name = 'LegacyExportError'; this.code = code; }
}

// Decode the legacy string-map envelope without materializing its values or nested histories.
export async function* streamStringMap(input) {
  let state = 'start'; let key = ''; let buffer = ''; let escape = ''; let unicode = '';
  let afterComma = false; const keys = new Set();
  const fail = () => { throw new LegacyExportError('corrupt_source'); };
  for await (const text of input) for (const char of text) {
    if (state === 'key' || state === 'value') {
      let decoded = char;
      if (unicode) {
        if (!/[a-fA-F0-9]/u.test(char)) fail();
        unicode += char;
        if (unicode.length < 5) continue;
        decoded = String.fromCharCode(Number.parseInt(unicode.slice(1), 16)); unicode = '';
      } else if (escape) {
        escape = '';
        if (char === 'u') { unicode = 'u'; continue; }
        const codes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!Object.hasOwn(codes, char)) fail();
        decoded = codes[char];
      } else if (char === '\\') { escape = '\\'; continue; }
      else if (char === '"') {
        if (state === 'key') { key = buffer; if (keys.has(key)) fail(); keys.add(key); buffer = ''; state = 'colon'; }
        else { yield { key, content: buffer, end: true }; buffer = ''; state = 'comma'; }
        continue;
      } else if (char.charCodeAt(0) < 32) fail();
      buffer += decoded;
      if (state === 'key' && buffer.length > 16384) fail();
      if (state === 'value' && buffer.length >= 16384 && !/[\uD800-\uDBFF]$/u.test(buffer)) {
        yield { key, content: buffer, end: false }; buffer = '';
      }
      continue;
    }
    if (/\s/u.test(char) && [' ', '\r', '\n', '\t'].includes(char)) continue;
    switch (state) {
      case 'start': if (char !== '{') fail(); state = 'next'; break;
      case 'next':
        if (char === '}' && !afterComma) state = 'done';
        else if (char === '"') { state = 'key'; afterComma = false; }
        else fail();
        break;
      case 'colon': if (char !== ':') fail(); state = 'quote'; break;
      case 'quote': if (char !== '"') fail(); state = 'value'; break;
      case 'comma':
        if (char === ',') { state = 'next'; afterComma = true; }
        else if (char === '}') state = 'done';
        else fail();
        break;
      default: fail();
    }
  }
  if (state !== 'done') fail();
}

export function* stringChunks(text) {
  if (!text.length) { yield { content: '', end: true }; return; }
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 16384, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    yield { content: text.slice(offset, end), end: end === text.length }; offset = end;
  }
}
