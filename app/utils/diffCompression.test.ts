import { describe, expect, it } from 'vitest';

import { compactUnifiedDiffPatch } from './diffCompression';

describe('compactUnifiedDiffPatch', () => {
  it('reduces oversized patch context around a small change', () => {
    const patch = [
      '@@ -1,10 +1,10 @@',
      ' line1',
      ' line2',
      ' line3',
      ' line4',
      ' line5',
      '-line6-old',
      '+line6-new',
      ' line7',
      ' line8',
      ' line9',
      ' line10',
    ].join('\n');

    expect(compactUnifiedDiffPatch(patch)).toBe([
      '@@ -3,7 +3,7 @@',
      ' line3',
      ' line4',
      ' line5',
      '-line6-old',
      '+line6-new',
      ' line7',
      ' line8',
      ' line9',
    ].join('\n'));
  });

  it('keeps first-line modifications at the top of the hunk', () => {
    const patch = [
      '@@ -1,8 +1,8 @@',
      '-export const first = 1;',
      '+export const first = 2;',
      ' const second = 2;',
      ' const third = 3;',
      ' const fourth = 4;',
      ' const fifth = 5;',
      ' const sixth = 6;',
      ' const seventh = 7;',
      ' const eighth = 8;',
    ].join('\n');

    expect(compactUnifiedDiffPatch(patch)).toBe([
      '@@ -1,4 +1,4 @@',
      '-export const first = 1;',
      '+export const first = 2;',
      ' const second = 2;',
      ' const third = 3;',
      ' const fourth = 4;',
    ].join('\n'));
  });

  it('drops diff metadata like Index headers from compacted output', () => {
    const patch = [
      'Index: app/utils/diffCompression.test.ts',
      '===================================================================',
      '--- app/utils/diffCompression.test.ts',
      '+++ app/utils/diffCompression.test.ts',
      '@@ -1,5 +1,5 @@',
      ' import { describe, expect, it } from \'vitest\';',
      '-old line',
      '+new line',
      ' const keep = true;',
      ' const more = true;',
    ].join('\n');

    expect(compactUnifiedDiffPatch(patch)).toBe([
      '@@ -1,4 +1,4 @@',
      ' import { describe, expect, it } from \'vitest\';',
      '-old line',
      '+new line',
      ' const keep = true;',
      ' const more = true;',
    ].join('\n'));
  });
});
