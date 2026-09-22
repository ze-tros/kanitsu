import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
const DOUBLE_TAP_SCALE_FACTOR = 0.85;
const DOUBLE_TAP_MAX_SCALE = 3;
const PINCH_TRANSITION_MS = 45;
const FULL_FADE_MS = 140;
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

interface ImageTransform {
  scale: number;
  tx: number;
  ty: number;
}

interface TransformAnimation {
  frame: number;
  timer: number | null;
  cancelled: boolean;
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
  onClose,
  onNavigate,
  onShowActions,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onShowActions: (image: ImageEntry) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(index);
  const current = images[activeIndex];
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
  const mountedRef = useRef(true);
  const loadingThumbsRef = useRef(new Set<string>());
  const loadingFullRef = useRef(new Set<string>());
  const decodingFullRef = useRef(new Set<string>());
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const indexRef = useRef(activeIndex);
  indexRef.current = activeIndex;
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
          // 淘汰页的原图 URL 必须归还：条目离开 Map 后卸载清理扫不到它，不释放
          // 就是每个淘汰页泄漏一个受控句柄（翻阅 64 张以上逐张累积）。
          if (v.fullUrl) store.releaseViewerUrl(v.fullUrl);
          map.delete(k);
        }
      }
      return map;
    });
  }, [store]);

  // 加载某张图：缩略图立即占位，原图随后。
  const ensurePage = useCallback(
    (image: ImageEntry) => {
      const existing = pagesRef.current.get(image.id);
      if (existing?.fullReady && existing.fullUrl) return;
      if (!existing) {
        patchPage(image.id, {
          naturalW: image.width ?? 0,
          naturalH: image.height ?? 0,
        });
      }
      if (!existing?.thumbUrl && !loadingThumbsRef.current.has(image.id)) {
        loadingThumbsRef.current.add(image.id);
        getThumbnailBlob(store, toFileRef(image), 512, { shouldCancel: () => !mountedRef.current })
          .then((blob) => {
            if (!mountedRef.current) return;
            // 原图已经加载完成时，缩略图请求可能刚好才返回；此时不再
            // 创建一个永远不会展示的 object URL。
            if (pagesRef.current.get(image.id)?.fullReady) return;
            const url = acquireObjectUrl(blob);
            objectUrlsRef.current.add(url);
            patchPage(image.id, { thumbUrl: url });
          })
          .catch(() => undefined)
          .finally(() => loadingThumbsRef.current.delete(image.id));
      }
      if (!existing?.fullUrl && !loadingFullRef.current.has(image.id)) {
        loadingFullRef.current.add(image.id);
        void store
          .getViewerUrl(toFileRef(image))
          .then((url) => {
            if (!mountedRef.current) {
              store.releaseViewerUrl(url);
              return;
            }
            patchPage(image.id, { fullUrl: url });
          })
          .catch(() => undefined)
          .finally(() => loadingFullRef.current.delete(image.id));
      }
    },
    [store, patchPage],
  );

  // 当前与前后两页持续加载。请求不随 activeIndex 变化取消：快速连续翻页时，
  // 刚成为当前页的图片必须沿用之前已经开始的缩略图/原图请求。
  useEffect(() => {
    for (let d = -2; d <= 2; d++) {
      const img = images[activeIndex + d];
      if (img) ensurePage(img);
    }
  }, [activeIndex, images, ensurePage]);

  useEffect(() => {
    if (!images.length) return;
    let cancelled = false;
    const tasks: Array<() => void> = [];
    for (const d of [2, -2]) {
      const img = images[activeIndex + d];
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
  }, [activeIndex, images, store]);

  // 卸载释放全部 objectURL 与 viewer URL
  useEffect(() => {
    mountedRef.current = true;
    const urls = objectUrlsRef.current;
    const pageMap = pagesRef.current;
    return () => {
      mountedRef.current = false;
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
  const thumbElRef = useRef<HTMLImageElement | null>(null);
  const zoomAnimationRef = useRef<TransformAnimation | null>(null);
  const [, forceRender] = useState(0);

  const fitScale = useMemo(() => {
    const p = current ? pages.get(current.id) : undefined;
    if (!p || !p.naturalW || !p.naturalH || !containerSize.w || !containerSize.h) return 1;
    return Math.max(0.05, Math.min(1, Math.min(containerSize.w / p.naturalW, containerSize.h / p.naturalH)));
  }, [pages, current, containerSize]);

  const applyTransform = useCallback(() => {
    const { scale, tx, ty } = viewRef.current;
    const transform = `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)`;
    const image = imgElRef.current;
    const thumb = thumbElRef.current;
    if (image) image.style.transform = transform;
    if (thumb) thumb.style.transform = transform;
  }, [rotation]);

  useEffect(() => {
    // 旋转状态更新后，原图和缩略图必须在同一帧使用相同变换，避免
    // 原图旋转时露出下方仍保持原方向的缩略图。
    applyTransform();
  }, [applyTransform, rotation]);

  const setTransformTransition = useCallback((transition: string) => {
    const image = imgElRef.current;
    const thumb = thumbElRef.current;
    if (image) image.style.transition = transition;
    if (thumb) thumb.style.transition = transition;
  }, []);

  const readCurrentTransform = useCallback((): ImageTransform => {
    const el = imgElRef.current ?? thumbElRef.current;
    if (!el) return { ...viewRef.current };
    const value = window.getComputedStyle(el).transform;
    if (value === 'none') return { ...viewRef.current };
    const values = value.startsWith('matrix3d(')
      ? value.slice(9, -1).split(',').map(Number)
      : value.slice(7, -1).split(',').map(Number);
    if (values.some((number) => !Number.isFinite(number))) return { ...viewRef.current };
    if (value.startsWith('matrix3d(') && values.length >= 16) {
      return { scale: Math.hypot(values[0]!, values[1]!), tx: values[12]!, ty: values[13]! };
    }
    if (values.length >= 6) {
      return { scale: Math.hypot(values[0]!, values[1]!), tx: values[4]!, ty: values[5]! };
    }
    return { ...viewRef.current };
  }, []);

  const cancelZoomAnimation = useCallback(() => {
    const animation = zoomAnimationRef.current;
    if (!animation) return;
    animation.cancelled = true;
    window.cancelAnimationFrame(animation.frame);
    if (animation.timer != null) window.clearTimeout(animation.timer);
    viewRef.current = readCurrentTransform();
    setTransformTransition('none');
    applyTransform();
    zoomAnimationRef.current = null;
  }, [applyTransform, readCurrentTransform, setTransformTransition]);

  const animateTransformTo = useCallback(
    (target: ImageTransform, duration = 260) => {
      cancelZoomAnimation();
      if (prefersReducedMotion()) {
        viewRef.current = target;
        applyTransform();
        return;
      }
      const animation: TransformAnimation = { frame: 0, timer: null, cancelled: false };
      zoomAnimationRef.current = animation;
      setTransformTransition(`transform ${duration}ms cubic-bezier(0.22, 0.8, 0.36, 1)`);
      applyTransform();
      animation.frame = window.requestAnimationFrame(() => {
        if (animation.cancelled || zoomAnimationRef.current !== animation) return;
        viewRef.current = target;
        applyTransform();
        animation.timer = window.setTimeout(() => {
          if (animation.cancelled || zoomAnimationRef.current !== animation) return;
          setTransformTransition('');
          zoomAnimationRef.current = null;
        }, duration + 24);
      });
    },
    [applyTransform, cancelZoomAnimation, setTransformTransition],
  );

  const resetTransform = useCallback(() => {
    cancelZoomAnimation();
    setTransformTransition('none');
    viewRef.current = { scale: 1, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform, cancelZoomAnimation, setTransformTransition]);

  // 切图时重置缩放
  const prevIndexRef = useRef(activeIndex);
  const swipeAnimationRef = useRef<{ frame: number; current: number; cancelled: boolean } | null>(null);
  const dragPositionRef = useRef(0);
  const pageNodesRef = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (prevIndexRef.current !== activeIndex) {
      prevIndexRef.current = activeIndex;
      resetTransform();
      setRotation(0);
      setShowInfo(false);
      forceRender((n) => n + 1);
    }
  }, [activeIndex, resetTransform]);

  // —— 滑页偏移（翻页手势跟手 + 回弹动画）——
  const [dragX, setDragX] = useState(0); // 手势中跟手偏移
  const [animating, setAnimating] = useState(false);

  const setDragPosition = (position: number): void => {
    dragPositionRef.current = position;
    setDragX(position);
  };

  const applyPagePosition = (position: number): void => {
    for (const node of pageNodesRef.current.values()) {
      const offset = Number(node.dataset.pageOffset ?? 0);
      node.style.transform = `translateX(calc(${offset * 100}% + ${position}px))`;
    }
  };

  useLayoutEffect(() => {
    // 图片加载或相邻页挂载触发 React 重渲染时，恢复当前动画帧，避免
    // React 的旧 inline style 把页面瞬间绘回动画起点而造成闪烁。
    applyPagePosition(swipeAnimationRef.current?.current ?? dragPositionRef.current);
  }, [activeIndex, pages]);

  useEffect(() => {
    if (animating || index === activeIndex) return;
    setActiveIndex(index);
    setDragPosition(0);
  }, [activeIndex, animating, index]);

  useEffect(() => () => {
    const motion = swipeAnimationRef.current;
    if (motion) {
      motion.cancelled = true;
      window.cancelAnimationFrame(motion.frame);
      swipeAnimationRef.current = null;
    }
    cancelZoomAnimation();
  }, [cancelZoomAnimation]);

  const animateDragTo = useCallback((from: number, to: number, duration: number, onDone?: () => void) => {
    const previous = swipeAnimationRef.current;
    if (previous) {
      previous.cancelled = true;
      window.cancelAnimationFrame(previous.frame);
    }
    if (prefersReducedMotion()) {
      swipeAnimationRef.current = null;
      setDragPosition(to);
      setAnimating(false);
      onDone?.();
      return;
    }
    const motion = { frame: 0, current: from, cancelled: false };
    swipeAnimationRef.current = motion;
    setAnimating(true);
    setDragPosition(from);
    const start = performance.now();
    const tick = (now: number): void => {
      if (motion.cancelled || swipeAnimationRef.current !== motion) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
        motion.current = from + (to - from) * eased;
        dragPositionRef.current = motion.current;
        applyPagePosition(motion.current);
        if (progress < 1) {
        motion.frame = window.requestAnimationFrame(tick);
      } else {
        swipeAnimationRef.current = null;
        setAnimating(false);
        setDragPosition(to);
        onDone?.();
      }
    };
    motion.frame = window.requestAnimationFrame(tick);
  }, []);

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
    startDragX: number;
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
    startDragX: 0,
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
      animateTransformTo({ scale, tx: clamped.tx, ty: clamped.ty });
    },
    [animateTransformTo, containerSize, clampPan],
  );

  const navigateWithAnimation = useCallback(
    (dir: 1 | -1, fromOffset: number, velocity: number) => {
      const targetIndex = activeIndex + dir;
      const target = images[targetIndex];
      if (!target || !containerSize.w) {
        // 边界：回弹
        if (prefersReducedMotion()) {
          setAnimating(false);
          setDragPosition(0);
          return;
        }
        animateDragTo(fromOffset, 0, 220, resetTransform);
        return;
      }
      // 「减少动态效果」：跳过滑动动画，直接切图。
      if (prefersReducedMotion()) {
        setActiveIndex(targetIndex);
        onNavigate(target.id);
        setDragPosition(0);
        resetTransform();
        return;
      }
      const currentOffset = Math.max(-containerSize.w, Math.min(containerSize.w, fromOffset));
      const rebasedOffset = Math.max(-containerSize.w * 2, Math.min(containerSize.w * 2, dir * containerSize.w + currentOffset));
      const remaining = Math.max(1, Math.abs(rebasedOffset));
      const duration = Math.max(110, Math.min(320, remaining / Math.max(Math.abs(velocity), 0.55)));
      setActiveIndex(targetIndex);
      onNavigate(target.id);
      animateDragTo(rebasedOffset, 0, duration, resetTransform);
    },
    [activeIndex, animateDragTo, images, containerSize.w, onNavigate, resetTransform],
  );

  const handleTap = useCallback(() => {
    const g = gestureRef.current;
    const now = performance.now();
    if (now - g.lastTapTime < DOUBLE_TAP_MS) {
      // 双击：100%（自然像素）↔ 适应窗口（DESIGN.md 8.3）
      g.lastTapTime = 0;
      const v = viewRef.current;
      if (v.scale > 1.05) {
        animateTransformTo({ scale: 1, tx: 0, ty: 0 });
      } else {
        const mid = { x: g.startX, y: g.startY };
        const targetScale = Math.min(DOUBLE_TAP_MAX_SCALE, Math.max(1, (1 / fitScale) * DOUBLE_TAP_SCALE_FACTOR));
        zoomTo(targetScale, mid.x, mid.y);
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
  }, [animateTransformTo, zoomTo, fitScale]);

  const onPointerDown = (e: React.PointerEvent) => {
    cancelZoomAnimation();
    setTransformTransition('none');
    const motion = swipeAnimationRef.current;
    if (motion) {
      motion.cancelled = true;
      window.cancelAnimationFrame(motion.frame);
      swipeAnimationRef.current = null;
      setAnimating(false);
    }
    const g = gestureRef.current;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1) {
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.startDragX = dragPositionRef.current;
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
      setTransformTransition(`transform ${PINCH_TRANSITION_MS}ms linear`);
      setDragPosition(0);
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
        const rect = containerRef.current?.getBoundingClientRect();
        const midX = (a.x + b.x) / 2 - (rect?.left ?? 0);
        const midY = (a.y + b.y) / 2 - (rect?.top ?? 0);
        const midDx = midX - g.pinchMidX;
        const midDy = midY - g.pinchMidY;
        const px = g.pinchMidX - cx;
        const py = g.pinchMidY - cy;
        const ratio = scale / g.pinchStartScale;
        const tx = px - (px - g.pinchStartTx) * ratio + midDx;
        const ty = py - (py - g.pinchStartTy) * ratio + midDy;
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
      setDragPosition(g.startDragX + dx);
    } else if (g.mode === 'close') {
      // 下滑：图片跟随下移，背景渐隐
      const ty = Math.max(0, dy);
      setDragPosition(0);
      viewRef.current = { scale: 1, tx: 0, ty };
      const el = imgElRef.current;
      const transform = `translateY(${ty}px) scale(${Math.max(0.85, 1 - ty / 1600)})`;
      for (const imageEl of [el, thumbElRef.current]) {
        if (imageEl) imageEl.style.transform = transform;
      }
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
      // CSS 过渡可能还停在目标值之前；先读取当前合成矩阵，再解除过渡，
      // 避免抬指时从视觉位置跳到最后一个 pointermove 的目标位置。
      viewRef.current = readCurrentTransform();
      setTransformTransition('none');
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
          animateTransformTo({ scale: 1, tx: 0, ty: 0 }, 180);
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
      if (Math.abs(dx) > SWIPE_THRESHOLD || Math.abs(vx) > SWIPE_VELOCITY) {
        const dir = vx < 0 ? 1 : -1;
        navigateWithAnimation(dir, g.startDragX + dx, vx);
      } else {
        const returnDuration = Math.max(110, Math.min(260, Math.abs(g.startDragX + dx) / 0.7));
        animateDragTo(g.startDragX + dx, 0, returnDuration, resetTransform);
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

  // 静止时保留前后一页；运动及被下一次手势接管时保留前后两页。
  // 连续翻页会让尚未完全离场的旧页短暂落到 activeIndex ±2，必须等它
  // 真正离开屏幕后再卸载，否则用户会看到旧页突然变成黑色舞台。
  const pageRadius = animating || Math.abs(dragX) > 0.5 ? 2 : 1;
  const pageIndexes: number[] = [];
  for (let i = Math.max(0, activeIndex - pageRadius); i <= Math.min(images.length - 1, activeIndex + pageRadius); i++) {
    pageIndexes.push(i);
  }

  return (
    <div
      className={`m-viewer-root fixed inset-0 flex flex-col select-none ${closing ? 'm-viewer-exit' : ''}`}
      style={{ touchAction: 'none', zIndex: Z_VIEWER }}
    >
      {/* 手势层 + 图片页 */}
      <div
        ref={containerRef}
        className="m-viewer-stage flex-1 relative overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {pageIndexes.map((i) => {
          const img = images[i];
          const p = pages.get(img.id);
          const offsetPages = i - activeIndex;
          // Percentage translation is available on the first paint, before ResizeObserver
          // reports the container width. Using the measured width here briefly stacked the
          // current and adjacent pages at x=0 when opening the viewer.
          const x = `calc(${offsetPages * 100}% + ${dragX}px)`;
          const isCurrent = i === activeIndex;
          const d = displayDims(p, containerSize.w, containerSize.h);
          return (
            <div
              key={img.id}
              className="absolute inset-0"
              style={{
                transform: `translateX(${x})`,
                transition: 'none',
                visibility: Math.abs(offsetPages) > 1 ? 'hidden' : 'visible',
              }}
              data-page-offset={offsetPages}
              ref={(node) => {
                if (node) pageNodesRef.current.set(img.id, node);
                else pageNodesRef.current.delete(img.id);
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
                {/* 原图先显示，覆盖完整淡入周期后再移除缩略图，避免合成黑帧。 */}
                {p?.thumbUrl && (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <img
                      ref={isCurrent ? thumbElRef : undefined}
                      src={p.thumbUrl}
                      alt=""
                      draggable={false}
                      className="object-contain"
                      style={{
                        pointerEvents: 'none',
                        width: d.iw,
                        height: d.ih,
                        transform: isCurrent
                          ? `translate(${viewRef.current.tx}px, ${viewRef.current.ty}px) scale(${viewRef.current.scale}) rotate(${rotation}deg)`
                          : undefined,
                        willChange: isCurrent ? 'transform' : undefined,
                      }}
                    />
                  </div>
                )}
                {p?.fullUrl && (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{
                      opacity: p.fullReady ? 1 : 0,
                      transition: animating ? 'none' : `opacity ${FULL_FADE_MS}ms ease-out`,
                    }}
                  >
                    <img
                      ref={isCurrent ? imgElRef : undefined}
                      src={p.fullUrl}
                      alt={img.name}
                      draggable={false}
                      decoding="async"
                      className="object-contain"
                      style={{
                        pointerEvents: 'none',
                        width: d.iw,
                        height: d.ih,
                        willChange: isCurrent ? 'transform' : undefined,
                        transform: isCurrent
                          ? `translate(${viewRef.current.tx}px, ${viewRef.current.ty}px) scale(${viewRef.current.scale}) rotate(${rotation}deg)`
                          : undefined,
                      }}
                      onLoad={(e) => {
                        const el = e.currentTarget;
                        if (decodingFullRef.current.has(img.id)) return;
                        decodingFullRef.current.add(img.id);
                        // load 只表示网络资源已到达；Android WebView 的 async 解码
                        // 可能尚未完成。先等像素可绘制，再让原图接管显示。
                        const decoded = typeof el.decode === 'function' ? el.decode() : Promise.resolve();
                        void decoded
                          .catch(() => undefined)
                          .then(() => {
                            decodingFullRef.current.delete(img.id);
                            if (!mountedRef.current || pagesRef.current.get(img.id)?.fullReady) return;
                            patchPage(img.id, {
                              fullReady: true,
                              naturalW: el.naturalWidth,
                              naturalH: el.naturalHeight,
                            });
                            // 缩略图要覆盖完整的原图淡入周期；只等一两帧会在
                            // opacity 尚未到 1 时露出黑色舞台。
                            window.setTimeout(() => {
                              if (!mountedRef.current) return;
                              const thumbUrl = pagesRef.current.get(img.id)?.thumbUrl;
                              if (!thumbUrl || !pagesRef.current.get(img.id)?.fullReady) return;
                              // 先提交 DOM 移除，下一帧再归还 URL，避免合成器
                              // 在旧缩略图仍存在时看到被撤销的资源。
                              patchPage(img.id, { thumbUrl: null });
                              window.requestAnimationFrame(() => {
                                if (objectUrlsRef.current.delete(thumbUrl)) releaseObjectUrl(thumbUrl);
                              });
                            }, FULL_FADE_MS + 40);
                          });
                      }}
                    />
                  </div>
                )}
                {!p?.thumbUrl && !p?.fullReady && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="m-viewer-spinner" aria-label="正在载入原图" />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 顶部栏 */}
      <div
        className={`m-viewer-chrome m-viewer-top absolute top-0 left-0 right-0 z-10 transition-opacity duration-200 ${
          uiVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="m-viewer-toolbar">
          <button className="m-viewer-button" onClick={requestClose} aria-label="返回">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <div className="m-viewer-heading">
            <strong>{current.name}</strong>
            <span className="tabular-nums">
              {activeIndex + 1} / {images.length}
              {currentPage?.naturalW ? ` · ${currentPage.naturalW}×${currentPage.naturalH}` : ''}
            </span>
          </div>
          <button
            className="m-viewer-button"
             onClick={() => {
               cancelZoomAnimation();
               setTransformTransition('none');
               const next = (rotation + 90) % 360;
               setRotation(next);
             }}
            aria-label="旋转"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            className={`m-viewer-button ${showInfo ? 'is-active' : ''}`}
            onClick={() => setShowInfo((v) => !v)}
            aria-label="图片信息"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-5" />
              <path d="M12 8h.01" />
            </svg>
          </button>
          <button
            className="m-viewer-button"
            onClick={() => onShowActions(current)}
            aria-label="更多操作"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
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
          className="m-viewer-info absolute left-3 right-3 z-20"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 72px)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="m-viewer-info-title truncate">{current.name}</div>
            <button className="m-viewer-info-close shrink-0" onClick={() => setShowInfo(false)} aria-label="关闭信息">
              ✕
            </button>
          </div>
          <div className="m-viewer-info-grid">
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
        className={`m-viewer-chrome m-viewer-bottom absolute bottom-0 left-0 right-0 z-10 transition-opacity duration-200 ${
          uiVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)' }}
      >
        <Filmstrip images={images} index={activeIndex} store={store} onSelect={(img) => onNavigate(img.id)} />
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
      className="m-filmstrip flex gap-1.5 overflow-x-auto"
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
            className={`m-filmstrip-item shrink-0 w-14 h-14 overflow-hidden ${i === index ? 'is-active' : ''}`}
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
    <div className="m-viewer-info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FilmThumb({ store, image }: { store: LibraryStore; image: ImageEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objUrl: string | null = null;
    getThumbnailBlob(store, toFileRef(image), 128, { shouldCancel: () => cancelled })
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
  if (!url) return <div className="m-filmstrip-placeholder w-full h-full" />;
  return <img src={url} alt="" className="w-full h-full object-cover" draggable={false} />;
}
