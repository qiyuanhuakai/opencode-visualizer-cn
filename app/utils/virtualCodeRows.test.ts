import { describe, expect, it } from 'vitest';
import { buildAbsoluteRowRects, findLineAtY } from './virtualCodeRows';

describe('virtual code row geometry', () => {
  it('preserves absolute line indexes for a scrolled render window', () => {
    const visibleRows = Array.from({ length: 11 }, (_, index) => ({
      top: -200 + index * 20,
      height: 20,
      right: 500,
    }));
    const rows = buildAbsoluteRowRects(190, visibleRows);

    expect(rows[0]).toBeUndefined();
    expect(rows[190]?.top).toBe(-200);
    expect(rows[200]?.top).toBe(0);
    expect(findLineAtY(rows, 10)).toBe(200);
  });

  it('returns null when the pointer is outside all rendered rows', () => {
    const rows = buildAbsoluteRowRects(
      500,
      [{ top: 40, height: 20, right: 500 }],
    );

    expect(findLineAtY(rows, 10)).toBeNull();
  });
});
