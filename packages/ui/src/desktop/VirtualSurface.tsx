import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { recordScrollFrame } from '../fpsMonitor';
import { itemRangeOfRows, rowWindow, type GalleryLayout, type ItemBox, type RowWindow } from './galleryLayout';

export interface SurfaceWindow {
  /** 已挂载的项目区间 [first, last)。 */
  first: number;
  last: number;
  /** 最近一次滚动方向。 */
  direction: 'down' | 'up' | null;
  /** 视口里能放下的行数（方向预取按「下一屏」取行用）。 */
  screenRows: number;
  /** 行区间（含 overscan）。 */
  rows: RowWindow;
}

/**
 * 按行虚拟化的绝对定位表面：只挂载与视口（± overscan）相交的行。
 * 自己订阅滚动容器的滚动（rAF 节流），只有行窗口变化时才重渲本组件，
 * 父组件不随滚动重渲。surfaceRef 暴露给父组件做框选 / 键盘导航的坐标换算。
 */
export function VirtualSurface({
  layout,
  scrollRef,
  surfaceRef,
  renderItem,
  onWindowChange,
  overscanPx = 480,
  className,
  label,
}: {
  layout: GalleryLayout;
  scrollRef: RefObject<HTMLElement | null>;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  renderItem: (index: number, box: ItemBox, rowHeight: number) => ReactNode;
  onWindowChange?: (win: SurfaceWindow) => void;
  overscanPx?: number;
  className?: string;
  label?: string;
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onWindowChangeRef = useRef(onWindowChange);
  onWindowChangeRef.current = onWindowChange;
  const frameRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const [win, setWin] = useState<RowWindow>(() => ({ first: 0, last: Math.min(layout.rowCount, 12) }));
  const winRef = useRef(win);

  const compute = useCallback(() => {
    const scroller = scrollRef.current;
    const surface = localRef.current;
    if (!scroller || !surface) return;
    const t0 = performance.now();
    const current = layoutRef.current;
    const surfaceTop = surface.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    // surfaceTop 已包含滚动偏移：视口顶部相对表面顶部 = -surfaceTop。
    // 布局变矮（切到行高更小的布局、筛选后）时浏览器收回 scrollTop 的 scroll 事件要到
    // 下一帧才来；先把位置夹到内容范围内，避免这一两帧挂载 0 行、闪出空白。
    const localTop = Math.min(-surfaceTop, Math.max(0, current.height - scroller.clientHeight));
    const next = rowWindow(current, localTop, scroller.clientHeight, overscanPx);
    const st = scroller.scrollTop;
    const direction = st > lastScrollTopRef.current ? 'down' : st < lastScrollTopRef.current ? 'up' : null;
    lastScrollTopRef.current = st;
    const prev = winRef.current;
    if (prev.first !== next.first || prev.last !== next.last) {
      winRef.current = next;
      setWin(next);
      const [first, last] = itemRangeOfRows(current, next.first, next.last);
      const rowH = current.rowCount > 0 ? current.rowHeight(0) + current.gap : 1;
      onWindowChangeRef.current?.({
        first,
        last,
        direction,
        screenRows: Math.max(1, Math.ceil(scroller.clientHeight / Math.max(1, rowH))),
        rows: next,
      });
    }
    recordScrollFrame(performance.now() - t0);
  }, [overscanPx, scrollRef]);

  // 布局（列数 / 尺寸 / 数量）变化后同步重算窗口，避免先画一帧旧窗口。
  useLayoutEffect(() => {
    compute();
  }, [layout, compute]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        compute();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => compute());
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [compute, scrollRef]);

  const items: ReactNode[] = [];
  const first = Math.min(win.first, layout.rowCount);
  const last = Math.min(win.last, layout.rowCount);
  for (let r = first; r < last; r++) {
    const rowH = layout.rowHeight(r);
    const [s, e] = layout.rowRange(r);
    for (let i = s; i < e; i++) items.push(renderItem(i, layout.itemBox(i), rowH));
  }

  return (
    <div
      ref={(node) => {
        localRef.current = node;
        if (surfaceRef) (surfaceRef as { current: HTMLDivElement | null }).current = node;
      }}
      className={`dk-vsurface ${className ?? ''}`}
      style={{ position: 'relative', height: Math.max(1, layout.height) }}
      role={label ? 'grid' : undefined}
      aria-label={label}
      aria-rowcount={label ? layout.rowCount : undefined}
    >
      {items}
    </div>
  );
}
