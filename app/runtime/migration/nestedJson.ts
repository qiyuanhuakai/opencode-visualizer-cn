import { DraftStorageError } from './draftChunks';
export type JsonLeaf = Readonly<{ path: readonly (string | number)[]; content: string; end: boolean; string: boolean }>;
type Frame = { type: 'object' | 'array'; path: (string | number)[]; state: 'key' | 'colon' | 'value' | 'comma'; key: string; index: number; empty: boolean };
export async function* jsonLeaves(input: AsyncIterable<string>): AsyncGenerator<JsonLeaf> {
  const stack: Frame[] = []; let rootDone = false; let mode: 'idle' | 'string' | 'primitive' = 'idle'; let buffer = ''; let encoded = ''; let keyString = false; let path: (string | number)[] = [];
  const fail = () => { throw new DraftStorageError('corrupt'); };
  const finishValue = () => { const parent = stack.at(-1); if (parent) { parent.state = 'comma'; parent.empty = false; } else rootDone = true; };
  for await (const text of input) for (const char of text) {
    let again = true;
    while (again) {
      again = false;
      if (mode === 'string') {
        if (encoded) {
          encoded += char;
          if (encoded === '\\u') continue;
          if (encoded.startsWith('\\u') && encoded.length < 6) continue;
          try { buffer += JSON.parse('"' + encoded + '"'); } catch { fail(); }
          encoded = '';
        } else if (char === '\\') { encoded = '\\'; continue; }
        else if (char === '"') {
          mode = 'idle';
          if (keyString) { const frame = stack.at(-1); if (!frame) fail(); else { frame.key = buffer; frame.state = 'colon'; } }
          else { yield { path, content: buffer, end: true, string: true }; finishValue(); }
          buffer = ''; continue;
        } else { if (char.charCodeAt(0) < 32) fail(); buffer += char; }
        if (keyString && buffer.length > 16384) fail();
        if (!keyString && buffer.length >= 16384 && !/[\uD800-\uDBFF]$/u.test(buffer)) { yield { path, content: buffer, end: false, string: true }; buffer = ''; }
        continue;
      }
      if (mode === 'primitive') {
        if (!/[\s,}\]]/u.test(char)) { buffer += char; if (buffer.length > 1024) fail(); continue; }
        try { const value: unknown = JSON.parse(buffer); if (typeof value === 'object' && value !== null) fail(); } catch { fail(); }
        yield { path, content: buffer, end: true, string: false }; buffer = ''; mode = 'idle'; finishValue(); again = true; continue;
      }
      if (/[ \r\n\t]/u.test(char)) continue;
      const frame = stack.at(-1);
      if (frame?.state === 'comma') {
        if (char === ',') { frame.state = frame.type === 'object' ? 'key' : 'value'; frame.index++; continue; }
        if (char !== (frame.type === 'object' ? '}' : ']')) fail();
        stack.pop(); finishValue(); continue;
      }
      if (frame?.state === 'key') {
        if (char === '}' && frame.empty) { stack.pop(); finishValue(); continue; }
        if (char !== '"') fail(); keyString = true; mode = 'string'; continue;
      }
      if (frame?.state === 'colon') { if (char !== ':') fail(); frame.state = 'value'; continue; }
      if (frame?.type === 'array' && frame.state === 'value' && char === ']' && frame.empty) { stack.pop(); finishValue(); continue; }
      if (rootDone) fail();
      path = frame ? [...frame.path, frame.type === 'array' ? frame.index : frame.key] : [];
      if (char === '{' || char === '[') { if (stack.length >= 64) fail(); stack.push({ type: char === '{' ? 'object' : 'array', path, state: char === '{' ? 'key' : 'value', key: '', index: 0, empty: true }); }
      else if (char === '"') { keyString = false; mode = 'string'; }
      else { if (!/[-0-9tfn]/u.test(char)) fail(); mode = 'primitive'; buffer = char; }
    }
  }
  if (mode === 'primitive' && stack.length === 0) { try { JSON.parse(buffer); } catch { fail(); } yield { path, content: buffer, end: true, string: false }; rootDone = true; mode = 'idle'; }
  if (!rootDone || stack.length || mode !== 'idle') fail();
}

export type JsonEntry = Readonly<{ key: string; content: string; end: boolean }>;
export async function* jsonEntries(input: AsyncIterable<string>): AsyncGenerator<JsonEntry> {
  let state: 'start' | 'key' | 'quoted-key' | 'colon' | 'value' | 'done' = 'start';
  let key = ''; let buffer = ''; let quoted = false; let escaped = false; let empty = true; let valueStarted = false; const nesting: string[] = [];
  const fail = () => { throw new DraftStorageError('corrupt'); };
  for await (const text of input) for (const char of text) {
    switch (state) {
      case 'start': if (/\s/u.test(char)) continue; if (char !== '{') fail(); state = 'key'; break;
      case 'key':
        if (/\s/u.test(char)) continue;
        if (char === '}' && empty) { state = 'done'; break; }
        if (char !== '"') fail(); buffer = '"'; state = 'quoted-key'; break;
      case 'quoted-key':
        buffer += char;
        if (buffer.length > 16384) fail();
        if (escaped) { escaped = false; break; }
        if (char === '\\') { escaped = true; break; }
        if (char === '"') {
          try { const parsed: unknown = JSON.parse(buffer); if (typeof parsed !== 'string') fail(); else key = parsed; } catch { fail(); }
          buffer = ''; valueStarted = false; state = 'colon';
        }
        break;
      case 'colon': if (/\s/u.test(char)) continue; if (char !== ':') fail(); state = 'value'; break;
      case 'value':
        if (!quoted && nesting.length === 0 && (char === ',' || char === '}')) {
          if (!valueStarted) fail(); yield { key, content: buffer, end: true }; buffer = ''; empty = false;
          state = char === ',' ? 'key' : 'done'; break;
        }
        buffer += char; if (!/\s/u.test(char)) valueStarted = true;
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') { nesting.push(char); if (nesting.length > 64) fail(); }
        else if (char === '}' || char === ']') { if (nesting.pop() !== (char === '}' ? '{' : '[')) fail(); }
        if (buffer.length >= 16384 && !/[\uD800-\uDBFF]$/u.test(buffer)) { yield { key, content: buffer, end: false }; buffer = ''; }
        break;
      case 'done': if (!/\s/u.test(char)) fail(); break;
      default: state satisfies never;
    }
  }
  if (state !== 'done') fail();
}
