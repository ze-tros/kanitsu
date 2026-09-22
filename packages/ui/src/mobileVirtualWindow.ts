import { OVERSCAN_ROWS } from './virtualWindow';

/**
 * 移动端虚拟窗口计算（VirtualGrid 与滚动节流键共用的单一数据源）。
 *
 * 此前 VirtualGrid 与 onMainScroll 的节流键各自复制了一份窗口公式，且键固定
 * 按网格卡尺寸计算——列表模式（70px 行高/单列）下键每 ~470px 才变化一次，
 * 冻结的挂载窗口跟不上快速滑动的视口，整屏露出空白（骨架和图片都没挂载）。
 * 共用同一份计算后，键变化 ⟺ 挂载窗口变化，按构造不可能再错位。
 */

/** 缓冲行数下限：保持网格模式原有 8 行缓冲不缩水。 */
export const MOBILE_OVERSCAN_MIN_ROWS = Math.max(OVERSCAN_ROWS, 8);
/**
 * 静态缓冲的像素预算：缓冲按像素换算行数而不是固定行数——列表行高仅 70px，
 * 固定 8 行只有 560px，约等于极高速惯性滚动一帧的行程，视口追上挂载窗口
 * 就露出整屏空白。2048px ≈ 数帧的行程余量，网格模式（大行高）仍取行数下限。
 */
export const MOBILE_OVERSCAN_PX = 2048;
/**
 * 速度补偿的回看时窗：连续快滑会把惯性速度叠加上去，单帧行程可达上千像素，
 * 而挂载窗口最多滞后一次渲染提交（挂载越多提交越慢，滞后越大）。缓冲按
 * 当前速度回看 120ms 的行程，才能跑赢“速度 × 提交延迟”这趟车。
 */
export const MOBILE_WINDOW_LOOKAHEAD_MS = 120;
/** 速度补偿缓冲上限：防极端速度下缓冲换算出巨量 DOM。 */
export const MOBILE_MAX_WINDOW_PAD_PX = 10240;
/** 缓冲行数上限：70px 列表行换算 10240px 是 147 行，DOM 成本必须封顶。 */
export const MOBILE_MAX_OVERSCAN_ROWS = 96;

export interface VirtualRowWindow {
  first: number;
  last: number;
}

/**
 * 由滚动速率（px/ms）得出窗口缓冲：静态预算与“速率 × 回看时窗”取大者，
 * 再封顶。两端窗口（上下缓冲）都用它，节流键与 VirtualGrid 必须传同一个值。
 */
export function windowPadFor(speedPxPerMs: number): number {
  const speed = Number.isFinite(speedPxPerMs) ? Math.abs(speedPxPerMs) : 0;
  const pad = speed * MOBILE_WINDOW_LOOKAHEAD_MS;
  return Math.min(MOBILE_MAX_WINDOW_PAD_PX, Math.max(MOBILE_OVERSCAN_PX, pad));
}

/** 行高 step、缓冲 padPx 下的缓冲行数：像素预算换算，行数下限与 DOM 上限夹紧。 */
export function overscanRowsFor(step: number, padPx: number = MOBILE_OVERSCAN_PX): number {
  if (!(step > 0)) return MOBILE_OVERSCAN_MIN_ROWS;
  const pad = Number.isFinite(padPx) ? Math.max(0, padPx) : MOBILE_OVERSCAN_PX;
  return Math.max(
    MOBILE_OVERSCAN_MIN_ROWS,
    Math.min(MOBILE_MAX_OVERSCAN_ROWS, Math.ceil(pad / step)),
  );
}

/**
 * 计算可视行窗口（含缓冲）。gs 为内容滚动到本节顶端之上的像素数。
 * 几何无效（NaN/0 行高、无条目等）返回 null；正常输入下窗口恒非空，
 * 且 gs 越界（sectionTops 度量滞后导致滚过头）时钳制到最后一行而不是空窗口。
 */
export function virtualRowWindow(
  gs: number,
  viewportH: number,
  step: number,
  cols: number,
  itemCount: number,
  padPx: number = MOBILE_OVERSCAN_PX,
): VirtualRowWindow | null {
  if (!(step > 0) || !(cols > 0) || !(itemCount > 0) || !Number.isFinite(gs)) return null;
  const totalRows = Math.ceil(itemCount / cols);
  const overscanRows = overscanRowsFor(step, padPx);
  const vh = Number.isFinite(viewportH) ? Math.max(0, viewportH) : 0;
  let first = Math.floor(gs / step) - overscanRows;
  if (first > totalRows - 1) first = totalRows - 1;
  if (first < 0) first = 0;
  let last = Math.ceil((gs + vh) / step) + overscanRows;
  if (last > totalRows) last = totalRows;
  if (last <= first) last = first + 1;
  return { first, last };
}

/**
 * 虚拟窗口节流键：onMainScroll 仅当该键变化时才 setScrollTop 触发渲染。
 * 入参必须与对应 VirtualGrid 实例同一套几何（列表模式传 LIST_ROW_STEP/1，
 * 网格模式传卡行高/列数），否则退化为按错误粒度更新的旧 bug。
 */
export function virtualWindowKey(
  scrollTop: number,
  sectionTop: number,
  viewportH: number,
  step: number,
  cols: number,
  itemCount: number,
  padPx: number = MOBILE_OVERSCAN_PX,
): string {
  if (!(step > 0) || !(viewportH > 0) || !(cols > 0) || itemCount <= 0) return 'empty';
  const gs = Math.max(0, scrollTop - sectionTop);
  const win = virtualRowWindow(gs, viewportH, step, cols, itemCount, padPx);
  return win ? `${win.first}:${win.last}` : 'empty';
}
