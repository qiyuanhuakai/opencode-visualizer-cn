export type CodeRowRect = { top: number; height: number; right: number };

export type VariableRowGeometry = {
  readonly totalRows: number;
  readonly estimatedRowHeight: number;
  readonly measuredHeights: Map<number, number>;
  readonly heightDeltas: Float64Array;
};

export type VirtualRowAnchor = {
  readonly rowIndex: number;
  readonly offsetWithinRow: number;
};

export function shouldVirtualizeCodeRows(
  rowCount: number,
  threshold: number,
  _wraps: boolean,
) {
  return rowCount > threshold;
}

export function createVariableRowGeometry(
  totalRows: number,
  estimatedRowHeight: number,
): VariableRowGeometry {
  const normalizedTotal = Math.max(0, Math.floor(totalRows));
  return {
    totalRows: normalizedTotal,
    estimatedRowHeight: Math.max(1, estimatedRowHeight),
    measuredHeights: new Map(),
    heightDeltas: new Float64Array(normalizedTotal + 1),
  };
}

function addHeightDelta(geometry: VariableRowGeometry, rowIndex: number, delta: number): void {
  for (let index = rowIndex + 1; index < geometry.heightDeltas.length; index += index & -index) {
    geometry.heightDeltas[index] = (geometry.heightDeltas[index] ?? 0) + delta;
  }
}

function getHeightDeltaBefore(geometry: VariableRowGeometry, rowIndex: number): number {
  let sum = 0;
  for (let index = Math.min(rowIndex, geometry.totalRows); index > 0; index -= index & -index) {
    sum += geometry.heightDeltas[index] ?? 0;
  }
  return sum;
}

export function updateVariableRowHeight(
  geometry: VariableRowGeometry,
  rowIndex: number,
  height: number,
): boolean {
  if (rowIndex < 0 || rowIndex >= geometry.totalRows || !Number.isFinite(height) || height <= 0) {
    return false;
  }
  const previousHeight = geometry.measuredHeights.get(rowIndex) ?? geometry.estimatedRowHeight;
  if (Math.abs(previousHeight - height) <= 0.5) return false;
  geometry.measuredHeights.set(rowIndex, height);
  addHeightDelta(geometry, rowIndex, height - previousHeight);
  return true;
}

export function getVariableRowOffset(geometry: VariableRowGeometry, rowIndex: number): number {
  const normalizedIndex = Math.min(geometry.totalRows, Math.max(0, Math.floor(rowIndex)));
  return (
    normalizedIndex * geometry.estimatedRowHeight +
    getHeightDeltaBefore(geometry, normalizedIndex)
  );
}

export function getVariableTotalHeight(geometry: VariableRowGeometry): number {
  return getVariableRowOffset(geometry, geometry.totalRows);
}

function findVariableRowAtOffset(geometry: VariableRowGeometry, offset: number): number {
  if (geometry.totalRows === 0) return 0;
  const normalizedOffset = Math.max(0, offset);
  let low = 0;
  let high = geometry.totalRows;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (getVariableRowOffset(geometry, middle + 1) <= normalizedOffset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.min(geometry.totalRows - 1, low);
}

export function measureOuterVirtualRowHeights(
  container: ParentNode,
  firstRenderedRow: number,
): Map<number, number> {
  const heights = new Map<number, number>();
  const normalizedFirstRow = Math.max(0, Math.floor(firstRenderedRow));
  const rows = container.querySelectorAll<HTMLElement>('.virtual-row');
  rows.forEach((row, index) => {
    const height = row.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) {
      heights.set(normalizedFirstRow + index, height);
    }
  });
  return heights;
}

export function measureInnerVirtualRowHeights(
  container: ParentNode,
  firstRenderedRow: number,
): Map<number, number> {
  const heights = new Map<number, number>();
  const normalizedFirstRow = Math.max(0, Math.floor(firstRenderedRow));
  const rows = container.querySelectorAll<HTMLElement>('.virtual-row .code-row');
  rows.forEach((row, index) => {
    const height = row.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) {
      heights.set(normalizedFirstRow + index, height);
    }
  });
  return heights;
}

export function captureFixedRowAnchor(params: {
  readonly scrollTop: number;
  readonly rowHeight: number;
  readonly totalRows: number;
}): VirtualRowAnchor | null {
  const totalRows = Math.max(0, Math.floor(params.totalRows));
  const rowHeight = Math.max(1, params.rowHeight);
  if (totalRows === 0) return null;
  const scrollTop = Math.max(0, params.scrollTop);
  const rowIndex = Math.min(totalRows - 1, Math.floor(scrollTop / rowHeight));
  return {
    rowIndex,
    offsetWithinRow: scrollTop - rowIndex * rowHeight,
  };
}

