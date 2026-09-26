/**
 * 桌面图片区 / 图包区的几何布局（纯函数，便于单测）。
 *
 * 三种布局统一抽象成「行」：
 * - 网格：等宽等高的卡片，列数由最小卡片宽度决定；
 * - 按原比例（justified）：每行按图片宽高比铺满容器宽度，行高围绕目标高度浮动；
 * - 列表：固定行高，每行一项。
 *
 * 虚拟化只挂载与视口相交的行；框选命中、方向键邻居和方向预取都基于这份几何，
 * 不读 DOM，因此未挂载的行也能被正确选中和导航。
 * 网格与列表按算术计算，不为每一项分配对象；按原比例使用定长类型数组，
 * 十万级图片也只占几 MB。
 */

export type GalleryLayoutMode = 'grid' | 'justified' | 'list';

export interface ItemBox {
  x: number;
  y: number;
  w: number;
  /** 媒体区高度（不含标题区）。 */
  h: number;
}

export interface GalleryLayout {
  readonly mode: GalleryLayoutMode;
  readonly count: number;
  readonly rowCount: number;
  /** 内容总高度（不含上下留白）。 */
  readonly height: number;
  /** 每项标题区高度（显示文件名时），列表模式为 0。 */
  readonly captionH: number;
  readonly gap: number;
  /** 网格模式的列数；其余模式为 0。 */
  readonly cols: number;
  rowTop(row: number): number;
  /** 行高（含标题区，不含行间距）。 */
  rowHeight(row: number): number;
  /** 行内项目区间 [start, end)。 */
  rowRange(row: number): [number, number];
  rowOf(index: number): number;
  itemBox(index: number): ItemBox;
  /** 第一个底边不在 y 之上的行（y 以内容顶部为 0）。 */
  rowAt(y: number): number;
}

export interface GridLayoutInput {
  count: number;
  width: number;
  minCard: number;
  gap: number;
  /** 媒体区高 / 宽。 */
  mediaAspect: number;
  captionH: number;
}

/** 等宽网格：列数 = 能放下的最小卡片数。 */
export function gridLayout(input: GridLayoutInput): GalleryLayout {
  const { count, gap, captionH } = input;
  const width = Math.max(1, input.width);
  const cols = Math.max(1, Math.floor((width + gap) / (Math.max(1, input.minCard) + gap)));
  const cardW = (width - gap * (cols - 1)) / cols;
  const mediaH = cardW * input.mediaAspect;
  const rowH = mediaH + captionH;
  const stride = rowH + gap;
  const rowCount = Math.ceil(count / cols);
  return {
    mode: 'grid',
    count,
    rowCount,
    height: rowCount > 0 ? rowCount * stride - gap : 0,
    captionH,
    gap,
    cols,
    rowTop: (row) => row * stride,
    rowHeight: () => rowH,
    rowRange: (row) => [row * cols, Math.min(count, (row + 1) * cols)],
    rowOf: (index) => Math.floor(index / cols),
    itemBox: (index) => ({
      x: (index % cols) * (cardW + gap),
      y: Math.floor(index / cols) * stride,
      w: cardW,
      h: mediaH,
    }),
    rowAt: (y) => clampRow(Math.floor(Math.max(0, y) / stride), rowCount),
  };
}

/** 列表：每项一行、固定行高。 */
export function listLayout(count: number, width: number, rowH: number): GalleryLayout {
  return {
    mode: 'list',
    count,
    rowCount: count,
    height: count * rowH,
    captionH: 0,
    gap: 0,
    cols: 0,
    rowTop: (row) => row * rowH,
    rowHeight: () => rowH,
    rowRange: (row) => [row, Math.min(count, row + 1)],
    rowOf: (index) => index,
    itemBox: (index) => ({ x: 0, y: index * rowH, w: Math.max(1, width), h: rowH }),
    rowAt: (y) => clampRow(Math.floor(Math.max(0, y) / rowH), count),
  };
}

