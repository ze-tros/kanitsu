import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImageEntry } from '../../../core/src/index';
import type { FileRef, LibraryStore } from '../../../fs-adapter/src/types';
import { getThumbnailBlob } from '../thumbnailCache';
import { prefetchOriginal } from '../LibraryBrowser';
import { acquireObjectUrl, releaseObjectUrl } from '../objectUrlPool';
import { formatBytes, prefersReducedMotion } from './mobileShared';
import { Z_VIEWER } from './zindex';

/**
 * 移动端全屏查看器。
 * 手势：单指左右滑切换（跟手）、单指下滑关闭、双指捏合缩放、双击 适应/放大、
 * 放大后单指平移、单击切换界面显隐。
 * 加载：缩略图占位 → 原图淡入（无黑屏），相邻 ±2 预取。
 */

const MAX_SCALE = 8; // DESIGN.md 8.3：放大上限 8x
const SWIPE_THRESHOLD = 64;
const SWIPE_VELOCITY = 0.35; // px/ms
const CLOSE_THRESHOLD = 110;
const TAP_MAX_DIST = 10;
const TAP_MAX_MS = 280;
const DOUBLE_TAP_MS = 300;
/** 查看器页面缓存上限：浏览过的每张图都保留 thumb/full URL，无上限会随翻阅
 *  数百张后内存膨胀（与桌面端 objectUrlPool LRU 对齐）。超限时淘汰最久未用的
 *  非当前/相邻页，并释放其缩略图 object URL。 */
const MAX_PAGES = 64;
// —— 底部胶片条虚拟化 ——
const FILM_ITEM_W = 56; // w-14
const FILM_GAP = 6; // gap-1.5
const FILM_ITEM_STEP = FILM_ITEM_W + FILM_GAP;
const FILM_WINDOW = 24; // 当前项 ±24 张（共 49 张）足够覆盖可视区

interface PageInfo {
  thumbUrl: string | null;
  fullUrl: string | null;
  fullReady: boolean;
  naturalW: number;
  naturalH: number;
}

function toFileRef(image: ImageEntry): FileRef {
  return {
    id: image.fileRefId ?? image.id,
    name: image.name,
    kind: 'file',
    mtime: image.mtime,
    size: image.size,
    width: image.width,
    height: image.height,
  };
}

/** 计算图片在视口中的基准显示尺寸（视图 scale=1 时）。
 *  普通图片：等比含入（contain），整幅可见；
 *  长图（比例比视口更瘦长，如漫画/长截图）：按宽度适配并纵向溢出，
 *  支持上滑/下滑平移查看顶部/底部。尺寸未加载完成时返回容器尺寸（不参与钳制）。 */
function displayDims(
  p: { naturalW: number; naturalH: number } | undefined,
  cw: number,
  ch: number,
): { iw: number; ih: number } {
  if (!p || !p.naturalW || !p.naturalH || !cw || !ch) return { iw: cw, ih: ch };
  const contain = Math.min(cw / p.naturalW, ch / p.naturalH, 1);
  let iw = p.naturalW * contain;
  let ih = p.naturalH * contain;
  if (p.naturalH / p.naturalW > ch / cw) {
    iw = cw;
    ih = p.naturalH * (cw / p.naturalW);
  }
  return { iw, ih };
}

