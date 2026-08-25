import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
  renameFolder,
  renameImage,
  rescanLibrary,
  undoOrganize,
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
import type { KanituDesktopBridge } from '../../fs-adapter/src/electron';
import { organizeByFolder, type CustomOrganizeRule } from '../../organizer/src/index';
import { pickCover } from '../../cover-picker/src/index';
import { BlobImage } from './BlobImage';
import {
  getThumbnailBlob,
  preloadThumbnails,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_DIRECTIONAL,
  THUMB_PRIORITY_SUBFOLDER,
  THUMB_PRIORITY_WARMUP,
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
import { loadCustomRules, saveCustomRules } from './OrganizeRulesModal';
import { OrganizePreview } from './OrganizePreview';
import { ArrowLeftIcon, ArrowRightIcon, FolderUpIcon, HomeIcon, NavButton, NavIconButton, PanelLeftIcon, SettingsIcon } from './NavButton';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { SettingsPage } from './SettingsPage';

function skippedReasonLabel(reason: ImportSkippedFile['reason']): string {
  switch (reason) {
    case 'no-extension':
      return '无扩展名';
    case 'unsupported-format':
      return '不支持的格式';
    default:
      return reason;
  }
}

function conflictReasonLabel(reason: string): string {
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

const BLUR_STORAGE_KEY = 'kanitu-blurred-images';
const PINNED_COVERS_KEY = 'kanitu-pinned-covers';

// 子文件夹预览图预加载参数：进入某文件夹时，为每个子文件夹的前若干张
// 缩略图预热缓存（见下方 useEffect），点进子文件夹时网格立即可用。
const PRELOAD_PER_FOLDER = 12;
const PRELOAD_MAX_FOLDERS = 16;

// —— 图片网格虚拟化（性能优化 P2）——
// 卡片尺寸固定（aspect-[4/3] + 定宽列），因此行高可精确度量。滚动时只挂载
// 可视区 ± OVERSCAN_ROWS 的行，其余行以绝对定位撑起总高度（与安卓相册
// RecyclerView 的"只实例化可视 ItemView + 缓冲区"同思路）。
const MIN_CARD_WIDTH = 180; // 与 styles.css .gallery-grid minmax(180px, 1fr) 对齐
const GRID_GAP = 16; // 与 .gallery-grid gap: 1rem 对齐
const OVERSCAN_ROWS = 3; // 可视区上下各多挂载的行数（缓冲）

interface GalleryMetrics {
  cols: number;
  cardHeight: number;
  rowHeight: number;
  /** 该 section 相对主滚动容器内容的顶部偏移（滚动无关）。 */
  galleryTop: number;
  /** 主滚动容器可视高度。 */
  viewportH: number;
}

/** 通用虚拟窗口计算：按滚动位置返回某区应挂载的首/末行（含上下缓冲）。 */
function windowRowsFor(
  m: GalleryMetrics,
  scrollTop: number,
  itemCount: number,
): { first: number; last: number } {
  if (m.rowHeight <= 0 || m.cols <= 0 || itemCount <= 0) return { first: 0, last: 0 };
  const totalRows = Math.ceil(itemCount / m.cols);
  const gs = Math.max(0, scrollTop - m.galleryTop);
  const first = Math.max(0, Math.floor(gs / m.rowHeight) - OVERSCAN_ROWS);
  const last = Math.min(totalRows, Math.ceil((gs + m.viewportH) / m.rowHeight) + OVERSCAN_ROWS);
  return { first, last };
}

function loadPinnedCovers(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PINNED_COVERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function savePinnedCovers(covers: Record<string, string>): void {
  try {
    localStorage.setItem(PINNED_COVERS_KEY, JSON.stringify(covers));
  } catch {
    // ignore storage errors
  }
}

function loadBlurredImages(): ReadonlySet<string> {
  try {
    // 旧版按相册（文件夹）存储，现改为逐图标记，作废旧键。
    localStorage.removeItem('kanitu-blurred-albums');
    const raw = localStorage.getItem(BLUR_STORAGE_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

function saveBlurredImages(paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLUR_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage errors
  }
}

function isImageBlurred(relPath: string | undefined, blurred: ReadonlySet<string>): boolean {
  return !!relPath && blurred.has(relPath);
}

export function LibraryBrowser({
  picker,
  store,
  index,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
}) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
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
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'folder'; folder: FolderNode } | { kind: 'image'; image: ImageEntry } | null>(null);
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
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem('kanitu-sidebar-hidden') === '1');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const value = Number(localStorage.getItem('kanitu-sidebar-width'));
    return Number.isFinite(value) && value >= 200 && value <= 480 ? value : 288;
  });
  const [customRules, setCustomRules] = useState<CustomOrganizeRule[]>(() => loadCustomRules());
  const [showSettings, setShowSettings] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuModel | null>(null);
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>(() => loadPinnedCovers());
  const [coverPickerFolder, setCoverPickerFolder] = useState<FolderNode | null>(null);
  // 前进/后退导航历史（浏览器/资源管理器风格）：栈 + 当前位置指针。
  const [nav, setNav] = useState<NavHistory>(() => createNavHistory());
  // 最近一次“已入栈”的目录 id：后退/前进自身触发的选中变化用它来抑制重复记录。
  const lastRecordedFolderRef = useRef<string | null>(null);

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
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
    void window.kanituDesktop?.setLogLevel?.(getLogLevelPref());
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
      localStorage.setItem('kanitu-sidebar-hidden', sidebarHidden ? '1' : '0');
    } catch {
      // Ignore storage errors.
    }
  }, [sidebarHidden]);

  useEffect(() => {
    try {
      localStorage.setItem('kanitu-sidebar-width', String(sidebarWidth));
    } catch {
      // Ignore storage errors.
    }
  }, [sidebarWidth]);

  // Startup: load the cached index (no full re-scan). Fallback scans + persists.
  useEffect(() => {
    void (async () => {
      applySnapshot(await loadOrScan(store, index));
    })();
  }, [store, index, applySnapshot]);

  // Mutation / explicit refresh: re-scan from disk and persist the fresh index.
  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index);
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot]);

  // Auto-dismiss the toast message after a short delay (like the demo).
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => notify(''), 3500);
    return () => clearTimeout(t);
  }, [message]);

  const searchTerm = searchQuery.trim().toLowerCase();
  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    const images = directImagesOf(snapshot, id);
    return searchTerm ? images.filter((img) => img.name.toLowerCase().includes(searchTerm)) : images;
  }, [snapshot, selectedFolderId, searchTerm]);

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const id = selectedFolderId || snapshot.rootId;
    const folders = childrenOf(snapshot, id).sort((a, b) => a.name.localeCompare(b.name));
    return searchTerm ? folders.filter((f) => f.name.toLowerCase().includes(searchTerm)) : folders;
  }, [snapshot, selectedFolderId, searchTerm]);

  const childFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return childFolders.map((child) => ({
      folder: child,
      cover: pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers[child.id] }),
    }));
  }, [snapshot, childFolders, pinnedCovers]);

  // —— 内容区滚动位置记忆 + 图片网格虚拟化（P2）+ 滚动方向预取（P3）——
  // 统一放在 folderImages/childFolders 之后：虚拟化窗口与方向预取都依赖
  // folderImages，且滚动时须同步 scrollTop 驱动窗口重算。
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const scrollSaveFrameRef = useRef<number | null>(null);
  const currentFolderId = selectedFolderId || snapshot?.rootId || '';
  const [scrollTop, setScrollTop] = useState(0);
  const [galleryMetrics, setGalleryMetrics] = useState<GalleryMetrics>({
    cols: 1,
    cardHeight: 0,
    rowHeight: 0,
    galleryTop: 0,
    viewportH: 0,
  });
  const galleryMetricsRef = useRef<GalleryMetrics>(galleryMetrics);
  const gallerySectionRef = useRef<HTMLElement | null>(null);
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
  const folderSectionRef = useRef<HTMLElement | null>(null);
  const folderProbeCardRef = useRef<HTMLDivElement | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);

  // 滚动时（rAF 节流）记录该目录的滚动位置；只在虚拟窗口（文件夹/图片两区）
  // 发生变化时才 setScrollTop 触发整树重渲——小幅度滚动（仍在同一行内）不重渲，
  // 护住目录多/图多场景的帧率。
  const lastWindowKeyRef = useRef('');
  const onMainScroll = useCallback(() => {
    const el = mainScrollRef.current;
    if (!el || !currentFolderId) return;
    if (scrollSaveFrameRef.current != null) return; // 已排队待写
    scrollSaveFrameRef.current = requestAnimationFrame(() => {
      scrollSaveFrameRef.current = null;
      const node = mainScrollRef.current;
      if (!node) return;
      const st = node.scrollTop;
      scrollPositionsRef.current.set(currentFolderId, st); // 位置记忆始终更新
      const fw = windowRowsFor(folderMetricsRef.current, st, childFolderCards.length);
      const gw = windowRowsFor(galleryMetricsRef.current, st, folderImages.length);
      const key = `${fw.first}:${fw.last}|${gw.first}:${gw.last}`;
      if (key !== lastWindowKeyRef.current) {
        lastWindowKeyRef.current = key;
        setScrollTop(st);
      }
    });
  }, [currentFolderId, childFolderCards.length, folderImages.length]);

  // 主滚动容器尺寸变化（窗口缩放 / 侧栏调宽）时重新度量。
  useEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    const ro = new ResizeObserver(() => setLayoutTick((t) => t + 1));
    ro.observe(main);
    return () => ro.disconnect();
  }, []);

  // 度量两个虚拟区（子文件夹 / 图片）的列数、真实卡片高度、相对主容器的偏移
  // 与视口高度。各自用同构探测卡量高度（含 figcaption/边框），行高无累积漂移；
  // 文件夹卡片与图片卡片 caption 高度不同，因此分开度量。
  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    const measure = (
      section: HTMLElement | null,
      probe: HTMLDivElement | null,
      fallbackCaptionH: number,
    ): GalleryMetrics => {
      if (!section) {
        return { cols: 1, cardHeight: 0, rowHeight: 0, galleryTop: 0, viewportH: 0 };
      }
      const sectionW = section.clientWidth;
      const cols = Math.max(1, Math.floor((sectionW + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
      const estCardW = (sectionW - GRID_GAP * (cols - 1)) / cols;
      const cardHeight = probe?.offsetHeight || estCardW * 0.75 + fallbackCaptionH;
      const rowHeight = cardHeight + GRID_GAP;
      const offset =
        section.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      return { cols, cardHeight, rowHeight, galleryTop: offset, viewportH: main.clientHeight };
    };
    const same = (a: GalleryMetrics, b: GalleryMetrics): boolean =>
      a.cols === b.cols &&
      a.cardHeight === b.cardHeight &&
      a.rowHeight === b.rowHeight &&
      a.galleryTop === b.galleryTop &&
      a.viewportH === b.viewportH;
    const nextFolder = measure(folderSectionRef.current, folderProbeCardRef.current, 46);
    const nextGallery = measure(gallerySectionRef.current, probeCardRef.current, 42);
    setFolderMetrics((prev) => (same(prev, nextFolder) ? prev : nextFolder));
    setGalleryMetrics((prev) => (same(prev, nextGallery) ? prev : nextGallery));
  }, [folderImages.length, childFolderCards.length, searchQuery, selectedFolderId, snapshot, sidebarHidden, sidebarWidth, layoutTick]);

  // 最新度量同步到 ref：滚动窗口计算/方向预取在 rAF/effect 里读取，避免陈旧值。
  useEffect(() => {
    galleryMetricsRef.current = galleryMetrics;
    folderMetricsRef.current = folderMetrics;
  }, [galleryMetrics, folderMetrics]);

  // 切换目录后恢复该目录上次浏览位置（首次进入为顶部）。主区启用了
  // scroll-smooth，恢复动作为“柔和滑回”；但要等各 section 的虚拟化度量就绪
  // （行高准确、内容高度真实）再执行，否则平滑滚动会在内容还没撑高时先被
  // 钳到 0，出现“先跳顶再滑回”的抽搐。
  useLayoutEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    if (childFolderCards.length > 0 && folderMetrics.rowHeight <= 0) return;
    if (folderImages.length > 0 && galleryMetrics.rowHeight <= 0) return;
    el.scrollTop = scrollPositionsRef.current.get(currentFolderId) ?? 0;
  }, [
    selectedFolderId,
    snapshot,
    galleryMetrics,
    folderMetrics,
    currentFolderId,
    childFolderCards.length,
    folderImages.length,
  ]);

  // —— 滚动方向预取（P3）：按方向把“下一屏”缩略图以优先级 1 排入 worker，
  // 抢在整目录后台预热（优先级 2）之前生成，快速滚动时白格明显减少。
  // 与安卓 RecyclerView 的 prefetch（滚动时预解码下一屏）同思路。 ——
  const lastScrollTopRef = useRef(0);
  const lastDirectionalKeyRef = useRef('');
  const directionalTokenRef = useRef<{ cancelled: boolean } | null>(null);

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
    for (const child of childFolders) {
      if (targets.length >= PRELOAD_MAX_FOLDERS) break;
      for (const img of directImagesOf(snapshot, child.id).slice(0, PRELOAD_PER_FOLDER)) {
        targets.push({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file', mtime: img.mtime, size: img.size });
      }
    }
    if (targets.length === 0) return;
    if (!isPrefetchEnabled()) return; // 设置页“调试→预取开关”可关闭
    const schedule = (work: () => void): void => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(work, { timeout: 1500 });
      } else {
        setTimeout(work, 0);
      }
    };
    schedule(() => preloadThumbnails(store, targets, { priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled }));
    logDebug('prefetch', `子文件夹预取 P2：${targets.length} 张`);
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, childFolders, store]);

  // 当前目录的其余图片（优先级 1）：不仅仅加载“点击过/可见”的图，整个目录的
