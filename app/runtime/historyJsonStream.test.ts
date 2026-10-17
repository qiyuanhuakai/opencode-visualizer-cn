// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tokenizeHistoryJson } from '../../bridge/runtime/historyJsonStream.js';
import type { HistoryJsonToken } from '../../bridge/runtime/historyJsonStream.js';

async function* chunks(text: string, size = 3) {
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size);
}
async function collect(text: string, size?: number) {
  const tokens: HistoryJsonToken[] = [];
  for await (const token of tokenizeHistoryJson(chunks(text, size))) tokens.push(token);
  return tokens;
}
describe('history incremental JSON', () => {
  it('retains raw escapes and qualified paths across byte boundaries', async () => {
    // Given native unknown fields, escaped characters and split multibyte UTF8.
    const raw = ' {"items":[{"unknown":"😀汉\\u0061\\n\\\"", "id":"late"}],"cursor":null}\n';
    // When the byte parser consumes one byte at a time.
    const tokens = await collect(raw, 1);
    // Then exact native syntax and late identity are preserved.
    expect(Buffer.concat(tokens.map(token => token.raw)).toString()).toBe(raw);
    expect(tokens.find(token => token.kind === 'string-data' && token.text === 'late')?.path).toEqual(['items', 0, 'id']);
  });
  it.each(['{"a":1,"a":2}', '[1,]', '{"a":}', 'true false', '01', '[1', '"bad\n"', '"\\x00"', '{"a" 1}', '[1 2]', '1e999'])('rejects invalid input %s without completing', async raw => {
    // Given malformed native JSON; when streamed; then no successful completion.
    await expect(collect(raw)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('bounds structural depth and key tokens independently of body length', async () => {
    // Given hostile nesting and a key exceeding the declared cap.
    // When parsing; then bounded capability errors are explicit.
    await expect(collect('['.repeat(65) + '0' + ']'.repeat(65))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(collect(JSON.stringify({ ['x'.repeat(4097)]: 1 }), 16384)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rejects malformed UTF8 and oversized backing allocations', async () => {
    // Given invalid bytes and a tiny view retaining a large allocation.
    async function* invalid() { yield Uint8Array.of(34, 0xc0, 0xaf, 34); }
    async function* oversized() { yield new Uint8Array(131072).subarray(0, 1); }
    // When streamed; then both producer violations fail.
    await expect((async () => { for await (const token of tokenizeHistoryJson(invalid())) void token; })()).rejects.toMatchObject({ code: 'invalid_request' });
    await expect((async () => { for await (const token of tokenizeHistoryJson(oversized())) void token; })()).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