export function captureRenderedRowAnchor(params: {
  readonly viewportTop: number;
  readonly firstRenderedRow: number;
  readonly rowRects: ReadonlyArray<{ readonly top: number; readonly height: number }>;
}): VirtualRowAnchor | null {
  const boundaryTolerancePx = 0.5;
  const firstRenderedRow = Math.max(0, Math.floor(params.firstRenderedRow));
  const rowIndex = params.rowRects.findIndex(
    (rect) =>
      Number.isFinite(rect.top) &&
      Number.isFinite(rect.height) &&
      rect.height > 0 &&
      rect.top + rect.height > params.viewportTop + boundaryTolerancePx,
  );
  if (rowIndex < 0) return null;
  const rect = params.rowRects[rowIndex];
  if (!rect) return null;
  return {
    rowIndex: firstRenderedRow + rowIndex,
    offsetWithinRow: Math.max(0, params.viewportTop - rect.top),
  };
}

export function restoreFixedRowAnchor(params: {
  readonly anchor: VirtualRowAnchor | null;
  readonly rowHeight: number;
  readonly totalRows: number;
}): number {
  if (!params.anchor) return 0;
  const totalRows = Math.max(0, Math.floor(params.totalRows));
  if (totalRows === 0) return 0;
  const rowHeight = Math.max(1, params.rowHeight);
  const rowIndex = Math.min(totalRows - 1, Math.max(0, params.anchor.rowIndex));
  return Math.max(0, rowIndex * rowHeight + params.anchor.offsetWithinRow);
}

export function captureVariableRowAnchor(params: {
  readonly scrollTop: number;
  readonly geometry: VariableRowGeometry;
}): VirtualRowAnchor | null {
  if (params.geometry.totalRows === 0) return null;
  const scrollTop = Math.max(0, params.scrollTop);
  const rowIndex = findVariableRowAtOffset(params.geometry, scrollTop);
  return {
    rowIndex,
    offsetWithinRow: scrollTop - getVariableRowOffset(params.geometry, rowIndex),
  };
}

export function restoreVariableRowAnchor(params: {
  readonly anchor: VirtualRowAnchor | null;
  readonly geometry: VariableRowGeometry;
}): number {
  if (!params.anchor || params.geometry.totalRows === 0) return 0;
  const rowIndex = Math.min(
    params.geometry.totalRows - 1,
    Math.max(0, params.anchor.rowIndex),
  );
  return Math.max(
    0,
    getVariableRowOffset(params.geometry, rowIndex) + params.anchor.offsetWithinRow,
  );
}

export function calculateVariableRowWindow(
  geometry: VariableRowGeometry,
  params: { scrollTop: number; containerHeight: number; overscanRows: number },
): { start: number; end: number } {
  if (geometry.totalRows === 0) return { start: 0, end: 0 };
  const overscanRows = Math.max(0, Math.floor(params.overscanRows));
  const firstVisible = findVariableRowAtOffset(geometry, params.scrollTop);
  const lastVisible = findVariableRowAtOffset(
    geometry,
    params.scrollTop + Math.max(0, params.containerHeight),
  );
  return {
    start: Math.max(0, firstVisible - overscanRows),
    end: Math.min(geometry.totalRows, lastVisible + overscanRows + 1),
  };
}

export function calculateVirtualRowWindow(params: {
  totalRows: number;
  scrollTop: number;
  containerHeight: number;
  rowHeight: number;
  overscanRows: number;
}) {
  const rowHeight = Math.max(1, params.rowHeight);
  const start = Math.max(0, Math.floor(params.scrollTop / rowHeight) - params.overscanRows);
  const visibleCount = Math.ceil(params.containerHeight / rowHeight);
  const end = Math.min(
    params.totalRows,
    start + visibleCount + params.overscanRows * 2,
  );
  return { start, end };
}

export function buildAbsoluteRowRects(
  firstRenderedLine: number,
  visibleRowRects: CodeRowRect[],
): Map<number, CodeRowRect> {
  const rows = new Map<number, CodeRowRect>();
  visibleRowRects.forEach((rect, index) => {
    rows.set(firstRenderedLine + index, rect);
  });
  return rows;
}

export function findLineAtY(rowRects: ReadonlyMap<number, CodeRowRect>, y: number): number | null {
  for (const [line, rect] of rowRects) {
    if (y >= rect.top && y < rect.top + rect.height) return line;
  }
  return null;
}

export function buildVisibleRangeHighlightStyles(
  rowRects: ReadonlyMap<number, CodeRowRect>,
  start: number,
  end: number,
) {
  return [...rowRects]
    .filter(([line]) => line >= start && line <= end)
    .map(([, rect]) => ({
      top: `${rect.top}px`,
      left: '0',
      right: '0',
      height: `${rect.height}px`,
    }));
}
