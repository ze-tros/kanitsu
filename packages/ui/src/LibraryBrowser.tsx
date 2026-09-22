import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowsOut,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  Export,
  Eye,
  EyeSlash,
  FileZip,
  Folder,
  FolderOpen,
  FolderPlus,
  GearSix,
  House,
  ImagesSquare,
  ImageSquare,
  Info,
  LockSimple,
  MagicWand,
  MagnifyingGlass,
  Minus,
  Moon,
  PencilSimple,
  Plus,
  PushPin,
  Rows,
  SidebarSimple,
  SortAscending,
  SquaresFour,
  Sun,
  Trash,
  UploadSimple,
  X,
} from '@phosphor-icons/react';
import { recordScrollFrame } from './fpsMonitor';
import {
  applyOrganize,
  childrenOf,
  createSubfolder,
  deleteImage,
  deleteLibraryFolder,
  directImagesOf,
  imagesOf,
  importFolder,
  joinRelPath,
  loadOrScan,
  readSnapshotMirror,
  renameFolder,
  renameImage,
  rescanLibrary,
  undoOrganize,
  writeSnapshotMirror,
  type FolderNode,
  type ImageEntry,
  type ImportSkippedFile,
  type ImportTask,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type OrganizeResult,
  type PersistentIndex,
} from '../../core/src/index';
import type { ImportSourcePicker, LibraryStore } from '../../fs-adapter/src/types';
import type { FileRef } from '../../fs-adapter/src/types';
import { organizeByFolder, type CustomOrganizeRule } from '../../organizer/src/index';
import { pickCover } from '../../cover-picker/src/index';
import { BlobImage } from './BlobImage';
import { KanitsuLogo } from './KanitsuLogo';
import {
  COVER_THUMBNAIL_SIZE,
  getThumbnailBlob,
  peekThumbnailBlob,
  preloadThumbnails,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_DIRECTIONAL,
  THUMB_PRIORITY_SUBFOLDER,
  THUMB_PRIORITY_WARMUP,
  setThumbnailPreloadPaused,
} from './thumbnailCache';
import { getLogLevelPref, isPrefetchEnabled, logDebug } from './debugLog';
import {
  backTarget,
  canGoBack,
  canGoForward,
  createNavHistory,
  forwardTarget,
  moveBack,
  moveForward,
  recordNav,
  type NavHistory,
} from './navHistory';
import { ContextMenu, type ContextMenuItem, type ContextMenuModel } from './ContextMenu';
import { CoverPickerModal } from './CoverPickerModal';
import { LibraryLocationModal } from './LibraryLocationModal';
import { fetchLibraryLocation, shouldPromptLibraryLocation, type LibraryLocationInfo } from './libraryLocation';
import { loadCustomRules, saveCustomRules } from './OrganizeRulesModal';
import { OrganizePreview } from './OrganizePreview';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { DEFAULT_ACCENT, isAccentMode } from './accents';
import { SettingsPage, type AccentOption, type ThemeOption } from './SettingsPage';
import { DesktopWindowControls } from './DesktopWindowControls';
import {
  OVERSCAN_ROWS,
  VIRTUAL_WINDOW_STEP_ROWS,
  clampWindow,
  stableWindowRowsFor,
  virtualSurfaceHeight,
  windowRowsFor,
  type GalleryMetrics,
} from './virtualWindow';

export {
  OVERSCAN_ROWS,
  VIRTUAL_WINDOW_STEP_ROWS,
  clampWindow,
  stableWindowRowsFor,
  virtualSurfaceHeight,
  windowRowsFor,
} from './virtualWindow';
export type { GalleryMetrics } from './virtualWindow';

