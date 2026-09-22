import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOBILE_MAX_OVERSCAN_ROWS,
  MOBILE_MAX_WINDOW_PAD_PX,
  MOBILE_OVERSCAN_MIN_ROWS,
  MOBILE_OVERSCAN_PX,
  overscanRowsFor,
  virtualRowWindow,
  virtualWindowKey,
  windowPadFor,
} from '../src/mobileVirtualWindow';

const LIST_STEP = 70; // 列表视图行高（LIST_ROW_STEP）
const GRID_STEP = 470; // 网格卡片行高近似值
const VIEWPORT_H = 3145;

test('overscan scales rows by step with a pixel budget and a grid minimum', () => {
  // 网格模式（大行高）维持原有 8 行缓冲不缩水。
  assert.equal(overscanRowsFor(GRID_STEP), MOBILE_OVERSCAN_MIN_ROWS);
  // 列表模式（70px 行高）缓冲换算后必须覆盖像素预算——旧实现固定 8 行只有
  // 560px，约等于极高速惯性滚动一帧的行程。
  const listRows = overscanRowsFor(LIST_STEP);
  assert.ok(listRows > MOBILE_OVERSCAN_MIN_ROWS);
  assert.ok(listRows * LIST_STEP >= MOBILE_OVERSCAN_PX);
  assert.equal(overscanRowsFor(0), MOBILE_OVERSCAN_MIN_ROWS);
  assert.equal(overscanRowsFor(NaN), MOBILE_OVERSCAN_MIN_ROWS);
});

test('window covers every visible row with overscan on both sides', () => {
  const itemCount = 655;
  const gs = 50 * LIST_STEP + 10;
  const win = virtualRowWindow(gs, VIEWPORT_H, LIST_STEP, 1, itemCount);
  assert.ok(win);
  assert.ok(win.first <= Math.floor(gs / LIST_STEP));
  assert.ok(win.last >= Math.ceil((gs + VIEWPORT_H) / LIST_STEP));
  assert.equal(win.first, Math.floor(gs / LIST_STEP) - overscanRowsFor(LIST_STEP));
});

test('window is never empty and clamps gs overshoot to the last row', () => {
  // sectionTops 度量滞后时 gs 可能越界；空窗口就是整屏空白。
  const win = virtualRowWindow(999999, VIEWPORT_H, LIST_STEP, 1, 655);
  assert.ok(win);
  assert.ok(win.first < win.last);
  assert.ok(win.last <= 655);
  assert.equal(win.first, 654);
  assert.equal(win.last, 655);
});

test('invalid geometry yields no window and an empty throttle key', () => {
  assert.equal(virtualRowWindow(0, VIEWPORT_H, 0, 1, 10), null);
  assert.equal(virtualRowWindow(0, VIEWPORT_H, NaN, 1, 10), null);
  assert.equal(virtualRowWindow(0, VIEWPORT_H, LIST_STEP, 0, 10), null);
  assert.equal(virtualRowWindow(0, VIEWPORT_H, LIST_STEP, 1, 0), null);
  assert.equal(virtualRowWindow(NaN, VIEWPORT_H, LIST_STEP, 1, 10), null);
  assert.equal(virtualWindowKey(0, 0, VIEWPORT_H, LIST_STEP, 1, 0), 'empty');
  // NaN 行高必须落 'empty'：旧代码 NaN <= 0 为 false，会吐出恒定的
  // "NaN:NaN" 键把 setScrollTop 永久卡死在过期窗口上。
  assert.equal(virtualWindowKey(0, 0, VIEWPORT_H, NaN, 1, 10), 'empty');
});

test('throttle key granularity is one list row (regression: was one grid card)', () => {
  // 键必须逐行变化。回归前键按网格卡几何计算，每 ~470px 才变化一次，
  // 冻结的挂载窗口跟不上快速滑动的视口 → 整屏空白。
  let prevKey = virtualWindowKey(0, 0, VIEWPORT_H, LIST_STEP, 1, 655);
  let lastChangeAt = 0;
  for (let st = LIST_STEP / 2; st <= 60 * LIST_STEP; st += LIST_STEP / 2) {
    const key = virtualWindowKey(st, 0, VIEWPORT_H, LIST_STEP, 1, 655);
    if (key !== prevKey) {
      const gap = st - lastChangeAt;
      assert.ok(gap <= LIST_STEP * 1.5, `key stale for ${gap}px at scrollTop=${st}`);
      lastChangeAt = st;
      prevKey = key;
    }
  }
});

test('key equality implies window equality', () => {
  const w1 = virtualRowWindow(3 * LIST_STEP, VIEWPORT_H, LIST_STEP, 1, 655);
  const k1 = virtualWindowKey(3 * LIST_STEP, 0, VIEWPORT_H, LIST_STEP, 1, 655);
  const w2 = virtualRowWindow(3 * LIST_STEP + 5, VIEWPORT_H, LIST_STEP, 1, 655);
  const k2 = virtualWindowKey(3 * LIST_STEP + 5, 0, VIEWPORT_H, LIST_STEP, 1, 655);
  assert.deepEqual(w1, w2);
  assert.equal(k1, k2);
});

test('window pad scales with scroll speed and clamps at the DOM budget', () => {
  assert.equal(windowPadFor(0), MOBILE_OVERSCAN_PX);
  assert.equal(windowPadFor(NaN), MOBILE_OVERSCAN_PX);
  assert.equal(windowPadFor(-50), windowPadFor(50)); // 只看速率不看方向
  // 速度叠加上来后缓冲按“速率 × 回看时窗”放大，才能跑赢单次渲染提交延迟。
  assert.ok(windowPadFor(50) > MOBILE_OVERSCAN_PX);
  assert.equal(windowPadFor(1e6), MOBILE_MAX_WINDOW_PAD_PX);
});

test('overscan rows respect both pixel budget and DOM row cap', () => {
  assert.equal(overscanRowsFor(LIST_STEP, MOBILE_MAX_WINDOW_PAD_PX), MOBILE_MAX_OVERSCAN_ROWS);
  const fastRows = overscanRowsFor(LIST_STEP, windowPadFor(50));
  assert.ok(fastRows > overscanRowsFor(LIST_STEP));
  assert.ok(fastRows <= MOBILE_MAX_OVERSCAN_ROWS);
});

test('speed pad widens the window on both sides', () => {
  // 取样点放列表中部：贴近顶部时 first 都被钳到 0，看不出差异。
  const gs = 200 * LIST_STEP;
  const base = virtualRowWindow(gs, VIEWPORT_H, LIST_STEP, 1, 655);
  const wide = virtualRowWindow(gs, VIEWPORT_H, LIST_STEP, 1, 655, MOBILE_MAX_WINDOW_PAD_PX);
  assert.ok(base && wide);
  assert.ok(wide.first < base.first);
  assert.ok(wide.last > base.last);
});
