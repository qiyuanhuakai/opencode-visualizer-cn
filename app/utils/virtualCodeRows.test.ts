import { describe, expect, it, vi } from 'vitest';
import {
  buildAbsoluteRowRects,
  buildVisibleRangeHighlightStyles,
  captureFixedRowAnchor,
  captureRenderedRowAnchor,
  captureVariableRowAnchor,
  calculateVariableRowWindow,
  calculateVirtualRowWindow,
  createVariableRowGeometry,
  findLineAtY,
  getVariableRowOffset,
  getVariableTotalHeight,
  measureInnerVirtualRowHeights,
  measureOuterVirtualRowHeights,
  restoreFixedRowAnchor,
  restoreVariableRowAnchor,
  shouldVirtualizeCodeRows,
  updateVariableRowHeight,
} from './virtualCodeRows';

describe('virtual code row geometry', () => {
  it('captures the first rendered row intersecting the viewport instead of trusting estimated offsets', () => {
    const anchor = captureRenderedRowAnchor({
      viewportTop: 100,
      firstRenderedRow: 7_490,
      rowRects: [
        { top: -20, height: 40 },
        { top: 20, height: 40 },
        { top: 60, height: 80 },
        { top: 140, height: 40 },
      ],
    });

    expect(anchor).toEqual({ rowIndex: 7_492, offsetWithinRow: 40 });
  });

  it('does not move the anchor to a previous row for a subpixel boundary overlap', () => {
    const anchor = captureRenderedRowAnchor({
      viewportTop: 100,
      firstRenderedRow: 7_508,
      rowRects: [
        { top: 80, height: 20.25 },
        { top: 100.25, height: 20 },
      ],
    });

    expect(anchor).toEqual({ rowIndex: 7_509, offsetWithinRow: 0 });
  });


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

  it('keeps large wrapped files virtualized', () => {
    expect(
      calculateVirtualRowWindow({
        totalRows: 10_000,
        scrollTop: 24_000,
        containerHeight: 480,
        rowHeight: 24,
        overscanRows: 10,
      }),
    ).toEqual({ start: 990, end: 1030 });
    expect(shouldVirtualizeCodeRows(10_000, 500, true)).toBe(true);
    expect(shouldVirtualizeCodeRows(10_000, 500, false)).toBe(true);
  });

  it('tracks measured wrapped row heights without mounting the full file', () => {
    const geometry = createVariableRowGeometry(1_000_000, 20);

    expect(updateVariableRowHeight(geometry, 1, 60)).toBe(true);
    expect(getVariableRowOffset(geometry, 2)).toBe(80);
    expect(getVariableTotalHeight(geometry)).toBe(20_000_040);
    expect(
      calculateVariableRowWindow(geometry, {
        scrollTop: 40,
        containerHeight: 100,
        overscanRows: 1,
      }),
    ).toEqual({ start: 0, end: 7 });
  });

  it('measures the outer virtual-row boxes rather than their inner code rows', () => {
    const container = document.createElement('div');
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.className = 'virtual-row';
    second.className = 'virtual-row';
    first.innerHTML = '<div class="code-row">inner</div>';
    second.innerHTML = '<div class="code-row">inner</div>';
    container.append(first, second);
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 37));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 37, 100, 61));

    expect(measureOuterVirtualRowHeights(container, 40)).toEqual(
      new Map([
        [40, 37],
        [41, 61],
      ]),
    );
  });

  it('measures inner code rows for fixed virtual rows', () => {
    const container = document.createElement('div');
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.className = 'virtual-row';
    second.className = 'virtual-row';
    first.innerHTML = '<div class="code-row">inner</div>';
    second.innerHTML = '<div class="code-row">inner</div>';
    container.append(first, second);
    const innerRows = [...container.querySelectorAll<HTMLElement>('.code-row')];
    innerRows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, index === 0 ? 0 : 44, 100, index === 0 ? 44 : 28),
      );
    });

    expect(measureInnerVirtualRowHeights(container, 40)).toEqual(
      new Map([
        [40, 44],
        [41, 28],
      ]),
    );
  });

  it('restores a fixed-row anchor to the same row after a geometry reset', () => {
    const anchor = captureFixedRowAnchor({ scrollTop: 247, rowHeight: 20, totalRows: 1_000 });

    expect(anchor).toEqual({ rowIndex: 12, offsetWithinRow: 7 });
    expect(
      restoreFixedRowAnchor({ anchor, rowHeight: 32, totalRows: 1_000 }),
    ).toBe(391);
  });

  it('preserves the exact fixed-row line when wrapped geometry starts estimated', () => {
    const anchor = captureFixedRowAnchor({ scrollTop: 100, rowHeight: 40, totalRows: 1_000 });
    const geometry = createVariableRowGeometry(1_000, 20);
    updateVariableRowHeight(geometry, 0, 30);
    updateVariableRowHeight(geometry, 1, 30);
    updateVariableRowHeight(geometry, 2, 30);

    expect(anchor).toEqual({ rowIndex: 2, offsetWithinRow: 20 });
    expect(restoreVariableRowAnchor({ anchor, geometry })).toBe(80);
  });

  it('restores a variable-row anchor by row identity after measured heights change', () => {
    const before = createVariableRowGeometry(100, 20);
    updateVariableRowHeight(before, 0, 40);
    updateVariableRowHeight(before, 1, 60);
    const anchor = captureVariableRowAnchor({ scrollTop: 57, geometry: before });

    const after = createVariableRowGeometry(100, 20);
    updateVariableRowHeight(after, 0, 80);

    expect(anchor).toEqual({ rowIndex: 1, offsetWithinRow: 17 });
    expect(restoreVariableRowAnchor({ anchor, geometry: after })).toBe(97);
  });
});
