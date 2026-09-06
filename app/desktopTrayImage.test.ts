import { readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';

it('ships a complete PNG with valid checksums and pixel data for native tray decoding', () => {
  const source = readFileSync(path.resolve(__dirname, '../electron/desktopShell.js'), 'utf8');
  const encoded = source.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/u)?.[1];
  if (!encoded) throw new Error('Tray PNG is missing');
  const png = Buffer.from(encoded, 'base64');
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const compressed: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + length;
    expect(png.readUInt32BE(end), `${kind} checksum`).toBe(crc32(png.subarray(offset + 4, end)));
    if (kind === 'IDAT') compressed.push(png.subarray(offset + 8, end));
    offset = end + 4;
  }
  expect(offset).toBe(png.length);
  expect(png.readUInt32BE(16)).toBe(16);
  expect(png.readUInt32BE(20)).toBe(16);
  expect(inflateSync(Buffer.concat(compressed)).length).toBe(16 * (1 + 16 * 4));
});
