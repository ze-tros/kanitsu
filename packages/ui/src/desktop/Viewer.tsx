import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowsIn,
  CaretLeft,
  CaretRight,
  DotsThree,
  EyeSlash,
  Info,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PushPin,
  Trash,
  X,
} from '@phosphor-icons/react';
import { isRawImage, type ImageEntry } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import type { DesktopRawViewMode } from '../../../fs-adapter/src/electron';
import { BlobImage } from '../BlobImage';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { useExifInfo } from '../exifInfo';
import { DEFAULT_THUMBNAIL_SIZE, getThumbnailBlob, peekThumbnailBlob } from '../thumbnailCache';
import { Segmented } from './controls';
import { ExifSummary } from './Inspector';
import { extLabel, formatBytes, formatModifiedTime, imageFileRef, isElectron } from './shared';
import { peekPrefetchedOriginal, prefetchOriginal } from '../originalPrefetch';

/** 长图：画面上高宽比超过该值时按宽度适配、从顶部开始，滚轮纵向滚动。 */
const LONG_IMAGE_RATIO = 2.5;
/** 长图适配时占画布宽度的比例，两侧留白，便于看出这是一张可滚动的长图。 */
const LONG_IMAGE_WIDTH_SHARE = 0.72;
/** 平移的「顶端」哨兵：经 clamp 后落在图片顶边（不需要滚动的图夹到 0，即居中）。 */
const PAN_TOP = Number.MAX_SAFE_INTEGER;

const VIEWER_FILMSTRIP_ITEM_WIDTH = 56;
const VIEWER_FILMSTRIP_GAP = 6;
const VIEWER_FILMSTRIP_PADDING = 14;
const VIEWER_FILMSTRIP_STRIDE = VIEWER_FILMSTRIP_ITEM_WIDTH + VIEWER_FILMSTRIP_GAP;
const VIEWER_FILMSTRIP_OVERSCAN = 8;

type ViewerFilmstripWindow = { first: number; last: number };

function viewerFilmstripContentWidth(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return itemCount * VIEWER_FILMSTRIP_ITEM_WIDTH + (itemCount - 1) * VIEWER_FILMSTRIP_GAP;
}

function viewerFilmstripWindowFor(
  itemCount: number,
  scrollLeft: number,
  viewportWidth: number,
): ViewerFilmstripWindow {
  if (itemCount <= 0) return { first: 0, last: 0 };
  const surfaceLeft = Math.max(0, scrollLeft - VIEWER_FILMSTRIP_PADDING);
  const firstVisible = Math.min(itemCount - 1, Math.floor(surfaceLeft / VIEWER_FILMSTRIP_STRIDE));
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportWidth) / VIEWER_FILMSTRIP_STRIDE) + 1);
  return {
    first: Math.max(0, firstVisible - VIEWER_FILMSTRIP_OVERSCAN),
    last: Math.min(itemCount, firstVisible + visibleCount + VIEWER_FILMSTRIP_OVERSCAN),
  };
}

const ViewerFilmstripItem = memo(function ViewerFilmstripItem({
  image,
  itemIndex,
  itemCount,
  active,
  blurred,
  store,
  onNavigate,
}: {
  image: ImageEntry;
  itemIndex: number;
  itemCount: number;
  active: boolean;
  blurred: boolean;
  store: LibraryStore;
  onNavigate: (id: string) => void;
}) {
  const fileRef = useMemo(() => imageFileRef(image), [image]);
  return (
    <button
      type="button"
      className={active ? 'on' : ''}
      style={{ left: itemIndex * VIEWER_FILMSTRIP_STRIDE }}
      aria-label={`查看${image.name}`}
      aria-current={active ? 'true' : undefined}
      aria-posinset={itemIndex + 1}
      aria-setsize={itemCount}
      onClick={() => onNavigate(image.id)}
    >
      <BlobImage store={store} fileRef={fileRef} alt="" className="dk-art" thumbnail lazy blur={blurred} />
    </button>
  );
});

