import { describe, expect, it } from 'vitest';
import {
  buildAbsoluteRowRects,
  buildVisibleRangeHighlightStyles,
  calculateVirtualRowWindow,
  findLineAtY,
  shouldVirtualizeCodeRows,
} from './virtualCodeRows';

describe('virtual code row geometry', () => {
  it('preserves absolute line indexes for a scrolled render window', () => {
    const visibleRows = Array.from({ length: 11 }, (_, index) => ({
      top: -200 + index * 20,
      height: 20,
      right: 500,
    }));
    const rows = buildAbsoluteRowRects(190, visibleRows);

    expect(rows.size).toBe(11);
    expect(rows.get(0)).toBeUndefined();
    expect(rows.get(190)?.top).toBe(-200);
    expect(rows.get(200)?.top).toBe(0);
    expect(findLineAtY(rows, 10)).toBe(200);
  });

  it('uses memory proportional to the rendered window at deep offsets', () => {
    const rows = buildAbsoluteRowRects(1_000_000, [
      { top: 0, height: 20, right: 500 },
      { top: 20, height: 20, right: 500 },
    ]);

    expect(rows.size).toBe(2);
    expect(findLineAtY(rows, 10)).toBe(1_000_000);
  });

  it('returns null when the pointer is outside all rendered rows', () => {
    const rows = buildAbsoluteRowRects(
      500,
      [{ top: 40, height: 20, right: 500 }],
    );

    expect(findLineAtY(rows, 10)).toBeNull();
  });

  it('builds million-line range highlights from visible rows only', () => {
    const rows = new Map([
      [999_990, { top: 0, height: 20, right: 300 }],
      [999_991, { top: 20, height: 20, right: 300 }],
    ]);

    expect(buildVisibleRangeHighlightStyles(rows, 0, 1_000_000)).toEqual([
      { top: '0px', left: '0', right: '0', height: '20px' },
      { top: '20px', left: '0', right: '0', height: '20px' },
    ]);
  });

  it('uses measured row height and disables virtualization for wrapped code', () => {
    expect(
      calculateVirtualRowWindow({
        totalRows: 10_000,
        scrollTop: 24_000,
        containerHeight: 480,
        rowHeight: 24,
        overscanRows: 10,
      }),
    ).toEqual({ start: 990, end: 1030 });
    expect(shouldVirtualizeCodeRows(10_000, 500, true)).toBe(false);
    expect(shouldVirtualizeCodeRows(10_000, 500, false)).toBe(true);
  });
});
