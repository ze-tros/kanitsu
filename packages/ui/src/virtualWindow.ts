export const OVERSCAN_ROWS = 2;
export const VIRTUAL_WINDOW_STEP_ROWS = 3;

export interface GalleryMetrics {
  cols: number;
  cardHeight: number;
  rowHeight: number;
  /** The virtual surface's content offset inside its scroll container. */
  galleryTop: number;
  /** The scroll container's visible height. */
  viewportH: number;
}

export interface RowWindow {
  first: number;
  last: number;
}

/** Exact surface height without a trailing grid gap after the final row. */
export function virtualSurfaceHeight(metrics: GalleryMetrics, itemCount: number): number {
  if (metrics.rowHeight <= 0 || metrics.cols <= 0 || itemCount <= 0) return 0;
  const totalRows = Math.ceil(itemCount / metrics.cols);
  const cardHeight = metrics.cardHeight > 0 ? metrics.cardHeight : metrics.rowHeight;
  return (totalRows - 1) * metrics.rowHeight + cardHeight;
}

/** Returns the visible row range plus a small overscan buffer. */
export function windowRowsFor(
  metrics: GalleryMetrics,
  scrollTop: number,
  itemCount: number,
): RowWindow {
  if (metrics.rowHeight <= 0 || metrics.cols <= 0 || itemCount <= 0) {
    return { first: 0, last: 0 };
  }
  const totalRows = Math.ceil(itemCount / metrics.cols);
  const surfaceScrollTop = Math.max(0, scrollTop - metrics.galleryTop);
  const first = Math.min(
    totalRows,
    Math.max(0, Math.floor(surfaceScrollTop / metrics.rowHeight) - OVERSCAN_ROWS),
  );
  const last = Math.min(
    totalRows,
    Math.ceil((surfaceScrollTop + metrics.viewportH) / metrics.rowHeight) + OVERSCAN_ROWS,
  );
  return { first, last };
}

/**
 * Advances the mounted row range in fixed blocks. Keeping the range stable
 * inside a block avoids a React unmount/mount cycle at every row boundary.
 */
export function stableWindowRowsFor(
  metrics: GalleryMetrics,
  scrollTop: number,
  itemCount: number,
): RowWindow {
  if (metrics.rowHeight <= 0 || metrics.cols <= 0 || itemCount <= 0) {
    return { first: 0, last: 0 };
  }
  const totalRows = Math.ceil(itemCount / metrics.cols);
  const relativeTop = scrollTop - metrics.galleryTop;
  if (relativeTop >= virtualSurfaceHeight(metrics, itemCount)) {
    return { first: totalRows, last: totalRows };
  }
  const firstVisible = Math.max(0, Math.floor(relativeTop / metrics.rowHeight));
  const blockStart = Math.floor(firstVisible / VIRTUAL_WINDOW_STEP_ROWS) * VIRTUAL_WINDOW_STEP_ROWS;
  const visibleRows = Math.max(1, Math.ceil(metrics.viewportH / metrics.rowHeight) + 1);
  return {
    first: Math.max(0, blockStart - OVERSCAN_ROWS),
    last: Math.min(
      totalRows,
      blockStart + visibleRows + OVERSCAN_ROWS + VIRTUAL_WINDOW_STEP_ROWS,
    ),
  };
}

/** Limits one-row boundary jitter while allowing large scroll jumps. */
export function clampWindow(prev: RowWindow, next: RowWindow): RowWindow {
  if (Math.abs(next.first - prev.first) > 2 || Math.abs(next.last - prev.last) > 2) {
    return next;
  }
  return {
    first: Math.min(Math.max(next.first, prev.first - 1), prev.first + 1),
    last: Math.min(Math.max(next.last, prev.last - 1), prev.last + 1),
  };
}
