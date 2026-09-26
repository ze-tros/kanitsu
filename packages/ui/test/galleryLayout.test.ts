import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  gridLayout,
  itemRangeOfRows,
  itemsInRect,
  justifiedLayout,
  listLayout,
  neighborIndex,
  rowWindow,
} from '../src/desktop/galleryLayout';

describe('gridLayout', () => {
  test('columns fit the minimum card width and rows are uniform', () => {
    const l = gridLayout({ count: 10, width: 1000, minCard: 180, gap: 10, mediaAspect: 1, captionH: 40 });
    assert.equal(l.cols, 5);
    const cardW = (1000 - 40) / 5;
    assert.equal(l.rowCount, 2);
    assert.equal(l.rowHeight(0), cardW + 40);
    assert.equal(l.height, 2 * (cardW + 40) + 10);
    assert.deepEqual(l.rowRange(1), [5, 10]);
    assert.deepEqual(l.itemBox(6), { x: cardW + 10, y: cardW + 50, w: cardW, h: cardW });
    assert.equal(l.rowAt(cardW + 45), 0, 'gap below row 0 still belongs to row 0');
    assert.equal(l.rowAt(99999), 1);
  });

  test('always at least one column', () => {
    const l = gridLayout({ count: 3, width: 50, minCard: 180, gap: 10, mediaAspect: 1.25, captionH: 0 });
    assert.equal(l.cols, 1);
    assert.equal(l.rowCount, 3);
  });
});

describe('justifiedLayout', () => {
  test('rows fill the width exactly except the last one', () => {
    const aspects = [1.5, 1.5, 0.75, 1, 2, 1.5, 1.5];
    const l = justifiedLayout({ aspects, width: 900, targetHeight: 200, gap: 10, captionH: 0 });
    for (let r = 0; r < l.rowCount - 1; r++) {
      const [s, e] = l.rowRange(r);
      const last = l.itemBox(e - 1);
      assert.ok(Math.abs(last.x + last.w - 900) < 1e-6, `row ${r} should reach the right edge`);
      assert.ok(l.rowHeight(r) <= 200 + 1e-6);
      assert.ok(e > s);
    }
    const lastRow = l.rowCount - 1;
    assert.ok(l.rowHeight(lastRow) <= 200 + 1e-6, 'last row is never stretched');
    const covered = Array.from({ length: l.rowCount }, (_, r) => l.rowRange(r)).flatMap(([s, e]) => Array.from({ length: e - s }, (_, i) => s + i));
    assert.deepEqual(covered, aspects.map((_, i) => i));
  });

  test('unknown sizes use the fallback aspect and extreme aspects are clamped', () => {
    const l = justifiedLayout({ aspects: [NaN, 0, 0.05, 40], width: 2000, targetHeight: 100, gap: 0, captionH: 0 });
    assert.ok(Math.abs(l.itemBox(0).w - 400 / 3) < 1e-6);
    assert.ok(Math.abs(l.itemBox(2).w - 40) < 1e-6, 'aspect clamped to 0.4');
    assert.ok(Math.abs(l.itemBox(3).w - 300) < 1e-6, 'aspect clamped to 3');
  });

  test('rowAt / rowOf agree with row geometry', () => {
    const aspects = Array.from({ length: 200 }, (_, i) => 0.6 + (i % 7) * 0.3);
    const l = justifiedLayout({ aspects, width: 1200, targetHeight: 180, gap: 8, captionH: 30 });
    for (let r = 0; r < l.rowCount; r++) {
      assert.equal(l.rowAt(l.rowTop(r) + 1), r);
      const [s] = l.rowRange(r);
      assert.equal(l.rowOf(s), r);
    }
  });
});

describe('rowWindow', () => {
  test('only rows around the viewport are mounted, aligned to blocks', () => {
    const l = listLayout(1000, 800, 48);
    const w = rowWindow(l, 48 * 100, 480, 96, 4);
    assert.equal(w.first, 96);
    assert.equal(w.last, 116);
    assert.deepEqual(rowWindow(l, -5000, 480, 96), { first: 0, last: 0 });
    assert.deepEqual(rowWindow(listLayout(0, 800, 48), 0, 480, 96), { first: 0, last: 0 });
  });

  test('a layout starting below the viewport mounts its first rows once in range', () => {
    const l = listLayout(50, 800, 48);
    assert.deepEqual(rowWindow(l, -300, 480, 0, 4), { first: 0, last: 4 });
  });
});

describe('itemsInRect', () => {
  test('marquee hits across rows including unmounted ones', () => {
    const l = gridLayout({ count: 40, width: 1000, minCard: 180, gap: 10, mediaAspect: 1, captionH: 0 });
    const cardW = l.itemBox(0).w;
    const hits = itemsInRect(l, { x: cardW + 20, y: 5, w: cardW + 20, h: 3 * (cardW + 10) });
    assert.deepEqual(hits, [1, 2, 6, 7, 11, 12, 16, 17]);
    assert.deepEqual(itemsInRect(l, { x: 0, y: 0, w: 0, h: 10 }), []);
  });
});

describe('neighborIndex', () => {
  const l = gridLayout({ count: 12, width: 1000, minCard: 180, gap: 10, mediaAspect: 1, captionH: 0 });
  test('arrows move within the grid and stop at edges', () => {
    assert.equal(neighborIndex(l, 6, 'down'), 11);
    assert.equal(neighborIndex(l, 11, 'down'), 11);
    assert.equal(neighborIndex(l, 6, 'up'), 1);
    assert.equal(neighborIndex(l, 1, 'up'), 1);
    assert.equal(neighborIndex(l, 0, 'left'), 0);
    assert.equal(neighborIndex(l, 11, 'right'), 11);
    assert.equal(neighborIndex(l, 5, 'end'), 11);
    assert.equal(neighborIndex(l, -1, 'down'), 0);
  });

  test('down into a shorter last row picks the nearest column', () => {
    assert.equal(neighborIndex(l, 9, 'down'), 11);
  });

  test('page keys jump by viewport height', () => {
    const list = listLayout(100, 800, 50);
    assert.equal(neighborIndex(list, 10, 'pageDown', 500), 20);
    assert.equal(neighborIndex(list, 5, 'pageUp', 500), 0);
    assert.equal(neighborIndex(list, 95, 'pageDown', 500), 99);
  });
});

describe('itemRangeOfRows', () => {
  test('maps a row window to item indices', () => {
    const l = gridLayout({ count: 23, width: 1000, minCard: 180, gap: 10, mediaAspect: 1, captionH: 0 });
    assert.deepEqual(itemRangeOfRows(l, 1, 3), [5, 15]);
    assert.deepEqual(itemRangeOfRows(l, 4, 9), [20, 23]);
    assert.deepEqual(itemRangeOfRows(l, 2, 2), [0, 0]);
  });
});