// 缩略图都按顺序排入 worker 后台生成。可见请求仍最高优先级插队在前；预取
// 命中后，滚动到任意位置都直接出图（配合磁盘缓存，重启后同样免解码）。
  useEffect(() => {
    if (!snapshot) return;
    const token = { cancelled: false };
    const targets: FileRef[] = folderImages.map((img) => ({
      id: img.fileRefId ?? img.id,
      name: img.name,
      kind: 'file',
      mtime: img.mtime,
      size: img.size,
    }));
    if (targets.length === 0) return;
    if (!isPrefetchEnabled()) return; // 设置页“调试→预取开关”可关闭
    preloadThumbnails(store, targets, {
      priority: THUMB_PRIORITY_CURRENT_DIR,
      // 并发 2 → 4（与主进程 worker 数对齐）：5000 张的整目录预取等待时间减半；
      // 可见请求会按需升级插队，因此稍高的并发不会拖慢正在显示的图。
      concurrency: 4,
      shouldStop: () => token.cancelled,
    });
    logDebug('prefetch', `当前目录预取 P1：${folderImages.length} 张 → ${selectedFolder?.name ?? '根'}`);
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, selectedFolderId, folderImages, store]);

  // 启动即全库低优先级预热（优先级 3）：打开应用后就按“当前目录（初始为根目录）
  // 优先 → 其余随后”的顺序，把整个图库的缩略图排入 worker 后台生成，可见的图
  // 仍最高优先级插队。已生成的条目落盘（userData/thumbcache），重启直接读盘。
  // 仅随快照变化（刷新/导入后）重启预热，切换目录不中断。
  useEffect(() => {
    if (!snapshot) return;
    const token = { cancelled: false };
    const folderImageIds = new Set(directImagesOf(snapshot, snapshot.rootId).map((img) => img.id));
    const all = Object.values(snapshot.images);
    const ordered: FileRef[] = [
      ...all.filter((img) => folderImageIds.has(img.id)),
      ...all.filter((img) => !folderImageIds.has(img.id)),
    ].map((img) => ({ id: img.fileRefId ?? img.id, name: img.name, kind: 'file', mtime: img.mtime, size: img.size }));
    if (ordered.length === 0) return;
    if (!isPrefetchEnabled()) return; // 设置页“调试→预取开关”可关闭
    preloadThumbnails(store, ordered, { priority: THUMB_PRIORITY_WARMUP, shouldStop: () => token.cancelled });
    logDebug('prefetch', `全库预热 P3：${ordered.length} 张（当前目录 ${folderImageIds.size} 张优先）`);
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, store]);

  const selectedFolder = snapshot?.folders[selectedFolderId || snapshot?.rootId || ''] ?? null;
  const rootFolder = snapshot?.folders[snapshot.rootId] ?? null;
  const selectedParentFolder = selectedFolder?.parentId ? snapshot?.folders[selectedFolder.parentId] ?? null : null;
  const runtimeLabel =
    (window as { kanituDesktop?: { platform?: string } }).kanituDesktop?.platform === 'electron'
      ? 'Electron 模式 v0.5 · daisyUI 5'
      : 'Web 模式 v0.5 · daisyUI 5';
  const isRootSelected = !selectedFolderId || selectedFolderId === snapshot?.rootId;
  // 文件夹级模糊状态：统计当前相册（含所有子文件夹）里逐图标记的数量。
  const folderAllImages = useMemo(
    () => (snapshot && selectedFolder ? imagesOf(snapshot, selectedFolder.id) : []),
    [snapshot, selectedFolder],
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
    if (!selectedFolder || !snapshot) return null;
    const images = imagesOf(snapshot, selectedFolder.id);
    return pickCover(images, { preferredId: pinnedCovers[selectedFolder.id] });
  }, [snapshot, selectedFolder, pinnedCovers]);

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
  }, [viewerImageId, folderImages, handleNavBack, handleNavForward]);

  const handleGoUp = useCallback(() => {
    if (!snapshot || !selectedFolder?.parentId) return;
    const parent = snapshot.folders[selectedFolder.parentId];
    if (parent) handleSelectFolder(parent);
  }, [snapshot, selectedFolder, handleSelectFolder]);

  const handleGoRoot = useCallback(() => {
    if (rootFolder) handleSelectFolder(rootFolder);
  }, [rootFolder, handleSelectFolder]);

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
      const next = await refresh();
      const importedTopFolder = Object.values(next.folders).find(
        (folder) => folder.parentId === next.rootId && folder.name === task.targetTopFolder,
      );
      if (importedTopFolder) {
        setSelectedFolderId(importedTopFolder.id);
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
    setSelectedFolderId(folder.id);
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
        const base = folder.relPath ? folder.relPath.split('/').pop() : '相册';
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
      if (parentId) setSelectedFolderId(parentId);
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
    notify(imageId ? `已将“${imageName ?? '该图片'}”设为相册封面。` : '已取消固定封面。');
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
        setSelectedFolderId(created.id);
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
    return [
      { label: '查看图片', icon: '🔍', onSelect: () => setViewerImageId(image.id) },
      {
        label: imageBlurred ? '取消隐私预览' : '设为隐私预览',
        icon: imageBlurred ? '🔓' : '🔒',
        onSelect: () => toggleImageBlur(image),
      },
      {
        label: pinnedCovers[image.folderId] === image.id ? '取消固定封面' : '设为封面',
        icon: '⭐',
        onSelect: () => pinCover(image.folderId, pinnedCovers[image.folderId] === image.id ? null : image.id, image.name),
      },
      { label: '重命名…', icon: '✏️', onSelect: () => void handleRenameImage(image) },
      { label: '复制路径', icon: '📋', onSelect: () => void copyPath(image.relPath) },
      { label: '删除', icon: '🗑️', danger: true, separator: true, onSelect: () => requestDeleteImage(image) },
    ];
  };

  const buildFolderMenu = (folder: FolderNode): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: '打开', icon: '📂', onSelect: () => handleSelectFolder(folder) },
      { label: '新建子文件夹…', icon: '➕', onSelect: () => void handleCreateSubfolder(folder) },
    ];
    if (folder.relPath && folder.childCount > 0) {
      items.push({
        label: expandedFolders.has(folder.id) ? '收起子目录' : '展开子目录',
        icon: expandedFolders.has(folder.id) ? '▾' : '▸',
        onSelect: () => toggleFolder(folder.id),
      });
    }
    if (folder.relPath) {
      items.push({ label: '重命名…', icon: '✏️', onSelect: () => void handleRenameFolder(folder) });
    }
    const folderImagesList = snapshot ? imagesOf(snapshot, folder.id) : [];
    const folderAllBlurred =
      folderImagesList.length > 0 && folderImagesList.every((img) => blurredImages.has(img.relPath));
    items.push({
      label: folderAllBlurred ? '取消隐私预览（含子文件夹）' : '设为隐私预览（含子文件夹）',
      icon: folderAllBlurred ? '🔓' : '🔒',
      disabled: folderImagesList.length === 0,
      onSelect: () => toggleFolderBlur(folder),
    });
    items.push({
      label: '设置封面…',
      icon: '🖼️',
      disabled: folderImagesList.length === 0,
      onSelect: () => setCoverPickerFolder(folder),
    });
    items.push(
      { label: '整理…', icon: '🧹', onSelect: () => openOrganizePreviewFor(folder) },
      { label: '导出 ZIP…', icon: '📦', onSelect: () => void exportFolder(folder) },
      { label: '复制路径', icon: '📋', onSelect: () => void copyPath(folder.relPath || '根目录') },
    );
    if (folder.relPath) {
      items.push({ label: '删除', icon: '🗑️', danger: true, separator: true, onSelect: () => requestDeleteFolder(folder) });
    }
    return items;
  };

  const viewerImages = folderImages;
  const viewerIndex = viewerImages.findIndex((img) => img.id === viewerImageId);

  return (
    <div className="app-shell flex h-screen flex-col">
      <TitleBar />
      <div className={'drawer flex-1 min-h-0' + (sidebarHidden ? '' : ' lg:drawer-open')}>
        <input id="app-drawer" type="checkbox" className="drawer-toggle" checked={!sidebarHidden} onChange={(event) => setSidebarHidden(!event.target.checked)} />

      <div className="drawer-content flex flex-col min-h-0">
        <div className="navbar bg-base-200 border-b border-base-300 px-4 gap-2 sticky top-0 z-10">
          <div className="flex-none lg:hidden">
            <label htmlFor="app-drawer" className="btn btn-square btn-ghost" aria-label="打开侧边栏">☰</label>
          </div>
          <div className="flex-none flex items-center gap-1">
            <NavIconButton
              onClick={() => setSidebarHidden((value) => !value)}
              className="hidden lg:inline-flex"
              title={sidebarHidden ? '显示侧边栏' : '隐藏侧边栏'}
            >
              <PanelLeftIcon />
            </NavIconButton>
            <NavIconButton onClick={handleNavBack} disabled={!canGoBack(nav)} title="后退">
              <ArrowLeftIcon />
            </NavIconButton>
            <NavIconButton onClick={handleNavForward} disabled={!canGoForward(nav)} title="前进">
              <ArrowRightIcon />
            </NavIconButton>
            <NavIconButton onClick={handleGoUp} disabled={!selectedParentFolder} title="上一级目录">
              <FolderUpIcon />
            </NavIconButton>
            <NavIconButton onClick={handleGoRoot} disabled={isRootSelected} active={isRootSelected} title="全部相册">
              <HomeIcon />
            </NavIconButton>
          </div>
          <div className="flex-1 min-w-0">
            <nav className="breadcrumbs text-sm" aria-label="面包屑">
              <ul>
                {crumbs.map((crumb, i) => (
                  <li key={crumb.id} className={i === crumbs.length - 1 ? 'font-semibold' : ''}>
                    {i < crumbs.length - 1 ? (
                      <a className="link link-hover" onClick={() => handleSelectFolder(crumb)}>{crumb.name}</a>
                    ) : (
                      <span>{crumb.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="flex-none">
            <ThemeToggle />
          </div>
        </div>

        <div className="bg-base-100 px-5 lg:px-8 py-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="min-w-0">
              <h2 className="text-2xl font-bold min-w-0">{selectedFolder?.name ?? '全部相册'}</h2>
              {(selectedFolder || cover) && (
                <div className="mt-1 text-sm opacity-70 flex flex-wrap gap-x-4 gap-y-1">
                  {selectedFolder && (
                    <span>{selectedFolder.imageCount} 图片 / {selectedFolder.childCount} 子目录</span>
                  )}
                  {blurredInFolderCount > 0 && (
                    <span>隐私预览 {blurredInFolderCount} 张</span>
                  )}
                  {cover && (
                    <span>
                      封面：{snapshot?.images[cover.imageId]?.name ?? cover.imageId}
                      {selectedFolder && pinnedCovers[selectedFolder.id] != null && '（已固定）'}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-none shrink-0 flex-wrap justify-end gap-2">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleAdd}>导入相册</button>
            <button className="btn btn-ghost btn-sm" disabled={!selectedFolder} onClick={() => void refresh()}>刷新</button>
            <button className="btn btn-ghost btn-sm" disabled={!selectedFolder} onClick={openOrganizePreview}>整理</button>
            <button className="btn btn-ghost btn-sm" disabled={!lastManifest || busy} onClick={handleUndoOrganize}>撤销</button>
            <button className="btn btn-ghost btn-sm" disabled={!selectedFolder || busy || exporting} onClick={handleExport}>
              {exporting ? '导出中…' : '导出 ZIP'}
            </button>
            <button className="btn btn-error btn-sm btn-outline" disabled={!selectedFolder || !selectedFolder.relPath || busy || exporting} onClick={requestDelete}>删除</button>
            {importReport && <button className="btn btn-ghost btn-sm" onClick={() => setImportReport(importReport)}>报告</button>}
          </div>
        </div>

        <main className="flex-1 overflow-y-auto p-5 lg:p-8 scroll-smooth" ref={mainScrollRef} onScroll={onMainScroll}>
          {childFolderCards.length > 0 && (
            <section className="mb-8" ref={folderSectionRef}>
              <h3 className="text-sm font-semibold opacity-70 mb-3">子文件夹</h3>
              {/* 文件夹区虚拟化（同图片区）：目录多时只挂载可视行 ± 缓冲，DOM 稳定 */}
              {(() => {
                const { cols, rowHeight, galleryTop, viewportH } = folderMetrics;
                const totalRows = cols > 0 ? Math.ceil(childFolderCards.length / cols) : 0;
                if (totalRows === 0) return null;
                const gs = Math.max(0, scrollTop - galleryTop);
                const firstRow =
                  rowHeight > 0 ? Math.max(0, Math.floor(gs / rowHeight) - OVERSCAN_ROWS) : 0;
                const lastRow =
                  rowHeight > 0
                    ? Math.min(totalRows, Math.ceil((gs + viewportH) / rowHeight) + OVERSCAN_ROWS)
                    : Math.min(totalRows, 1);
                const rows: number[] = [];
                for (let r = firstRow; r < lastRow; r++) rows.push(r);
                return (
                  <div style={{ position: 'relative', height: Math.max(1, totalRows * rowHeight) }}>
                    {rows.map((row) => {
                      const start = row * cols;
                      const end = Math.min(childFolderCards.length, start + cols);
                      return (
                        <div
                          key={row}
                          className="folder-grid"
                          style={{ position: 'absolute', top: row * rowHeight, left: 0, right: 0 }}
                        >
                          {childFolderCards.slice(start, end).map(({ folder, cover }) => (
                            <div
                              key={folder.id}
                              className="card bg-base-200 border border-base-300 shadow hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] transition cursor-pointer overflow-hidden kanitu-card-in"
                              onClick={() => handleSelectFolder(folder)}
                              onContextMenu={(event) => openContextMenu(event, buildFolderMenu(folder))}
                            >
                              <figure className="aspect-[4/3] overflow-hidden relative">
                                {cover ? (
                                  <BlobImage
                                    store={store}
                                    fileRef={{
                                      id: snapshot?.images[cover.imageId]?.fileRefId ?? cover.imageId,
                                      name: snapshot?.images[cover.imageId]?.name ?? '',
                                      kind: 'file',
                                      mtime: snapshot?.images[cover.imageId]?.mtime,
                                      size: snapshot?.images[cover.imageId]?.size,
                                    }}
                                    alt={folder.name}
                                    className="w-full h-full object-cover"
                                    thumbnail
                                    lazy
                                    blur={isImageBlurred(snapshot?.images[cover.imageId]?.relPath, blurredImages)}
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center opacity-60 text-sm">无图片</div>
                                )}
                                {pinnedCovers[folder.id] != null && (
                                  <span className="absolute top-2 left-2 z-10 badge badge-primary badge-sm shadow">⭐ 已固定</span>
                                )}
                              </figure>
                              <figcaption className="p-3 flex items-center justify-between gap-2">
                                <span className="text-sm font-medium truncate">{folder.name}</span>
                                <span className="text-[11px] opacity-60 whitespace-nowrap">{folder.imageCount} 图 / {folder.childCount} 子</span>
                              </figcaption>
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
                      <div className="folder-grid">
                        <div ref={folderProbeCardRef} className="card bg-base-200 border border-base-300 shadow overflow-hidden">
                          <figure className="aspect-[4/3] overflow-hidden relative" />
                          <figcaption className="p-3 flex items-center justify-between gap-2">
                            <span className="text-sm font-medium truncate">测</span>
                            <span className="text-[11px] opacity-60 whitespace-nowrap">0 图 / 0 子</span>
                          </figcaption>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

          {folderImages.length > 0 && (
            <section className="mb-8" ref={gallerySectionRef}>
              <h3 className="text-sm font-semibold opacity-70 mb-3">图片</h3>
              {/* 虚拟化网格（P2）：只挂载可视区 ± 缓冲的行，其余行由绝对定位撑起总高，
                  从"全量 DOM"变为"固定几十张"，滚动时只替换窗口内的行。 */}
              {(() => {
                const { cols, rowHeight, galleryTop, viewportH } = galleryMetrics;
                const totalRows = cols > 0 ? Math.ceil(folderImages.length / cols) : 0;
                if (totalRows === 0) return null;
                const gs = Math.max(0, scrollTop - galleryTop);
                const firstRow =
                  rowHeight > 0 ? Math.max(0, Math.floor(gs / rowHeight) - OVERSCAN_ROWS) : 0;
                const lastRow =
                  rowHeight > 0
                    ? Math.min(totalRows, Math.ceil((gs + viewportH) / rowHeight) + OVERSCAN_ROWS)
                    : Math.min(totalRows, 1);
                const rows: number[] = [];
                for (let r = firstRow; r < lastRow; r++) rows.push(r);
                return (
                  <div style={{ position: 'relative', height: Math.max(1, totalRows * rowHeight) }}>
                    {rows.map((row) => {
                      const start = row * cols;
                      const end = Math.min(folderImages.length, start + cols);
                      return (
                        <div
                          key={row}
                          className="gallery-grid"
                          style={{ position: 'absolute', top: row * rowHeight, left: 0, right: 0 }}
                        >
                          {folderImages.slice(start, end).map((image) => (
                            <div
                              key={image.id}
                              className="card bg-base-200 border border-base-300 shadow hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] transition cursor-pointer overflow-hidden kanitu-card-in"
                              onClick={() => setViewerImageId(image.id)}
                              onContextMenu={(event) => openContextMenu(event, buildImageMenu(image))}
                            >
                              <figure className="aspect-[4/3] overflow-hidden relative">
                                <BlobImage
                                  store={store}
                                  fileRef={{ id: image.fileRefId ?? image.id, name: image.name, kind: 'file', mtime: image.mtime, size: image.size }}
                                  alt={image.name}
                                  className="w-full h-full object-cover"
                                  thumbnail
                                  lazy
                                  blur={blurredImages.has(image.relPath)}
                                />
                              </figure>
                              <figcaption className="p-3">
                                <span className="text-xs truncate block">{image.name}</span>
                              </figcaption>
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
                      <div className="gallery-grid">
                        <div ref={probeCardRef} className="card bg-base-200 border border-base-300 shadow overflow-hidden">
                          <figure className="aspect-[4/3] overflow-hidden relative" />
                          <figcaption className="p-3">
                            <span className="text-xs truncate block">测</span>
                          </figcaption>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </section>
          )}

          {childFolderCards.length === 0 && folderImages.length === 0 && (
            <div className="border-2 border-dashed border-base-300 rounded-2xl p-12 text-center">
              <p className="text-4xl mb-3">{searchTerm ? '⍰' : '◻'}</p>
              <div className="text-lg font-medium mb-1">{searchTerm ? '未找到匹配结果' : '该目录暂无图片'}</div>
              <p className="text-sm opacity-70 mb-4">{searchTerm ? `没有与“${searchQuery}”匹配的相册或图片` : '导入照片，开始整理你的图库'}</p>
              {!searchTerm && <button className="btn btn-primary" disabled={busy} onClick={handleAdd}>导入图片</button>}
            </div>
          )}
        </main>

      </div>

      <div className="drawer-side">
        <label htmlFor="app-drawer" className="drawer-overlay"></label>
        <aside className="bg-base-200 h-full flex flex-col relative shrink-0" style={{ width: sidebarWidth }}>
          <SidebarResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
          <div className="p-4 pb-0 flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
            <div className="px-1">
            <label className="input input-sm w-full flex items-center gap-2 bg-base-100 border-base-300">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 opacity-60"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
              <input
                type="text"
                className="grow"
                placeholder="搜索相册 / 图片…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="btn btn-ghost btn-xs btn-square" title="清除搜索" onClick={() => setSearchQuery('')}>✕</button>
              )}
            </label>
          </div>

          {rootFolder && (
            <div>
              <div className="menu-title text-xs opacity-60 px-1 mt-1">快捷</div>
              <div
                className={`flex items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 cursor-pointer ${isRootSelected ? 'bg-primary/15 text-primary' : 'hover:bg-base-300/60'}`}
                onClick={() => handleSelectFolder(rootFolder)}
                onContextMenu={(event) => openContextMenu(event, buildFolderMenu(rootFolder))}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0"><path d="M3 10.5L12 3l9 7.5V21H3z"/></svg>
                <span className="truncate">全部相册</span>
                {rootFolder.imageCount > 0 && <span className={`badge badge-sm ml-auto ${isRootSelected ? 'badge-primary' : 'badge-ghost'}`}>{rootFolder.imageCount}</span>}
              </div>
            </div>
          )}

          <div className="menu-title text-xs opacity-60 px-1 mt-1">目录树</div>
          {snapshot && (
            <FolderTree
              snapshot={snapshot}
              folderId={snapshot.rootId}
              selectedFolderId={selectedFolderId || snapshot.rootId}
              onSelect={handleSelectFolder}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              onFolderContextMenu={(event, folder) => openContextMenu(event, buildFolderMenu(folder))}
              depth={0}
            />
          )}

          </div>
          <div className="p-4 pt-3 border-t border-base-300 shrink-0 flex flex-col gap-2 text-sm bg-base-200">
            {importReport && (
              <NavButton onClick={() => setImportReport(importReport)} className="w-full">
                <span>导入报告</span>
              </NavButton>
            )}
            <NavButton onClick={() => setShowSettings(true)} className="w-full" title="设置">
              <SettingsIcon />
              <span>设置</span>
            </NavButton>
            <div className="text-xs opacity-60 px-1">{runtimeLabel}</div>
          </div>
        </aside>
      </div>

      {showSettings && (
        <SettingsPage
          rules={customRules}
          onChange={handleCustomRulesChange}
          onBack={() => setShowSettings(false)}
          runtimeLabel={runtimeLabel}
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={setSidebarWidth}
        />
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

      {importReport && (
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
            <div className="modal-action shrink-0"><button className="btn btn-ghost" onClick={() => setImportReport(null)}>关闭</button></div>
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
                  : `确定要删除图包“${deleteTarget.folder.name}”及其全部子目录吗？此操作不可撤销。`}
              </p>
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
        <Viewer
          images={viewerImages}
          index={viewerIndex}
          store={store}
          onClose={() => setViewerImageId(null)}
          onNavigate={(id) => setViewerImageId(id)}
          onSwitchSibling={handleViewerSwitchSibling}
          onImageContextMenu={(event, image) => openContextMenu(event, buildImageMenu(image))}
        />
      ) : (
        <div className="toast toast-end">
          {message && <div className={`alert alert-${messageKind} shadow-lg`}><span>{message}</span></div>}
          {exporting && exportProgress && (
            <div className="alert alert-info shadow-lg">
              <span>打包中… {exportProgress.done}/{exportProgress.total}</span>
              <progress className="progress progress-info w-24" value={exportProgress.done} max={exportProgress.total || 1} />
            </div>
          )}
        </div>
      )}

      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
    </div>
  );
}

// 侧栏目录树：浅比较 memo。LibraryBrowser 每帧滚动都会重渲外壳，但树的
// props（snapshot/选中目录/展开集/回调）在滚动期间稳定，memo 让整棵树跳过
// 每帧 Reconciliation——文件夹越多收益越大。
const FolderTree = memo(function FolderTree({
  snapshot,
  folderId,
  selectedFolderId,
  onSelect,
  expandedFolders,
  onToggleFolder,
  onFolderContextMenu,
  depth,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  selectedFolderId: string;
  onSelect: (folder: FolderNode) => void;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  onFolderContextMenu: (event: ReactMouseEvent, folder: FolderNode) => void;
  depth: number;
}) {
  const children = childrenOf(snapshot, folderId).sort((a, b) => a.name.localeCompare(b.name));
  if (children.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      {children.map((folder) => {
        const childFolders = childrenOf(snapshot, folder.id);
        const hasChildren = childFolders.length > 0;
        const expanded = expandedFolders.has(folder.id);
        const active = folder.id === selectedFolderId;
        return (
          <li key={folder.id}>
            <div
              className={`flex items-center rounded-lg ${active ? 'bg-primary/15 text-primary' : 'hover:bg-base-300/60'}`}
              onContextMenu={(event) => onFolderContextMenu(event, folder)}
            >
              <button
                className={`chevron-btn ${hasChildren ? '' : 'invisible'} ${expanded ? 'expanded' : ''}`}
                disabled={!hasChildren}
                aria-label={hasChildren ? (expanded ? '收起' : '展开') : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) onToggleFolder(folder.id);
                }}
              >
                <svg className="chevron-icon" viewBox="0 0 12 12" width="12" height="12" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3.5 2.2L8.5 6l-5 3.8z" fill="currentColor" />
                </svg>
              </button>
              <button className="flex-1 min-w-0 text-left flex items-center justify-between gap-2 py-1.5 pr-2" onClick={() => onSelect(folder)}>
                <span className="truncate">{folder.name}</span>
                <span className={`badge badge-sm ${active ? 'badge-primary' : 'badge-ghost'}`}>{folder.imageCount}</span>
              </button>
            </div>
            {hasChildren && expanded && (
              <FolderTree
                snapshot={snapshot}
                folderId={folder.id}
                selectedFolderId={selectedFolderId}
                onSelect={onSelect}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onFolderContextMenu={onFolderContextMenu}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
});

function TitleBar() {
  const bridge = (window as { kanituDesktop?: KanituDesktopBridge }).kanituDesktop;
  const isElectron = bridge?.platform === 'electron';
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    let alive = true;
    void bridge?.isWindowMaximized?.().then((m) => {
      if (alive) setMaximized(m);
    });
    const off = bridge?.onWindowMaximizedChanged?.((m) => setMaximized(m));
    return () => {
      alive = false;
      off?.();
    };
  }, [isElectron, bridge]);

  const toggleMaximize = () => {
    if (!isElectron) return;
    void bridge?.maximizeWindowToggle?.().then((m) => setMaximized(m));
  };

  if (!isElectron) return null;

  return (
    <div
      className={`app-titlebar flex items-center justify-between h-12 px-3 shrink-0 select-none bg-base-200 border-b border-base-300 ${isElectron ? 'titlebar-drag' : ''}`}
    >
      <div className="flex items-center gap-2.5 min-w-0 pl-1">
        <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-sky-500 to-violet-500 flex items-center justify-center text-white text-base">◉</span>
        <span className="text-base font-semibold truncate">全能看图王</span>
      </div>
      {isElectron && (
        <div className="titlebar-no-drag flex items-center gap-0.5">
          <button className="btn btn-ghost btn-square btn-sm" title="最小化" onClick={() => void bridge?.minimizeWindow?.()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="currentColor"><rect x="1" y="4.5" width="8" height="1"/></svg>
          </button>
          <button className="btn btn-ghost btn-square btn-sm" title={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
            {maximized ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="3" width="5.5" height="5.5"/><path d="M3 1.5h5.5V7"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="1.5" width="7" height="7"/></svg>
            )}
          </button>
          <button className="btn btn-ghost btn-square btn-sm hover:bg-red-500 hover:text-white" title="关闭" onClick={() => void bridge?.closeWindow?.()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>
          </button>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('kanitu-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('kanitu-theme', theme);
  }, [theme]);
  return (
    <label className="swap swap-rotate btn btn-ghost btn-square btn-sm" title="切换主题">
      <input type="checkbox" checked={theme === 'light'} onChange={(e) => setTheme(e.target.checked ? 'light' : 'dark')} />
      <svg className="swap-off fill-current w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4M12 7a5 5 0 010 10z"/></svg>
      <svg className="swap-on fill-current w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"/></svg>
    </label>
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
function prefetchOriginal(url: string, estWidth?: number, estHeight?: number): void {
  if (ORIGINAL_POOL.has(url)) {
    originalPoolTouch(url);
    return;
  }
  // 预估内存超限则不预解码，避免压垮内存。
  if (ORIGINAL_POOL_BYTES + estimatedImageBytes(estWidth, estHeight) > ORIGINAL_POOL_MAX_BYTES * 2) return;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => originalPoolPut(url, img);
  img.onerror = () => {
    ORIGINAL_POOL.delete(url);
    releasePooledUrl(url);
  };
  img.src = url;
}

function Viewer({
  images,
  index,
  store,
  onClose,
  onNavigate,
  onSwitchSibling,
  onImageContextMenu,
}: {
  images: ImageEntry[];
  index: number;
  store: LibraryStore;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onSwitchSibling: (dir: number) => void;
  onImageContextMenu: (event: ReactMouseEvent, image: ImageEntry) => void;
}) {
  const image = images[index];
  // displayUrl：当前正在显示的图（只在确已解码完成后换入，切换期间旧图保持可见，
  // 不会黑屏）；pendingUrl：下一张正在后台解码的隐式加载器；thumbUrl：缩略图占位。
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [originalFailed, setOriginalFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
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
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 原图解码完成后换入显示（旧图在换入前始终保持可见，切换不黑屏）。
  const swapIn = useCallback(
    (url: string, w: number, h: number) => {
      if (displayUrlRef.current && displayUrlRef.current !== url) {
        store.releaseViewerUrl(displayUrlRef.current);
      }
      displayUrlRef.current = url;
      pendingUrlRef.current = null;
      setPendingUrl(null);
      setOriginalFailed(false);
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
      pendingUrlRef.current = url;
      setPendingUrl(url);
    });
    return () => {
      cancelled = true;
      if (pendingUrlRef.current) {
        store.releaseViewerUrl(pendingUrlRef.current);
        pendingUrlRef.current = null;
      }
    };
  }, [image, store]);

  useEffect(() => {
    return () => {
      if (pendingUrlRef.current) store.releaseViewerUrl(pendingUrlRef.current);
      if (displayUrlRef.current) store.releaseViewerUrl(displayUrlRef.current);
    };
  }, [store]);

  // 切换图片时先加载缩略图占位（走缩略图缓存，已看过的图瞬时可用），
  // 覆盖在仍在显示的旧图之上；原图在加载器里解码完成后换入。
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    let thumbObjectUrl: string | null = null;
    setThumbUrl(null);
    getThumbnailBlob(store, fileRefFor(image), 512)
      .then((blob) => {
        if (cancelled) return;
        thumbObjectUrl = URL.createObjectURL(blob);
        setThumbUrl(thumbObjectUrl);
      })
      .catch(() => {
        // 缩略图失败时静默；原图会照常加载。
      });
    return () => {
      cancelled = true;
      if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
    };
  }, [image, store]);

  useEffect(() => {
    // natural 跟随当前显示的图，切换期间旧图仍显示，因此不重置 natural。
    setZoom(1);
    setRotate(0);
    setPan({ x: 0, y: 0 });
    setOriginalFailed(false);
  }, [image?.id]);

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
            if (!cancelled) prefetchOriginal(url, neighbor.width, neighbor.height);
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
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(step, { timeout: 800 });
    } else {
      setTimeout(step, 0);
    }
    return () => {
      cancelled = true;
    };
  }, [image?.id, images, index, store]);

  const baseFit = useMemo(() => {
    if (!natural || !containerSize.w || !containerSize.h) return 1;
    const s = Math.min(containerSize.w / natural.w, containerSize.h / natural.h);
    return Math.max(0.05, Math.min(1, s));
  }, [natural, containerSize]);

  const displayed = useMemo(() => {
    const w = (natural?.w ?? 1) * baseFit * zoom;
    const h = (natural?.h ?? 1) * baseFit * zoom;
    return { w, h };
  }, [natural, baseFit, zoom]);

  // The transform below uses scale(zoom). Keep the img's layout box at the
  // fit-to-window size so the browser's max-width:100% (Tailwind preflight)
  // does NOT shrink it a second time on top of the transform scale.
  const fitSize = useMemo(() => {
    const w = (natural?.w ?? 1) * baseFit;
    const h = (natural?.h ?? 1) * baseFit;
    return { w, h };
  }, [natural, baseFit]);

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
      if (e.key === 'Escape') {
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

  if (!image) return null;

  // 缩略图“替换”显示层的条件：新图正在加载（pendingUrl 非空）、或尚无显示图、
  // 或原图加载失败——此时只显示缩略图，与旧图互斥，不叠放。
  const showThumbReplace = thumbUrl != null && (pendingUrl != null || displayUrl == null || originalFailed);

  return (
    <div className="viewer-overlay fixed inset-0 z-[100] bg-black flex flex-col">
      <div className="flex items-center justify-between gap-3 p-4 text-white">
        <button className="btn btn-ghost btn-square text-white" onClick={onClose} aria-label="关闭">✕</button>
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost text-white" onClick={() => onNavigate(images[(index - 1 + images.length) % images.length]!.id)}>‹</button>
          <span className="text-sm opacity-80">{index + 1} / {images.length}</span>
          <button className="btn btn-ghost text-white" onClick={() => onNavigate(images[(index + 1) % images.length]!.id)}>›</button>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn btn-ghost btn-sm text-white" onClick={fit}>适应</button>
          <button className="btn btn-ghost btn-sm text-white" onClick={percent}>100%</button>
          <button className="btn btn-ghost btn-sm text-white" onClick={rotateCW}>↻</button>
        </div>
      </div>
      <div
        className="flex-1 flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing relative"
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
        {/* 缩略图就绪后“替换”旧图（不是叠放）：显示层与缩略图层互斥，避免快速
        切换时新缩略图叠在旧图上。旧图在缩略图就绪前保持显示，保证不黑屏。 */}
        {(displayUrl && !showThumbReplace) && (
          <img
            className="select-none pointer-events-none"
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
            className="absolute inset-0 opacity-0 pointer-events-none select-none"
            src={pendingUrl}
            alt=""
            aria-hidden="true"
            decoding="async"
            onLoad={(e) => {
              const el = e.currentTarget;
              if (pendingUrlRef.current !== pendingUrl) return;
              swapIn(pendingUrl, el.naturalWidth, el.naturalHeight);
            }}
            onError={() => {
              if (pendingUrlRef.current !== pendingUrl) return;
              pendingUrlRef.current = null;
              setPendingUrl(null);
              setOriginalFailed(true);
            }}
          />
        )}
        {/* 新图缩略图占位：取代显示层，等待原图解码完成。 */}
        {showThumbReplace && (
          <img
            className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
            src={thumbUrl}
            alt=""
            aria-hidden="true"
          />
        )}
        {/* 初始打开、显示层与缩略图都未就绪时的加载指示。 */}
        {!displayUrl && !thumbUrl && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="loading loading-spinner loading-lg text-white/70" />
          </div>
        )}
      </div>
      <div className="flex gap-2 px-4 pb-4 pt-2 bg-black/40 overflow-x-auto flex-shrink-0">
        {images.map((img, i) => (
          <button key={img.id} className={`filmstrip-thumb ${i === index ? 'active' : ''}`} onClick={() => onNavigate(img.id)}>
            <BlobImage store={store} fileRef={fileRefFor(img)} alt={img.name} className="w-full h-full object-cover" thumbnail lazy />
          </button>
        ))}
      </div>
      <div className="absolute bottom-20 right-5 text-xs text-white/80 bg-black/50 rounded-lg px-3 py-2">
        {image.name} · {natural ? `${natural.w}×${natural.h}` : '—'} · {Math.round(baseFit * zoom * 100)}%
      </div>
    </div>
  );
}