export interface JustifiedLayoutInput {
  /** 每项宽高比（宽 / 高）；未知尺寸传 NaN 或 0，按 fallbackAspect 处理。 */
  aspects: ArrayLike<number>;
  width: number;
  targetHeight: number;
  gap: number;
  captionH: number;
  /** 宽高比夹取范围：极端长图 / 全景图不至于把一行挤成一条缝。 */
  minAspect?: number;
  maxAspect?: number;
  fallbackAspect?: number;
  /** 行高最多拉伸到目标高度的倍数；超过时该行不铺满（只剩一两张宽图的末行等）。 */
  maxStretch?: number;
}

/** 按原比例：贪心装行，每行缩放到恰好铺满容器宽度；末行不拉伸。 */
export function justifiedLayout(input: JustifiedLayoutInput): GalleryLayout {
  const count = input.aspects.length;
  const width = Math.max(1, input.width);
  const { gap, captionH } = input;
  const target = Math.max(1, input.targetHeight);
  const minA = input.minAspect ?? 0.4;
  const maxA = input.maxAspect ?? 3;
  const fallback = input.fallbackAspect ?? 4 / 3;
  const maxStretch = input.maxStretch ?? 1.5;

  const aspect = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = Number(input.aspects[i]);
    aspect[i] = Math.min(maxA, Math.max(minA, Number.isFinite(a) && a > 0 ? a : fallback));
  }

  const rowStarts: number[] = [];
  const rowMediaH: number[] = [];
  const xs = new Float64Array(count);
  const ws = new Float64Array(count);
  let start = 0;
  while (start < count) {
    let sum = 0;
    let end = start;
    // 至少放一张；放到按目标行高已超出容器宽度为止。
    while (end < count) {
      sum += aspect[end]!;
      end++;
      if (sum * target + gap * (end - start - 1) >= width) break;
    }
    const gaps = gap * (end - start - 1);
    let h = (width - gaps) / sum;
    const last = end >= count;
    if (last && h > target) h = target; // 末行不拉伸
    if (h > target * maxStretch) h = target * maxStretch;
    let x = 0;
    for (let i = start; i < end; i++) {
      const w = aspect[i]! * h;
      xs[i] = x;
      ws[i] = w;
      x += w + gap;
    }
    rowStarts.push(start);
    rowMediaH.push(h);
    start = end;
  }

  const rowCount = rowStarts.length;
  const tops = new Float64Array(rowCount + 1);
  const rowOfItem = new Int32Array(count);
  for (let r = 0; r < rowCount; r++) {
    tops[r + 1] = tops[r]! + rowMediaH[r]! + captionH + gap;
    const s = rowStarts[r]!;
    const e = r + 1 < rowCount ? rowStarts[r + 1]! : count;
    for (let i = s; i < e; i++) rowOfItem[i] = r;
  }
  const rowEnd = (r: number): number => (r + 1 < rowCount ? rowStarts[r + 1]! : count);

  return {
    mode: 'justified',
    count,
    rowCount,
    height: rowCount > 0 ? tops[rowCount]! - gap : 0,
    captionH,
    gap,
    cols: 0,
    rowTop: (row) => tops[row] ?? 0,
    rowHeight: (row) => (rowMediaH[row] ?? 0) + captionH,
    rowRange: (row) => [rowStarts[row] ?? count, rowEnd(row)],
    rowOf: (index) => rowOfItem[index] ?? 0,
    itemBox: (index) => {
      const r = rowOfItem[index] ?? 0;
      return { x: xs[index] ?? 0, y: tops[r] ?? 0, w: ws[index] ?? 0, h: rowMediaH[r] ?? 0 };
    },
    rowAt: (y) => {
      // 二分：第一个「行底 + 间距」超过 y 的行。
      let lo = 0;
      let hi = rowCount - 1;
      if (hi < 0) return 0;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid + 1]! <= y) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}