export function MobileViewer({
  images,
  index,
  store,
  isBlurred,
  onClose,
  onNavigate,
  onShowActions,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  isBlurred: (image: ImageEntry) => boolean;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onShowActions: (image: ImageEntry) => void;
}) {
  const current = images[index];
  const containerRef = useRef<HTMLDivElement>(null);
  const [entering, setEntering] = useState(true);
  const [closing, setClosing] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [uiVisible, setUiVisible] = useState(true);
  const [rotation, setRotation] = useState(0); // 0/90/180/270
  const [showInfo, setShowInfo] = useState(false);

  // —— 页面图片缓存：imageId → PageInfo ——
  const [pages, setPages] = useState<ReadonlyMap<string, PageInfo>>(new Map());
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const objectUrlsRef = useRef(new Set<string>());
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const indexRef = useRef(index);
  indexRef.current = index;
  const initialImageIdRef = useRef(current?.id);
  const closeTimerRef = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    if (closing) return;
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 160);
  }, [closing, onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const patchPage = useCallback((id: string, patch: Partial<PageInfo>) => {
    setPages((prev) => {
      const old = prev.get(id);
      const next: PageInfo = {
        thumbUrl: old?.thumbUrl ?? null,
        fullUrl: old?.fullUrl ?? null,
        fullReady: old?.fullReady ?? false,
        naturalW: old?.naturalW ?? 0,
        naturalH: old?.naturalH ?? 0,
        ...patch,
      };
      const map = new Map(prev);
      map.set(id, next);
      // LRU 淘汰：超过 MAX_PAGES 时移除最久未用且非「当前 ±2」的条目，并释放
      // 其缩略图 object URL，防止翻阅几百张后内存无限膨胀（原 Map 无上限）。
      if (map.size > MAX_PAGES) {
        const keep = new Set<string>();
        const idx = indexRef.current;
        for (let d = -2; d <= 2; d++) {
          const img = imagesRef.current[idx + d];
          if (img) keep.add(img.id);
        }
        for (const [k, v] of map) {
          if (map.size <= MAX_PAGES) break;
          if (keep.has(k)) continue;
          if (v.thumbUrl && objectUrlsRef.current.has(v.thumbUrl)) {
            objectUrlsRef.current.delete(v.thumbUrl);
            releaseObjectUrl(v.thumbUrl);
          }
          map.delete(k);
        }
      }
      return map;
    });
  }, []);

  // 加载某张图：缩略图立即占位，原图随后。
  const ensurePage = useCallback(
    (image: ImageEntry) => {
      const existing = pagesRef.current.get(image.id);
      if (existing?.thumbUrl) return;
      patchPage(image.id, {
        naturalW: image.width ?? 0,
        naturalH: image.height ?? 0,
      });
      let cancelled = false;
      getThumbnailBlob(store, toFileRef(image), 512)
        .then((blob) => {
          if (cancelled) return;
          const url = acquireObjectUrl(blob);
          objectUrlsRef.current.add(url);
          patchPage(image.id, { thumbUrl: url });
        })
        .catch(() => undefined);
      void store
        .getViewerUrl(toFileRef(image))
        .then((url) => {
          if (cancelled) return;
          patchPage(image.id, { fullUrl: url });
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    },
    [store, patchPage],
  );

  // 当前 + 相邻页加载；相邻 ±2 原图预解码进 LRU 池。
  useEffect(() => {
    const cancels: Array<(() => void) | undefined> = [];
    for (let d = -1; d <= 1; d++) {
      const img = images[index + d];
      if (img) cancels.push(ensurePage(img));
    }
    return () => cancels.forEach((c) => c?.());
  }, [index, images, ensurePage]);

  useEffect(() => {
    if (!images.length) return;
    let cancelled = false;
    const tasks: Array<() => void> = [];
    for (const d of [2, -2]) {
      const img = images[index + d];
      if (!img) continue;
      tasks.push(() => {
        if (cancelled) return;
        void store
          .getViewerUrl(toFileRef(img))
          .then((url) => prefetchOriginal(url, img.width, img.height))
          .catch(() => undefined);
      });
    }
    const run = () => {
      if (cancelled || tasks.length === 0) return;
      tasks.shift()?.();
      window.setTimeout(run, 60);
    };
    const idle = window.setTimeout(run, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(idle);
    };
  }, [index, images, store]);

  // 卸载释放全部 objectURL 与 viewer URL
  useEffect(() => {
    const urls = objectUrlsRef.current;
    const pageMap = pagesRef.current;
    return () => {
      urls.forEach((url) => releaseObjectUrl(url));
      urls.clear();
      pageMap.forEach((p) => {
        if (p.fullUrl) store.releaseViewerUrl(p.fullUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // 容器尺寸
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // —— 变换状态（直接写 DOM，避免手势高频 setState）——
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const [, forceRender] = useState(0);

  const fitScale = useMemo(() => {
    const p = current ? pages.get(current.id) : undefined;
    if (!p || !p.naturalW || !p.naturalH || !containerSize.w || !containerSize.h) return 1;
    return Math.max(0.05, Math.min(1, Math.min(containerSize.w / p.naturalW, containerSize.h / p.naturalH)));
  }, [pages, current, containerSize]);

  const applyTransform = useCallback(() => {
    const el = imgElRef.current;
    if (!el) return;
    const { scale, tx, ty } = viewRef.current;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)`;
  }, [rotation]);

  const resetTransform = useCallback(() => {
    viewRef.current = { scale: 1, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform]);

  // 切图时重置缩放
  const prevIndexRef = useRef(index);
  useEffect(() => {
    if (prevIndexRef.current !== index) {
      prevIndexRef.current = index;
      resetTransform();
      setRotation(0);
      setShowInfo(false);
      // 切图后强制回到静止态：清掉可能残留的滑动偏移/动画状态，
      // 保证新图始终从正中显示（否则会出现“偏左 + 右侧露出下一张”）。
      setDragX(0);
      setAnimating(false);
      forceRender((n) => n + 1);
    }
  }, [index, resetTransform]);

  // —— 滑页偏移（翻页手势跟手 + 回弹动画）——
  const [dragX, setDragX] = useState(0); // 手势中跟手偏移
  const [animating, setAnimating] = useState(false);

  // 静止态自愈：非动画状态强制 dragX 归零，避免任何路径残留导致当前页偏移
  //（表现为图片偏左、右侧露出下一张）。
  useEffect(() => {
    if (!animating && dragX !== 0) setDragX(0);
  }, [animating, dragX]);


  const clampPan = useCallback(
    (scale: number, tx: number, ty: number) => {
      const p = current ? pagesRef.current.get(current.id) : undefined;
      // 尺寸未加载完成前不钳制：否则拖动手感会被错误地限制在容器内。
      if (!p || !p.naturalW || !p.naturalH) return { tx, ty };
      const { iw, ih } = displayDims(p, containerSize.w, containerSize.h);
      const w = iw * scale;
      const h = ih * scale;
      const maxX = Math.max(0, (w - containerSize.w) / 2);
      const maxY = Math.max(0, (h - containerSize.h) / 2);
      return { tx: Math.max(-maxX, Math.min(maxX, tx)), ty: Math.max(-maxY, Math.min(maxY, ty)) };
    },
    [current, containerSize],
  );

  // —— 手势状态机 ——
  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    mode: 'none' | 'decide' | 'swipe' | 'close' | 'pan' | 'pinch';
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    downTime: number;
    pinchStartDist: number;
    pinchStartScale: number;
    pinchStartTx: number;
    pinchStartTy: number;
    pinchMidX: number;
    pinchMidY: number;
    swipeStart: number;
    lastTapTime: number;
  }>({
    pointers: new Map(),
    mode: 'none',
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    downTime: 0,
    pinchStartDist: 0,
    pinchStartScale: 1,
    pinchStartTx: 0,
    pinchStartTy: 0,
    pinchMidX: 0,
    pinchMidY: 0,
    swipeStart: 0,
    lastTapTime: 0,
  });

  const zoomTo = useCallback(
    (nextScale: number, focalX: number, focalY: number) => {
      const v = viewRef.current;
      const min = 1;
      const scale = Math.max(min * 0.9, Math.min(MAX_SCALE, nextScale));
      // 焦点处的图片坐标保持不变
      const cx = containerSize.w / 2;
      const cy = containerSize.h / 2;
      const px = focalX - cx;
      const py = focalY - cy;
      const ratio = scale / v.scale;
      let tx = px - (px - v.tx) * ratio;
      let ty = py - (py - v.ty) * ratio;
      const clamped = clampPan(scale, tx, ty);
      viewRef.current = { scale, tx: clamped.tx, ty: clamped.ty };
      applyTransform();
    },
    [containerSize, clampPan, applyTransform],
  );

  const navigateWithAnimation = useCallback(
    (dir: 1 | -1, fromOffset: number) => {
      const target = images[index + dir];
      if (!target || !containerSize.w) {
        // 边界：回弹
        if (prefersReducedMotion()) {
          setAnimating(false);
          setDragX(0);
          return;
        }
        setAnimating(true);
        setDragX(0);
        window.setTimeout(() => setAnimating(false), 260);
        return;
      }
      // 「减少动态效果」：跳过滑动动画，直接切图。
      if (prefersReducedMotion()) {
        onNavigate(target.id);
        setAnimating(false);
        setDragX(0);
        resetTransform();
        return;
      }
      setAnimating(true);
      setDragX(dir === 1 ? -containerSize.w : containerSize.w);
      // 用 transitionend 驱动切图，慢设备上动画真正结束后才切换，避免闪烁；
      // transition 在子页面元素上，需用 capture 监听容器并只校验 propertyName；
      // 事件丢失时由兜底定时器（动画 240ms + 余量）兜底，防止卡死。
      const el = containerRef.current;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el?.removeEventListener('transitionend', onEnd, true);
        window.clearTimeout(timer);
        onNavigate(target.id);
        setAnimating(false);
        setDragX(0);
        resetTransform();
      };
      const onEnd = (ev: TransitionEvent) => {
        if (ev.propertyName !== 'transform') return;
        finish();
      };
      const timer = window.setTimeout(finish, 300);
      el?.addEventListener('transitionend', onEnd, true);
      void fromOffset;
    },
    [images, index, containerSize.w, onNavigate, resetTransform],
  );

  const handleTap = useCallback(() => {
    const g = gestureRef.current;
    const now = performance.now();
    if (now - g.lastTapTime < DOUBLE_TAP_MS) {
      // 双击：100%（自然像素）↔ 适应窗口（DESIGN.md 8.3）
      g.lastTapTime = 0;
      const v = viewRef.current;
      if (v.scale > 1.05) {
        viewRef.current = { scale: 1, tx: 0, ty: 0 };
        applyTransform();
      } else {
        const mid = { x: g.startX, y: g.startY };
        zoomTo(Math.min(MAX_SCALE, 1 / fitScale), mid.x, mid.y);
      }
      return;
    }
    g.lastTapTime = now;
    // 延迟执行单击（等待可能的双击）
    window.setTimeout(() => {
      if (gestureRef.current.lastTapTime === now) {
        setUiVisible((v) => !v);
      }
    }, DOUBLE_TAP_MS);
  }, [applyTransform, zoomTo, fitScale]);

  const onPointerDown = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1) {
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      g.downTime = performance.now();
      g.swipeStart = performance.now();
      g.mode = 'decide';
    } else if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.mode = 'pinch';
      g.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      g.pinchStartScale = viewRef.current.scale;
      g.pinchStartTx = viewRef.current.tx;
      g.pinchStartTy = viewRef.current.ty;
      const rect = containerRef.current?.getBoundingClientRect();
      g.pinchMidX = (a.x + b.x) / 2 - (rect?.left ?? 0);
      g.pinchMidY = (a.y + b.y) / 2 - (rect?.top ?? 0);
      setDragX(0);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g.mode === 'pinch' && g.pointers.size >= 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinchStartDist > 0) {
        const scale = Math.max(0.9, Math.min(MAX_SCALE, g.pinchStartScale * (dist / g.pinchStartDist)));
        const cx = containerSize.w / 2;
        const cy = containerSize.h / 2;
        const px = g.pinchMidX - cx;
        const py = g.pinchMidY - cy;
        const ratio = scale / g.pinchStartScale;
        const tx = px - (px - g.pinchStartTx) * ratio;
        const ty = py - (py - g.pinchStartTy) * ratio;
        const clamped = clampPan(scale, tx, ty);
        viewRef.current = { scale, tx: clamped.tx, ty: clamped.ty };
        applyTransform();
      }
      return;
    }

    if (g.pointers.size !== 1) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const v = viewRef.current;

    if (g.mode === 'decide') {
      if (Math.hypot(dx, dy) < TAP_MAX_DIST) return;
      if (v.scale > 1.02) {
        g.mode = 'pan';
      } else {
        const p = current ? pagesRef.current.get(current.id) : undefined;
        const tall = !!(p && p.naturalW && p.naturalH && p.naturalH / p.naturalW > containerSize.h / containerSize.w);
        if (Math.abs(dx) >= Math.abs(dy)) {
          g.mode = 'swipe';
        } else if (dy > 0) {
          g.mode = tall ? 'pan' : 'close'; // 长图下拉=平移；普通图下拉=关闭
        } else {
          g.mode = tall ? 'pan' : 'none'; // 上滑：长图平移；普通图不响应（不误翻页）
        }
      }
    }

    if (g.mode === 'pan') {
      const nx = v.tx + (e.clientX - g.lastX);
      const ny = v.ty + (e.clientY - g.lastY);
      const clamped = clampPan(v.scale, nx, ny);
      viewRef.current = { ...v, tx: clamped.tx, ty: clamped.ty };
      applyTransform();
    } else if (g.mode === 'swipe') {
      setDragX(dx);
    } else if (g.mode === 'close') {
      // 下滑：图片跟随下移，背景渐隐
      const ty = Math.max(0, dy);
      setDragX(0);
      viewRef.current = { scale: 1, tx: 0, ty };
      const el = imgElRef.current;
      if (el) el.style.transform = `translateY(${ty}px) scale(${Math.max(0.85, 1 - ty / 1600)})`;
      const mask = containerRef.current?.parentElement;
      if (mask) (mask as HTMLElement).style.background = `rgba(0,0,0,${Math.max(0.35, 1 - ty / 500)})`;
    }
    g.lastX = e.clientX;
    g.lastY = e.clientY;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    const wasMode = g.mode;
    g.pointers.delete(e.pointerId);

    if (wasMode === 'pinch') {
      if (g.pointers.size === 1) {
        // 剩余一指：转 pan/等待
        const [p] = [...g.pointers.values()];
        g.startX = p.x;
        g.startY = p.y;
        g.lastX = p.x;
        g.lastY = p.y;
        g.mode = viewRef.current.scale > 1.02 ? 'pan' : 'decide';
      } else if (g.pointers.size === 0) {
        // 捏合结束：若缩放小于 1 回弹到适应
        const v = viewRef.current;
        if (v.scale < 1) {
          viewRef.current = { scale: 1, tx: 0, ty: 0 };
          applyTransform();
        }
        g.mode = 'none';
      }
      return;
    }

    if (g.pointers.size > 0) return;
    g.mode = 'none';

    if (wasMode === 'swipe') {
      const dx = e.clientX - g.startX;
      const dt = Math.max(1, performance.now() - g.swipeStart);
      const vx = dx / dt;
      setAnimating(true);
      if (Math.abs(dx) > SWIPE_THRESHOLD || Math.abs(vx) > SWIPE_VELOCITY) {
        const dir = dx < 0 ? 1 : -1;
        navigateWithAnimation(dir, dx);
      } else {
        setDragX(0);
        window.setTimeout(() => setAnimating(false), 260);
      }
      return;
    }

    if (wasMode === 'close') {
      const dy = Math.max(0, e.clientY - g.startY);
      const dt = Math.max(1, performance.now() - g.swipeStart);
      const vy = dy / dt;
      const mask = containerRef.current?.parentElement;
      if (dy > CLOSE_THRESHOLD || vy > 0.5) {
        requestClose();
      } else {
        // 回弹
        if (mask) (mask as HTMLElement).style.background = '';
        resetTransform();
      }
      return;
    }

    // tap 判定
    const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    const dt = performance.now() - g.downTime;
    if (wasMode === 'decide' && dist < TAP_MAX_DIST && dt < TAP_MAX_MS) {
      handleTap();
    }
  };

  if (!current) return null;
  const currentPage = pages.get(current.id);

  // 静止时只挂载当前图片，确保新会话的首帧不包含旧页或相邻页。
  // 开始滑动后才临时挂载相邻页，保留跟手翻页效果。
  const pageIndexes = [index];
  if (dragX !== 0 || animating) {
    if (index > 0) pageIndexes.unshift(index - 1);
    if (index + 1 < images.length) pageIndexes.push(index + 1);
  }

  return (
    <div
      className={`fixed inset-0 bg-black flex flex-col select-none ${closing ? 'm-viewer-exit' : ''}`}
      style={{ touchAction: 'none', zIndex: Z_VIEWER }}
    >
      {/* 手势层 + 图片页 */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {pageIndexes.map((i) => {
          const img = images[i];
          const p = pages.get(img.id);
          const offsetPages = i - index;
          // Percentage translation is available on the first paint, before ResizeObserver
          // reports the container width. Using the measured width here briefly stacked the
          // current and adjacent pages at x=0 when opening the viewer.
          const x = `calc(${offsetPages * 100}% + ${dragX}px)`;
          const isCurrent = i === index;
          const d = displayDims(p, containerSize.w, containerSize.h);
          return (
            <div
              key={img.id}
              className="absolute inset-0"
              style={{
                transform: `translateX(${x})`,
                transition: animating ? 'transform 240ms cubic-bezier(0.25, 0.8, 0.3, 1)' : 'none',
                visibility: Math.abs(offsetPages) > 1 ? 'hidden' : 'visible',
              }}
            >
              <div
                className={`absolute inset-0 ${
                  isCurrent && entering && img.id === initialImageIdRef.current && (p?.thumbUrl || p?.fullReady)
                    ? 'm-viewer-media-enter'
                    : ''
                }`}
                onAnimationEnd={() => {
                  if (isCurrent && img.id === initialImageIdRef.current) setEntering(false);
                }}
              >
                {/* Both image layers have identical geometry and never participate in page layout. */}
                {p?.thumbUrl && (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{
                      // Keep the thumbnail fully opaque until the original has
                      // finished fading in. Fading both layers exposes the black
                      // background at mid-transition and creates a dark flash.
                      visibility: p.fullReady ? 'hidden' : 'visible',
                      transition: animating || !p.fullReady ? 'none' : 'visibility 0ms linear 140ms',
                    }}
                  >
                    <img
                      src={p.thumbUrl}
                      alt=""
                      draggable={false}
                      className={`object-contain ${isBlurred(img) ? 'blur-preview' : ''}`}
                      style={{ pointerEvents: 'none', width: d.iw, height: d.ih }}
                    />
                  </div>
                )}
                {p?.fullUrl && (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{
                      opacity: p.fullReady ? 1 : 0,
                      transition: animating ? 'none' : 'opacity 140ms ease-out',
                    }}
                  >
                    <img
                      ref={isCurrent ? imgElRef : undefined}
                      src={p.fullUrl}
                      alt={img.name}
                      draggable={false}
                      decoding="async"
                      className={`object-contain ${isBlurred(img) ? 'blur-preview' : ''}`}
                      style={{
                        pointerEvents: 'none',
                        width: d.iw,
                        height: d.ih,
                        willChange: isCurrent ? 'transform' : undefined,
                      }}
                      onLoad={(e) => {
                        const el = e.currentTarget;
                        patchPage(img.id, { fullReady: true, naturalW: el.naturalWidth, naturalH: el.naturalHeight });
                      }}
                    />
                  </div>
                )}
                {!p?.thumbUrl && !p?.fullReady && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="loading loading-spinner loading-lg text-white/60" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 顶部栏 */}
      <div
        className={`absolute top-0 left-0 right-0 z-10 transition-opacity duration-200 ${
          uiVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.55), transparent)',
        }}
      >
        <div className="flex items-center gap-1 px-1 py-2">
          <button className="w-11 h-11 flex items-center justify-center text-white active:opacity-60" onClick={requestClose} aria-label="返回">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="flex-1 min-w-0 text-white">
            <div className="text-[15px] font-medium truncate">{current.name}</div>
            <div className="text-xs opacity-70 tabular-nums">
              {index + 1} / {images.length}
              {currentPage?.naturalW ? ` · ${currentPage.naturalW}×${currentPage.naturalH}` : ''}
            </div>
          </div>
          <button
            className="w-11 h-11 flex items-center justify-center text-white active:opacity-60"
            onClick={() => {
              const next = (rotation + 90) % 360;
              setRotation(next);
              const el = imgElRef.current;
              if (el) {
                const v = viewRef.current;
                el.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale}) rotate(${next}deg)`;
              }
            }}
            aria-label="旋转"
          >
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            className="w-11 h-11 flex items-center justify-center text-white active:opacity-60"
            onClick={() => setShowInfo((v) => !v)}
            aria-label="图片信息"
          >
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-5" />
              <path d="M12 8h.01" />
            </svg>
          </button>
          <button
            className="w-11 h-11 flex items-center justify-center text-white active:opacity-60"
            onClick={() => onShowActions(current)}
            aria-label="更多操作"
          >
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor">
              <circle cx="12" cy="5" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="12" cy="19" r="1.8" />
            </svg>
          </button>
        </div>
      </div>

      {/* 图片信息面板 */}
      {showInfo && current && (
        <div
          className="absolute left-3 right-3 z-20 bg-black/85 backdrop-blur text-white rounded-xl p-4"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 72px)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm font-semibold truncate">{current.name}</div>
            <button className="shrink-0 text-white/70 active:opacity-60" onClick={() => setShowInfo(false)} aria-label="关闭信息">
              ✕
            </button>
          </div>
          <div className="mt-2 text-xs space-y-1.5">
            <InfoRow
              label="尺寸"
              value={
                currentPage?.naturalW
                  ? `${currentPage.naturalW}×${currentPage.naturalH}`
                  : current.width && current.height
                    ? `${current.width}×${current.height}`
                    : '—'
              }
            />
            <InfoRow label="大小" value={current.size ? formatBytes(current.size) : '—'} />
            <InfoRow label="修改时间" value={current.mtime ? new Date(current.mtime).toLocaleString('zh-CN', { hour12: false }) : '—'} />
            <InfoRow label="路径" value={current.relPath} />
          </div>
        </div>
      )}

      {/* 底部胶片条 */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-10 transition-opacity duration-200 ${
          uiVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)',
          background: 'linear-gradient(to top, rgba(0,0,0,0.55), transparent)',
        }}
      >
        <Filmstrip images={images} index={index} store={store} onSelect={(img) => onNavigate(img.id)} />
      </div>
    </div>
  );
}

function Filmstrip({
  images,
  index,
  store,
  onSelect,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onSelect: (image: ImageEntry) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const positionedRef = useRef(false);

  // 虚拟化：只渲染当前项 ±FILM_WINDOW 张。几千张图不再全量挂载 FilmThumb
  // （每张都发一次缩略图请求，全量渲染会直接 OOM）。两侧用 padding 撑出总宽度，
  // 滚动条位置与 scrollTo 居中逻辑保持不变（offsetLeft 不受 padding 影响）。
  const start = Math.max(0, index - FILM_WINDOW);
  const end = Math.min(images.length, index + FILM_WINDOW + 1);

  // 当前项滚动到可视区中间
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.children[index - start] as HTMLElement | undefined;
    if (!active) return;
    const target = active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2;
    strip.scrollTo({
      left: target,
      behavior: !positionedRef.current || prefersReducedMotion() ? 'auto' : 'smooth',
    });
    positionedRef.current = true;
  }, [index, start]);

  return (
    <div
      ref={stripRef}
      className="flex gap-1.5 pt-2 overflow-x-auto m-filmstrip"
      style={{
        paddingLeft: start * FILM_ITEM_STEP + 12, // 12 = 原 px-3
        paddingRight: (images.length - end) * FILM_ITEM_STEP + 12,
      }}
    >
      {images.slice(start, end).map((img, k) => {
        const i = start + k;
        return (
          <button
            key={img.id}
            className={`shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors ${
              i === index ? 'border-white' : 'border-transparent opacity-60'
            }`}
            onClick={() => onSelect(img)}
          >
            <FilmThumb store={store} image={img} />
          </button>
        );
      })}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 opacity-60 w-14">{label}</span>
      <span className="flex-1 break-all">{value}</span>
    </div>
  );
}

function FilmThumb({ store, image }: { store: LibraryStore; image: ImageEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objUrl: string | null = null;
    getThumbnailBlob(store, toFileRef(image), 128)
      .then((blob) => {
        if (cancelled) return;
        objUrl = acquireObjectUrl(blob);
        setUrl(objUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objUrl) releaseObjectUrl(objUrl);
    };
  }, [store, image]);
  if (!url) return <div className="w-full h-full bg-white/10" />;
  return <img src={url} alt="" className="w-full h-full object-cover" draggable={false} />;
}
