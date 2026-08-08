import { describe, expect, it } from 'vitest';

import { appendBoundedBuffer } from '../bridge/boundedOutput.js';

describe('bounded output buffering', () => {
  it('rejects an overflowing chunk without allocating it into the retained buffer', () => {
    const retained = Buffer.from('1234');
    const result = appendBoundedBuffer(retained, Buffer.from('5678'), 6);

    expect(result).toEqual({ buffer: retained, overflow: true });
    expect(result.buffer).toBe(retained);
  });
});