function clampRow(row: number, rowCount: number): number {
  return Math.max(0, Math.min(Math.max(0, rowCount - 1), row));
}

export interface RowWindow {
  first: number;
  last: number;
}

/**
 * 与视口相交的行区间 [first, last)，前后各留 overscanPx 缓冲，并按 block 行对齐，
 * 滚动时不必每跨一行就重渲。
 * localTop 为视口顶部相对布局内容顶部的偏移，可为负（布局尚在视口下方）。
 */
export function rowWindow(layout: GalleryLayout, localTop: number, viewportH: number, overscanPx: number, block = 4): RowWindow {
  if (layout.rowCount === 0) return { first: 0, last: 0 };
  const top = localTop - overscanPx;
  const bottom = localTop + viewportH + overscanPx;
  if (bottom < 0 || top > layout.height) return { first: 0, last: 0 };
  const first = Math.floor(layout.rowAt(top) / block) * block;
  const lastVisible = layout.rowAt(bottom) + 1;
  const last = Math.min(layout.rowCount, Math.ceil(lastVisible / block) * block);
  return { first, last };
}

/** 与矩形相交的项目索引（矩形坐标以布局内容顶部为原点；命中判断包含标题区）。 */
export function itemsInRect(layout: GalleryLayout, rect: { x: number; y: number; w: number; h: number }): number[] {
  const out: number[] = [];
  if (layout.count === 0 || rect.w <= 0 || rect.h <= 0) return out;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  for (let r = layout.rowAt(rect.y); r < layout.rowCount; r++) {
    const top = layout.rowTop(r);
    if (top > y1) break;
    if (top + layout.rowHeight(r) < rect.y) continue;
    const [s, e] = layout.rowRange(r);
    for (let i = s; i < e; i++) {
      const box = layout.itemBox(i);
      if (box.x < x1 && box.x + box.w > rect.x) out.push(i);
    }
  }
  return out;
}

export type NavKey = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown';

/** 方向键导航：左右按序号，上下取相邻行里水平中心最接近的一项；翻页按视口高度跳行。 */
export function neighborIndex(layout: GalleryLayout, index: number, key: NavKey, viewportH = 0): number {
  const n = layout.count;
  if (n === 0) return -1;
  if (index < 0 || index >= n) return 0;
  switch (key) {
    case 'left':
      return Math.max(0, index - 1);
    case 'right':
      return Math.min(n - 1, index + 1);
    case 'home':
      return 0;
    case 'end':
      return n - 1;
    default:
      break;
  }
  const box = layout.itemBox(index);
  const cx = box.x + box.w / 2;
  const row = layout.rowOf(index);
  let targetRow: number;
  if (key === 'up' || key === 'down') {
    targetRow = row + (key === 'down' ? 1 : -1);
  } else {
    const step = Math.max(viewportH, layout.rowHeight(row));
    const y = layout.rowTop(row) + (key === 'pageDown' ? step : -step);
    targetRow = layout.rowAt(Math.max(0, y));
  }
  if (targetRow < 0) return key === 'pageUp' ? 0 : index;
  if (targetRow >= layout.rowCount) return key === 'pageDown' ? n - 1 : index;
  const [s, e] = layout.rowRange(targetRow);
  let best = s;
  let bestDist = Infinity;
  for (let i = s; i < e; i++) {
    const b = layout.itemBox(i);
    const d = Math.abs(b.x + b.w / 2 - cx);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** 行区间对应的项目区间 [start, end)。 */
export function itemRangeOfRows(layout: GalleryLayout, first: number, last: number): [number, number] {
  if (layout.rowCount === 0 || last <= first) return [0, 0];
  const f = Math.max(0, Math.min(layout.rowCount - 1, first));
  const l = Math.max(f, Math.min(layout.rowCount - 1, last - 1));
  return [layout.rowRange(f)[0], layout.rowRange(l)[1]];
}