const ViewerFilmstrip = memo(function ViewerFilmstrip({
  images,
  activeIndex,
  store,
  blurredImages,
  onNavigate,
}: {
  images: readonly ImageEntry[];
  activeIndex: number;
  store: LibraryStore;
  blurredImages: ReadonlySet<string>;
  onNavigate: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const handleNavigate = useCallback((id: string) => navigateRef.current(id), []);
  const [mountedWindow, setMountedWindow] = useState<ViewerFilmstripWindow>(() => {
    const estimatedViewport = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const estimatedScrollLeft = Math.max(
      0,
      VIEWER_FILMSTRIP_PADDING
        + activeIndex * VIEWER_FILMSTRIP_STRIDE
        + VIEWER_FILMSTRIP_ITEM_WIDTH / 2
        - estimatedViewport / 2,
    );
    return viewerFilmstripWindowFor(images.length, estimatedScrollLeft, estimatedViewport);
  });

  const updateWindow = useCallback((scrollLeft: number, viewportWidth: number) => {
    const next = viewerFilmstripWindowFor(images.length, scrollLeft, viewportWidth);
    setMountedWindow((current) => (
      current.first === next.first && current.last === next.last ? current : next
    ));
  }, [images.length]);

  const centerActive = useCallback(() => {
    const node = scrollRef.current;
    if (!node || activeIndex < 0 || activeIndex >= images.length) return;
    const desired = VIEWER_FILMSTRIP_PADDING
      + activeIndex * VIEWER_FILMSTRIP_STRIDE
      + VIEWER_FILMSTRIP_ITEM_WIDTH / 2
      - node.clientWidth / 2;
    const nextScrollLeft = Math.min(
      Math.max(0, node.scrollWidth - node.clientWidth),
      Math.max(0, desired),
    );
    node.scrollLeft = nextScrollLeft;
    updateWindow(nextScrollLeft, node.clientWidth);
  }, [activeIndex, images.length, updateWindow]);

  useLayoutEffect(() => {
    if (scrollFrameRef.current != null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    centerActive();
  }, [centerActive]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(centerActive);
    observer.observe(node);
    return () => observer.disconnect();
  }, [centerActive]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const onScroll = useCallback(() => {
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const node = scrollRef.current;
      if (node) updateWindow(node.scrollLeft, node.clientWidth);
    });
  }, [updateWindow]);

  const visibleImages = images.slice(mountedWindow.first, mountedWindow.last);
  return (
    <footer
      ref={scrollRef}
      className="dk-film"
      aria-label="缩略图导航"
      onScroll={onScroll}
    >
      <div
        className="dk-film-surface"
        style={{ width: viewerFilmstripContentWidth(images.length) }}
      >
        {visibleImages.map((item, windowIndex) => {
          const itemIndex = mountedWindow.first + windowIndex;
          return (
            <ViewerFilmstripItem
              key={item.id}
              image={item}
              itemIndex={itemIndex}
              itemCount={images.length}
              active={itemIndex === activeIndex}
              blurred={blurredImages.has(item.relPath)}
              store={store}
              onNavigate={handleNavigate}
            />
          );
        })}
      </div>
    </footer>
  );
});

/**
 * 沉浸式查看器：画布铺满窗口，顶部工具栏与底部胶片条闲置后淡出（idle 由外层按
 * 鼠标活动计算），图片信息面板停靠在右侧并挤开画布。按图片 id 重挂载（外层 key），
 * 面板 / 胶片条开关与闲置状态由外层持有，切图时保持。
 */
