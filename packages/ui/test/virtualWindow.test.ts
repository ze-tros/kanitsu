import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VIRTUAL_WINDOW_STEP_ROWS,
  stableWindowRowsFor,
  virtualSurfaceHeight,
  type GalleryMetrics,
} from '../src/virtualWindow';

function metrics(overrides: Partial<GalleryMetrics> = {}): GalleryMetrics {
  return {
    cols: 4,
    cardHeight: 90,
    rowHeight: 100,
    galleryTop: 240,
    viewportH: 450,
    ...overrides,
  };
}

test('returns an empty window for invalid geometry or no items', () => {
  assert.deepEqual(stableWindowRowsFor(metrics({ rowHeight: 0 }), 0, 100), { first: 0, last: 0 });
  assert.deepEqual(stableWindowRowsFor(metrics({ cols: 0 }), 0, 100), { first: 0, last: 0 });
  assert.deepEqual(stableWindowRowsFor(metrics(), 0, 0), { first: 0, last: 0 });
});

test('keeps a stable window throughout one row block', () => {
  const source = metrics();
  const atFirstRow = stableWindowRowsFor(source, source.galleryTop, 400);
  for (let row = 0; row < VIRTUAL_WINDOW_STEP_ROWS; row += 1) {
    const withinRow = source.galleryTop + row * source.rowHeight + source.rowHeight - 1;
    assert.deepEqual(stableWindowRowsFor(source, withinRow, 400), atFirstRow);
  }
  assert.notDeepEqual(
    stableWindowRowsFor(source, source.galleryTop + VIRTUAL_WINDOW_STEP_ROWS * source.rowHeight, 400),
    atFirstRow,
  );
});

test('covers every visible row for mixed-section offsets and bottom boundaries', () => {
  const source = metrics({ galleryTop: 673, viewportH: 517, rowHeight: 113, cols: 5 });
  const itemCount = 503;
  const totalRows = Math.ceil(itemCount / source.cols);
  const surfaceBottom = source.galleryTop + virtualSurfaceHeight(source, itemCount);

  for (let scrollTop = 0; scrollTop < surfaceBottom; scrollTop += 37) {
    const viewportBottom = scrollTop + source.viewportH;
    if (viewportBottom <= source.galleryTop) continue;
    const firstVisible = Math.max(0, Math.floor((scrollTop - source.galleryTop) / source.rowHeight));
    const lastVisible = Math.min(
      totalRows,
      Math.ceil((viewportBottom - source.galleryTop) / source.rowHeight),
    );
    const window = stableWindowRowsFor(source, scrollTop, itemCount);
    assert.ok(window.first <= firstVisible, `first visible row missing at ${scrollTop}`);
    assert.ok(window.last >= lastVisible, `last visible row missing at ${scrollTop}`);
    assert.ok(window.first >= 0 && window.last <= totalRows);
  }

  assert.deepEqual(
    stableWindowRowsFor(source, surfaceBottom, itemCount),
    { first: totalRows, last: totalRows },
  );
});

test('surface height excludes the final gap and still mounts a partial last row', () => {
  const source = metrics({ cols: 4, cardHeight: 90, rowHeight: 106, galleryTop: 80, viewportH: 120 });
  const itemCount = 9;
  assert.equal(virtualSurfaceHeight(source, itemCount), 302);

  const bottom = source.galleryTop + virtualSurfaceHeight(source, itemCount);
  const beforeBottom = stableWindowRowsFor(source, bottom - 1, itemCount);
  assert.ok(beforeBottom.first <= 2 && beforeBottom.last === 3);
  assert.deepEqual(stableWindowRowsFor(source, bottom, itemCount), { first: 3, last: 3 });
});
