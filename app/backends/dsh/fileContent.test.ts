import { expect, it } from 'vitest';
import { decodeDshFileContent } from './fileContent';

it('preserves UTF-8 content, trailing newlines and files beyond one line page', () => {
  const content = '中文\n'.repeat(6001);
  expect(decodeDshFileContent(new TextEncoder().encode(content))).toEqual({ type: 'text', encoding: 'utf-8', content });
});
it('retains NUL bytes and invalid UTF-8 as lossless binary', () => {
  for (const bytes of [new Uint8Array([65, 0, 66]), new Uint8Array([255, 254, 65])]) {
    const result = decodeDshFileContent(bytes);
    expect(result.type).toBe('binary');
    expect(result.encoding).toBe('base64');
    expect(Uint8Array.from(atob(result.content), char => char.charCodeAt(0))).toEqual(bytes);
  }
});
it('keeps empty files as successful empty text', () => {
  expect(decodeDshFileContent(new Uint8Array())).toEqual({ type: 'text', encoding: 'utf-8', content: '' });
});
