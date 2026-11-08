// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSseDecoder } from '../shared/runtime/native/opencode/sse.js';

it('accepts many bounded SSE frames delivered in one native read', () => {
  const decoder = createSseDecoder(64);
  const frames = Array.from({ length: 20 }, (_, index) => ({ index }));
  const bytes = new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''));
  expect(bytes.byteLength).toBeGreaterThan(64);
  expect(decoder.push(bytes)).toEqual(frames);
  decoder.finish();
});

it('refuses an oversized raw frame before UTF-8 decoding allocates it', () => {
  const decoder = createSseDecoder();
  const bytes = new Uint8Array(1024 * 1024 + 1).fill(120);
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    expect(() => decoder.push(bytes)).toThrow('opencode.sse_frame');
    expect(decode).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});

it('rejects a producer read above its independent budget before decoding', () => {
  const decoder = createSseDecoder();
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    expect(() => decoder.push(bytes)).toThrow('opencode.sse_chunk');
    expect(decode).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});

it('counts a split frame in original bytes and rejects its overflowing continuation before decoding', () => {
  const decoder = createSseDecoder(64);
  const bytes = new TextEncoder().encode(`data: {"text":"${'中'.repeat(20)}"}\n\n`);
  expect(decoder.push(bytes.subarray(0, 40))).toEqual([]);
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    expect(() => decoder.push(bytes.subarray(40))).toThrow('opencode.sse_frame');
    expect(decode).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});

it('preserves CRLF boundaries and Unicode when every native byte arrives separately', () => {
  const decoder = createSseDecoder(128);
  const bytes = new TextEncoder().encode('data: {"text":"中文🙂"}\r\n\r\ndata: {"next":true}\n\n');
  const frames = [...bytes].flatMap(byte => decoder.push(Uint8Array.of(byte)));
  expect(frames).toEqual([{ text: '中文🙂' }, { next: true }]);
  decoder.finish();
});