export function Viewer({
  images,
  index,
  store,
  onClose,
  onNavigate,
  onSwitchSibling,
  onImageContextMenu,
  rawViewMode,
  onRawViewModeChange,
  infoOpen,
  onInfoOpenChange,
  filmstripVisible,
  onToggleFilmstrip,
  idle,
  folderName,
  blurred,
  revealed,
  onReveal,
  pinned,
  onTogglePin,
  onToggleBlur,
  onDelete,
  blurredImages,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onSwitchSibling: (dir: number) => void;
  onImageContextMenu: (event: ReactMouseEvent, image: ImageEntry) => void;
  /** RAW 观感:工具栏切换按钮与完整解码提示仅 RAW 文件渲染。 */
  rawViewMode: DesktopRawViewMode;
  onRawViewModeChange: (mode: DesktopRawViewMode) => void;
  /** 图片信息面板开关（受控）：状态在外层，切换图片时面板保留。 */
  infoOpen: boolean;
  onInfoOpenChange: (open: boolean) => void;
  filmstripVisible: boolean;
  onToggleFilmstrip: () => void;
  /** 鼠标闲置：工具栏与胶片条淡出。 */
  idle: boolean;
  folderName?: string;
  /** 当前图开启了隐私预览。 */
  blurred: boolean;
  /** 本次会话已点「本次显示」。 */
  revealed: boolean;
  onReveal: () => void;
  pinned: boolean;
  onTogglePin: (image: ImageEntry) => void;
  onToggleBlur: (image: ImageEntry) => void;
  onDelete: (image: ImageEntry) => void;
  blurredImages: ReadonlySet<string>;
}) {
  const image = images[index];
  // displayUrl：当前正在显示的图（只在确已解码完成后换入）；pendingUrl：当前图正在
  // 后台解码的隐式加载器；thumbUrl：当前图的缩略图占位。
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [displayImageId, setDisplayImageId] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbImageId, setThumbImageId] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [originalFailed, setOriginalFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: PAN_TOP });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // 面板开关由父层持有（切换图片会重挂载本组件，见外层 key），这里只读。
  const showInfo = infoOpen;
  // 图片信息面板里的拍摄参数；面板没开就不读文件。
  const exif = useExifInfo(store, image, showInfo);

  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const displayUrlRef = useRef<string | null>(null);
  const pendingUrlRef = useRef<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPan: { x: number; y: number } } | null>(null);
  // 触控板一次滚动手势能发上百个 wheel 事件；按帧合并缩放增量，避免每个
  // 事件都触发一轮 React 渲染 + 大图重绘。rAF 在窗口被遮挡等场景会被节流
  // 甚至暂停，另挂一个短定时器兜底，保证缩放不会卡在排队状态。
  const wheelZoomRef = useRef({ factor: 1, rafId: 0, timerId: 0 });

  // 必须在绘制前量出画布尺寸：查看器每次切图都会重挂载，若用 useEffect，第一帧 containerSize
  // 还是 0，baseFit 退回 1，图片会先按 100% 画一帧再缩回适应窗口（尺寸跳变）。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const style = window.getComputedStyle(el);
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      setContainerSize({
        w: Math.max(0, el.clientWidth - horizontalPadding),
        h: Math.max(0, el.clientHeight - verticalPadding),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showInfo, filmstripVisible]);

  // 原图解码完成后换入显示（旧图在换入前始终保持可见，切换不黑屏）。
  const swapIn = useCallback(
    (imageId: string, url: string, w: number, h: number) => {
      if (displayUrlRef.current && displayUrlRef.current !== url) {
        store.releaseViewerUrl(displayUrlRef.current);
      }
      displayUrlRef.current = url;
      pendingUrlRef.current = null;
      setPendingUrl(null);
      setOriginalFailed(false);
      setDisplayImageId(imageId);
      setDisplayUrl(url);
      setNatural({ w, h });
    },
    [store],
  );

  // RAW 派生图后台升级:首次查看先显示预览级派生(毫秒级),主进程完成完整
  // 解码覆盖同一文件后推送事件;若正是当前显示/等待中的文件,则重新取
  // URL(版本号变化)触发热替换。其他图片在下次 getViewerUrl 时自然拿到新版。
  const [rawUpgradeTick, setRawUpgradeTick] = useState(0);
  useEffect(() => {
    if (!store.onRawDerivativeUpdated) return;
    const matchDerivPath = (u: string | null, derivPath: string): boolean => {
      if (!u) return false;
      try {
        return new URL(u).searchParams.get('p') === derivPath;
      } catch {
        return false;
      }
    };
    return store.onRawDerivativeUpdated(({ derivPath }) => {
      if (matchDerivPath(displayUrlRef.current, derivPath) || matchDerivPath(pendingUrlRef.current, derivPath)) {
        setRawUpgradeTick((t) => t + 1);
      }
    });
  }, [store]);

  const isRaw = isRawImage(image.name);

  // developed 模式下完整解码是否仍在后台进行:显示工具栏加载指示。
  // 升级事件(rawUpgradeTick 自增)与取到新 URL 都会触发重查,完成后撤下;
  // camera 模式与 HEIF 恒为 false(无完整解码升级阶段)。
  const [rawFullPending, setRawFullPending] = useState(false);
  useEffect(() => {
    if (!isRaw || rawViewMode !== 'developed') {
      setRawFullPending(false);
      return;
    }
    let derivPath: string | null = null;
    try {
      derivPath = new URL(displayUrl ?? '').searchParams.get('p');
    } catch {
      derivPath = null;
    }
    const bridge = window.kanitsuDesktop;
    if (!derivPath || !bridge?.isRawDerivativeFullDone) {
      setRawFullPending(false);
      return;
    }
    let cancelled = false;
    void bridge
      .isRawDerivativeFullDone(derivPath)
      .then((done) => {
        if (!cancelled) setRawFullPending(!done);
      })
      .catch(() => {
        if (!cancelled) setRawFullPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [displayUrl, isRaw, rawViewMode, rawUpgradeTick]);

  // 下一张图：取原始文件 URL，放入后台隐式解码的加载器（不立即换入显示）。
  // rawUpgradeTick:RAW 完整解码后台覆盖预览级派生后自增,重新取 URL 热替换。
  // rawViewMode:工具栏切换观感后立即按新模式重取当前图。
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    store.getViewerUrl(imageFileRef(image)).then((url) => {
      if (cancelled) {
        store.releaseViewerUrl(url);
        return;
      }
      // 已解码完成的同文件(缓存命中同版本号)无需换入。
      if (displayUrlRef.current === url) return;
      const prefetched = peekPrefetchedOriginal(url);
      if (prefetched) {
        swapIn(image.id, url, prefetched.w, prefetched.h);
        return;
      }
      if (pendingUrlRef.current === url) return;
      pendingUrlRef.current = url;
      setPendingUrl(url);
    });
    return () => {
      cancelled = true;
      if (pendingUrlRef.current) {
        store.releaseViewerUrl(pendingUrlRef.current);
        pendingUrlRef.current = null;
      }
      setPendingUrl(null);
    };
  }, [image, store, swapIn, rawUpgradeTick, rawViewMode]);

  useEffect(() => {
    return () => {
      if (pendingUrlRef.current) store.releaseViewerUrl(pendingUrlRef.current);
      if (displayUrlRef.current) store.releaseViewerUrl(displayUrlRef.current);
      const wheel = wheelZoomRef.current;
      window.cancelAnimationFrame(wheel.rafId);
      window.clearTimeout(wheel.timerId);
      wheel.rafId = 0;
      wheel.timerId = 0;
      wheel.factor = 1;
    };
  }, [store]);

  // 切换图片时先加载当前图片的缩略图占位（走缩略图缓存，已看过的图瞬时可用），
  // 原图在后台解码完成后换入；显示层始终绑定当前图片 ID。
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    let thumbObjectUrl: string | null = null;
    setThumbUrl(null);
    setThumbImageId(null);
    const fileRef = imageFileRef(image);
    const cached = peekThumbnailBlob(fileRef, DEFAULT_THUMBNAIL_SIZE);
    if (cached) {
      thumbObjectUrl = URL.createObjectURL(cached);
      setThumbImageId(image.id);
      setThumbUrl(thumbObjectUrl);
    } else {
      getThumbnailBlob(store, fileRef, DEFAULT_THUMBNAIL_SIZE, { shouldCancel: () => cancelled })
        .then((blob) => {
          if (cancelled) return;
          thumbObjectUrl = URL.createObjectURL(blob);
          setThumbImageId(image.id);
          setThumbUrl(thumbObjectUrl);
        })
        .catch(() => {
          // 缩略图失败时静默；原图会照常加载。
        });
    }
    return () => {
      cancelled = true;
      if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
    };
  }, [image, store]);

  useLayoutEffect(() => {
    // 切图在浏览器绘制前重置尺寸与缩放，避免上一张图的 1:1 状态
    // 短暂继承到新图，造成大图从适应窗口跳到 100%。
    setZoom(1);
    setRotate(0);
    setPan({ x: 0, y: PAN_TOP });
    setOriginalFailed(false);
    setNatural(image?.width && image?.height ? { w: image.width, h: image.height } : null);
  }, [image?.id, image?.width, image?.height]);

  // 预解码相邻原图（先 ±1、再 ±2，错峰执行）：位图保留在 ORIGINAL_POOL 里，
  // ←/→ 切换时直接复用已解码像素，不再等 Chromium 现场解码大图。
  // 等当前图换入显示（或确认加载失败）后再启动：打开大图的头几秒正是用户
  // 开始滚轮缩放的时候，4 张相邻大图的后台解码会和当前图的解码/缩放抢资源。
  const currentSettled = originalFailed || (!!image && displayImageId === image.id);
  useEffect(() => {
    if (!images.length || !currentSettled) return;
    let cancelled = false;
    const jobs: (() => void)[] = [];
    for (const offset of [1, -1, 2, -2]) {
      const i = index + offset;
      if (i < 0 || i >= images.length) continue;
      const neighbor = images[i]!;
      jobs.push(() => {
        store
          .getViewerUrl(imageFileRef(neighbor))
          .then((url) => {
            if (cancelled) {
              store.releaseViewerUrl(url);
              return;
            }
            prefetchOriginal(url, neighbor.width, neighbor.height);
          })
          .catch(() => {
            // 预解码失败静默；真显示时由主 <img> 自行加载。
          });
      });
    }
    if (jobs.length === 0) return;
    const step = (): void => {
      if (cancelled || jobs.length === 0) return;
      jobs.shift()!();
      // 每步隔一个宏任务，解码错峰，避免瞬时并发解码多张大图。
      setTimeout(step, 60);
    };
    // 同级前后图片是切换的关键路径，立即开始；step 内部仍按 60ms 错峰，
    // 避免相邻图片同时解码抢占当前图片。
    setTimeout(step, 0);
    return () => {
      cancelled = true;
    };
  }, [currentSettled, image?.id, images, index, store]);

  const effectiveNatural = natural ?? (image.width && image.height ? { w: image.width, h: image.height } : null);

  // 旋转 90° / 270° 后画面上的宽高对调，适配窗口与平移边界都按旋转后的外框计算。
  const quarterTurn = rotate % 180 !== 0;
  const isLong = !!effectiveNatural && (quarterTurn ? effectiveNatural.w / effectiveNatural.h : effectiveNatural.h / effectiveNatural.w) > LONG_IMAGE_RATIO;
  const baseFit = useMemo(() => {
    if (!effectiveNatural || !containerSize.w || !containerSize.h) return 1;
    const boxW = quarterTurn ? effectiveNatural.h : effectiveNatural.w;
    const boxH = quarterTurn ? effectiveNatural.w : effectiveNatural.h;
    // 长图只按宽度适配（上下可滚动），否则整张塞进画布。
    const s = isLong ? (containerSize.w * LONG_IMAGE_WIDTH_SHARE) / boxW : Math.min(containerSize.w / boxW, containerSize.h / boxH);
    return Math.max(0.05, Math.min(1, s));
  }, [effectiveNatural, containerSize, quarterTurn, isLong]);

  const displayed = useMemo(() => {
    const w = (effectiveNatural?.w ?? 1) * baseFit * zoom;
    const h = (effectiveNatural?.h ?? 1) * baseFit * zoom;
    return { w, h };
  }, [effectiveNatural, baseFit, zoom]);

  // 下方 transform 用 scale(zoom) 缩放；img 的布局盒固定为适应窗口的尺寸，
  // 避免 Tailwind preflight 的 max-width:100% 在缩放之外再压缩一次。
  const fitSize = useMemo(() => {
    const w = (effectiveNatural?.w ?? 1) * baseFit;
    const h = (effectiveNatural?.h ?? 1) * baseFit;
    return { w, h };
  }, [effectiveNatural, baseFit]);

  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const onScreenW = quarterTurn ? displayed.h : displayed.w;
  const onScreenH = quarterTurn ? displayed.w : displayed.h;
  const maxX = Math.max(0, (onScreenW - containerSize.w) / 2);
  const maxY = Math.max(0, (onScreenH - containerSize.h) / 2);
  const panX = clamp(pan.x, maxX);
  const panY = clamp(pan.y, maxY);

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => Math.max(0.5, Math.min(8, z * factor)));
  }, []);
  // 应用排队中的滚轮缩放增量；rAF 与兜底定时器都可能先到，幂等。
  const applyWheelZoom = useCallback(() => {
    const wheel = wheelZoomRef.current;
    window.cancelAnimationFrame(wheel.rafId);
    window.clearTimeout(wheel.timerId);
    wheel.rafId = 0;
    wheel.timerId = 0;
    const factor = wheel.factor;
    wheel.factor = 1;
    if (factor !== 1) zoomBy(factor);
  }, [zoomBy]);
  const fit = useCallback(() => setZoom(1), []);
  const percent = useCallback(() => {
    setZoom(baseFit > 0 ? 1 / baseFit : 1);
  }, [baseFit]);
  const toggleFit100 = useCallback(() => {
    setZoom((z) => (Math.abs(z - 1) < 0.01 ? (baseFit > 0 ? 1 / baseFit : 1) : 1));
  }, [baseFit]);
  // 旋转后适配比例变了，回到适应窗口，避免沿用旧的缩放 / 平移把图甩出画布。
  const rotateCW = useCallback(() => {
    setRotate((r) => (r + 90) % 360);
    setZoom(1);
    setPan({ x: 0, y: PAN_TOP });
  }, []);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.dk-menu, .dk-scrim, .dk-pal')) return;
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        const focusable = dialog
          ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
              .filter((element) => element.offsetParent !== null)
          : [];
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialog?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialog?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'Escape') {
        e.preventDefault();
        // 信息面板开着时先收起面板，再按一次才关闭查看器。
        if (showInfo) onInfoOpenChange(false);
        else onClose();
      } else if (key === 'ArrowLeft') {
        onNavigate(images[(index - 1 + images.length) % images.length]!.id);
      } else if (key === 'ArrowRight') {
        onNavigate(images[(index + 1) % images.length]!.id);
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        onSwitchSibling(-1);
      } else if (key === 'ArrowDown') {
        e.preventDefault();
        onSwitchSibling(1);
      } else if (key === 'Home') {
        onNavigate(images[0]!.id);
      } else if (key === 'End') {
        onNavigate(images[images.length - 1]!.id);
      } else if (key === '+' || key === '=') {
        zoomBy(1.25);
      } else if (key === '-') {
        zoomBy(0.8);
      } else if (key === '0') {
        fit();
      } else if (key === '1') {
        percent();
      } else if (key === 'r') {
        rotateCW();
      } else if (key === 'i') {
        onInfoOpenChange(!showInfo);
      } else if (key === 'f') {
        onToggleFilmstrip();
      } else if (key === 'Delete') {
        onDelete(image);
      }
    },
    [images, index, image, showInfo, onClose, onNavigate, onSwitchSibling, onInfoOpenChange, onToggleFilmstrip, onDelete, zoomBy, fit, percent, rotateCW],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    // 查看器按图片 id 重挂载，翻页时也会走到这里：还原焦点不能滚动背后的网格。
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  if (!image) return null;

  // 缩略图“替换”显示层的条件：新图正在加载（pendingUrl 非空）、或尚无显示图、
  // 或原图加载失败——此时只显示缩略图，与旧图互斥，不叠放。
  const hasCurrentDisplay = displayUrl != null && displayImageId === image.id;
  const hasCurrentThumb = thumbUrl != null && thumbImageId === image.id;
  const showThumbReplace = hasCurrentThumb && (pendingUrl != null || !hasCurrentDisplay || originalFailed);
  const previousImage = images[(index - 1 + images.length) % images.length]!;
  const nextImage = images[(index + 1) % images.length]!;
  const scalePercent = Math.round(baseFit * zoom * 100);
  const hidden = blurred && !revealed;
  const zoomed = zoom > 1.01;

  return (
    <div
      className={`dk-viewer ${idle && !showInfo ? 'idle' : ''}`}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`查看${image.name}`}
    >
      <div
        className={`dk-v-stage ${zoomed || maxY > 0 ? 'grab' : ''} ${filmstripVisible && images.length > 1 ? 'has-film' : ''}`}
        ref={containerRef}
        onContextMenu={(event) => onImageContextMenu(event, image)}
        onWheel={(e) => {
          e.preventDefault();
          // 长图在适应宽度时滚轮纵向滚动；按住 Ctrl 仍然缩放。
          if (isLong && !e.ctrlKey && zoom <= 1.01) {
            // 函数式更新：触控板一帧内连发多个 wheel 事件时逐个累加，不丢增量。
            const dy = e.deltaY;
            setPan((p) => ({ x: clamp(p.x, maxX), y: clamp(clamp(p.y, maxY) - dy, maxY) }));
            return;
          }
          const wheel = wheelZoomRef.current;
          wheel.factor *= e.deltaY > 0 ? 0.8 : 1.25;
          if (wheel.rafId || wheel.timerId) return;
          wheel.rafId = window.requestAnimationFrame(() => applyWheelZoom());
          wheel.timerId = window.setTimeout(() => applyWheelZoom(), 60);
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button, .dk-v-top, .dk-v-bottom')) return;
          toggleFit100();
        }}
        onMouseDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button, .dk-v-top, .dk-v-bottom')) return;
          // 以夹紧后的实际位置为起点（pan 里可能是顶端哨兵值）。
          dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: { x: panX, y: panY } };
        }}
        onMouseMove={(e) => {
          const drag = dragRef.current;
          if (drag) setPan({ x: drag.startPan.x + (e.clientX - drag.startX), y: drag.startPan.y + (e.clientY - drag.startY) });
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
      >
        {/* 显示层与缩略图层共用同一几何（同一个变换容器），缩略图就绪后“替换”
            旧图而不是叠放；旧图在缩略图就绪前保持显示，保证不黑屏。 */}
        <div
          className={`dk-v-img ${hidden ? 'blurred' : ''}`}
          style={{
            width: fitSize.w,
            height: fitSize.h,
            transform: `translate(${panX}px, ${panY}px) rotate(${rotate}deg) scale(${zoom})`,
          }}
        >
          {hasCurrentDisplay && !showThumbReplace && (
            <img className="dk-v-photo" src={displayUrl} alt={image.name} draggable={false} />
          )}
          {showThumbReplace && <img className="dk-v-photo" src={thumbUrl} alt="" aria-hidden="true" draggable={false} />}
        </div>
        {/* 当前图的后台隐式加载器：透明挂载，解码完成才换入 displayUrl。 */}
        {pendingUrl && (
          <img
            className="dk-v-pending"
            src={pendingUrl}
            alt=""
            aria-hidden="true"
            decoding="async"
            onLoad={(e) => {
              const el = e.currentTarget;
              if (pendingUrlRef.current !== pendingUrl) return;
              // 大图 onload 只代表字节到位；按 DESIGN.md 5.3 先 decode() 出完整
              // 位图再换入覆盖，否则换入后的首次滚轮缩放要现场解码整张大图。
              void el
                .decode()
                .catch(() => undefined)
                .then(() => {
                  if (pendingUrlRef.current !== pendingUrl) return;
                  swapIn(image.id, pendingUrl, el.naturalWidth, el.naturalHeight);
                });
            }}
            onError={() => {
              if (pendingUrlRef.current !== pendingUrl) return;
              store.releaseViewerUrl(pendingUrl);
              pendingUrlRef.current = null;
              setPendingUrl(null);
              setOriginalFailed(true);
            }}
          />
        )}
        {!hasCurrentDisplay && !hasCurrentThumb && (
          <div className="dk-v-loading" role="status" aria-label="正在载入图片"><span className="dk-spin" /></div>
        )}
        {hidden && (
          <div className="dk-v-reveal">
            <EyeSlash size={26} />
            <div>这张图片开启了隐私预览</div>
            <button type="button" className="dk-btn sm" onClick={onReveal}>本次显示</button>
          </div>
        )}

        <header className={`dk-v-top ${isElectron() ? 'titlebar-drag' : ''}`}>
          <div className="dk-v-group titlebar-no-drag">
            <button ref={closeButtonRef} type="button" className="dk-ib" onClick={onClose} aria-label="关闭查看器" title="关闭查看器 (Esc)">
              <ArrowLeft size={18} />
            </button>
            <div className="dk-v-title">
              <b title={image.name}>{image.name}</b>
              <small className="num">{folderName ? `${folderName} · ` : ''}{index + 1} / {images.length}</small>
            </div>
          </div>
          <span className="dk-spacer" />
          <div className="dk-v-tools titlebar-no-drag" aria-label="查看工具">
            <button type="button" className="dk-ib" aria-label="缩小" title="缩小 (−)" onClick={() => zoomBy(0.8)}><MagnifyingGlassMinus size={17} /></button>
            <button type="button" className="dk-z num" onClick={fit} title="适应窗口 (0)">{scalePercent}%</button>
            <button type="button" className="dk-ib" aria-label="放大" title="放大 (+)" onClick={() => zoomBy(1.25)}><MagnifyingGlassPlus size={17} /></button>
            <span className="dk-vr" />
            <button type="button" className="dk-ib" aria-label="适应窗口" title="适应窗口 (0)" onClick={fit}><ArrowsIn size={17} /></button>
            <button type="button" className="dk-ib dk-v-text" aria-label="原始大小" title="原始大小 (1)" onClick={percent}>1:1</button>
            <button type="button" className="dk-ib" aria-label="顺时针旋转" title="旋转 (R)" onClick={rotateCW}><ArrowClockwise size={17} /></button>
            {/* RAW 观感:显影=完整解码;直出=相机内嵌预览。顺序与设置页一致。 */}
            {isRaw && (
              <>
                <span className="dk-vr" />
                <Segmented<DesktopRawViewMode>
                  className="dk-v-seg"
                  label="RAW 观感"
                  value={rawViewMode}
                  onChange={onRawViewModeChange}
                  options={[
                    { value: 'developed', content: '显影', title: '完整解码' },
                    { value: 'camera', content: '直出', title: '相机直出（内嵌预览）' },
                  ]}
                />
              </>
            )}
          </div>
          <span className="dk-spacer" />
          <div className="dk-v-group titlebar-no-drag">
            <button type="button" className={`dk-ib ${pinned ? 'on' : ''}`} aria-pressed={pinned} title={pinned ? '取消固定封面' : '设为图包封面'} aria-label={pinned ? '取消固定封面' : '设为图包封面'} onClick={() => onTogglePin(image)}><PushPin size={17} /></button>
            <button type="button" className={`dk-ib ${blurred ? 'on' : ''}`} aria-pressed={blurred} title={blurred ? '取消隐私预览' : '隐私预览'} aria-label={blurred ? '取消隐私预览' : '隐私预览'} onClick={() => onToggleBlur(image)}><EyeSlash size={17} /></button>
            <button type="button" className="dk-ib" title="删除 (Del)" aria-label="删除" onClick={() => onDelete(image)}><Trash size={17} /></button>
            <button type="button" className={`dk-ib ${showInfo ? 'on' : ''}`} aria-pressed={showInfo} title="图片信息 (I)" aria-label="图片信息" onClick={() => onInfoOpenChange(!showInfo)}><Info size={17} /></button>
            <button type="button" className="dk-ib" title="更多" aria-label="更多操作" onClick={(event) => onImageContextMenu(event, image)}><DotsThree size={18} weight="bold" /></button>
          </div>
          {!showInfo && <DesktopWindowControls />}
        </header>

        <button type="button" className="dk-v-arrow l" aria-label="上一张" title="上一张 (←)" disabled={images.length <= 1} onClick={() => onNavigate(previousImage.id)}>
          <CaretLeft size={24} />
        </button>
        <button type="button" className="dk-v-arrow r" aria-label="下一张" title="下一张 (→)" disabled={images.length <= 1} onClick={() => onNavigate(nextImage.id)}>
          <CaretRight size={24} />
        </button>

        {isRaw && rawFullPending && (
          <div className="dk-v-pill" role="status">
            <span className="dk-spin" />RAW 完整解码中，先显示相机内嵌预览
          </div>
        )}

        {filmstripVisible && images.length > 1 && (
          <div className="dk-v-bottom">
            <ViewerFilmstrip images={images} activeIndex={index} store={store} blurredImages={blurredImages} onNavigate={onNavigate} />
          </div>
        )}
      </div>

      {showInfo && (
        <aside
          className="dk-v-info"
          aria-label="图片信息"
          // 信息面板里的滚动 / 拖拽 / 双击是面板自己的交互，不下传到画布的缩放与平移。
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className={`dk-insp-h ${isElectron() ? 'titlebar-drag' : ''}`}>
            <span>图片信息</span>
            <button type="button" className="dk-ib titlebar-no-drag" aria-label="收起图片信息" title="收起 (I)" onClick={() => onInfoOpenChange(false)}><X size={16} /></button>
            <DesktopWindowControls />
          </div>
          <div className="dk-insp-b dk-scroll">
            <h3 className="first">{image.name}</h3>
            <div className="dk-sub num">
              {natural ? `${natural.w} × ${natural.h}` : image.width && image.height ? `${image.width} × ${image.height}` : '尺寸未知'}
              {` · ${formatBytes(image.size)} · ${extLabel(image)}`}
            </div>
            <section>
              <h4>拍摄信息</h4>
              <ExifSummary state={exif} />
            </section>
            <section>
              <h4>文件</h4>
              <div className="dk-kv">
                <span>修改时间</span><b className="num">{formatModifiedTime(image.mtime)}</b>
                {folderName && (<><span>所在图包</span><b>{folderName}</b></>)}
                <span>库内路径</span><b className="path">{image.relPath}</b>
              </div>
            </section>
          </div>
        </aside>
      )}
    </div>
  );
}