type ViewMode = 'grid' | 'list';
type SortMode = 'name' | 'size' | 'modified';
type ResolvedTheme = 'light' | 'dark';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatModifiedTime(value: number): string {
  if (!value) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function imageFileRef(image: ImageEntry): FileRef {
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

export function skippedReasonLabel(reason: ImportSkippedFile['reason']): string {
  switch (reason) {
    case 'no-extension':
      return '无扩展名';
    case 'unsupported-format':
      return '不支持的格式';
    default:
      return reason;
  }
}

export function conflictReasonLabel(reason: string): string {
  switch (reason) {
    case 'source-missing':
      return '源文件缺失';
    case 'target-exists':
      return '目标已存在';
    case 'move-failed':
      return '移动失败';
    default:
      return reason;
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const BLUR_STORAGE_KEY = 'kanitsu-blurred-images';
const PINNED_COVERS_KEY = 'kanitsu-pinned-covers';

// 子文件夹预览图预加载参数：进入某文件夹时，为每个子文件夹的前若干张
// 缩略图预热缓存（见下方 useEffect），点进子文件夹时网格立即可用。
const PRELOAD_PER_FOLDER = 12;
const PRELOAD_MAX_FOLDERS = 16;

// —— 图片网格虚拟化（性能优化 P2）——
// 卡片尺寸固定（aspect-[4/3] + 定宽列），因此行高可精确度量。滚动时只挂载
// 可视区 ± OVERSCAN_ROWS 的行，其余行以绝对定位撑起总高度（与安卓相册
// RecyclerView 的"只实例化可视 ItemView + 缓冲区"同思路）。
// 网格常量随视口变化：桌面 180px/16px；移动端（<1024px）130px/10px。
// 与 styles.css 的移动端媒体查询成对对齐：保证虚拟化计算的列数 == CSS 实际渲染列数，
// 避免"JS 按 N 列切片、CSS 却渲染 M 列"导致的卡片变窄/错位/滚动高度失真。
const LIST_FOLDER_CARD_HEIGHT = 88;
const LIST_IMAGE_CARD_HEIGHT = 72;

function gridUnits(viewMode: ViewMode) {
  if (viewMode === 'list') return { minCard: 0, gap: 6, fixedCols: 1 };
  const mobile = typeof window !== 'undefined' && window.innerWidth < 1024;
  if (mobile) return { minCard: 130, gap: 10, fixedCols: undefined };
  return { minCard: 180, gap: 16, fixedCols: undefined };
}
export function loadPinnedCovers(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PINNED_COVERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function savePinnedCovers(covers: Record<string, string>): void {
  try {
    localStorage.setItem(PINNED_COVERS_KEY, JSON.stringify(covers));
  } catch {
    // ignore storage errors
  }
}

export function loadBlurredImages(): ReadonlySet<string> {
  try {
    // 旧版按相册（文件夹）存储，现改为逐图标记，作废旧键。
    localStorage.removeItem('kanitsu-blurred-albums');
    const raw = localStorage.getItem(BLUR_STORAGE_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

export function saveBlurredImages(paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLUR_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage errors
  }
}

export function isImageBlurred(relPath: string | undefined, blurred: ReadonlySet<string>): boolean {
  return !!relPath && blurred.has(relPath);
}

export function LibraryBrowser({
  picker,
  store,
  index,
  enableRaw,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
  /** 是否收录主流相机 RAW(桌面开启;需配套平台解码管线支持)。 */
  enableRaw?: boolean;
}) {
  // 首帧同步水合：localStorage 读取是同步的，能在首次渲染前拿到上次会话的
  // 图库结构，侧栏"全部图包"与图包列表不必等 IndexedDB + IPC 的异步加载
  // 结束才"慢一拍"弹出。loadOrScan 完成后仍会用权威数据整体覆盖。
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(readSnapshotMirror);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'info' | 'success' | 'error'>('info');
  const [organizePreview, setOrganizePreview] = useState<OrganizeBinding[] | null>(null);
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null);
  const [lastManifest, setLastManifest] = useState<OrganizeManifest | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organizeProgress, setOrganizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importReport, setImportReport] = useState<ImportTask | null>(null);
  const [showImportReport, setShowImportReport] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'folder'; folder: FolderNode }
    | { kind: 'folders'; folders: FolderNode[] }
    | { kind: 'image'; image: ImageEntry }
    | null
  >(null);
  const [promptState, setPromptState] = useState<{
    kind: 'rename-image' | 'rename-folder' | 'create-folder';
    title: string;
    label: string;
    initialValue: string;
    image?: ImageEntry;
    folder?: FolderNode;
  } | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [blurredImages, setBlurredImages] = useState<ReadonlySet<string>>(() => loadBlurredImages());
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState<ThemeOption>(() => {
    const saved = localStorage.getItem('kanitsu-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    // 与移动端 loadThemeMode 保持一致：首启跟随系统深浅色。
    return 'system';
  });
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  const [accent, setAccent] = useState<AccentOption>(() => {
    const saved = localStorage.getItem('kanitsu-accent');
    return isAccentMode(saved) ? saved : DEFAULT_ACCENT;
  });
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem('kanitsu-view-mode') === 'list' ? 'list' : 'grid',
  );
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    localStorage.getItem('kanitsu-inspector-open') === '1',
  );
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [showNames, setShowNames] = useState(true);
  const [selectedImageIds, setSelectedImageIds] = useState<ReadonlySet<string>>(new Set());
  const lastSelectedImageRef = useRef<string | null>(null);
  // 图包也能像图片一样勾选：两套选择集互不干扰，工具栏/检查器按内容分派动作。
  const [selectedFolderIds, setSelectedFolderIds] = useState<ReadonlySet<string>>(new Set());
  const lastSelectedFolderRef = useRef<string | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    // 手机竖屏（<1024px）默认收起侧栏；桌面端沿用本地记忆。
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return true;
    return localStorage.getItem('kanitsu-sidebar-hidden') === '1';
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const value = Number(localStorage.getItem('kanitsu-sidebar-width'));
    return Number.isFinite(value) && value >= 200 ? Math.min(value, 360) : 304;
  });
  const [customRules, setCustomRules] = useState<CustomOrganizeRule[]>(() => loadCustomRules());
  const [showSettings, setShowSettings] = useState(false);
  // 首次运行（桌面端）的保存位置确认弹窗：未确认过才弹，见下方启动 effect。
  const [locationPrompt, setLocationPrompt] = useState<LibraryLocationInfo | null>(null);
  const libraryRootRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuModel | null>(null);
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>(() => loadPinnedCovers());
  const [coverPickerFolder, setCoverPickerFolder] = useState<FolderNode | null>(null);
  // 前进/后退导航历史（浏览器/资源管理器风格）：栈 + 当前位置指针。
  const [nav, setNav] = useState<NavHistory>(() => createNavHistory());
  // 最近一次“已入栈”的目录 id：后退/前进自身触发的选中变化用它来抑制重复记录。
  const lastRecordedFolderRef = useRef<string | null>(null);

  // 同步镜像的签名：指纹 + 目录/图片数量。三者都不变时（如 focus 自动刷新
  // 的重复扫描）跳过重写，避免对大快照做无谓的 stringify。
  const mirrorKeyRef = useRef('');

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
    const mirrorKey = `${next.fingerprint}|${Object.keys(next.folders).length}|${Object.keys(next.images).length}`;
    if (mirrorKey !== mirrorKeyRef.current) {
      mirrorKeyRef.current = mirrorKey;
      writeSnapshotMirror(next);
    }
  }, []);

  // 记录每一次有效的文件夹导航（除前进/后退自身外）：截断当前位置之后的历史，
  // 把新的当前位置追加进栈（与浏览器/资源管理器行为一致）。
  useEffect(() => {
    const current = selectedFolderId || snapshot?.rootId || '';
    if (!current || current === lastRecordedFolderRef.current) return;
    lastRecordedFolderRef.current = current;
    setNav((prev) => recordNav(prev, current));
  }, [selectedFolderId, snapshot]);

  // 启动时把本地保存的日志等级同步给主进程：否则缩略图调试日志要等
  // “打开设置页”触发 setLogLevel 后才会开始记录。
  useEffect(() => {
    void window.kanitsuDesktop?.setLogLevel?.(getLogLevelPref());
  }, []);

  // —— 内容区滚动位置记忆：按目录保存/恢复，返回上一级再回来时停留在原处 ——
  // （滚动处理函数与虚拟化/方向预取逻辑整体移到了 folderImages 之后，见下方。）

  const notify = useCallback((text: string, kind?: 'info' | 'success' | 'error') => {
    const detected = kind ?? (/失败|错误/.test(text) ? 'error' : (/完成|成功|^已/.test(text) ? 'success' : 'info'));
    setMessage(text);
    setMessageKind(detected);
  }, []);

  // Persist sidebar appearance across sessions.
  useEffect(() => {
    try {
      localStorage.setItem('kanitsu-sidebar-hidden', sidebarHidden ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }, [sidebarHidden]);

  useEffect(() => {
    try {
      localStorage.setItem('kanitsu-sidebar-width', String(sidebarWidth));
    } catch {
      // Ignore storage errors.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem('kanitsu-view-mode', viewMode);
      localStorage.setItem('kanitsu-inspector-open', inspectorOpen ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }, [inspectorOpen, viewMode]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const handleSystemThemeChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'light' : 'dark');
    };
    media.addEventListener?.('change', handleSystemThemeChange);
    return () => media.removeEventListener?.('change', handleSystemThemeChange);
  }, []);

  const effectiveTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.colorScheme = effectiveTheme;
    try {
      localStorage.setItem('kanitsu-theme', theme);
      localStorage.setItem('kanitsu-accent', accent);
    } catch {
      // Ignore storage errors.
    }
  }, [accent, effectiveTheme, theme]);

  // Startup: load the cached index (no full re-scan). Fallback scans + persists.
  useEffect(() => {
    void (async () => {
      applySnapshot(await loadOrScan(store, index, { enableRaw: enableRaw ?? false }));
    })();
  }, [store, index, applySnapshot, enableRaw]);

  // Mutation / explicit refresh: re-scan from disk and persist the fresh index.
  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index, { enableRaw: enableRaw ?? false });
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot, enableRaw]);

  // 自动刷新：窗口重新获得焦点 / 从最小化恢复时重扫图库，取代侧栏里的手动
  // “刷新图库”按钮（导入、整理等变更操作仍各自触发刷新）。导入/整理进行中
  // 跳过；1 秒内的重复 focus/visibilitychange 只扫一次，也覆盖刷新在途的情况。
  const autoRefreshAtRef = useRef(0);
  useEffect(() => {
    if (busy) return;
    const runAutoRefresh = () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || now - autoRefreshAtRef.current < 1000) return;
      autoRefreshAtRef.current = now;
      void refresh();
    };
    window.addEventListener('focus', runAutoRefresh);
    document.addEventListener('visibilitychange', runAutoRefresh);
    return () => {
      window.removeEventListener('focus', runAutoRefresh);
      document.removeEventListener('visibilitychange', runAutoRefresh);
    };
  }, [busy, refresh]);

  // Auto-dismiss the toast message after a short delay (like the demo).
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => notify(''), 3500);
    return () => clearTimeout(t);
  }, [message]);

  // 首次运行（仅桌面端）：确认图包的保存位置。主进程已按默认目录就绪，用户可以
  // 直接确认，也可以先改到自选目录——所以确认后重扫一次，别让界面停在旧图库上。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await fetchLibraryLocation();
      if (!cancelled && shouldPromptLibraryLocation(info)) setLocationPrompt(info);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const searchTerm = searchQuery.trim().toLowerCase();
  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    if (id === snapshot.rootId) return [];
    const images = directImagesOf(snapshot, id);
    const filtered = searchTerm ? images.filter((img) => img.name.toLowerCase().includes(searchTerm)) : images;
    return [...filtered].sort((a, b) => {
      if (sortMode === 'size') return b.size - a.size;
      if (sortMode === 'modified') return b.mtime - a.mtime;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [snapshot, selectedFolderId, searchTerm, sortMode]);

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    const folders = childrenOf(snapshot, id);
    const filtered = searchTerm ? folders.filter((f) => f.name.toLowerCase().includes(searchTerm)) : folders;
    if (sortMode === 'name') return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const stats = new Map<string, { bytes: number; latestModified: number }>();
    filtered.forEach((folder) => {
      const images = imagesOf(snapshot, folder.id);
      stats.set(folder.id, {
        bytes: images.reduce((sum, image) => sum + image.size, 0),
        latestModified: images.reduce((latest, image) => Math.max(latest, image.mtime), 0),
      });
    });
    return [...filtered].sort((a, b) => {
      const aStats = stats.get(a.id)!;
      const bStats = stats.get(b.id)!;
      return sortMode === 'size'
        ? bStats.bytes - aStats.bytes
        : bStats.latestModified - aStats.latestModified;
    });
  }, [snapshot, selectedFolderId, searchTerm, sortMode]);

  const childFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return childFolders.map((child) => {
      const images = imagesOf(snapshot, child.id);
      const cover = pickCover(images, { preferredId: pinnedCovers[child.id] });
      const covers = [
        ...(cover ? [snapshot.images[cover.imageId]] : []),
        ...images.filter((image) => image.id !== cover?.imageId),
      ].filter((image): image is ImageEntry => Boolean(image)).slice(0, 3);
      return { folder: child, covers };
    });
  }, [snapshot, childFolders, pinnedCovers]);

  // —— 内容区滚动位置记忆 + 图片网格虚拟化（P2）+ 滚动方向预取（P3）——
  // 统一放在 folderImages/childFolders 之后：虚拟化窗口与方向预取都依赖
  // folderImages，且滚动时须同步 scrollTop 驱动窗口重算。
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const scrollSaveFrameRef = useRef<number | null>(null);
  const currentFolderId = selectedFolderId || snapshot?.rootId || '';
  const currentFolderIdRef = useRef(currentFolderId);
  const [scrollTop, setScrollTop] = useState(0);
  const [galleryMetrics, setGalleryMetrics] = useState<GalleryMetrics>({
    cols: 1,
    cardHeight: 0,
    rowHeight: 0,
    galleryTop: 0,
    viewportH: 0,
  });
  const galleryMetricsRef = useRef<GalleryMetrics>(galleryMetrics);
  const gallerySurfaceRef = useRef<HTMLDivElement | null>(null);
  const probeCardRef = useRef<HTMLDivElement | null>(null);
  // 子文件夹区同样虚拟化（目录多时文件夹卡片也是全量渲染的卡顿源）。
  const [folderMetrics, setFolderMetrics] = useState<GalleryMetrics>({
    cols: 1,
    cardHeight: 0,
    rowHeight: 0,
    galleryTop: 0,
    viewportH: 0,
  });
  const folderMetricsRef = useRef<GalleryMetrics>(folderMetrics);
  const folderSurfaceRef = useRef<HTMLDivElement | null>(null);
  const folderProbeCardRef = useRef<HTMLDivElement | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  const geometryStableRef = useRef(false);
  const restoredFolderRef = useRef<string | null>(null);
  const restoredMainRef = useRef<HTMLElement | null>(null);

  // 滚动时（rAF 节流）记录该目录的滚动位置；只在虚拟窗口（文件夹/图片两区）
  // 发生变化时才 setScrollTop 触发整树重渲——小幅度滚动（仍在同一行内）不重渲，
  // 护住目录多/图多场景的帧率。
  const lastWindowKeyRef = useRef('');
  const scrollAnimPauseTimerRef = useRef<number | null>(null);
  const nativeScrollEndRef = useRef(false);
  // 滚动开始时给主区加 .sk-scrolling；优先用 scrollend 恢复，旧内核用短延时兜底。
  const setScrollingClass = (node: HTMLElement, scrolling: boolean): void => {
    node.classList.toggle('sk-scrolling', scrolling);
    setThumbnailPreloadPaused(scrolling);
  };
  const onMainScroll = useCallback(() => {
    const el = mainScrollRef.current;
    if (!el || !currentFolderId) return;
    const scrolledFolderId = currentFolderId;
    setScrollingClass(el, true);
    if (!nativeScrollEndRef.current) {
      if (scrollAnimPauseTimerRef.current != null) window.clearTimeout(scrollAnimPauseTimerRef.current);
      scrollAnimPauseTimerRef.current = window.setTimeout(() => {
        scrollAnimPauseTimerRef.current = null;
        const node = mainScrollRef.current;
        if (node) setScrollingClass(node, false);
      }, 180);
    }
    if (scrollSaveFrameRef.current != null) return; // 已排队待写
    scrollSaveFrameRef.current = requestAnimationFrame(() => {
      scrollSaveFrameRef.current = null;
      const t0 = performance.now();
      if (currentFolderIdRef.current !== scrolledFolderId) return;
      const node = mainScrollRef.current;
      if (!node) return;
      const st = node.scrollTop;
      scrollPositionsRef.current.set(scrolledFolderId, st); // 位置记忆始终更新
      const fw = stableWindowRowsFor(folderMetricsRef.current, st, childFolderCards.length);
      const gw = stableWindowRowsFor(galleryMetricsRef.current, st, folderImages.length);
      const key = `${scrolledFolderId}|${viewMode}|${fw.first}:${fw.last}|${gw.first}:${gw.last}`;
      if (key !== lastWindowKeyRef.current) {
        lastWindowKeyRef.current = key;
        setScrollTop(st);
      }
      // 上报滚动回调耗时（设置页“调试→帧率与滚动性能”面板）。
      recordScrollFrame(performance.now() - t0);
    });
  }, [currentFolderId, childFolderCards.length, folderImages.length, viewMode]);

  useLayoutEffect(() => {
    currentFolderIdRef.current = currentFolderId;
  }, [currentFolderId]);

  // 主滚动容器尺寸变化（窗口缩放 / 侧栏调宽）时重新度量。
  useEffect(() => {
    if (showSettings) return;
    const main = mainScrollRef.current;
    if (!main) return;
    nativeScrollEndRef.current = 'onscrollend' in main;
    const finishScrolling = (): void => setScrollingClass(main, false);
    if (nativeScrollEndRef.current) main.addEventListener('scrollend', finishScrolling);
    const ro = new ResizeObserver(() => setLayoutTick((t) => t + 1));
    ro.observe(main);
    return () => {
      ro.disconnect();
      if (nativeScrollEndRef.current) main.removeEventListener('scrollend', finishScrolling);
      nativeScrollEndRef.current = false;
      if (scrollSaveFrameRef.current != null) {
        cancelAnimationFrame(scrollSaveFrameRef.current);
        scrollSaveFrameRef.current = null;
      }
      if (scrollAnimPauseTimerRef.current != null) {
        window.clearTimeout(scrollAnimPauseTimerRef.current);
        scrollAnimPauseTimerRef.current = null;
      }
      main.classList.remove('sk-scrolling');
      setThumbnailPreloadPaused(false);
    };
  }, [showSettings]);

  // 度量两个虚拟表面（子图包 / 图片）的列数、卡片高度、真实内容偏移与视口高度。
  // 网格媒体高度由当前列宽直接计算，探测卡只负责标题区高度，避免视图切换时读取到
  // 上一帧列数对应的探测宽度；列表则使用与 CSS 一致的固定行高。子图包几何改变后
  // 会再收敛一次，因为它会推移后方图片表面的内容坐标。
  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    geometryStableRef.current = false;
    const snapPixel = (value: number): number => Math.round(value * 64) / 64;
    const measure = (
      surface: HTMLDivElement | null,
      probe: HTMLDivElement | null,
      listCardHeight: number,
      fallbackCaptionH: number,
      mediaAspect: number,
    ): GalleryMetrics => {
      if (!surface) {
        return { cols: 1, cardHeight: 0, rowHeight: 0, galleryTop: 0, viewportH: 0 };
      }
      const sectionW = surface.clientWidth;
      const { minCard, gap, fixedCols } = gridUnits(viewMode);
      const cols = fixedCols ?? Math.max(1, Math.floor((sectionW + gap) / (minCard + gap)));
      const estCardW = (sectionW - gap * (cols - 1)) / cols;
      const media = probe?.querySelector<HTMLElement>('.desktop-package-cover, .desktop-photo-frame');
      const measuredCaptionH = probe && media
        ? Math.max(0, probe.offsetHeight - media.offsetHeight)
        : fallbackCaptionH;
      const cardHeight = snapPixel(viewMode === 'list'
        ? listCardHeight
        : estCardW * mediaAspect + measuredCaptionH);
      const rowHeight = snapPixel(cardHeight + gap);
      const offset = snapPixel(
        surface.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop,
      );
      return { cols, cardHeight, rowHeight, galleryTop: offset, viewportH: main.clientHeight };
    };
    const same = (a: GalleryMetrics, b: GalleryMetrics): boolean =>
      a.cols === b.cols &&
      a.cardHeight === b.cardHeight &&
      a.rowHeight === b.rowHeight &&
      a.galleryTop === b.galleryTop &&
      a.viewportH === b.viewportH;
    const nextFolder = measure(
      folderSurfaceRef.current,
      folderProbeCardRef.current,
      LIST_FOLDER_CARD_HEIGHT,
      46,
      10.5 / 16,
    );
    const nextGallery = measure(
      gallerySurfaceRef.current,
      probeCardRef.current,
      LIST_IMAGE_CARD_HEIGHT,
      42,
      3 / 4,
    );
    const folderChanged = !same(folderMetrics, nextFolder);
    const galleryChanged = !same(galleryMetrics, nextGallery);
    geometryStableRef.current = !folderChanged && !galleryChanged;
    if (folderChanged) setFolderMetrics(nextFolder);
    if (galleryChanged) setGalleryMetrics(nextGallery);
  }, [folderImages.length, childFolderCards.length, searchQuery, selectedFolderId, snapshot, sidebarHidden, sidebarWidth, layoutTick, viewMode, showNames, showSettings, inspectorOpen, folderMetrics, galleryMetrics]);

  // 最新度量同步到 ref：滚动窗口计算/方向预取在 rAF/effect 里读取，避免陈旧值。
  useLayoutEffect(() => {
    galleryMetricsRef.current = galleryMetrics;
    folderMetricsRef.current = folderMetrics;
  }, [galleryMetrics, folderMetrics]);

  const lastScrollTopRef = useRef(0);
  const lastDirectionalKeyRef = useRef('');
  const directionalTokenRef = useRef<{ cancelled: boolean } | null>(null);

  // 切换目录或主区重新挂载后恢复一次历史位置。视图/尺寸变化时不重写
  // 旧像素坐标，只读取浏览器 clamp 后的实际位置并同步虚拟窗口。
  useLayoutEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    if (!geometryStableRef.current) return;
    if (childFolderCards.length > 0 && folderMetrics.rowHeight <= 0) return;
    if (folderImages.length > 0 && galleryMetrics.rowHeight <= 0) return;
    const needsRestore = restoredFolderRef.current !== currentFolderId || restoredMainRef.current !== el;
    if (needsRestore) {
      el.scrollTop = scrollPositionsRef.current.get(currentFolderId) ?? 0;
      restoredFolderRef.current = currentFolderId;
      restoredMainRef.current = el;
    }
    const actualTop = el.scrollTop;
    scrollPositionsRef.current.set(currentFolderId, actualTop);
    const folderWindow = stableWindowRowsFor(folderMetrics, actualTop, childFolderCards.length);
    const galleryWindow = stableWindowRowsFor(galleryMetrics, actualTop, folderImages.length);
    lastWindowKeyRef.current = `${currentFolderId}|${viewMode}|${folderWindow.first}:${folderWindow.last}|${galleryWindow.first}:${galleryWindow.last}`;
    lastScrollTopRef.current = actualTop;
    lastDirectionalKeyRef.current = '';
    if (directionalTokenRef.current) directionalTokenRef.current.cancelled = true;
    directionalTokenRef.current = null;
    setScrollTop((current) => (current === actualTop ? current : actualTop));
  }, [
    selectedFolderId,
    snapshot,
    galleryMetrics,
    folderMetrics,
    currentFolderId,
    childFolderCards.length,
    folderImages.length,
    showSettings,
    viewMode,
    layoutTick,
  ]);

  // —— 滚动方向预取（P3）：按方向把“下一屏”缩略图以优先级 1 排入 worker，
  // 抢在整目录后台预热（优先级 2）之前生成，快速滚动时白格明显减少。
  // 与安卓 RecyclerView 的 prefetch（滚动时预解码下一屏）同思路。 ——
  useEffect(() => {
    if (folderImages.length === 0 || !isPrefetchEnabled()) return;
    const st = scrollTop;
    const prev = lastScrollTopRef.current;
    const dir = st > prev ? 'down' : st < prev ? 'up' : null;
    lastScrollTopRef.current = st;
    if (!dir) return;
    const m = galleryMetricsRef.current;
    if (m.rowHeight <= 0 || m.viewportH <= 0 || m.cols <= 0) return;
    const totalRows = Math.ceil(folderImages.length / m.cols);
    const gs = Math.max(0, st - m.galleryTop);
    const firstRow = Math.max(0, Math.floor(gs / m.rowHeight) - OVERSCAN_ROWS);
    const lastRow = Math.min(totalRows, Math.ceil((gs + m.viewportH) / m.rowHeight) + OVERSCAN_ROWS);
    const screenRows = Math.max(1, Math.ceil(m.viewportH / m.rowHeight));
    const r0 = dir === 'down' ? lastRow : firstRow - screenRows;
    const r1 = dir === 'down' ? lastRow + screenRows : firstRow;
    const c0 = Math.max(0, r0) * m.cols;
    const c1 = Math.min(folderImages.length, Math.max(0, r1) * m.cols);
    if (c1 <= c0) return;
    const key = `${dir}:${c0}:${c1}`;
    if (key === lastDirectionalKeyRef.current) return;
    lastDirectionalKeyRef.current = key;
    if (directionalTokenRef.current) directionalTokenRef.current.cancelled = true;
    const token = { cancelled: false };
    directionalTokenRef.current = token;
    const targets: FileRef[] = folderImages.slice(c0, c1).map((img) => ({
      id: img.fileRefId ?? img.id,
      name: img.name,
      kind: 'file',
      mtime: img.mtime,
      size: img.size,
    }));
    preloadThumbnails(store, targets, {
      priority: THUMB_PRIORITY_DIRECTIONAL,
      // 已排在整目录预取（优先级 2）队尾的文件：重新以优先 1 请求并替换缓存
      // Promise，让 worker 先出下一屏的图（否则合并返回慢 Promise = 没预取）。
      recheck: true,
      shouldStop: () => token.cancelled,
    });
    logDebug('prefetch', `滚动方向预取：${targets.length} 张（${c0}–${c1}，${dir}）`);
  }, [scrollTop, folderImages, store]);

  // 预加载子文件夹的预览图（优先级 3）：进入一个文件夹时，在空闲时间后台为每个
  // 子文件夹前若干张缩略图预热缓存（限并发、可取消），点进子文件夹时网格立即可用。
  // 已缓存的条目会立即命中，因此重复进入同一父目录几乎无成本。
  useEffect(() => {
    if (!snapshot) return;
    const token = { cancelled: false };
    const targets: FileRef[] = [];
    const pinnedTargets: FileRef[] = [];
    for (const child of childFolders) {
      if (targets.length >= PRELOAD_MAX_FOLDERS) break;
      const card = childFolderCards.find((item) => item.folder.id === child.id);
      const pinned = card?.covers.find((image) => image.id === pinnedCovers[child.id]);
      if (pinned) {
        pinnedTargets.push({ id: pinned.fileRefId ?? pinned.id, name: pinned.name, kind: 'file', mtime: pinned.mtime, size: pinned.size });
      }
      for (const img of directImagesOf(snapshot, child.id).slice(0, PRELOAD_PER_FOLDER)) {
        targets.push({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file', mtime: img.mtime, size: img.size });
      }
    }
    if (targets.length === 0 && pinnedTargets.length === 0) return;
    if (!isPrefetchEnabled()) return; // 设置页“调试→预取开关”可关闭
    const schedule = (work: () => void): void => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(work, { timeout: 1500 });
      } else {
        setTimeout(work, 0);
      }
    };
    if (targets.length > 0) {
      schedule(() => preloadThumbnails(store, targets, { priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled }));
    }
    if (pinnedTargets.length > 0) {
      schedule(() => preloadThumbnails(store, pinnedTargets, {
        maxSize: COVER_THUMBNAIL_SIZE,
        priority: THUMB_PRIORITY_SUBFOLDER,
        shouldStop: () => token.cancelled,
      }));
    }
    logDebug('prefetch', `子文件夹预取 P2：${targets.length} 张`);
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, childFolders, childFolderCards, pinnedCovers, store]);

  // 当前图包使用独立的优先级 2。切换图包时，这批请求会把同键的全库预热
  // 从优先级 4 提升；主进程按缓存键合并任务，因此只迁移队列位置，不重复解码。
  useEffect(() => {
    if (!snapshot || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const targets: FileRef[] = folderImages.map((img) => ({
      id: img.fileRefId ?? img.id,
      name: img.name,
      kind: 'file',
      mtime: img.mtime,
      size: img.size,
    }));
    if (targets.length === 0) return;
    preloadThumbnails(store, targets, {
      concurrency: 2,
      priority: THUMB_PRIORITY_CURRENT_DIR,
      recheck: true,
      shouldStop: () => token.cancelled,
    });
    logDebug('prefetch', `当前图包预取：${targets.length} 张`);
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, selectedFolderId, folderImages, store]);

  // 全库缩略图在应用空闲后以最低优先级生成并载入会话缓存。滚动开始时调度器会
  // 暂停这一级任务，只保留可见项和下一屏预取；停止滚动后从原位置继续。即使
  // 渲染端 LRU 后续淘汰了较早的 Blob，Electron 磁盘缓存仍保留已编码缩略图，
  // 再次浏览只需读取缓存，不会现场解码原图。
  useEffect(() => {
    if (!snapshot || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const targets: FileRef[] = Object.values(snapshot.images).map((img) => ({
      id: img.fileRefId ?? img.id,
      name: img.name,
      kind: 'file',
      mtime: img.mtime,
      size: img.size,
    }));
    if (targets.length === 0) return;
    const start = (): void => {
      preloadThumbnails(store, targets, {
        concurrency: 2,
        priority: THUMB_PRIORITY_WARMUP,
        shouldStop: () => token.cancelled,
      });
      logDebug('prefetch', `全库空闲预热：${targets.length} 张`);
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(start, { timeout: 2000 });
    } else {
      window.setTimeout(start, 250);
    }
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, store]);

  const selectedFolder = snapshot?.folders[selectedFolderId || snapshot?.rootId || ''] ?? null;
  const rootFolder = snapshot?.folders[snapshot.rootId] ?? null;
  const runtimeLabel =
    (window as { kanitsuDesktop?: { platform?: string } }).kanitsuDesktop?.platform === 'electron'
      ? 'Electron'
      : 'Web';
  const isRootSelected = !selectedFolderId || selectedFolderId === snapshot?.rootId;
  const selectedImages = useMemo(
    () => folderImages.filter((image) => selectedImageIds.has(image.id)),
    [folderImages, selectedImageIds],
  );
  const selectedFolders = useMemo(
    () => childFolders.filter((folder) => selectedFolderIds.has(folder.id)),
    [childFolders, selectedFolderIds],
  );
  // 隐私预览的作用范围：所选图片 + 所选图包（含子目录）里的每一张图片。
  const selectionBlurTargets = useMemo(() => {
    const relPaths = new Set(selectedImages.map((image) => image.relPath));
    if (snapshot) {
      for (const folder of selectedFolders) {
        for (const image of imagesOf(snapshot, folder.id)) relPaths.add(image.relPath);
      }
    }
    return relPaths;
  }, [selectedFolders, selectedImages, snapshot]);
  const selectionAllBlurred = useMemo(
    () => selectionBlurTargets.size > 0 && [...selectionBlurTargets].every((relPath) => blurredImages.has(relPath)),
    [blurredImages, selectionBlurTargets],
  );
  // 图包选择的汇总数据（含各自子目录），供工具栏与检查器共用。
  const selectedFolderStats = useMemo(() => {
    let images = 0;
    let bytes = 0;
    let childFoldersCount = 0;
    if (snapshot) {
      for (const folder of selectedFolders) {
        childFoldersCount += folder.childCount;
        for (const image of imagesOf(snapshot, folder.id)) {
          images += 1;
          bytes += image.size;
        }
      }
    }
    return { images, bytes, childFolders: childFoldersCount };
  }, [selectedFolders, snapshot]);
  const selectionCount = selectedImages.length + selectedFolders.length;
  const selectedFolderCovers = useMemo(
    () => childFolderCards
      .filter((card) => selectedFolderIds.has(card.folder.id))
      .map((card) => card.covers[0])
      .filter((image): image is ImageEntry => Boolean(image)),
    [childFolderCards, selectedFolderIds],
  );
  const allLibraryImages = useMemo(() => (snapshot ? Object.values(snapshot.images) : []), [snapshot]);
  const libraryBytes = useMemo(
    () => allLibraryImages.reduce((sum, image) => sum + image.size, 0),
    [allLibraryImages],
  );
  // 文件夹级模糊状态：统计当前相册（含所有子文件夹）里逐图标记的数量。
  const folderAllImages = useMemo(
    () => (snapshot && selectedFolder ? imagesOf(snapshot, selectedFolder.id) : []),
    [snapshot, selectedFolder],
  );
  const folderBytes = useMemo(
    () => folderAllImages.reduce((sum, image) => sum + image.size, 0),
    [folderAllImages],
  );
  const blurredInFolderCount = useMemo(
    () => folderAllImages.reduce((n, img) => n + (blurredImages.has(img.relPath) ? 1 : 0), 0),
    [folderAllImages, blurredImages],
  );

  // Breadcrumb path from the library root to the selected folder.
  const crumbs = useMemo(() => {
    if (!snapshot || !selectedFolder) return [];
    const chain: FolderNode[] = [];
    let node: FolderNode | undefined = selectedFolder;
    while (node) {
      chain.unshift(node);
      node = node.parentId ? snapshot.folders[node.parentId] : undefined;
    }
    return chain;
  }, [snapshot, selectedFolder]);

  const cover = useMemo(() => {
    if (!inspectorOpen || !selectedFolder || !snapshot) return null;
    return pickCover(folderAllImages, { preferredId: pinnedCovers[selectedFolder.id] });
  }, [folderAllImages, inspectorOpen, snapshot, selectedFolder, pinnedCovers]);

  useEffect(() => {
    setSelectedImageIds(new Set());
    lastSelectedImageRef.current = null;
    setSelectedFolderIds(new Set());
    lastSelectedFolderRef.current = null;
  }, [currentFolderId, searchQuery]);

  // 图包被删除/重命名后（id 随 relPath 变化）把失效的勾选摘掉，避免计数虚高。
  useEffect(() => {
    if (!snapshot) return;
    setSelectedFolderIds((current) => {
      if (current.size === 0) return current;
      const next = new Set<string>();
      for (const id of current) if (snapshot.folders[id]) next.add(id);
      return next.size === current.size ? current : next;
    });
  }, [snapshot]);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 仅切换选中目录（不含任何历史记录逻辑，供前进/后退与普通导航复用）。
  const selectFolderRaw = useCallback(
    (folderId: string) => {
      const outgoingId = currentFolderIdRef.current;
      const main = mainScrollRef.current;
      if (main && outgoingId) scrollPositionsRef.current.set(outgoingId, main.scrollTop);
      if (scrollSaveFrameRef.current != null) {
        cancelAnimationFrame(scrollSaveFrameRef.current);
        scrollSaveFrameRef.current = null;
      }
      // 立即使已排队的旧目录 rAF 失效，不等下一次 layout effect。
      currentFolderIdRef.current = folderId;
      setSelectedFolderId(folderId);
      const folder = snapshot?.folders[folderId];
      if (folder && folder.childCount > 0) {
        setExpandedFolders((prev) => (prev.has(folderId) ? prev : new Set(prev).add(folderId)));
      }
    },
    [snapshot],
  );

  const handleSelectFolder = useCallback(
    (folder: FolderNode) => {
      selectFolderRaw(folder.id);
    },
    [selectFolderRaw],
  );

  const handleNavBack = useCallback(() => {
    const target = backTarget(nav);
    if (target && snapshot?.folders[target]) {
      // 同步“已入栈”标记，让记录 effect 跳过这一次自身触发的选中变化。
      lastRecordedFolderRef.current = target;
      selectFolderRaw(target);
    }
    setNav((prev) => moveBack(prev));
  }, [nav, snapshot, selectFolderRaw]);

  const handleNavForward = useCallback(() => {
    const target = forwardTarget(nav);
    if (target && snapshot?.folders[target]) {
      lastRecordedFolderRef.current = target;
      selectFolderRaw(target);
    }
    setNav((prev) => moveForward(prev));
  }, [nav, snapshot, selectFolderRaw]);

  // 鼠标前进/后退键（XButton1=button 3 / XButton2=button 4）触发导航：
  // 浏览模式 → 文件夹后退/前进；查看器打开 → 上一张/下一张图片；
  // 输入框聚焦时不触发。在 mouseup 上立即执行（比 auxclick 更早），并在
  // mousedown/mouseup/auxclick 上 preventDefault，拦掉 Chromium 默认把侧键
  // 当作页面历史导航的行为（主进程 will-navigate 也会兜底阻止整页刷新）。
  useEffect(() => {
    const navigateByMouseButton = (button: number) => {
      if (showSettings) return;
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      if (viewerImageId) {
        const dir = button === 3 ? -1 : 1;
        const idx = folderImages.findIndex((img) => img.id === viewerImageId);
        if (idx >= 0 && folderImages.length > 0) {
          const next = folderImages[(idx + dir + folderImages.length) % folderImages.length]!;
          if (next.id !== viewerImageId) setViewerImageId(next.id);
        }
        return;
      }
      if (button === 3) handleNavBack();
      else handleNavForward();
    };
    const onSideButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === 'mouseup') navigateByMouseButton(event.button);
    };
    window.addEventListener('mousedown', onSideButton);
    window.addEventListener('mouseup', onSideButton);
    window.addEventListener('auxclick', onSideButton);
    return () => {
      window.removeEventListener('mousedown', onSideButton);
      window.removeEventListener('mouseup', onSideButton);
      window.removeEventListener('auxclick', onSideButton);
    };
  }, [viewerImageId, folderImages, handleNavBack, handleNavForward, showSettings]);

  const handleGoRoot = useCallback(() => {
    if (rootFolder) handleSelectFolder(rootFolder);
  }, [rootFolder, handleSelectFolder]);

  const selectImage = useCallback((
    image: ImageEntry,
    checked: boolean,
    shiftKey: boolean,
  ) => {
    setSelectedImageIds((current) => {
      if (shiftKey && lastSelectedImageRef.current) {
        const anchor = folderImages.findIndex((item) => item.id === lastSelectedImageRef.current);
        const target = folderImages.findIndex((item) => item.id === image.id);
        if (anchor >= 0 && target >= 0) {
          const [start, end] = anchor < target ? [anchor, target] : [target, anchor];
          const next = new Set(current);
          folderImages.slice(start, end + 1).forEach((item) => {
            if (checked) next.add(item.id);
            else next.delete(item.id);
          });
          lastSelectedImageRef.current = image.id;
          return next;
        }
      }
      lastSelectedImageRef.current = image.id;
      const next = new Set(current);
      if (checked) next.add(image.id);
      else next.delete(image.id);
      return next;
    });
  }, [folderImages]);

  const selectFolder = useCallback((
    folder: FolderNode,
    checked: boolean,
    shiftKey: boolean,
  ) => {
    setSelectedFolderIds((current) => {
      if (shiftKey && lastSelectedFolderRef.current) {
        const anchor = childFolders.findIndex((item) => item.id === lastSelectedFolderRef.current);
        const target = childFolders.findIndex((item) => item.id === folder.id);
        if (anchor >= 0 && target >= 0) {
          const [start, end] = anchor < target ? [anchor, target] : [target, anchor];
          const next = new Set(current);
          childFolders.slice(start, end + 1).forEach((item) => {
            if (checked) next.add(item.id);
            else next.delete(item.id);
          });
          lastSelectedFolderRef.current = folder.id;
          return next;
        }
      }
      lastSelectedFolderRef.current = folder.id;
      const next = new Set(current);
      if (checked) next.add(folder.id);
      else next.delete(folder.id);
      return next;
    });
  }, [childFolders]);

  const selectAllInView = useCallback(() => {
    setSelectedImageIds(new Set(folderImages.map((image) => image.id)));
    setSelectedFolderIds(new Set(childFolders.map((folder) => folder.id)));
  }, [childFolders, folderImages]);

  const clearSelection = useCallback(() => {
    setSelectedImageIds(new Set());
    lastSelectedImageRef.current = null;
    setSelectedFolderIds(new Set());
    lastSelectedFolderRef.current = null;
  }, []);

  const toggleSelectedBlur = useCallback(() => {
    if (selectionBlurTargets.size === 0) return;
    const allBlurred = selectionAllBlurred;
    setBlurredImages((current) => {
      const next = new Set(current);
      selectionBlurTargets.forEach((relPath) => {
        if (allBlurred) next.delete(relPath);
        else next.add(relPath);
      });
      saveBlurredImages(next);
      return next;
    });
    notify(allBlurred ? '已取消所选项目的隐私预览。' : '已为所选项目开启隐私预览。');
  }, [notify, selectionAllBlurred, selectionBlurTargets]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (showSettings) return;
      if (event.defaultPrevented || document.querySelector('.context-menu, .modal.modal-open')) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !typing && !viewerImageId) {
        event.preventDefault();
        selectAllInView();
      } else if (event.key === 'Escape' && (selectedImageIds.size > 0 || selectedFolderIds.size > 0) && !viewerImageId) {
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, selectAllInView, selectedFolderIds.size, selectedImageIds.size, viewerImageId, showSettings]);

  // In the viewer: switch to a sibling folder (same level) and show its first image.
  const handleViewerSwitchSibling = useCallback(
    (dir: number) => {
      if (!snapshot) return;
      const currentId = selectedFolderId || snapshot.rootId;
      if (currentId === snapshot.rootId) return;
      const parentId = snapshot.folders[currentId]?.parentId ?? snapshot.rootId;
      const siblings = childrenOf(snapshot, parentId).sort((a, b) => a.name.localeCompare(b.name));
      if (siblings.length === 0) return;
      const index = siblings.findIndex((f) => f.id === currentId);
      const next = siblings[(index + dir + siblings.length) % siblings.length]!;
      handleSelectFolder(next);
      const first = directImagesOf(snapshot, next.id)[0];
      if (first) setViewerImageId(first.id);
    },
    [snapshot, selectedFolderId, handleSelectFolder],
  );

  const handleAdd = async () => {
    setBusy(true);
    notify('正在导入…');
    try {
      const task = await importFolder(picker, store, {
        onProgress: (p) =>
          notify(`导入中：已扫描 ${p.scanned}，已复制 ${p.copied}，已跳过 ${p.skipped}`),
      });
      setImportReport(task);
      setShowImportReport(true);
      const next = await refresh();
      const importedTopFolder = Object.values(next.folders).find(
        (folder) => folder.parentId === next.rootId && folder.name === task.targetTopFolder,
      );
      if (importedTopFolder) {
        selectFolderRaw(importedTopFolder.id);
        setExpandedFolders((prev) => {
          const nextSet = new Set(prev);
          nextSet.add(importedTopFolder.id);
          return nextSet;
        });
      }
      notify(
        task.skippedCount > 0
          ? `导入完成：复制 ${task.copiedImageCount} 张，跳过 ${task.skippedCount} 张。`
          : `导入完成：复制 ${task.copiedImageCount} 张。`,
      );
    } catch (err) {
      notify(`导入失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openOrganizePreviewFor = (folder: FolderNode) => {
    if (!snapshot || !folder) return;
    selectFolderRaw(folder.id);
    setOrganizePreview(organizeByFolder(imagesOf(snapshot, folder.id), { customRules }));
    setOrganizeResult(null);
    setOrganizeProgress(null);
  };

  const openOrganizePreview = () => {
    if (selectedFolder) openOrganizePreviewFor(selectedFolder);
  };

  const handleCustomRulesChange = useCallback((rules: CustomOrganizeRule[]) => {
    setCustomRules(rules);
    saveCustomRules(rules);
  }, []);

  const handleApplyOrganize = async () => {
    if (!snapshot || !selectedFolder || !organizePreview) return;
    setOrganizing(true);
    setOrganizeProgress({ done: 0, total: organizePreview.length });
    try {
      const result = await applyOrganize(store, snapshot, selectedFolder.relPath, organizePreview, {
        onProgress: (done, total) => setOrganizeProgress({ done, total }),
      });
      setOrganizePreview(null);
      setOrganizeResult(result);
      setLastManifest(result.manifest);
      await refresh();
      notify(
        result.conflicts.length > 0
          ? `已整理 ${result.appliedCount} 个文件，${result.conflicts.length} 个冲突。`
          : `已整理 ${result.appliedCount} 个文件。`,
      );
    } catch (err) {
      notify(`整理失败：${String(err)}`);
    } finally {
      setOrganizing(false);
      setOrganizeProgress(null);
    }
  };

  const handleUndoOrganize = async () => {
    if (!lastManifest) return;
    setBusy(true);
    notify('正在撤销整理…');
    try {
      const result = await undoOrganize(store, lastManifest);
      setLastManifest(null);
      setOrganizeResult(null);
      await refresh();
      notify(
        result.errors.length > 0
          ? `撤销：已还原 ${result.undone} 个，${result.errors.length} 个错误。`
          : `撤销：已还原 ${result.undone} 个文件。`,
      );
    } catch (err) {
      notify(`撤销失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportFolder = async (folder: FolderNode) => {
    if (!folder) return;
    setExporting(true);
    setExportProgress({ done: 0, total: 0 });
    notify('正在导出 ZIP…');
    try {
      const result = await store.zipLibrary(folder.relPath, (done, total) => {
        setExportProgress({ done, total });
      });
      setExportProgress(null);
      if (result.kind === 'blob' && result.blob) {
        const base = folder.relPath ? folder.relPath.split('/').pop() : '全部图包';
        downloadBlob(result.blob, `${base}.zip`);
        notify(`已导出 ${result.exportedCount} 张图片为 ZIP。`);
      } else if (result.outputPath) {
        notify(`已导出 ${result.exportedCount} 张图片到 ${result.outputPath}。`);
      } else {
        notify(`已导出 ${result.exportedCount} 张图片。`);
      }
    } catch (err) {
      setExportProgress(null);
      notify(`导出失败：${String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleExport = async () => {
    if (selectedFolder) await exportFolder(selectedFolder);
  };

  const performDelete = async (folder: FolderNode = selectedFolder!) => {
    if (!folder || !folder.relPath) return;
    const name = folder.name;
    setBusy(true);
    notify(`正在删除“${name}”…`);
    const parentId = folder.parentId;
    try {
      await deleteLibraryFolder(store, folder.relPath);
      await refresh();
      if (parentId) selectFolderRaw(parentId);
      notify(`已删除“${name}”。`);
    } catch (err) {
      notify(`删除失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = () => {
    if (selectedFolder && selectedFolder.relPath) setDeleteTarget({ kind: 'folder', folder: selectedFolder });
  };
  const requestDeleteImage = (image: ImageEntry) => setDeleteTarget({ kind: 'image', image });
  const requestDeleteFolder = (folder: FolderNode) => setDeleteTarget({ kind: 'folder', folder });

  /** 批量删除所选图包：逐个执行并统计失败，避免一个出错就吞掉整批。 */
  const executeDeleteFolders = async (folders: FolderNode[]) => {
    if (folders.length === 0) return;
    setBusy(true);
    notify(`正在删除 ${folders.length} 个图包…`);
    let ok = 0;
    let failed = 0;
    try {
      for (const folder of folders) {
        try {
          await deleteLibraryFolder(store, folder.relPath);
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      await refresh();
      notify(
        failed > 0 ? `已删除 ${ok} 个图包，失败 ${failed} 个。` : `已删除 ${ok} 个图包。`,
        failed > 0 ? 'error' : 'success',
      );
    } catch (err) {
      notify(`删除失败：${String(err)}`, 'error');
    } finally {
      setBusy(false);
      clearSelection();
    }
  };

  const requestDeleteSelectedFolders = () => {
    // 根目录（relPath 为空）不可删除，勾选时也不该出现在列表里。
    const targets = selectedFolders.filter((folder) => folder.relPath);
    if (targets.length === 0) return;
    setDeleteTarget({ kind: 'folders', folders: targets });
  };

  /** 一键开启/取消某相册及其全部子文件夹里每一张图片的隐私预览（逐图标记）。 */
  const toggleFolderBlur = useCallback((folder: FolderNode) => {
    if (!snapshot || !folder) return;
    const images = imagesOf(snapshot, folder.id);
    if (images.length === 0) return;
    const allBlurred = images.every((img) => blurredImages.has(img.relPath));
    setBlurredImages((prev) => {
      const next = new Set(prev);
      for (const img of images) {
        if (allBlurred) next.delete(img.relPath);
        else next.add(img.relPath);
      }
      saveBlurredImages(next);
      return next;
    });
    notify(
      allBlurred
        ? `已取消“${folder.name}”及子文件夹的隐私预览。`
        : `已为“${folder.name}”及全部子文件夹开启隐私预览。`,
    );
  }, [snapshot, blurredImages, notify]);

  /** 仅切换某一张图片的隐私预览。 */
  const toggleImageBlur = useCallback((image: ImageEntry) => {
    setBlurredImages((prev) => {
      const next = new Set(prev);
      if (next.has(image.relPath)) next.delete(image.relPath);
      else next.add(image.relPath);
      saveBlurredImages(next);
      return next;
    });
  }, []);

  const copyPath = useCallback(async (text: string, label = '路径') => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制${label}。`);
    } catch {
      notify(`无法复制，请手动复制：${text}`);
    }
  }, [notify]);

  const pinCover = useCallback((folderId: string, imageId: string | null, imageName?: string) => {
    setPinnedCovers((prev) => {
      const next = { ...prev };
      if (imageId) next[folderId] = imageId;
      else delete next[folderId];
      savePinnedCovers(next);
      return next;
    });
    notify(imageId ? `已将“${imageName ?? '该图片'}”设为图包封面。` : '已取消固定封面。');
  }, [notify]);

  const handleRenameImage = (image: ImageEntry) => {
    setPromptState({ kind: 'rename-image', title: '重命名图片', label: '新名称', initialValue: image.name, image });
    setPromptValue(image.name);
  };

  const executeRenameImage = async (image: ImageEntry, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === image.name) return;
    setBusy(true);
    try {
      const renamed = await renameImage(store, image, name);
      await refresh();
      notify(`已重命名为“${renamed.name}”。`);
    } catch (err) {
      notify(`重命名失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const executeDeleteImage = async (image: ImageEntry) => {
    if (!image) return;
    setBusy(true);
    try {
      await deleteImage(store, image);
      await refresh();
      notify(`已删除图片“${image.name}”。`);
    } catch (err) {
      notify(`删除失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteTarget = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target.kind === 'image') await executeDeleteImage(target.image);
    else if (target.kind === 'folders') await executeDeleteFolders(target.folders);
    else await performDelete(target.folder);
  };

  const handleCreateSubfolder = (folder: FolderNode) => {
    setPromptState({
      kind: 'create-folder',
      title: `在“${folder.name}”中新建子文件夹`,
      label: '文件夹名称',
      initialValue: '新建文件夹',
      folder,
    });
    setPromptValue('新建文件夹');
  };

  const executeCreateSubfolder = async (folder: FolderNode, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const createdRel = joinRelPath(folder.relPath, clean);
      await createSubfolder(store, folder.relPath, clean);
      const next = await refresh();
      const created = Object.values(next.folders).find((item) => item.relPath === createdRel);
      if (created) {
        selectFolderRaw(created.id);
        setExpandedFolders((prev) => {
          const nextSet = new Set(prev);
          nextSet.add(folder.id);
          return nextSet;
        });
      }
      notify(`已创建“${clean}”。`);
    } catch (err) {
      notify(`新建失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRenameFolder = (folder: FolderNode) => {
    if (!folder.relPath) return;
    setPromptState({ kind: 'rename-folder', title: '重命名图包', label: '新名称', initialValue: folder.name, folder });
    setPromptValue(folder.name);
  };

  const executeRenameFolder = async (folder: FolderNode, nextName: string) => {
    const name = nextName.trim();
    if (!name || name === folder.name) return;
    setBusy(true);
    try {
      await renameFolder(store, folder, name);
      await refresh();
      notify(`已重命名为“${name}”。`);
    } catch (err) {
      notify(`重命名失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submitPrompt = async () => {
    if (!promptState) return;
    const state = promptState;
    const value = promptValue.trim();
    if (!value) return;
    setPromptState(null);
    if (state.kind === 'rename-image' && state.image) await executeRenameImage(state.image, value);
    else if (state.kind === 'rename-folder' && state.folder) await executeRenameFolder(state.folder, value);
    else if (state.kind === 'create-folder' && state.folder) await executeCreateSubfolder(state.folder, value);
  };

  const openContextMenu = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  const buildImageMenu = (image: ImageEntry): ContextMenuItem[] => {
    const imageBlurred = blurredImages.has(image.relPath);
    const imagePinned = pinnedCovers[image.folderId] === image.id;
    return [
      { label: '查看图片', icon: <Eye size={16} />, onSelect: () => setViewerImageId(image.id) },
      {
        label: imagePinned ? '取消固定封面' : '设为封面',
        icon: <PushPin size={16} />,
        checked: imagePinned,
        onSelect: () => pinCover(image.folderId, imagePinned ? null : image.id, image.name),
      },
      {
        label: imageBlurred ? '取消隐私预览' : '设为隐私预览',
        icon: <EyeSlash size={16} />,
        checked: imageBlurred,
        onSelect: () => toggleImageBlur(image),
      },
      { label: '重命名…', icon: <PencilSimple size={16} />, onSelect: () => void handleRenameImage(image) },
      { label: '复制路径', icon: <Copy size={16} />, separator: true, onSelect: () => void copyPath(image.relPath) },
      { label: '删除', icon: <Trash size={16} />, danger: true, separator: true, onSelect: () => requestDeleteImage(image) },
    ];
  };

  const buildFolderMenu = (folder: FolderNode): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: '打开', icon: <FolderOpen size={16} />, onSelect: () => handleSelectFolder(folder) },
      { label: '新建子文件夹…', icon: <FolderPlus size={16} />, onSelect: () => void handleCreateSubfolder(folder) },
    ];
    if (folder.relPath && folder.childCount > 0) {
      items.push({
        label: expandedFolders.has(folder.id) ? '收起子目录' : '展开子目录',
        icon: expandedFolders.has(folder.id) ? <CaretDown size={16} /> : <CaretRight size={16} />,
        onSelect: () => toggleFolder(folder.id),
      });
    }
    if (folder.relPath) {
      items.push({ label: '重命名…', icon: <PencilSimple size={16} />, separator: true, onSelect: () => void handleRenameFolder(folder) });
    }
    const folderImagesList = snapshot ? imagesOf(snapshot, folder.id) : [];
    const folderAllBlurred =
      folderImagesList.length > 0 && folderImagesList.every((img) => blurredImages.has(img.relPath));
    items.push({
      label: folderAllBlurred ? '取消隐私预览（含子文件夹）' : '设为隐私预览（含子文件夹）',
      icon: <EyeSlash size={16} />,
      checked: folderAllBlurred,
      disabled: folderImagesList.length === 0,
      separator: !folder.relPath,
      onSelect: () => toggleFolderBlur(folder),
    });
    items.push({
      label: '设置封面…',
      icon: <ImagesSquare size={16} />,
      disabled: folderImagesList.length === 0,
      onSelect: () => setCoverPickerFolder(folder),
    });
    items.push(
      { label: '整理…', icon: <MagicWand size={16} />, onSelect: () => openOrganizePreviewFor(folder) },
      { label: '导出 ZIP…', icon: <FileZip size={16} />, separator: true, onSelect: () => void exportFolder(folder) },
      { label: '复制路径', icon: <Copy size={16} />, onSelect: () => void copyPath(folder.relPath || '根目录') },
    );
    if (folder.relPath) {
      items.push({ label: '删除', icon: <Trash size={16} />, danger: true, separator: true, onSelect: () => requestDeleteFolder(folder) });
    }
    return items;
  };

  const buildFolderMenuRef = useRef(buildFolderMenu);
  buildFolderMenuRef.current = buildFolderMenu;
  const handleFolderContextMenu = useCallback((event: ReactMouseEvent, folder: FolderNode) => {
    openContextMenu(event, buildFolderMenuRef.current(folder));
  }, [openContextMenu]);

  const viewerImages = folderImages;
  const viewerIndex = viewerImageId ? viewerImages.findIndex((img) => img.id === viewerImageId) : -1;
  const isEmptyLibrary = childFolderCards.length === 0 && folderImages.length === 0;

  useEffect(() => {
    if (viewerImageId && viewerIndex < 0) setViewerImageId(null);
  }, [viewerImageId, viewerIndex]);

  const workspaceTitle = isRootSelected ? '全部图包' : selectedFolder?.name ?? '图包';
  const workspaceMeta = isRootSelected
    ? `${childFolders.length} 个图包 · ${allLibraryImages.length} 个文件 · ${formatBytes(libraryBytes)}`
    : `${selectedFolder?.directImageCount ?? 0} 张直属图片 · ${selectedFolder?.childCount ?? 0} 个子图包 · ${formatBytes(folderBytes)}`;

  const titlebarNavigation = (
    <>
      <DesktopIconButton label={sidebarHidden ? '显示侧栏' : '隐藏侧栏'} onClick={() => setSidebarHidden((value) => !value)}>
        <SidebarSimple size={17} />
      </DesktopIconButton>
      <DesktopIconButton label="后退" disabled={!canGoBack(nav)} onClick={handleNavBack}><ArrowLeft size={16} /></DesktopIconButton>
      <DesktopIconButton label="前进" disabled={!canGoForward(nav)} onClick={handleNavForward}><ArrowRight size={16} /></DesktopIconButton>
    </>
  );

  if (showSettings) {
    return (
      <div
        className="desktop-library app-shell flex h-screen flex-col"
        data-view={viewMode}
        data-sidebar={sidebarHidden ? 'closed' : 'open'}
        data-inspector={inspectorOpen ? 'open' : 'closed'}
      >
        <TitleBar
          navigation={titlebarNavigation}
          theme={effectiveTheme}
          onThemeChange={setTheme}
          busy={busy}
          onImport={() => void handleAdd()}
        />
        <div className="desktop-content-shell desktop-settings-shell flex-1 min-h-0">
          <SettingsPage
            rules={customRules}
            onChange={handleCustomRulesChange}
            onBack={() => {
              setShowSettings(false);
              requestAnimationFrame(() => settingsButtonRef.current?.focus());
            }}
            runtimeLabel={runtimeLabel}
            libraryBytes={libraryBytes}
            libraryFileCount={allLibraryImages.length}
            sidebarWidth={sidebarWidth}
            onSidebarWidthChange={setSidebarWidth}
            sidebarHidden={sidebarHidden}
            theme={theme}
            accent={accent}
            onThemeChange={setTheme}
            onAccentChange={setAccent}
            onLibraryLocationChange={() => void refresh()}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={libraryRootRef}
      className="desktop-library app-shell flex h-screen flex-col"
      data-view={viewMode}
      data-sidebar={sidebarHidden ? 'closed' : 'open'}
      data-inspector={inspectorOpen ? 'open' : 'closed'}
    >
      <TitleBar
        navigation={titlebarNavigation}
        theme={effectiveTheme}
        onThemeChange={setTheme}
        busy={busy}
        onImport={() => void handleAdd()}
      />
      <div className={'drawer desktop-drawer flex-1 min-h-0' + (sidebarHidden ? '' : ' is-sidebar-open')}>
        <input id="app-drawer" type="checkbox" className="drawer-toggle" checked={!sidebarHidden} onChange={(event) => setSidebarHidden(!event.target.checked)} />

      <div className="drawer-content desktop-content-shell min-h-0">
        <section className="desktop-workspace">
          <header className="desktop-workspace-header">
            <div className="desktop-workspace-nav">
              <nav className="desktop-breadcrumbs" aria-label="面包屑">
                {crumbs.map((crumb, index) => {
                  const label = index === 0 ? '全部图包' : crumb.name;
                  const current = index === crumbs.length - 1;
                  return (
                    <span key={crumb.id} className="desktop-breadcrumb-item">
                      {current ? <strong>{label}</strong> : <button type="button" onClick={() => handleSelectFolder(crumb)}>{label}</button>}
                      {!current && <CaretRight size={11} />}
                    </span>
                  );
                })}
              </nav>
            </div>
            <div className="desktop-workspace-title-row">
              <div className="desktop-workspace-title">
                <h1>{workspaceTitle}</h1>
                <span>{workspaceMeta}</span>
              </div>
              <div className="desktop-view-controls">
                <label className="desktop-sort-control">
                  <SortAscending size={15} />
                  <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="排序方式">
                    <option value="name">名称</option>
                    <option value="modified">最近修改</option>
                    <option value="size">占用空间</option>
                  </select>
                </label>
                <div className="desktop-segmented-control" role="group" aria-label="视图方式">
                  <button type="button" className={viewMode === 'grid' ? 'is-active' : ''} aria-label="平铺视图" aria-pressed={viewMode === 'grid'} title="平铺视图" onClick={() => setViewMode('grid')}><SquaresFour size={16} /></button>
                  <button type="button" className={viewMode === 'list' ? 'is-active' : ''} aria-label="列表视图" aria-pressed={viewMode === 'list'} title="列表视图" onClick={() => setViewMode('list')}><Rows size={16} /></button>
                </div>
                {viewMode === 'grid' && <DesktopIconButton label={showNames ? '隐藏文件名' : '显示文件名'} active={showNames} onClick={() => setShowNames((value) => !value)}><Info size={16} /></DesktopIconButton>}
                <DesktopIconButton label={inspectorOpen ? '收起检查器' : '显示检查器'} active={inspectorOpen} onClick={() => setInspectorOpen((value) => !value)}><SidebarSimple size={17} /></DesktopIconButton>
              </div>
            </div>
          </header>

        <main className={'desktop-media-canvas [overflow-anchor:none]' + (isEmptyLibrary ? ' is-empty' : '')} ref={mainScrollRef} onScroll={onMainScroll}>
          {childFolderCards.length > 0 && (
            <section className="desktop-content-section">
              {!isRootSelected && <h2 className="desktop-section-heading">子图包</h2>}
              {/* 文件夹区虚拟化（同图片区）：目录多时只挂载可视行 ± 缓冲，DOM 稳定 */}
              {(() => {
                const { cols, rowHeight } = folderMetrics;
                const gridGap = gridUnits(viewMode).gap;
                const totalRows = cols > 0 ? Math.ceil(childFolderCards.length / cols) : 0;
                if (totalRows === 0) return null;
                const win = stableWindowRowsFor(folderMetrics, scrollTop, childFolderCards.length);
                const rows: number[] = [];
                for (let r = win.first; r < win.last; r++) rows.push(r);
                return (
                  <div ref={folderSurfaceRef} className="desktop-virtual-surface" style={{ position: 'relative', height: Math.max(1, virtualSurfaceHeight(folderMetrics, childFolderCards.length)) }}>
                    {rows.map((row) => {
                      const start = row * cols;
                      const end = Math.min(childFolderCards.length, start + cols);
                      return (
                        <div
                          key={row}
                          className="folder-grid desktop-virtual-row"
                          style={{ position: 'absolute', top: row * rowHeight, left: 0, right: 0, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${gridGap}px` }}
                        >
                          {childFolderCards.slice(start, end).map(({ folder, covers }) => (
                            <div
                              key={folder.id}
                              className={`desktop-package-card ${selectedFolderIds.has(folder.id) ? 'is-selected' : ''}`}
                              onContextMenu={(event) => openContextMenu(event, buildFolderMenu(folder))}
                            >
                              <button type="button" className="desktop-package-target" onClick={() => handleSelectFolder(folder)} aria-label={`打开图包${folder.name}`}>
                                <span className={`desktop-package-cover cover-count-${covers.length}`} aria-hidden="true">
                                  {covers.map((image) => (
                                    <BlobImage
                                      key={image.id}
                                      store={store}
                                      fileRef={imageFileRef(image)}
                                      alt={`${folder.name}封面`}
                                      className="desktop-package-cover-image"
                                      thumbnail
                                      thumbnailSize={image.id === pinnedCovers[folder.id] ? COVER_THUMBNAIL_SIZE : undefined}
                                      lazy
                                      blur={isImageBlurred(image.relPath, blurredImages)}
                                    />
                                  ))}
                                  {covers.length === 0 && <span className="desktop-package-empty"><ImagesSquare size={30} weight="duotone" /></span>}
                                  {pinnedCovers[folder.id] != null && <span className="desktop-cover-pin"><PushPin size={12} weight="fill" />固定封面</span>}
                                </span>
                                <span className="desktop-package-body">
                                  <span className="desktop-package-title"><strong>{folder.name}</strong><CaretRight size={15} weight="bold" /></span>
                                  <span className="desktop-package-meta">{folder.imageCount.toLocaleString('zh-CN')} 张图片 · {folder.childCount} 个子图包</span>
                                  <span className="desktop-package-path">{folder.relPath || '图库'}</span>
                                </span>
                              </button>
                              <label className="desktop-selection-control" title={`选择图包${folder.name}`}>
                                <input
                                  type="checkbox"
                                  className="desktop-selection-input"
                                  aria-label={`选择图包${folder.name}`}
                                  checked={selectedFolderIds.has(folder.id)}
                                  onChange={(event) => {
                                    const nativeEvent = event.nativeEvent as MouseEvent;
                                    selectFolder(folder, event.currentTarget.checked, nativeEvent.shiftKey === true);
                                  }}
                                />
                                <span className="desktop-selection-mark" aria-hidden="true">
                                  {selectedFolderIds.has(folder.id) && <Check size={13} weight="bold" />}
                                </span>
                              </label>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {/* 隐藏的同构文件夹卡片探测：度量真实高度（含 figcaption/边框） */}
                    <div
                      aria-hidden="true"
                      style={{ position: 'absolute', left: 0, right: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' }}
                    >
                      <div className="folder-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${gridGap}px` }}>
                        <div ref={folderProbeCardRef} className="desktop-package-card">
                          <div className="desktop-package-cover" />
                          <div className="desktop-package-body">
                            <span className="desktop-package-title"><strong>测</strong></span>
                            <span className="desktop-package-meta">0 张图片 · 0 个子图包</span>
                            <span className="desktop-package-path">路径</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

          {folderImages.length > 0 && (
            <section className="desktop-content-section">
              {childFolderCards.length > 0 && <h2 className="desktop-section-heading">图片</h2>}
              {/* 虚拟化网格（P2）：只挂载可视区 ± 缓冲的行，其余行由绝对定位撑起总高，
                  从"全量 DOM"变为"固定几十张"，滚动时只替换窗口内的行。 */}
              {(() => {
                const { cols, rowHeight } = galleryMetrics;
                const gridGap = gridUnits(viewMode).gap;
                const totalRows = cols > 0 ? Math.ceil(folderImages.length / cols) : 0;
                if (totalRows === 0) return null;
                const win = stableWindowRowsFor(galleryMetrics, scrollTop, folderImages.length);
                const rows: number[] = [];
                for (let r = win.first; r < win.last; r++) rows.push(r);
                return (
                  <div ref={gallerySurfaceRef} className="desktop-virtual-surface" style={{ position: 'relative', height: Math.max(1, virtualSurfaceHeight(galleryMetrics, folderImages.length)) }}>
                    {rows.map((row) => {
                      const start = row * cols;
                      const end = Math.min(folderImages.length, start + cols);
                      return (
                        <div
                          key={row}
                          className="gallery-grid desktop-virtual-row"
                          style={{ position: 'absolute', top: row * rowHeight, left: 0, right: 0, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${gridGap}px` }}
                        >
                          {folderImages.slice(start, end).map((image) => (
                            <div
                              key={image.id}
                              className={`desktop-photo-card ${selectedImageIds.has(image.id) ? 'is-selected' : ''}`}
                              onContextMenu={(event) => openContextMenu(event, buildImageMenu(image))}
                            >
                              <button
                                type="button"
                                className="desktop-photo-target"
                                aria-label={`查看${image.name}`}
                                onClick={() => setViewerImageId(image.id)}
                              >
                              <span className={`desktop-photo-frame ${blurredImages.has(image.relPath) ? 'is-private' : ''}`}>
                                <BlobImage
                                  store={store}
                                  fileRef={imageFileRef(image)}
                                  alt={image.name}
                                  className="desktop-photo-image"
                                  thumbnail
                                  lazy
                                  blur={blurredImages.has(image.relPath)}
                                />
                                {blurredImages.has(image.relPath) && <span className="desktop-privacy-mark" aria-label="隐私预览已开启"><LockSimple size={13} weight="fill" /></span>}
                              </span>
                              {(showNames || viewMode === 'list') && (
                                <span className="desktop-photo-caption">
                                  <span className="desktop-photo-name" title={image.name}>{image.name}</span>
                                  <span className="desktop-photo-meta">{image.width && image.height ? `${image.width} × ${image.height}` : image.ext.toUpperCase()}</span>
                                  <span className="desktop-photo-size">{formatBytes(image.size)}</span>
                                </span>
                              )}
                              </button>
                              <label className="desktop-selection-control" title={`选择${image.name}`}>
                                <input
                                  type="checkbox"
                                  className="desktop-selection-input"
                                  aria-label={`选择${image.name}`}
                                  checked={selectedImageIds.has(image.id)}
                                  onChange={(event) => {
                                    const nativeEvent = event.nativeEvent as MouseEvent;
                                    selectImage(image, event.currentTarget.checked, nativeEvent.shiftKey === true);
                                  }}
                                  onClick={(event) => event.stopPropagation()}
                                />
                                <span className="desktop-selection-mark" aria-hidden="true">
                                  {selectedImageIds.has(image.id) && <Check size={13} weight="bold" />}
                                </span>
                              </label>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {/* 隐藏的同构探测卡片：度量真实卡片高度（含 figcaption 与边框），
                        保证绝对定位的行高与真实渲染一致、无累积漂移。 */}
                    <div
                      aria-hidden="true"
                      style={{ position: 'absolute', left: 0, right: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' }}
                    >
                      <div className="gallery-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${gridGap}px` }}>
                        <div ref={probeCardRef} className="desktop-photo-card">
                          <div className="desktop-photo-frame" />
                          {(showNames || viewMode === 'list') && <div className="desktop-photo-caption"><span className="desktop-photo-name">测</span></div>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

          {childFolderCards.length === 0 && folderImages.length === 0 && (
            <div className="desktop-empty-state">
              <span className="desktop-empty-icon">{searchTerm ? <MagnifyingGlass size={26} /> : isRootSelected ? <ImagesSquare size={26} /> : <ImageSquare size={26} />}</span>
              <h2>{searchTerm ? '没有匹配结果' : isRootSelected ? '尚未导入图包' : '该图包暂无内容'}</h2>
              <p>{searchTerm ? `没有名称包含“${searchQuery}”的图包或文件。` : isRootSelected ? '从本地文件夹导入第一个图包。' : '导入文件，或新建子图包继续整理。'}</p>
              {searchTerm ? (
                <button className="desktop-button secondary" type="button" onClick={() => setSearchQuery('')}>清除搜索</button>
              ) : (
                <button className="desktop-button primary" type="button" disabled={busy} onClick={() => void handleAdd()}><UploadSimple size={16} />导入图包</button>
              )}
            </div>
          )}
        </main>
        </section>

        {inspectorOpen && (
          <DesktopInspector
            store={store}
            folder={selectedFolder}
            rootSelected={isRootSelected}
            childFolderCount={childFolders.length}
            folderImages={folderAllImages}
            selectedImages={selectedImages}
            selectedFolders={selectedFolders}
            selectedFolderCovers={selectedFolderCovers}
            selectedFolderStats={selectedFolderStats}
            coverImage={cover ? snapshot?.images[cover.imageId] ?? null : null}
            pinnedCovers={pinnedCovers}
            blurredImages={blurredImages}
            busy={busy}
            exporting={exporting}
            canUndo={Boolean(lastManifest)}
            onClose={() => setInspectorOpen(false)}
            onClearSelection={clearSelection}
            onOpenImage={(image) => setViewerImageId(image.id)}
            onToggleSelectedBlur={toggleSelectedBlur}
            onToggleImageBlur={toggleImageBlur}
            onPinImage={(image) => pinCover(image.folderId, pinnedCovers[image.folderId] === image.id ? null : image.id, image.name)}
            onRenameImage={handleRenameImage}
            onCopyImagePath={(image) => void copyPath(image.relPath)}
            onDeleteImage={requestDeleteImage}
            onExportSelectedFolder={(folder) => void exportFolder(folder)}
            onDeleteSelectedFolders={requestDeleteSelectedFolders}
            onRefresh={() => void refresh()}
            onOrganize={openOrganizePreview}
            onUndo={() => void handleUndoOrganize()}
            onExport={() => void handleExport()}
            onCreateFolder={() => selectedFolder && handleCreateSubfolder(selectedFolder)}
            onPickCover={() => selectedFolder && setCoverPickerFolder(selectedFolder)}
            onToggleFolderBlur={() => selectedFolder && toggleFolderBlur(selectedFolder)}
            onRenameFolder={() => selectedFolder && handleRenameFolder(selectedFolder)}
            onDeleteFolder={requestDelete}
          />
        )}
      </div>

      <div className="drawer-side desktop-drawer-side">
        <label htmlFor="app-drawer" className="drawer-overlay" aria-label="关闭图包导航"></label>
        <aside className="desktop-sidebar" style={{ width: sidebarWidth }} aria-label="图包导航">
          <SidebarResizeHandle width={sidebarWidth} onResize={setSidebarWidth} max={360} />
          <div ref={sidebarScrollRef} className="desktop-sidebar-scroll">
            <div className="desktop-sidebar-heading">
              <div className="desktop-brand-lockup" aria-label="Kanitsu">
                <KanitsuLogo className="desktop-brand-mark" alt="" aria-hidden="true" />
                <strong>Kanitsu</strong>
              </div>
              <div className="desktop-sidebar-heading-tools">
                <label className="desktop-global-search">
                  <MagnifyingGlass size={16} aria-hidden="true" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={isRootSelected ? '搜索图包' : '搜索当前图包'}
                    aria-label={isRootSelected ? '搜索图包' : '搜索当前图包'}
                  />
                  {searchQuery ? (
                    <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => setSearchQuery('')}>
                      <X size={14} />
                    </button>
                  ) : (
                    <span className="desktop-search-spacer" aria-hidden="true" />
                  )}
                </label>
                <DesktopIconButton label="新建子图包" disabled={!selectedFolder} onClick={() => selectedFolder && handleCreateSubfolder(selectedFolder)}><FolderPlus size={16} /></DesktopIconButton>
              </div>
            </div>
            <nav className="desktop-sidebar-primary" aria-label="主要功能">
              {/* 常驻按钮：首次启动快照未加载时也可见可点，此时点击即回到根视图。 */}
              <button
                type="button"
                className={`desktop-sidebar-nav-item ${isRootSelected ? 'is-active' : ''}`}
                onClick={() => (rootFolder ? handleSelectFolder(rootFolder) : selectFolderRaw(''))}
                onContextMenu={rootFolder ? (event) => openContextMenu(event, buildFolderMenu(rootFolder)) : undefined}
              >
                <ImagesSquare size={18} weight="duotone" /><span>全部图包</span>
              </button>
            </nav>
            <div className="desktop-panel-label">图包目录</div>
            {snapshot ? (
              <FolderTree
                snapshot={snapshot}
                folderId={snapshot.rootId}
                selectedFolderId={selectedFolderId || snapshot.rootId}
                onSelect={handleSelectFolder}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                onFolderContextMenu={handleFolderContextMenu}
                scrollRootRef={sidebarScrollRef}
              />
            ) : (
              <div className="desktop-folder-tree-scroll" />
            )}
          </div>
          <div className="desktop-sidebar-footer">
            <button ref={settingsButtonRef} type="button" className="desktop-sidebar-nav-item desktop-sidebar-settings" onClick={() => setShowSettings(true)}><GearSix size={17} /><span>界面与性能</span></button>
          </div>
        </aside>
      </div>

      {selectionCount > 0 && (
        <div className="desktop-selection-toolbar" role="toolbar" aria-label="所选项目操作">
          <strong>
            {[
              selectedImages.length > 0 ? `${selectedImages.length} 张图片` : '',
              selectedFolders.length > 0 ? `${selectedFolders.length} 个图包` : '',
            ].filter(Boolean).join(' · ')}已选择
          </strong>
          <span className="desktop-selection-divider" />
          <button type="button" onClick={selectAllInView}>全选当前结果</button>
          <button type="button" disabled={selectionBlurTargets.size === 0} onClick={toggleSelectedBlur}>{selectionAllBlurred ? <Eye size={16} /> : <EyeSlash size={16} />}隐私预览</button>
          {selectionCount === 1 && selectedImages.length === 1 && (
            <>
              <button type="button" onClick={() => setViewerImageId(selectedImages[0]!.id)}><ArrowsOut size={16} />打开</button>
              <button type="button" onClick={() => pinCover(selectedImages[0]!.folderId, selectedImages[0]!.id, selectedImages[0]!.name)}><PushPin size={16} />设为封面</button>
              <button type="button" className="is-danger" onClick={() => requestDeleteImage(selectedImages[0]!)}><Trash size={16} />删除</button>
            </>
          )}
          {selectionCount === 1 && selectedFolders.length === 1 && (
            <>
              <button type="button" disabled={busy} onClick={() => handleSelectFolder(selectedFolders[0]!)}><FolderOpen size={16} />打开</button>
              <button type="button" disabled={busy} onClick={() => handleRenameFolder(selectedFolders[0]!)}><PencilSimple size={16} />重命名</button>
              <button type="button" disabled={busy || exporting} onClick={() => selectedFolders[0] && void exportFolder(selectedFolders[0])}><FileZip size={16} />导出 ZIP</button>
              <button type="button" className="is-danger" disabled={busy} onClick={requestDeleteSelectedFolders}><Trash size={16} />删除</button>
            </>
          )}
          {selectedFolders.length > 0 && selectionCount > 1 && (
            <button type="button" className="is-danger" disabled={busy} onClick={requestDeleteSelectedFolders}><Trash size={16} />删除图包</button>
          )}
          <button type="button" className="desktop-toolbar-close" aria-label="清除选择" onClick={clearSelection}><X size={15} /></button>
        </div>
      )}

      {organizePreview && (
        <OrganizePreview
          bindings={organizePreview}
          organizing={organizing}
          progress={organizeProgress}
          onChange={(next) => setOrganizePreview(next)}
          onApply={handleApplyOrganize}
          onClose={() => setOrganizePreview(null)}
        />
      )}

      {coverPickerFolder && snapshot && (
        <CoverPickerModal
          folderId={coverPickerFolder.id}
          snapshot={snapshot}
          store={store}
          pinnedCovers={pinnedCovers}
          currentCoverId={pinnedCovers[coverPickerFolder.id] ?? null}
          onPick={(imageId) => {
            const pinnedName = imageId ? snapshot.images[imageId]?.name : undefined;
            pinCover(coverPickerFolder.id, imageId, pinnedName);
            setCoverPickerFolder(null);
          }}
          onCancel={() => setCoverPickerFolder(null)}
        />
      )}

      {locationPrompt && (
        <LibraryLocationModal
          info={locationPrompt}
          onConfirm={() => {
            setLocationPrompt(null);
            void refresh();
          }}
        />
      )}

      {organizeResult && (
        <div className="modal modal-open">
          <div className="modal-box max-w-3xl flex flex-col max-h-[80vh]">
            <h3 className="font-bold text-lg shrink-0">整理结果</h3>
            <div className="flex flex-wrap gap-4 text-sm mb-3 shrink-0">
              <span>已应用：{organizeResult.appliedCount}</span>
              <span>低置信跳过：{organizeResult.skippedLowConfidenceCount}</span>
              <span>冲突：{organizeResult.conflicts.length}</span>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0">
              {organizeResult.conflicts.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr><th>文件</th><th>目标</th><th>原因</th></tr>
                    </thead>
                    <tbody>
                      {organizeResult.conflicts.map((c, i) => (
                        <tr key={`${c.imageId}-${i}`}>
                          <td>{c.name}</td>
                          <td>{c.targetRelPath}</td>
                          <td>{conflictReasonLabel(c.reason)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="modal-action shrink-0"><button className="btn btn-ghost" onClick={() => setOrganizeResult(null)}>关闭</button></div>
          </div>
        </div>
      )}

      {importReport && showImportReport && (
        <div className="modal modal-open">
          <div className="modal-box max-w-3xl flex flex-col max-h-[80vh]">
            <h3 className="font-bold text-lg shrink-0">导入报告</h3>
            <div className="flex flex-wrap gap-4 text-sm mb-3 shrink-0">
              <span>来源：{importReport.sourceFolderName}</span>
              <span>扫描：{importReport.scannedFileCount}</span>
              <span>复制：{importReport.copiedImageCount}</span>
              <span>跳过：{importReport.skippedCount}</span>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0">
              {importReport.skippedFiles.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead><tr><th>跳过的文件</th><th>原因</th></tr></thead>
                    <tbody>
                      {importReport.skippedFiles.map((item, idx) => (
                        <tr key={`${item.path}-${idx}`}>
                          <td className="font-mono text-xs">{item.path}</td>
                          <td>{skippedReasonLabel(item.reason)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {importReport.errors.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-semibold mb-2">失败项</h4>
                  <div className="overflow-x-auto">
                    <table className="table table-sm">
                      <thead><tr><th>错误</th></tr></thead>
                      <tbody>
                        {importReport.errors.map((error, idx) => (
                          <tr key={`error-${idx}`}>
                            <td className="font-mono text-xs text-error">{error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-action shrink-0"><button className="btn btn-ghost" onClick={() => setShowImportReport(false)}>关闭</button></div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal modal-open">
          <div className="modal-box flex flex-col max-h-[80vh]">
            <h3 className="font-bold text-lg shrink-0">确认删除</h3>
            <div className="overflow-y-auto flex-1 min-h-0">
              <p className="py-4 text-sm opacity-80">
                {deleteTarget.kind === 'image'
                  ? `确定要删除图片“${deleteTarget.image.name}”吗？此操作不可撤销。`
                  : deleteTarget.kind === 'folders'
                    ? `确定要删除选中的 ${deleteTarget.folders.length} 个图包及其全部子目录吗？此操作不可撤销。`
                    : `确定要删除图包“${deleteTarget.folder.name}”及其全部子目录吗？此操作不可撤销。`}
              </p>
              {deleteTarget.kind === 'folders' && (
                <ul className="pb-2 text-xs opacity-70">
                  {deleteTarget.folders.map((folder) => <li key={folder.id} className="truncate">{folder.relPath}</li>)}
                </ul>
              )}
            </div>
            <div className="modal-action shrink-0">
              <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="btn btn-error" onClick={() => void confirmDeleteTarget()}>删除</button>
            </div>
          </div>
        </div>
      )}

      {promptState && (
        <div className="modal modal-open z-[130]">
          <div className="modal-box max-w-md flex flex-col max-h-[80vh]">
            <h3 className="font-bold text-lg shrink-0">{promptState.title}</h3>
            <div className="overflow-y-auto flex-1 min-h-0">
              <div className="form-control w-full mt-3">
                <span className="label-text text-xs">{promptState.label}</span>
                <input
                  className="input input-bordered input-sm mt-1 font-mono"
                  value={promptValue}
                  onChange={(event) => setPromptValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitPrompt();
                    if (event.key === 'Escape') setPromptState(null);
                  }}
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-action shrink-0">
              <button className="btn btn-ghost btn-sm" onClick={() => setPromptState(null)}>取消</button>
              <button className="btn btn-primary btn-sm" onClick={() => void submitPrompt()}>保存</button>
            </div>
          </div>
        </div>
      )}
      </div>

      {viewerImageId && viewerIndex >= 0 ? (
        <>
          <Viewer
            key={viewerImageId}
            images={viewerImages}
            index={viewerIndex}
            store={store}
            onClose={() => setViewerImageId(null)}
            onNavigate={(id) => setViewerImageId(id)}
            onSwitchSibling={handleViewerSwitchSibling}
            onImageContextMenu={(event, image) => openContextMenu(event, buildImageMenu(image))}
            showFilmstrip={false}
          />
          <div className="viewer-filmstrip-overlay">
            <ViewerFilmstrip images={viewerImages} activeIndex={viewerIndex} store={store} onNavigate={setViewerImageId} />
          </div>
        </>
      ) : (
        <div
          className="toast toast-end"
          role="status"
          aria-live={messageKind === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {message && <div className={`alert alert-${messageKind} shadow-lg`}><span>{message}</span></div>}
          {exporting && exportProgress && (
            <div className="alert alert-info shadow-lg">
              <span>打包中… {exportProgress.done}/{exportProgress.total}</span>
              <progress className="progress progress-info w-24" value={exportProgress.done} max={exportProgress.total || 1} />
            </div>
          )}
        </div>
      )}

      <ContextMenu menu={contextMenu} container={libraryRootRef.current} onClose={() => setContextMenu(null)} />
    </div>
  );
}

function DesktopIconButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`desktop-icon-button ${active ? 'is-active' : ''}`}
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function DesktopInspector({
  store,
  folder,
  rootSelected,
  childFolderCount,
  folderImages,
  selectedImages,
  selectedFolders,
  selectedFolderCovers,
  selectedFolderStats,
  coverImage,
  pinnedCovers,
  blurredImages,
  busy,
  exporting,
  canUndo,
  onClose,
  onClearSelection,
  onOpenImage,
  onToggleSelectedBlur,
  onToggleImageBlur,
  onPinImage,
  onRenameImage,
  onCopyImagePath,
  onDeleteImage,
  onExportSelectedFolder,
  onDeleteSelectedFolders,
  onRefresh,
  onOrganize,
  onUndo,
  onExport,
  onCreateFolder,
  onPickCover,
  onToggleFolderBlur,
  onRenameFolder,
  onDeleteFolder,
}: {
  store: LibraryStore;
  folder: FolderNode | null;
  rootSelected: boolean;
  childFolderCount: number;
  folderImages: ImageEntry[];
  selectedImages: ImageEntry[];
  selectedFolders: FolderNode[];
  /** 每个所选图包的代表封面（用于批量预览叠图）。 */
  selectedFolderCovers: ImageEntry[];
  selectedFolderStats: { images: number; bytes: number; childFolders: number };
  coverImage: ImageEntry | null;
  pinnedCovers: Record<string, string>;
  blurredImages: ReadonlySet<string>;
  busy: boolean;
  exporting: boolean;
  canUndo: boolean;
  onClose: () => void;
  onClearSelection: () => void;
  onOpenImage: (image: ImageEntry) => void;
  onToggleSelectedBlur: () => void;
  onToggleImageBlur: (image: ImageEntry) => void;
  onPinImage: (image: ImageEntry) => void;
  onRenameImage: (image: ImageEntry) => void;
  onCopyImagePath: (image: ImageEntry) => void;
  onDeleteImage: (image: ImageEntry) => void;
  onExportSelectedFolder: (folder: FolderNode) => void;
  onDeleteSelectedFolders: () => void;
  onRefresh: () => void;
  onOrganize: () => void;
  onUndo: () => void;
  onExport: () => void;
  onCreateFolder: () => void;
  onPickCover: () => void;
  onToggleFolderBlur: () => void;
  onRenameFolder: () => void;
  onDeleteFolder: () => void;
}) {
  const { folderBytes, latestModified, formatSummary, blurredCount } = useMemo(() => ({
    folderBytes: folderImages.reduce((sum, image) => sum + image.size, 0),
    latestModified: folderImages.reduce((value, image) => Math.max(value, image.mtime), 0),
    formatSummary: [...new Set(folderImages.map((image) => image.ext.replace(/^\./, '').toUpperCase()).filter(Boolean))].slice(0, 4).join(' · ') || '暂无文件',
    blurredCount: folderImages.reduce((count, image) => count + (blurredImages.has(image.relPath) ? 1 : 0), 0),
  }), [blurredImages, folderImages]);

  // 混选（图片 + 图包）：检查器展示图包侧（图片动作仍在工具栏），批量删除只作用于图包。
  const imageOnlySelection = selectedImages.length > 0 && selectedFolders.length === 0;

  if (imageOnlySelection && selectedImages.length > 1) {
    const selectedBytes = selectedImages.reduce((sum, image) => sum + image.size, 0);
    const selectedFormats = [...new Set(selectedImages.map((image) => image.ext.replace(/^\./, '').toUpperCase()))].join(' · ');
    return (
      <aside className="desktop-inspector" aria-label="批量检查器">
        <header className="desktop-inspector-header">
          <div><span>批量选择</span><h2>{selectedImages.length} 张图片</h2></div>
          <span className="desktop-inspector-header-actions">
            <DesktopIconButton label="清除选择" onClick={onClearSelection}><X size={16} /></DesktopIconButton>
            <DesktopIconButton label="收起检查器" onClick={onClose}><SidebarSimple size={16} /></DesktopIconButton>
          </span>
        </header>
        <div className="desktop-selection-preview" aria-hidden="true">
          {selectedImages.slice(0, 3).map((image, index) => (
            <span key={image.id} style={{ transform: `translateX(${index * -13}px) rotate(${index * 2 - 2}deg)` }}>
              <BlobImage store={store} fileRef={imageFileRef(image)} alt={image.name} className="desktop-selection-preview-image" thumbnail lazy />
            </span>
          ))}
        </div>
        <section className="desktop-inspector-section desktop-data-list">
          <div><span>合计大小</span><strong>{formatBytes(selectedBytes)}</strong></div>
          <div><span>包含格式</span><strong>{selectedFormats}</strong></div>
          <div><span>所在图包</span><strong>{folder?.name ?? '未知'}</strong></div>
        </section>
        <section className="desktop-inspector-section">
          <h3>批量操作</h3>
          <button type="button" className="desktop-action-row" onClick={onToggleSelectedBlur}><EyeSlash size={17} /><span>切换隐私预览</span><CaretRight size={13} /></button>
          <button type="button" className="desktop-action-row" onClick={onClearSelection}><X size={17} /><span>清除选择</span><CaretRight size={13} /></button>
        </section>
      </aside>
    );
  }

  if (imageOnlySelection && selectedImages.length === 1) {
    const image = selectedImages[0]!;
    const blurred = blurredImages.has(image.relPath);
    const pinned = pinnedCovers[image.folderId] === image.id;
    return (
      <aside className="desktop-inspector" aria-label="图片检查器">
        <header className="desktop-inspector-header">
          <div><span>图片信息</span><h2 title={image.name}>{image.name}</h2></div>
          <span className="desktop-inspector-header-actions">
            <DesktopIconButton label="清除选择" onClick={onClearSelection}><X size={16} /></DesktopIconButton>
            <DesktopIconButton label="收起检查器" onClick={onClose}><SidebarSimple size={16} /></DesktopIconButton>
          </span>
        </header>
        <div className={`desktop-inspector-image ${blurred ? 'is-private' : ''}`}>
          <BlobImage store={store} fileRef={imageFileRef(image)} alt={image.name} className="desktop-inspector-image-content" thumbnail blur={blurred} />
        </div>
        <div className="desktop-inspector-quick-actions">
          <button type="button" onClick={() => onOpenImage(image)}><ArrowsOut size={16} />打开</button>
          <button type="button" onClick={() => onPinImage(image)}><PushPin size={16} />{pinned ? '取消封面' : '设为封面'}</button>
          <button type="button" onClick={() => onToggleImageBlur(image)}>{blurred ? <Eye size={16} /> : <EyeSlash size={16} />}{blurred ? '显示预览' : '隐私预览'}</button>
        </div>
        <section className="desktop-inspector-section desktop-data-list">
          <h3>文件</h3>
          <div><span>格式</span><strong>{image.ext.replace(/^\./, '').toUpperCase() || '未知'}</strong></div>
          <div><span>尺寸</span><strong>{image.width && image.height ? `${image.width} × ${image.height}` : '未知'}</strong></div>
          <div><span>大小</span><strong>{formatBytes(image.size)}</strong></div>
          <div><span>文件修改</span><strong>{formatModifiedTime(image.mtime)}</strong></div>
          <div className="is-stacked"><span>所在路径</span><strong title={image.relPath}>{image.relPath}</strong></div>
        </section>
        <section className="desktop-inspector-section">
          <button type="button" className="desktop-action-row" onClick={() => onRenameImage(image)}><PencilSimple size={17} /><span>重命名</span><CaretRight size={13} /></button>
          <button type="button" className="desktop-action-row" onClick={() => onCopyImagePath(image)}><Copy size={17} /><span>复制路径</span><CaretRight size={13} /></button>
          <button type="button" className="desktop-action-row is-danger" onClick={() => onDeleteImage(image)}><Trash size={17} /><span>删除图片</span><CaretRight size={13} /></button>
        </section>
      </aside>
    );
  }

  if (selectedFolders.length > 0) {
    const single = selectedFolders.length === 1 ? selectedFolders[0]! : null;
    return (
      <aside className="desktop-inspector" aria-label="图包选择">
        <header className="desktop-inspector-header">
          <div>
            <span>图包选择</span>
            <h2 title={single ? single.name : `${selectedFolders.length} 个图包`}>{single ? single.name : `${selectedFolders.length} 个图包`}</h2>
          </div>
          <span className="desktop-inspector-header-actions">
            <DesktopIconButton label="清除选择" onClick={onClearSelection}><X size={16} /></DesktopIconButton>
            <DesktopIconButton label="收起检查器" onClick={onClose}><SidebarSimple size={16} /></DesktopIconButton>
          </span>
        </header>
        {selectedFolderCovers.length > 0 && (
          <div className="desktop-selection-preview" aria-hidden="true">
            {selectedFolderCovers.slice(0, 3).map((image, index) => (
              <span key={image.id} style={{ transform: `translateX(${index * -13}px) rotate(${index * 2 - 2}deg)` }}>
                <BlobImage store={store} fileRef={imageFileRef(image)} alt={image.name} className="desktop-selection-preview-image" thumbnail lazy />
              </span>
            ))}
          </div>
        )}
        <section className="desktop-inspector-section desktop-data-list">
          <div><span>包含图片</span><strong>{selectedFolderStats.images.toLocaleString('zh-CN')} 张</strong></div>
          <div><span>子图包</span><strong>{selectedFolderStats.childFolders.toLocaleString('zh-CN')}</strong></div>
          <div><span>合计大小</span><strong>{formatBytes(selectedFolderStats.bytes)}</strong></div>
          {single && <div className="is-stacked"><span>所在路径</span><strong title={single.relPath}>{single.relPath}</strong></div>}
        </section>
        <section className="desktop-inspector-section">
          <h3>批量操作</h3>
          <button type="button" className="desktop-action-row" disabled={selectedFolderStats.images === 0} onClick={onToggleSelectedBlur}><EyeSlash size={17} /><span>切换隐私预览</span><CaretRight size={13} /></button>
          {single && <button type="button" className="desktop-action-row" disabled={busy || exporting} onClick={() => onExportSelectedFolder(single)}><FileZip size={17} /><span>{exporting ? '正在导出' : '导出 ZIP'}</span><CaretRight size={13} /></button>}
          <button type="button" className="desktop-action-row is-danger" disabled={busy} onClick={onDeleteSelectedFolders}><Trash size={17} /><span>{selectedFolders.length > 1 ? `删除 ${selectedFolders.length} 个图包` : '删除图包'}</span><CaretRight size={13} /></button>
          <button type="button" className="desktop-action-row" onClick={onClearSelection}><X size={17} /><span>清除选择</span><CaretRight size={13} /></button>
        </section>
      </aside>
    );
  }

  return (
    <aside className="desktop-inspector" aria-label="图包检查器">
      <header className="desktop-inspector-header">
        <div><span>{rootSelected ? '图包总览' : '当前图包'}</span><h2>{rootSelected ? '全部图包' : folder?.name ?? '图包'}</h2></div>
        <span className="desktop-inspector-header-actions">
          <DesktopIconButton label="刷新图库" disabled={!folder || busy} onClick={onRefresh}><ArrowClockwise size={16} /></DesktopIconButton>
          <DesktopIconButton label="收起检查器" onClick={onClose}><SidebarSimple size={16} /></DesktopIconButton>
        </span>
      </header>
      <div className="desktop-inspector-cover">
        {coverImage ? (
          <BlobImage store={store} fileRef={imageFileRef(coverImage)} alt={rootSelected ? '全部图包封面' : `${folder?.name ?? '图包'}封面`} className="desktop-inspector-cover-image" thumbnail thumbnailSize={folder && coverImage.id === pinnedCovers[folder.id] ? COVER_THUMBNAIL_SIZE : undefined} lazy blur={blurredImages.has(coverImage.relPath)} />
        ) : (
          <span><ImagesSquare size={30} weight="duotone" /></span>
        )}
      </div>
      <section className="desktop-inspector-summary">
        <div><strong>{rootSelected ? childFolderCount : folder?.imageCount ?? 0}</strong><span>{rootSelected ? '图包' : '图片'}</span></div>
        <div><strong>{rootSelected ? folderImages.length : folder?.childCount ?? 0}</strong><span>{rootSelected ? '文件' : '子图包'}</span></div>
        <div><strong>{formatBytes(folderBytes)}</strong><span>占用</span></div>
      </section>
      <section className="desktop-inspector-section desktop-organize-callout">
        <span className="desktop-callout-icon"><MagicWand size={18} weight="duotone" /></span>
        <h3>按文件名整理当前图包</h3>
        <p>所有变更会先预览，确认后才写入本地副本。</p>
        <button type="button" className="desktop-text-action" disabled={!folder || busy} onClick={onOrganize}>审阅整理建议 <ArrowRight size={14} /></button>
      </section>
      <section className="desktop-inspector-section desktop-data-list">
        <h3>{rootSelected ? '图库状态' : '图包状态'}</h3>
        <div className="is-stacked"><span>所在路径</span><strong title={folder?.relPath || '图库'}>{folder?.relPath || '图库'}</strong></div>
        <div><span>包含格式</span><strong>{formatSummary}</strong></div>
        <div><span>文件修改</span><strong>{formatModifiedTime(latestModified)}</strong></div>
        <div><span>隐私预览</span><strong>{blurredCount} 张</strong></div>
      </section>
      <section className="desktop-inspector-section">
        <h3>图包操作</h3>
        <button type="button" className="desktop-action-row" disabled={!folder || busy} onClick={onCreateFolder}><FolderPlus size={17} /><span>新建子图包</span><CaretRight size={13} /></button>
        {!rootSelected && <button type="button" className="desktop-action-row" disabled={folderImages.length === 0 || busy} onClick={onPickCover}><PushPin size={17} /><span>设置封面</span><CaretRight size={13} /></button>}
        <button type="button" className="desktop-action-row" disabled={folderImages.length === 0 || busy} onClick={onToggleFolderBlur}><EyeSlash size={17} /><span>切换隐私预览</span><CaretRight size={13} /></button>
        <button type="button" className="desktop-action-row" disabled={!folder || busy || exporting} onClick={onExport}><FileZip size={17} /><span>{exporting ? '正在导出' : '导出 ZIP'}</span><CaretRight size={13} /></button>
        {canUndo && <button type="button" className="desktop-action-row" disabled={busy} onClick={onUndo}><ArrowClockwise size={17} /><span>撤销上次整理</span><CaretRight size={13} /></button>}
        {!rootSelected && <button type="button" className="desktop-action-row" disabled={busy} onClick={onRenameFolder}><PencilSimple size={17} /><span>重命名图包</span><CaretRight size={13} /></button>}
        {!rootSelected && <button type="button" className="desktop-action-row is-danger" disabled={busy} onClick={onDeleteFolder}><Trash size={17} /><span>删除图包</span><CaretRight size={13} /></button>}
      </section>
    </aside>
  );
}

const FOLDER_TREE_ROW_HEIGHT = 36;
const FOLDER_TREE_OVERSCAN_ROWS = 8;
const FOLDER_TREE_WINDOW_BLOCK_ROWS = 8;
const FOLDER_TREE_INITIAL_ROWS = 32;

type FolderTreeRow = {
  folder: FolderNode;
  depth: number;
  positionInSet: number;
  setSize: number;
};

type FolderTreeWindow = {
  first: number;
  last: number;
};

function buildFolderChildren(snapshot: LibrarySnapshot): ReadonlyMap<string, readonly FolderNode[]> {
  const children = new Map<string, FolderNode[]>();
  for (const folder of Object.values(snapshot.folders)) {
    if (!folder.parentId) continue;
    const siblings = children.get(folder.parentId);
    if (siblings) {
      siblings.push(folder);
    } else {
      children.set(folder.parentId, [folder]);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name));
  }
  return children;
}

function flattenFolderTree(
  folderId: string,
  children: ReadonlyMap<string, readonly FolderNode[]>,
  expandedFolders: ReadonlySet<string>,
): FolderTreeRow[] {
  const rows: FolderTreeRow[] = [];
  const stack: FolderTreeRow[] = [];
  const rootChildren = children.get(folderId) ?? [];

  for (let index = rootChildren.length - 1; index >= 0; index -= 1) {
    stack.push({
      folder: rootChildren[index]!,
      depth: 0,
      positionInSet: index + 1,
      setSize: rootChildren.length,
    });
  }

  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    if (!expandedFolders.has(row.folder.id)) continue;

    const nestedChildren = children.get(row.folder.id) ?? [];
    for (let index = nestedChildren.length - 1; index >= 0; index -= 1) {
      stack.push({
        folder: nestedChildren[index]!,
        depth: row.depth + 1,
        positionInSet: index + 1,
        setSize: nestedChildren.length,
      });
    }
  }

  return rows;
}

function folderTreeWindowFor(rowCount: number, scrollTop: number, viewportHeight: number): FolderTreeWindow {
  if (rowCount <= 0) return { first: 0, last: 0 };

  const visibleRows = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / FOLDER_TREE_ROW_HEIGHT));
  const maxVisibleStart = Math.max(0, rowCount - visibleRows);
  const visibleStart = Math.min(
    maxVisibleStart,
    Math.max(0, Math.floor(Math.max(0, scrollTop) / FOLDER_TREE_ROW_HEIGHT)),
  );
  const firstCandidate = Math.max(0, visibleStart - FOLDER_TREE_OVERSCAN_ROWS);
  const first = Math.floor(firstCandidate / FOLDER_TREE_WINDOW_BLOCK_ROWS) * FOLDER_TREE_WINDOW_BLOCK_ROWS;
  const lastCandidate = Math.min(
    rowCount,
    visibleStart + visibleRows + FOLDER_TREE_OVERSCAN_ROWS,
  );
  const last = Math.min(
    rowCount,
    Math.ceil(lastCandidate / FOLDER_TREE_WINDOW_BLOCK_ROWS) * FOLDER_TREE_WINDOW_BLOCK_ROWS,
  );
  return { first, last };
}

// 展开目录先扩平为固定高度行，再按滚动位置分块窗口化。滚动时只有
// 这个 memo 子树会更新，且每跨越一个分块才更换 DOM 行。
const FolderTree = memo(function FolderTree({
  snapshot,
  folderId,
  selectedFolderId,
  onSelect,
  expandedFolders,
  onToggleFolder,
  onFolderContextMenu,
  scrollRootRef,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  selectedFolderId: string;
  onSelect: (folder: FolderNode) => void;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  onFolderContextMenu: (event: ReactMouseEvent, folder: FolderNode) => void;
  scrollRootRef?: RefObject<HTMLDivElement | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const children = useMemo(() => buildFolderChildren(snapshot), [snapshot]);
  const rows = useMemo(
    () => flattenFolderTree(folderId, children, expandedFolders),
    [children, expandedFolders, folderId],
  );
  const rowCountRef = useRef(rows.length);
  rowCountRef.current = rows.length;
  const [windowRows, setWindowRows] = useState<FolderTreeWindow>({
    first: 0,
    last: Math.min(rows.length, FOLDER_TREE_INITIAL_ROWS),
  });

  const updateWindow = useCallback(() => {
    const node = scrollRootRef?.current ?? scrollRef.current;
    if (!node) return;
    const localScrollTop = scrollRootRef?.current && scrollRef.current
      ? Math.max(0, scrollRootRef.current.scrollTop - scrollRef.current.offsetTop)
      : node.scrollTop;
    const next = folderTreeWindowFor(rowCountRef.current, localScrollTop, node.clientHeight);
    setWindowRows((current) => (
      current.first === next.first && current.last === next.last ? current : next
    ));
  }, [scrollRootRef]);

  const onScroll = useCallback(() => {
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateWindow();
    });
  }, [updateWindow]);

  useLayoutEffect(() => {
    updateWindow();
  }, [rows.length, updateWindow]);

  useEffect(() => {
    const node = scrollRootRef?.current ?? scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(updateWindow);
    observer.observe(node);
    if (scrollRootRef?.current && scrollRef.current) observer.observe(scrollRef.current);
    if (scrollRootRef?.current) scrollRootRef.current.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      if (scrollRootRef?.current) scrollRootRef.current.removeEventListener('scroll', onScroll);
    };
  }, [onScroll, scrollRootRef, updateWindow]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  return (
    <div ref={scrollRef} className="desktop-folder-tree-scroll">
      <ul
        className="desktop-tree-list desktop-tree-virtual-surface"
        style={{ height: rows.length * FOLDER_TREE_ROW_HEIGHT }}
        role="tree"
        aria-label="图包目录"
      >
        {rows.slice(windowRows.first, windowRows.last).map((row, windowIndex) => {
          const { folder, depth, positionInSet, setSize } = row;
          const hasChildren = folder.childCount > 0;
          const expanded = expandedFolders.has(folder.id);
          const active = folder.id === selectedFolderId;
          const rowIndex = windowRows.first + windowIndex;
          return (
            <li
              key={folder.id}
              className="desktop-tree-virtual-row"
              style={{ top: rowIndex * FOLDER_TREE_ROW_HEIGHT }}
              role="treeitem"
              aria-level={depth + 1}
              aria-posinset={positionInSet}
              aria-setsize={setSize}
              aria-selected={active}
              aria-expanded={hasChildren ? expanded : undefined}
            >
              <div
                className={`desktop-tree-row ${active ? 'is-active' : ''}`}
                style={{ paddingLeft: 6 + depth * 14 }}
                onContextMenu={(event) => onFolderContextMenu(event, folder)}
              >
                <button
                  type="button"
                  className={`chevron-btn ${hasChildren ? '' : 'invisible'} ${expanded ? 'expanded' : ''}`}
                  disabled={!hasChildren}
                  aria-label={hasChildren ? `${expanded ? '收起' : '展开'} ${folder.name}` : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasChildren) onToggleFolder(folder.id);
                  }}
                >
                  <svg className="chevron-icon" viewBox="0 0 12 12" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3.5 2.2L8.5 6l-5 3.8z" fill="currentColor" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="desktop-tree-target"
                  aria-label={`${folder.name}，${folder.imageCount.toLocaleString('zh-CN')} 张图片`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onSelect(folder)}
                >
                  {active ? <FolderOpen size={16} weight="fill" /> : <Folder size={16} weight="duotone" />}
                  <span className="desktop-tree-name">{folder.name}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

function TitleBar({
  navigation,
  theme,
  onThemeChange,
  busy,
  onImport,
}: {
  navigation?: ReactNode;
  theme: ThemeOption;
  onThemeChange: (value: ThemeOption) => void;
  busy: boolean;
  onImport: () => void;
}) {
  const hasNavigation = Boolean(navigation);
  return (
    <header className={`app-titlebar ${hasNavigation ? 'has-nav' : ''} ${window.kanitsuDesktop?.platform === 'electron' ? 'titlebar-drag' : ''}`}>
      {hasNavigation && <div className="desktop-titlebar-nav titlebar-no-drag">{navigation}</div>}
      <div className="desktop-titlebar-actions titlebar-no-drag">
        <DesktopIconButton
          label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </DesktopIconButton>
        <button type="button" className="desktop-button primary desktop-import-button" disabled={busy} onClick={onImport}>
          <UploadSimple size={16} />
          <span>{busy ? '正在导入' : '导入图包'}</span>
        </button>
        <DesktopWindowControls />
      </div>
    </header>
  );
}

// ---- 查看器：已解码原图缓存池（LRU，按估算字节限流）----
// 查看器始终显示原始分辨率原图，大图解码是切换卡顿的主因。这里预解码相邻
// 原图并把位图留在内存里（LRU），来回切换时 Chromium 直接复用已解码像素，
// 而不是每次现场解码。只用游离的 Image 对象，绝不触碰 React 渲染的元素。
const ORIGINAL_POOL_MAX_ENTRIES = 16;
const ORIGINAL_POOL_MAX_BYTES = 384 * 1024 * 1024; // RGBA 估算上限（约合几张千万像素图）
const ORIGINAL_POOL = new Map<string, HTMLImageElement>(); // 迭代序 = 插入序（LRU）
let ORIGINAL_POOL_BYTES = 0;

function estimatedImageBytes(width: number | undefined, height: number | undefined): number {
  return width && height && width > 0 && height > 0 ? width * height * 4 : 0;
}

function originalPoolTouch(url: string): void {
  const img = ORIGINAL_POOL.get(url);
  if (!img) return;
  ORIGINAL_POOL.delete(url);
  ORIGINAL_POOL.set(url, img);
}

/** 释放不再保留的 URL（web/memory 实现生成 blob: URL 需要 revoke；协议 URL 是 no-op）。 */
function releasePooledUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function originalPoolEvict(): void {
  while (
    (ORIGINAL_POOL.size > ORIGINAL_POOL_MAX_ENTRIES || ORIGINAL_POOL_BYTES > ORIGINAL_POOL_MAX_BYTES) &&
    ORIGINAL_POOL.size > 0
  ) {
    const oldestUrl = ORIGINAL_POOL.keys().next().value;
    if (oldestUrl === undefined) break;
    const img = ORIGINAL_POOL.get(oldestUrl);
    ORIGINAL_POOL.delete(oldestUrl);
    if (img) {
      ORIGINAL_POOL_BYTES -= estimatedImageBytes(img.naturalWidth, img.naturalHeight);
      img.removeAttribute('src'); // 释放解码位图引用
      releasePooledUrl(oldestUrl);
    }
  }
}

function originalPoolPut(url: string, img: HTMLImageElement): void {
  const bytes = estimatedImageBytes(img.naturalWidth, img.naturalHeight);
  const existing = ORIGINAL_POOL.get(url);
  if (existing) {
    ORIGINAL_POOL.delete(url);
    ORIGINAL_POOL_BYTES -= estimatedImageBytes(existing.naturalWidth, existing.naturalHeight);
  }
  ORIGINAL_POOL.set(url, img);
  ORIGINAL_POOL_BYTES += bytes;
  originalPoolEvict();
}

/** 预解码一张原图并把位图放入缓存池。 */
export function prefetchOriginal(url: string, estWidth?: number, estHeight?: number): void {
  if (ORIGINAL_POOL.has(url)) {
    originalPoolTouch(url);
    return;
  }
  // 预估内存超限则不预解码，避免压垮内存。
  if (ORIGINAL_POOL_BYTES + estimatedImageBytes(estWidth, estHeight) > ORIGINAL_POOL_MAX_BYTES * 2) {
    releasePooledUrl(url);
    return;
  }
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => originalPoolPut(url, img);
  img.onerror = () => {
    ORIGINAL_POOL.delete(url);
    releasePooledUrl(url);
  };
  img.src = url;
}

/** 返回已预解码的原图尺寸，让查看器可以跳过第二次等待。 */
export function peekPrefetchedOriginal(url: string): { w: number; h: number } | null {
  const img = ORIGINAL_POOL.get(url);
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  originalPoolTouch(url);
  return { w: img.naturalWidth, h: img.naturalHeight };
}

const VIEWER_FILMSTRIP_ITEM_WIDTH = 64;
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
  store,
  onNavigate,
}: {
  image: ImageEntry;
  itemIndex: number;
  itemCount: number;
  active: boolean;
  store: LibraryStore;
  onNavigate: (id: string) => void;
}) {
  const fileRef = useMemo(() => imageFileRef(image), [image]);
  return (
    <button
      type="button"
      className={active ? 'is-active' : ''}
      style={{ left: itemIndex * VIEWER_FILMSTRIP_STRIDE }}
      aria-label={`查看${image.name}`}
      aria-current={active ? 'true' : undefined}
      aria-posinset={itemIndex + 1}
      aria-setsize={itemCount}
      onClick={() => onNavigate(image.id)}
    >
      <BlobImage store={store} fileRef={fileRef} alt="" className="viewer-filmstrip-image" thumbnail lazy />
    </button>
  );
});

const ViewerFilmstrip = memo(function ViewerFilmstrip({
  images,
  activeIndex,
  store,
  onNavigate,
}: {
  images: readonly ImageEntry[];
  activeIndex: number;
  store: LibraryStore;
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
      className="viewer-filmstrip"
      aria-label="缩略图导航"
      onScroll={onScroll}
    >
      <div
        className="viewer-filmstrip-virtual-surface"
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
              store={store}
              onNavigate={handleNavigate}
            />
          );
        })}
      </div>
    </footer>
  );
});

function Viewer({
  images,
  index,
  store,
  onClose,
  onNavigate,
  onSwitchSibling,
  onImageContextMenu,
  showFilmstrip = true,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onSwitchSibling: (dir: number) => void;
  onImageContextMenu: (event: ReactMouseEvent, image: ImageEntry) => void;
  showFilmstrip?: boolean;
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
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [showInfo, setShowInfo] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const displayUrlRef = useRef<string | null>(null);
  const pendingUrlRef = useRef<string | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPan: { x: number; y: number } } | null>(null);

  const fileRefFor = (img: ImageEntry) => ({
    id: img.fileRefId ?? img.id,
    name: img.name,
    kind: 'file' as const,
    mtime: img.mtime,
    size: img.size,
    width: img.width,
    height: img.height,
  });

  useEffect(() => {
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
  }, [showInfo]);

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

  // 下一张图：取原始文件 URL，放入后台隐式解码的加载器（不立即换入显示）。
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    store.getViewerUrl(fileRefFor(image)).then((url) => {
      if (cancelled) {
        store.releaseViewerUrl(url);
        return;
      }
      const prefetched = peekPrefetchedOriginal(url);
      if (prefetched) {
        swapIn(image.id, url, prefetched.w, prefetched.h);
        return;
      }
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
  }, [image, store]);

  useEffect(() => {
    return () => {
      if (pendingUrlRef.current) store.releaseViewerUrl(pendingUrlRef.current);
      if (displayUrlRef.current) store.releaseViewerUrl(displayUrlRef.current);
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
    const fileRef = fileRefFor(image);
    const cached = peekThumbnailBlob(fileRef, 512);
    if (cached) {
      thumbObjectUrl = URL.createObjectURL(cached);
      setThumbImageId(image.id);
      setThumbUrl(thumbObjectUrl);
    } else {
      getThumbnailBlob(store, fileRef, 512, { shouldCancel: () => cancelled })
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
    setPan({ x: 0, y: 0 });
    setOriginalFailed(false);
    setNatural(image?.width && image?.height ? { w: image.width, h: image.height } : null);
  }, [image?.id, image?.width, image?.height]);

  // 预解码相邻原图（先 ±1、再 ±2，错峰执行）：位图保留在 ORIGINAL_POOL 里，
  // ←/→ 切换时直接复用已解码像素，不再等 Chromium 现场解码大图。
  useEffect(() => {
    if (!images.length) return;
    let cancelled = false;
    const jobs: (() => void)[] = [];
    for (const offset of [1, -1, 2, -2]) {
      const i = index + offset;
      if (i < 0 || i >= images.length) continue;
      const neighbor = images[i]!;
      jobs.push(() => {
        store
          .getViewerUrl(fileRefFor(neighbor))
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
  }, [image?.id, images, index, store]);

  const effectiveNatural = natural ?? (image.width && image.height ? { w: image.width, h: image.height } : null);

  const baseFit = useMemo(() => {
    if (!effectiveNatural || !containerSize.w || !containerSize.h) return 1;
    const s = Math.min(containerSize.w / effectiveNatural.w, containerSize.h / effectiveNatural.h);
    return Math.max(0.05, Math.min(1, s));
  }, [effectiveNatural, containerSize]);

  const displayed = useMemo(() => {
    const w = (effectiveNatural?.w ?? 1) * baseFit * zoom;
    const h = (effectiveNatural?.h ?? 1) * baseFit * zoom;
    return { w, h };
  }, [effectiveNatural, baseFit, zoom]);

  // The transform below uses scale(zoom). Keep the img's layout box at the
  // fit-to-window size so the browser's max-width:100% (Tailwind preflight)
  // does NOT shrink it a second time on top of the transform scale.
  const fitSize = useMemo(() => {
    const w = (effectiveNatural?.w ?? 1) * baseFit;
    const h = (effectiveNatural?.h ?? 1) * baseFit;
    return { w, h };
  }, [effectiveNatural, baseFit]);

  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const maxX = Math.max(0, (displayed.w - containerSize.w) / 2);
  const maxY = Math.max(0, (displayed.h - containerSize.h) / 2);
  const panX = clamp(pan.x, maxX);
  const panY = clamp(pan.y, maxY);

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => Math.max(0.5, Math.min(8, z * factor)));
  }, []);
  const fit = useCallback(() => setZoom(1), []);
  const percent = useCallback(() => {
    setZoom((z) => (baseFit > 0 ? 1 / baseFit : 1));
  }, [baseFit]);
  const toggleFit100 = useCallback(() => {
    setZoom((z) => (Math.abs(z - 1) < 0.01 ? (baseFit > 0 ? 1 / baseFit : 1) : 1));
  }, [baseFit]);
  const rotateCW = useCallback(() => setRotate((r) => (r + 90) % 360), []);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.context-menu, .modal.modal-open')) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
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
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        onNavigate(images[(index - 1 + images.length) % images.length]!.id);
      } else if (e.key === 'ArrowRight') {
        onNavigate(images[(index + 1) % images.length]!.id);
      } else if (e.key === 'ArrowUp') {
        onSwitchSibling(-1);
      } else if (e.key === 'ArrowDown') {
        onSwitchSibling(1);
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(1.25);
      } else if (e.key === '-') {
        zoomBy(0.8);
      } else if (e.key === '0') {
        fit();
      } else if (e.key === '1') {
        percent();
      } else if (e.key === 'r' || e.key === 'R') {
        rotateCW();
      }
    },
    [images, index, onClose, onNavigate, onSwitchSibling, zoomBy, fit, percent, rotateCW],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => previousFocus?.focus();
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

  return (
    <div className="viewer-overlay" role="dialog" aria-modal="true" aria-label={`查看${image.name}`}>
      <div className="viewer-dialog" ref={dialogRef}>
      <header className="viewer-toolbar">
        <div className="viewer-left">
          <button ref={closeButtonRef} type="button" className="viewer-button" onClick={onClose} aria-label="关闭查看器" title="关闭查看器"><X size={18} /></button>
          <div className="viewer-title">
            <strong title={image.name}>{image.name}</strong>
            <span>{index + 1} / {images.length}</span>
          </div>
        </div>
        <div className="viewer-tools" aria-label="查看工具">
          <button type="button" className="viewer-button" aria-label="缩小" title="缩小" onClick={() => zoomBy(0.8)}><Minus size={17} /></button>
          <button type="button" className="viewer-zoom" onClick={fit} title="适应窗口">{scalePercent}%</button>
          <button type="button" className="viewer-button" aria-label="放大" title="放大" onClick={() => zoomBy(1.25)}><Plus size={17} /></button>
          <span className="viewer-separator" />
          <button type="button" className="viewer-button" aria-label="适应窗口" title="适应窗口" onClick={fit}><ArrowsOut size={17} /></button>
          <button type="button" className="viewer-button viewer-tool-text" aria-label="原始大小" title="原始大小" onClick={percent}>1:1</button>
          <button type="button" className="viewer-button" aria-label="顺时针旋转" title="顺时针旋转" onClick={rotateCW}><ArrowClockwise size={17} /></button>
          <button type="button" className={`viewer-button ${showInfo ? 'is-active' : ''}`} aria-label="图片信息" aria-pressed={showInfo} title="图片信息" onClick={() => setShowInfo((value) => !value)}><Info size={17} /></button>
        </div>
      </header>
      <div
        className={`viewer-stage ${showInfo ? 'has-info' : ''}`}
        ref={containerRef}
        onContextMenu={(event) => onImageContextMenu(event, image)}
        onWheel={(e) => {
          e.preventDefault();
          zoomBy(e.deltaY > 0 ? 0.8 : 1.25);
        }}
        onDoubleClick={toggleFit100}
        onMouseDown={(e) => {
          dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan };
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
        <button type="button" className="viewer-nav is-left" aria-label="上一张" disabled={images.length <= 1} onClick={() => onNavigate(previousImage.id)}>
          <ArrowLeft size={21} />
        </button>
        {/* 缩略图就绪后“替换”旧图（不是叠放）：显示层与缩略图层互斥，避免快速
        切换时新缩略图叠在旧图上。旧图在缩略图就绪前保持显示，保证不黑屏。 */}
        {(hasCurrentDisplay && !showThumbReplace) && (
          <img
            className="viewer-image"
            src={displayUrl}
            alt={image.name}
            draggable={false}
            style={{
              width: fitSize.w,
              height: fitSize.h,
              transform: `translate(${panX}px, ${panY}px) rotate(${rotate}deg) scale(${zoom})`,
            }}
          />
        )}
        {/* 下一张图的后台隐式加载器：透明挂载，解码完成才换入 displayUrl。 */}
        {pendingUrl && (
          <img
            className="viewer-pending-image"
            src={pendingUrl}
            alt=""
            aria-hidden="true"
            decoding="async"
            onLoad={(e) => {
              const el = e.currentTarget;
              if (pendingUrlRef.current !== pendingUrl) return;
               swapIn(image.id, pendingUrl, el.naturalWidth, el.naturalHeight);
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
        {/* 新图缩略图占位：取代显示层，等待原图解码完成。 */}
        {showThumbReplace && (
          <img
            className="viewer-image viewer-placeholder-image"
            src={thumbUrl}
            alt=""
            aria-hidden="true"
            style={{ width: fitSize.w, height: fitSize.h }}
          />
        )}
        {/* 初始打开、显示层与缩略图都未就绪时的加载指示。 */}
        {!hasCurrentDisplay && !hasCurrentThumb && (
          <div className="viewer-loading" role="status" aria-label="正在载入图片">
            <span />
          </div>
        )}
        <button type="button" className="viewer-nav is-right" aria-label="下一张" disabled={images.length <= 1} onClick={() => onNavigate(nextImage.id)}>
          <ArrowRight size={21} />
        </button>
        {showInfo && (
          <aside className="viewer-info" aria-label="图片信息">
            <h2>图片信息</h2>
            <div><span>格式</span><strong>{image.ext.replace(/^\./, '').toUpperCase() || '未知'}</strong></div>
            <div><span>尺寸</span><strong>{natural ? `${natural.w} × ${natural.h}` : image.width && image.height ? `${image.width} × ${image.height}` : '未知'}</strong></div>
            <div><span>大小</span><strong>{formatBytes(image.size)}</strong></div>
            <div><span>文件修改</span><strong>{formatModifiedTime(image.mtime)}</strong></div>
            <div className="is-stacked"><span>所在路径</span><strong title={image.relPath}>{image.relPath}</strong></div>
            <button type="button" className="viewer-info-action" onClick={(event) => onImageContextMenu(event, image)}><Info size={14} />更多文件操作</button>
          </aside>
        )}
      </div>
      {showFilmstrip && <ViewerFilmstrip images={images} activeIndex={index} store={store} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}
