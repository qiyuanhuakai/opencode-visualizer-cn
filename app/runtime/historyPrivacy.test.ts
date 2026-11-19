// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPrivacy } from '../../shared/runtime/native/codex/boundaries.js';
import { tokenizeHistoryJson } from '../../bridge/runtime/historyJsonStream.js';
import { redactHistoryJson } from '../../bridge/runtime/historyPrivacy.js';

async function redact(raw: string, secrets: readonly string[] = [], size = 3) {
  async function* source() {
    const bytes = new TextEncoder().encode(raw);
    for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size);
  }
  const pieces: Uint8Array[] = [];
  for await (const token of redactHistoryJson(tokenizeHistoryJson(source()), { secrets })) pieces.push(token.raw);
  return Buffer.concat(pieces).toString();
}
describe('streamed native history privacy', () => {
  it.each([
    { unknown: ['😀secret汉', { password: { huge: 'hidden' }, api_key: ['hidden'] }], url: 'HTTPS://name:password@EXAMPLE.com/a/../b?x=a%20b&token=secret#hash' },
    { body: 'URL appears here https://a:b@host/?token=secret', x: 'http://[', y: 'ws://name:pass@host/?token=a&token=b&keep=1' },
    { body: 'aaaaabaaaaa', secret: true, unknown: [null, 12, false], url: 'https://host' },
  ])('matches existing Codex privacy with split bytes for %j', async value => {
    // Given the existing production policy as an independent bounded oracle.
    const secrets = ['secret', 'aaa', '[REDACTED]b'];
    // When privacy processes native JSON a byte at a time.
    const actual = await redact(JSON.stringify(value), secrets, 1);
    // Then semantic output equals the established policy, including replacement order.
    expect(JSON.parse(actual)).toEqual(createPrivacy(secrets)(value));
  });
  it('preserves unknown raw string escapes when privacy does not alter their values', async () => {
    // Given escaped unknown native fields and an unrelated configured secret.
    const raw = '{"x":"\\u0061\\/😀","empty":"","number":1e2}';
    // When transformed; then unchanged string bytes and order are retained.
    expect(await redact(raw, ['absent'], 1)).toBe(raw);
  });
  it('redacts a secret crossing a tokenizer chunk and escaped surrogate boundary', async () => {
    // Given an escaped secret straddling the bounded token flush.
    const value = { body: 'x'.repeat(16380) + '😀secret-tail' };
    const raw = JSON.stringify(value).replace('😀', '\\ud83d\\ude00');
    // When streamed; then exact existing-policy output is retained.
    expect(JSON.parse(await redact(raw, ['😀secret'], 65536))).toEqual(createPrivacy(['😀secret'])(value));
  });
  it('fails oversized URL normalization explicitly while long ordinary text remains streamable', async () => {
    // Given a bounded URL policy and larger ordinary message text.
    // When transformed; then URL failure is explicit, not truncation or partial success.
    await expect(redact(JSON.stringify('https://host/' + 'x'.repeat(65536)))).rejects.toMatchObject({ code: 'unsupported' });
    const raw = JSON.stringify('message https://host/' + 'x'.repeat(100000));
    expect(await redact(raw, [], 65536)).toBe(raw);
  });
});
