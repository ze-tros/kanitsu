import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  applyOrganize,
  childrenOf,
  createSubfolder,
  deleteImage,
  deleteLibraryFolder,
  directImagesOf,
  imagesOf,
  importFolder,
  loadOrScan,
  renameFolder,
  renameImage,
  rescanLibrary,
  undoOrganize,
  type FolderNode,
  type ImageEntry,
  type ImportTask,
  type LibrarySnapshot,
  type OrganizeBinding,
  type OrganizeManifest,
  type OrganizeResult,
  type PersistentIndex,
} from '../../../core/src/index';
import type { FileRef, ImportSourcePicker, LibraryStore } from '../../../fs-adapter/src/types';
import { organizeByFolder, type CustomOrganizeRule } from '../../../organizer/src/index';
import { pickCover } from '../../../cover-picker/src/index';
import { BlobImage } from '../BlobImage';
import {
  preloadThumbnails,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_DIRECTIONAL,
  THUMB_PRIORITY_SUBFOLDER,
  THUMB_PRIORITY_WARMUP,
} from '../thumbnailCache';
import { isPrefetchEnabled, logDebug } from '../debugLog';
import { loadCustomRules, saveCustomRules } from '../OrganizeRulesModal';
import { OrganizePreview } from '../OrganizePreview';
import { CoverPickerModal } from '../CoverPickerModal';
import { MobileViewer } from './MobileViewer';
import {
  MobileActionSheet,
  MobileConfirmDialog,
  MobileProgressCard,
  MobilePromptDialog,
  MobileToast,
  type SheetAction,
} from './MobileSheets';
import { MobileSettingsScreen } from './MobileSettingsScreen';
import {
  OVERSCAN_ROWS,
  conflictReasonLabel,
  haptic,
  isImageBlurred,
  loadBlurredImages,
  loadPinnedCovers,
  saveBlurredImages,
  savePinnedCovers,
  skippedReasonLabel,
} from './mobileShared';

// —— 移动端网格参数 ——
const IMAGE_COLS = 3;
const IMAGE_GAP = 3;
const FOLDER_COLS = 2;
const FOLDER_GAP = 10;
const FOLDER_CAPTION_H = 46;

type OverlayLayer = 'drawer' | 'sheet' | 'viewer' | 'settings' | 'organize' | 'cover' | 'dialog' | 'report' | 'search';
type StackEntry = { type: 'folder'; folderId: string } | { type: 'overlay'; layer: OverlayLayer };

interface SheetModel {
  title?: string;
  subtitle?: string;
  actions: SheetAction[];
}

type DeleteTarget = { kind: 'image'; image: ImageEntry } | { kind: 'folder'; folder: FolderNode };

type PromptState =
  | { kind: 'rename-image'; image: ImageEntry }
  | { kind: 'rename-folder'; folder: FolderNode }
  | { kind: 'create-folder'; folder: FolderNode };

function imageToFileRef(image: ImageEntry): FileRef {
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

/** 长按手势（移动端替代右键）。 */
function useLongPress(onLongPress: () => void, ms = 460) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const cancel = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const start = useCallback(() => {
    firedRef.current = false;
    cancel();
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true;
      haptic(18);
      onLongPress();
    }, ms);
  }, [cancel, onLongPress, ms]);
  useEffect(() => cancel, [cancel]);
  return {
    onTouchStart: start,
    onTouchMove: cancel,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    wasLongPress: () => firedRef.current,
  };
}

/** 虚拟化网格：只挂载可视区 ± 缓冲行。 */
function VirtualGrid<T>({
  items,
  cols,
  rowHeight,
  gap,
  scrollTop,
  viewportH,
  sectionTop,
  renderItem,
  getKey,
}: {
  items: T[];
  cols: number;
  rowHeight: number;
  gap: number;
  scrollTop: number;
  viewportH: number;
  sectionTop: number;
  renderItem: (item: T) => ReactNode;
  getKey: (item: T) => string;
}) {
  const totalRows = Math.ceil(items.length / cols);
  if (totalRows === 0 || rowHeight <= 0) return null;
  const gs = Math.max(0, scrollTop - sectionTop);
  const first = Math.max(0, Math.floor(gs / rowHeight) - OVERSCAN_ROWS);
  const last = Math.min(totalRows, Math.ceil((gs + viewportH) / rowHeight) + OVERSCAN_ROWS);
  const rows: number[] = [];
  for (let r = first; r < last; r++) rows.push(r);
  return (
    <div style={{ position: 'relative', height: Math.max(1, totalRows * rowHeight - gap) }}>
      {rows.map((r) => (
        <div
          key={r}
          style={{
            position: 'absolute',
            top: r * rowHeight,
            left: 0,
            right: 0,
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap,
            willChange: 'transform',
          }}
        >
          {items.slice(r * cols, Math.min(items.length, r * cols + cols)).map((item) => (
            <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 图片卡片（方形，无文件名，保持相册密度）。 */
function ImageCard({
  image,
  store,
  blurred,
  onOpen,
  onActions,
}: {
  image: ImageEntry;
  store: LibraryStore;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      className="relative aspect-square overflow-hidden rounded-[4px] bg-base-300/40 active:opacity-80"
      onTouchStart={lp.onTouchStart}
      onTouchMove={lp.onTouchMove}
      onTouchEnd={lp.onTouchEnd}
      onTouchCancel={lp.onTouchCancel}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <BlobImage
        store={store}
        fileRef={imageToFileRef(image)}
        alt={image.name}
        className="w-full h-full object-cover"
        thumbnail
        lazy
        blur={blurred}
      />
    </div>
  );
}

/** 文件夹卡片（封面 + 名称 + 计数）。 */
function FolderCard({
  folder,
  coverImage,
  store,
  pinned,
  blurred,
  onOpen,
  onActions,
}: {
  folder: FolderNode;
  coverImage: ImageEntry | undefined;
  store: LibraryStore;
  pinned: boolean;
  blurred: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  const lp = useLongPress(onActions);
  return (
    <div
      className="overflow-hidden rounded-2xl bg-base-200 border border-base-300/70 active:opacity-80"
      onTouchStart={lp.onTouchStart}
      onTouchMove={lp.onTouchMove}
      onTouchEnd={lp.onTouchEnd}
      onTouchCancel={lp.onTouchCancel}
      onClick={() => {
        if (!lp.wasLongPress()) onOpen();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-base-300/40">
        {coverImage ? (
          <BlobImage
            store={store}
            fileRef={imageToFileRef(coverImage)}
            alt={folder.name}
            className="w-full h-full object-cover"
            thumbnail
            lazy
            blur={blurred}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center opacity-40">
            <svg viewBox="0 0 24 24" className="w-10 h-10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          </div>
        )}
        {pinned && (
          <span className="absolute top-1.5 left-1.5 badge badge-primary badge-sm shadow">📌</span>
        )}
      </div>
      <div className="px-2.5 py-2 flex items-center justify-between gap-2" style={{ height: FOLDER_CAPTION_H }}>
        <span className="text-[13px] font-medium truncate">{folder.name}</span>
        <span className="text-[11px] opacity-60 whitespace-nowrap tabular-nums">
          {folder.imageCount} 图 / {folder.childCount} 夹
        </span>
      </div>
    </div>
  );
}

/** 抽屉内的递归目录树。 */
function MobileFolderTree({
  snapshot,
  folderId,
  selectedFolderId,
  expandedFolders,
  onSelect,
  onToggle,
  depth,
}: {
  snapshot: LibrarySnapshot;
  folderId: string;
  selectedFolderId: string;
  expandedFolders: ReadonlySet<string>;
  onSelect: (folder: FolderNode) => void;
  onToggle: (folderId: string) => void;
  depth: number;
}) {
  const children = childrenOf(snapshot, folderId).sort((a, b) => a.name.localeCompare(b.name));
  if (children.length === 0 && depth === 0) return null;
  return (
    <div className="flex flex-col">
      {children.map((folder) => {
        const hasChildren = folder.childCount > 0;
        const expanded = expandedFolders.has(folder.id);
        const selected = folder.id === selectedFolderId;
        return (
          <div key={folder.id}>
            <div
              className={`flex items-center rounded-xl min-h-[44px] ${selected ? 'bg-primary/15 text-primary' : 'active:bg-base-300/60'}`}
              style={{ paddingLeft: depth * 16 + 4 }}
            >
              <button
                className="w-8 h-11 flex items-center justify-center shrink-0"
                disabled={!hasChildren}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(folder.id);
                }}
                aria-label={expanded ? '收起' : '展开'}
              >
                <svg
                  viewBox="0 0 12 12"
                  width="12"
                  height="12"
                  className={`transition-transform ${expanded ? 'rotate-90' : ''} ${hasChildren ? 'opacity-60' : 'opacity-0'}`}
                >
                  <path d="M3.5 2.2L8.5 6l-5 3.8z" fill="currentColor" />
                </svg>
              </button>
              <button className="flex-1 min-w-0 flex items-center justify-between gap-2 pr-3 py-2 text-left" onClick={() => onSelect(folder)}>
                <span className="truncate text-[15px]">{folder.name}</span>
                <span className={`text-xs tabular-nums ${selected ? 'text-primary' : 'opacity-50'}`}>{folder.imageCount}</span>
              </button>
            </div>
            {hasChildren && expanded && (
              <MobileFolderTree
                snapshot={snapshot}
                folderId={folder.id}
                selectedFolderId={selectedFolderId}
                expandedFolders={expandedFolders}
                onSelect={onSelect}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MobileApp({
  picker,
  store,
  index,
}: {
  picker: ImportSourcePicker;
  store: LibraryStore;
  index: PersistentIndex;
}) {
  // ===== 数据状态 =====
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null);
  const [importReport, setImportReport] = useState<ImportTask | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [blurredImages, setBlurredImages] = useState<ReadonlySet<string>>(() => loadBlurredImages());
  const [pinnedCovers, setPinnedCovers] = useState<Record<string, string>>(() => loadPinnedCovers());
  const [customRules, setCustomRules] = useState<CustomOrganizeRule[]>(() => loadCustomRules());

  // ===== UI 层状态 =====
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sheet, setSheet] = useState<SheetModel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [coverPickerFolder, setCoverPickerFolder] = useState<FolderNode | null>(null);
  const [organizePreview, setOrganizePreview] = useState<{ folder: FolderNode; bindings: OrganizeBinding[] } | null>(null);
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null);
  const [lastManifest, setLastManifest] = useState<OrganizeManifest | null>(null);

  // ===== 任务进度 =====
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ scanned: number; copied: number; skipped: number } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organizeProgress, setOrganizeProgress] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    setSelectedFolderId((prev) => (prev && next.folders[prev] ? prev : next.rootId));
  }, []);

  // ===== 启动加载 =====
  useEffect(() => {
    void (async () => {
      try {
        applySnapshot(await loadOrScan(store, index));
      } catch (err) {
        setToast({ text: `加载失败：${String(err)}`, kind: 'error' });
      }
    })();
  }, [store, index, applySnapshot]);

  const refresh = useCallback(async () => {
    const next = await rescanLibrary(store, index);
    applySnapshot(next);
    return next;
  }, [store, index, applySnapshot]);

  // toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const notify = useCallback((text: string, kind?: 'info' | 'success' | 'error') => {
    const detected = kind ?? (/失败|错误/.test(text) ? 'error' : /完成|成功|^已/.test(text) ? 'success' : 'info');
    setToast({ text, kind: detected });
  }, []);

  // ===== 派生数据 =====
  const currentFolderId = selectedFolderId || snapshot?.rootId || '';
  const selectedFolder = snapshot?.folders[currentFolderId] ?? null;
  const rootFolder = snapshot ? snapshot.folders[snapshot.rootId] : null;
  const isRoot = !selectedFolderId || selectedFolderId === snapshot?.rootId;

  const searchTerm = searchQuery.trim().toLowerCase();
  const folderImages = useMemo(() => {
    if (!snapshot) return [];
    const images = directImagesOf(snapshot, currentFolderId);
    return searchTerm ? images.filter((img) => img.name.toLowerCase().includes(searchTerm)) : images;
  }, [snapshot, currentFolderId, searchTerm]);

  const childFolders = useMemo(() => {
    if (!snapshot) return [];
    const folders = childrenOf(snapshot, currentFolderId).sort((a, b) => a.name.localeCompare(b.name));
    return searchTerm ? folders.filter((f) => f.name.toLowerCase().includes(searchTerm)) : folders;
  }, [snapshot, currentFolderId, searchTerm]);

  const childFolderCards = useMemo(() => {
    if (!snapshot) return [];
    return childFolders.map((child) => {
      const cover = pickCover(imagesOf(snapshot, child.id), { preferredId: pinnedCovers[child.id] });
      return { folder: child, coverImage: cover ? snapshot.images[cover.imageId] : undefined };
    });
  }, [snapshot, childFolders, pinnedCovers]);

  const viewerIndex = viewerImageId ? folderImages.findIndex((img) => img.id === viewerImageId) : -1;
  const viewerOpen = viewerImageId != null && viewerIndex >= 0;

  // ===== 返回键混合栈（folder 导航 + overlay 层）=====
  const stackRef = useRef<StackEntry[]>([]);
  const consumedPopsRef = useRef(0);

  const closeOverlayUI = useCallback((layer: OverlayLayer) => {
    switch (layer) {
      case 'drawer':
        setDrawerOpen(false);
        break;
      case 'sheet':
        setSheet(null);
        break;
      case 'viewer':
        setViewerImageId(null);
        break;
      case 'settings':
        setShowSettings(false);
        break;
      case 'organize':
        setOrganizePreview(null);
        break;
      case 'cover':
        setCoverPickerFolder(null);
        break;
      case 'dialog':
        setDeleteTarget(null);
        setPromptState(null);
        break;
      case 'report':
        setShowReport(false);
        break;
      case 'search':
        setSearchActive(false);
        setSearchQuery('');
        break;
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (consumedPopsRef.current > 0) {
        consumedPopsRef.current--;
        return;
      }
      const entry = stackRef.current.pop();
      if (!entry) return;
      if (entry.type === 'folder') {
        const lastFolder = [...stackRef.current].reverse().find((e) => e.type === 'folder');
        setSelectedFolderId(lastFolder && lastFolder.type === 'folder' ? lastFolder.folderId : snapshotRef.current?.rootId ?? '');
      } else {
        closeOverlayUI(entry.layer);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [closeOverlayUI]);

  const openOverlay = useCallback((layer: OverlayLayer) => {
    stackRef.current.push({ type: 'overlay', layer });
    history.pushState({ kanitu: 'o', layer }, '');
  }, []);

  /** 主动关闭栈顶 overlay：同步消费栈 + back，popstate 到来时识别为已消费。 */
  const closeOverlay = useCallback(
    (layer: OverlayLayer) => {
      const stack = stackRef.current;
      const top = stack[stack.length - 1];
      if (top && top.type === 'overlay' && top.layer === layer) {
        stack.pop();
        consumedPopsRef.current++;
        closeOverlayUI(layer);
        history.back();
      } else {
        const i = stack.map((e, idx) => (e.type === 'overlay' && e.layer === layer ? idx : -1)).filter((idx) => idx >= 0).pop();
        if (i != null) stack.splice(i, 1);
        closeOverlayUI(layer);
      }
    },
    [closeOverlayUI],
  );

  const navigateToFolder = useCallback(
    (folderId: string) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const target = folderId || snap.rootId;
      if (target === (selectedFolderId || snap.rootId)) return;
      stackRef.current.push({ type: 'folder', folderId: target });
      history.pushState({ kanitu: 'f', id: target }, '');
      setSelectedFolderId(target);
      const folder = snap.folders[target];
      if (folder && folder.childCount > 0) {
        setExpandedFolders((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
      }
      setSearchQuery('');
      setSearchActive(false);
    },
    [selectedFolderId],
  );

  const goUp = useCallback(() => {
    const snap = snapshotRef.current;
    const folder = snap?.folders[selectedFolderId || snap?.rootId || ''];
    const parentId = folder?.parentId ?? null;
    const stack = stackRef.current;
    const top = stack[stack.length - 1];
    if (top && top.type === 'folder') {
      stack.pop();
      consumedPopsRef.current++;
      history.back();
    }
    setSelectedFolderId(parentId ?? snap?.rootId ?? '');
  }, [selectedFolderId]);

  // ===== 滚动 + 虚拟化度量 =====
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const scrollSaveFrameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [contentW, setContentW] = useState(0);
  const folderSectionRef = useRef<HTMLElement>(null);
  const imageSectionRef = useRef<HTMLElement>(null);
  const [sectionTops, setSectionTops] = useState({ folder: 0, image: 0 });

  const imageCardSize = contentW > 0 ? (contentW - IMAGE_GAP * (IMAGE_COLS - 1)) / IMAGE_COLS : 0;
  const imageRowHeight = imageCardSize + IMAGE_GAP;
  const folderCardWidth = contentW > 0 ? (contentW - FOLDER_GAP * (FOLDER_COLS - 1)) / FOLDER_COLS : 0;
  const folderRowHeight = folderCardWidth > 0 ? folderCardWidth * 0.625 + FOLDER_CAPTION_H + FOLDER_GAP : 0;

  const onMainScroll = useCallback(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    if (scrollSaveFrameRef.current != null) return;
    scrollSaveFrameRef.current = requestAnimationFrame(() => {
      scrollSaveFrameRef.current = null;
      const node = mainScrollRef.current;
      if (!node) return;
      const st = node.scrollTop;
      scrollPositionsRef.current.set(currentFolderId, st);
      setScrollTop(st);
    });
  }, [currentFolderId]);

  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewportH(el.clientHeight);
      setContentW(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 度量两个 section 相对内容顶部的偏移
  useLayoutEffect(() => {
    const main = mainScrollRef.current;
    if (!main) return;
    const top = (el: HTMLElement | null) =>
      el ? el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop : 0;
    setSectionTops({ folder: top(folderSectionRef.current), image: top(imageSectionRef.current) });
  }, [childFolderCards.length, folderImages.length, searchTerm, currentFolderId, contentW]);

  // 切换目录后恢复滚动位置
  useLayoutEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;
    el.scrollTop = scrollPositionsRef.current.get(currentFolderId) ?? 0;
    setScrollTop(el.scrollTop);
  }, [currentFolderId, snapshot]);

  // ===== 缩略图预取（与桌面同优先级策略）=====
  useEffect(() => {
    if (!snapshot || folderImages.length === 0 || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const files = folderImages.map(imageToFileRef);
    preloadThumbnails(store, files, { priority: THUMB_PRIORITY_CURRENT_DIR, concurrency: 4, shouldStop: () => token.cancelled });
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, currentFolderId, folderImages, store]);

  useEffect(() => {
    if (!snapshot || childFolderCards.length === 0 || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const covers: FileRef[] = [];
    for (const card of childFolderCards.slice(0, 16)) {
      if (card.coverImage) covers.push(imageToFileRef(card.coverImage));
      for (const img of imagesOf(snapshot, card.folder.id).slice(0, 8)) covers.push(imageToFileRef(img));
    }
    if (covers.length > 0) preloadThumbnails(store, covers, { priority: THUMB_PRIORITY_SUBFOLDER, shouldStop: () => token.cancelled });
    return () => {
      token.cancelled = true;
    };
  }, [snapshot, childFolderCards, store]);

  useEffect(() => {
    if (!snapshot || !isPrefetchEnabled()) return;
    const token = { cancelled: false };
    const all = Object.values(snapshot.images).map(imageToFileRef);
    if (all.length > 0) {
      const run = () => preloadThumbnails(store, all, { priority: THUMB_PRIORITY_WARMUP, shouldStop: () => token.cancelled });
      const idle = window.setTimeout(run, 800);
      return () => {
        token.cancelled = true;
        window.clearTimeout(idle);
      };
    }
    return;
  }, [snapshot, store]);

  // 滚动方向预取：下一屏图片优先生成
  const lastScrollTopRef = useRef(0);
  useEffect(() => {
    if (folderImages.length === 0 || !isPrefetchEnabled() || imageRowHeight <= 0 || viewportH <= 0) return;
    const st = scrollTop;
    const prev = lastScrollTopRef.current;
    const dir = st > prev ? 'down' : st < prev ? 'up' : null;
    lastScrollTopRef.current = st;
    if (!dir) return;
    const gs = Math.max(0, st - sectionTops.image);
    const screenRows = Math.max(1, Math.ceil(viewportH / imageRowHeight));
    const firstRow = Math.floor(gs / imageRowHeight);
    const lastRow = Math.ceil((gs + viewportH) / imageRowHeight);
    const from = dir === 'down' ? lastRow : firstRow - screenRows;
    const to = dir === 'down' ? lastRow + screenRows : firstRow;
    const start = Math.max(0, from * IMAGE_COLS);
    const end = Math.min(folderImages.length, Math.max(0, to) * IMAGE_COLS);
    if (end <= start) return;
    const token = { cancelled: false };
    preloadThumbnails(store, folderImages.slice(start, end).map(imageToFileRef), {
      priority: THUMB_PRIORITY_DIRECTIONAL,
      recheck: true,
      shouldStop: () => token.cancelled,
    });
    return () => {
      token.cancelled = true;
    };
  }, [scrollTop, viewportH, folderImages, store, imageRowHeight, sectionTops.image]);

  // ===== 业务操作 =====
  const handleImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    setImportProgress({ scanned: 0, copied: 0, skipped: 0 });
    try {
      const task = await importFolder(picker, store, {
        onProgress: (p) => setImportProgress({ scanned: p.scanned, copied: p.copied, skipped: p.skipped }),
      });
      setImportReport(task);
      const next = await refresh();
      const topFolder = Object.values(next.folders).find((f) => f.parentId === next.rootId && f.name === task.targetTopFolder);
      if (topFolder) navigateToFolder(topFolder.id);
      notify(
        task.skippedCount > 0
          ? `导入完成：复制 ${task.copiedImageCount} 张，跳过 ${task.skippedCount} 张`
          : `导入完成：复制 ${task.copiedImageCount} 张`,
      );
    } catch (err) {
      const msg = String(err);
      if (!/取消/.test(msg)) notify(`导入失败：${msg}`, 'error');
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [importing, picker, store, refresh, navigateToFolder, notify]);

  const openOrganizeFor = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const bindings = organizeByFolder(imagesOf(snap, folder.id), { customRules });
      setOrganizePreview({ folder, bindings });
      openOverlay('organize');
    },
    [customRules, openOverlay],
  );

  const handleApplyOrganize = useCallback(async () => {
    const preview = organizePreview;
    const snap = snapshotRef.current;
    if (!preview || !snap) return;
    closeOverlay('organize');
    setOrganizing(true);
    setOrganizeProgress({ done: 0, total: preview.bindings.length });
    try {
      const result = await applyOrganize(store, snap, preview.folder.relPath, preview.bindings, {
        onProgress: (done, total) => setOrganizeProgress({ done, total }),
      });
      setOrganizeResult(result);
      setLastManifest(result.manifest);
      await refresh();
      notify(
        result.conflicts.length > 0
          ? `整理完成：移动 ${result.appliedCount} 个文件，${result.conflicts.length} 个冲突`
          : `整理完成：移动 ${result.appliedCount} 个文件`,
      );
    } catch (err) {
      notify(`整理失败：${String(err)}`, 'error');
    } finally {
      setOrganizing(false);
      setOrganizeProgress(null);
    }
  }, [organizePreview, store, refresh, notify, closeOverlay]);

  const handleUndoOrganize = useCallback(async () => {
    if (!lastManifest || organizing) return;
    setOrganizing(true);
    try {
      const result = await undoOrganize(store, lastManifest);
      setLastManifest(null);
      setOrganizeResult(null);
      await refresh();
      notify(
        result.errors.length > 0
          ? `撤销完成：已还原 ${result.undone} 项，${result.errors.length} 项失败`
          : `撤销完成：已还原 ${result.undone} 项`,
      );
    } catch (err) {
      notify(`撤销失败：${String(err)}`, 'error');
    } finally {
      setOrganizing(false);
    }
  }, [lastManifest, organizing, store, refresh, notify]);

  const handleExport = useCallback(
    async (folder: FolderNode) => {
      if (exporting) return;
      setExporting(true);
      setExportProgress({ done: 0, total: 0 });
      try {
        const result = await store.zipLibrary(folder.relPath, (done, total) => setExportProgress({ done, total }));
        if (result.outputPath) {
          notify(`已导出 ${result.exportedCount} 张图片`, 'success');
        } else {
          notify(`已导出 ${result.exportedCount} 张图片`, 'success');
        }
      } catch (err) {
        const msg = String(err);
        if (!/取消/.test(msg)) notify(`导出失败：${msg}`, 'error');
      } finally {
        setExporting(false);
        setExportProgress(null);
      }
    },
    [exporting, store, notify],
  );

  const handleDeleteConfirm = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    closeOverlay('dialog');
    if (!target) return;
    try {
      if (target.kind === 'image') {
        await deleteImage(store, target.image);
        await refresh();
        notify(`已删除图片「${target.image.name}」`, 'success');
      } else {
        const parentId = target.folder.parentId;
        await deleteLibraryFolder(store, target.folder.relPath);
        await refresh();
        if (currentFolderId === target.folder.id && parentId) setSelectedFolderId(parentId);
        notify(`已删除相册「${target.folder.name}」`, 'success');
      }
    } catch (err) {
      notify(`删除失败：${String(err)}`, 'error');
    }
  }, [deleteTarget, store, refresh, notify, closeOverlay, currentFolderId]);

  const handlePromptSubmit = useCallback(
    async (value: string) => {
      const prompt = promptState;
      setPromptState(null);
      closeOverlay('dialog');
      if (!prompt) return;
      try {
        if (prompt.kind === 'rename-image') {
          if (value === prompt.image.name) return;
          const renamed = await renameImage(store, prompt.image, value);
          await refresh();
          notify(`已重命名为「${renamed.name}」`, 'success');
        } else if (prompt.kind === 'rename-folder') {
          if (value === prompt.folder.name) return;
          await renameFolder(store, prompt.folder, value);
          await refresh();
          notify(`已重命名为「${value}」`, 'success');
        } else {
          await createSubfolder(store, prompt.folder.relPath, value);
          const next = await refresh();
          const created = Object.values(next.folders).find((f) => f.parentId === prompt.folder.id && f.name === value);
          if (created) navigateToFolder(created.id);
          notify(`已创建「${value}」`, 'success');
        }
      } catch (err) {
        notify(`操作失败：${String(err)}`, 'error');
      }
    },
    [promptState, store, refresh, notify, closeOverlay, navigateToFolder],
  );

  const toggleImageBlur = useCallback(
    (image: ImageEntry) => {
      setBlurredImages((prev) => {
        const next = new Set(prev);
        if (next.has(image.relPath)) next.delete(image.relPath);
        else next.add(image.relPath);
        saveBlurredImages(next);
        return next;
      });
    },
    [],
  );

  const toggleFolderBlur = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const images = imagesOf(snap, folder.id);
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
      notify(allBlurred ? `已取消「${folder.name}」的隐私预览` : `已为「${folder.name}」全部图片开启隐私预览`, 'success');
    },
    [blurredImages, notify],
  );

  const pinCover = useCallback(
    (folderId: string, imageId: string | null, label?: string) => {
      setPinnedCovers((prev) => {
        const next = { ...prev };
        if (imageId) next[folderId] = imageId;
        else delete next[folderId];
        savePinnedCovers(next);
        return next;
      });
      notify(imageId ? `已将「${label ?? '该图片'}」设为封面` : '已取消固定封面', 'success');
    },
    [notify],
  );

  const copyText = useCallback(
    async (text: string, label = '路径') => {
      try {
        await navigator.clipboard.writeText(text);
        notify(`已复制${label}`, 'success');
      } catch {
        notify(`无法复制，请手动复制：${text}`, 'error');
      }
    },
    [notify],
  );

  // ===== 动作面板模型 =====
  const openImageActions = useCallback(
    (image: ImageEntry, fromViewer = false) => {
      const blurred = blurredImages.has(image.relPath);
      const pinned = pinnedCovers[image.folderId] === image.id;
      const actions: SheetAction[] = [
        ...(!fromViewer
          ? [{ label: '查看', icon: '👁', onSelect: () => openViewer(image) }]
          : []),
        {
          label: blurred ? '取消隐私预览' : '设为隐私预览',
          icon: blurred ? '🙈' : '🕶',
          onSelect: () => toggleImageBlur(image),
        },
        {
          label: pinned ? '取消固定封面' : '设为相册封面',
          icon: '📌',
          onSelect: () => pinCover(image.folderId, pinned ? null : image.id, image.name),
        },
        { label: '重命名', icon: '✏️', onSelect: () => openPrompt({ kind: 'rename-image', image }) },
        { label: '复制路径', icon: '🔗', onSelect: () => void copyText(image.relPath) },
        { label: '删除', icon: '🗑', danger: true, onSelect: () => openDelete({ kind: 'image', image }) },
      ];
      setSheet({ title: image.name, subtitle: image.relPath, actions });
      openOverlay('sheet');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blurredImages, pinnedCovers, toggleImageBlur, pinCover, copyText, openOverlay],
  );

  const openFolderActions = useCallback(
    (folder: FolderNode) => {
      const snap = snapshotRef.current;
      const images = snap ? imagesOf(snap, folder.id) : [];
      const allBlurred = images.length > 0 && images.every((img) => blurredImages.has(img.relPath));
      const isRootFolder = !folder.relPath;
      const actions: SheetAction[] = [
        { label: '打开', icon: '📂', onSelect: () => navigateToFolder(folder.id) },
        { label: '新建子文件夹', icon: '📁', onSelect: () => openPrompt({ kind: 'create-folder', folder }) },
        ...(!isRootFolder ? [{ label: '重命名', icon: '✏️', onSelect: () => openPrompt({ kind: 'rename-folder', folder }) }] : []),
        {
          label: allBlurred ? '取消隐私预览（含子文件夹）' : '设为隐私预览（含子文件夹）',
          icon: allBlurred ? '🙈' : '🕶',
          disabled: images.length === 0,
          onSelect: () => toggleFolderBlur(folder),
        },
        { label: '设置封面…', icon: '🖼', disabled: images.length === 0, onSelect: () => openCoverPicker(folder) },
        { label: '整理（按规则分组）', icon: '🧹', disabled: images.length === 0, onSelect: () => openOrganizeFor(folder) },
        { label: '导出 ZIP', icon: '📦', disabled: images.length === 0, onSelect: () => void handleExport(folder) },
        { label: '复制路径', icon: '🔗', onSelect: () => void copyText(folder.relPath || '（根目录）') },
        ...(!isRootFolder
          ? [{ label: '删除相册', icon: '🗑', danger: true, onSelect: () => openDelete({ kind: 'folder', folder }) }]
          : []),
      ];
      setSheet({ title: folder.name || '全部相册', subtitle: folder.relPath || undefined, actions });
      openOverlay('sheet');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blurredImages, navigateToFolder, toggleFolderBlur, openOrganizeFor, handleExport, copyText, openOverlay],
  );

  const openMoreActions = useCallback(() => {
    const folder = selectedFolder;
    const actions: SheetAction[] = [
      { label: '导入相册', icon: '⬇️', onSelect: () => void handleImport() },
      { label: '新建子文件夹', icon: '📁', onSelect: () => folder && openPrompt({ kind: 'create-folder', folder }) },
      { label: '整理本目录', icon: '🧹', onSelect: () => folder && openOrganizeFor(folder) },
      ...(lastManifest ? [{ label: '撤销整理', icon: '↩️', onSelect: () => void handleUndoOrganize() }] : []),
      { label: '导出本目录 ZIP', icon: '📦', onSelect: () => folder && void handleExport(folder) },
      { label: '刷新', icon: '🔄', onSelect: () => void refresh().then(() => notify('已刷新', 'success')) },
      ...(importReport ? [{ label: '查看导入报告', icon: '📋', onSelect: () => { setShowReport(true); openOverlay('report'); } }] : []),
      { label: '设置', icon: '⚙️', onSelect: () => { setShowSettings(true); openOverlay('settings'); } },
    ];
    setSheet({ title: folder?.name || '全部相册', actions });
    openOverlay('sheet');
  }, [selectedFolder, handleImport, openOrganizeFor, lastManifest, handleUndoOrganize, handleExport, refresh, notify, importReport, openOverlay]);

  // ===== 打开各 UI 层（history 栈配对）=====
  const openViewer = useCallback(
    (image: ImageEntry) => {
      setViewerImageId(image.id);
      openOverlay('viewer');
    },
    [openOverlay],
  );

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    openOverlay('drawer');
  }, [openOverlay]);

  const openPrompt = useCallback(
    (prompt: PromptState) => {
      setPromptState(prompt);
      openOverlay('dialog');
    },
    [openOverlay],
  );

  const openDelete = useCallback(
    (target: DeleteTarget) => {
      setDeleteTarget(target);
      openOverlay('dialog');
    },
    [openOverlay],
  );

  const openCoverPicker = useCallback(
    (folder: FolderNode) => {
      setCoverPickerFolder(folder);
      openOverlay('cover');
    },
    [openOverlay],
  );

  const openSearch = useCallback(() => {
    setSearchActive(true);
    openOverlay('search');
  }, [openOverlay]);

  const closeSearch = useCallback(() => {
    closeOverlay('search');
  }, [closeOverlay]);

  const handleCustomRulesChange = useCallback((rules: CustomOrganizeRule[]) => {
    setCustomRules(rules);
    saveCustomRules(rules);
  }, []);

  const toggleFolderExpand = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // ===== 渲染 =====
  const title = searchActive ? '' : isRoot ? '全能看图王' : selectedFolder?.name ?? '';
  const subtitle = selectedFolder
    ? `${selectedFolder.directImageCount} 图片 · ${selectedFolder.childCount} 子目录`
    : '';

  return (
    <div className="fixed inset-0 bg-base-100 text-base-content flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header
        className="shrink-0 z-20 bg-base-100/95 backdrop-blur border-b border-base-300/60"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        {searchActive ? (
          <div className="flex items-center gap-1 px-1 h-14">
            <button
              className="w-11 h-11 flex items-center justify-center shrink-0 active:opacity-60"
              onClick={closeSearch}
              aria-label="关闭搜索"
            >
              <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="flex-1 flex items-center gap-2 bg-base-200 rounded-full px-4 h-10">
              <svg viewBox="0 0 24 24" className="w-4 h-4 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                autoFocus
                className="flex-1 bg-transparent outline-none text-[15px] min-w-0"
                placeholder="搜索当前目录…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="shrink-0 opacity-60" onClick={() => setSearchQuery('')} aria-label="清空">
                  ✕
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center px-1 h-14">
            {isRoot ? (
              <button className="w-11 h-11 flex items-center justify-center shrink-0 active:opacity-60" onClick={openDrawer} aria-label="打开目录">
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            ) : (
              <button className="w-11 h-11 flex items-center justify-center shrink-0 active:opacity-60" onClick={goUp} aria-label="返回上级">
                <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            <div className="flex-1 min-w-0 px-1.5">
              <div className="text-[17px] font-semibold truncate leading-tight">{title}</div>
              {subtitle && <div className="text-[11px] opacity-60 truncate leading-tight mt-0.5">{subtitle}</div>}
            </div>
            <button className="w-11 h-11 flex items-center justify-center shrink-0 active:opacity-60" onClick={openSearch} aria-label="搜索">
              <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </button>
            <button className="w-11 h-11 flex items-center justify-center shrink-0 active:opacity-60" onClick={openMoreActions} aria-label="更多">
              <svg viewBox="0 0 24 24" className="w-[22px] h-[22px]" fill="currentColor">
                <circle cx="12" cy="5" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="12" cy="19" r="1.8" />
              </svg>
            </button>
          </div>
        )}
      </header>

      {/* 主内容 */}
      <main ref={mainScrollRef} onScroll={onMainScroll} className="flex-1 overflow-y-auto overscroll-contain relative">
        {!snapshot ? (
          <div className="h-full flex items-center justify-center">
            <span className="loading loading-spinner loading-lg text-primary" />
          </div>
        ) : childFolders.length === 0 && folderImages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center px-10 text-center">
            {searchTerm ? (
              <>
                <div className="text-5xl mb-4">🔍</div>
                <div className="text-base font-medium">未找到匹配项</div>
                <div className="text-sm opacity-60 mt-1">没有与「{searchQuery}」匹配的子目录或图片</div>
              </>
            ) : (
              <>
                <div className="text-5xl mb-4">🖼️</div>
                <div className="text-base font-medium">{isRoot ? '图库还是空的' : '该目录暂无图片'}</div>
                <div className="text-sm opacity-60 mt-1 mb-6">{isRoot ? '导入照片，开始整理你的图库' : '返回上级或导入新内容'}</div>
                <button className="px-6 py-3 rounded-full bg-primary text-primary-content font-medium active:scale-95 transition-transform" onClick={() => void handleImport()}>
                  导入相册
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="px-[10px] pt-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
            {childFolders.length > 0 && (
              <section ref={folderSectionRef} className="mb-4">
                <h3 className="text-[13px] font-semibold opacity-60 mb-2 px-0.5">子文件夹</h3>
                <VirtualGrid
                  items={childFolderCards}
                  cols={FOLDER_COLS}
                  rowHeight={folderRowHeight}
                  gap={FOLDER_GAP}
                  scrollTop={scrollTop}
                  viewportH={viewportH}
                  sectionTop={sectionTops.folder}
                  getKey={(c) => c.folder.id}
                  renderItem={(card) => (
                    <FolderCard
                      folder={card.folder}
                      coverImage={card.coverImage}
                      store={store}
                      pinned={pinnedCovers[card.folder.id] != null}
                      blurred={card.coverImage ? isImageBlurred(card.coverImage.relPath, blurredImages) : false}
                      onOpen={() => navigateToFolder(card.folder.id)}
                      onActions={() => openFolderActions(card.folder)}
                    />
                  )}
                />
              </section>
            )}
            {folderImages.length > 0 && (
              <section ref={imageSectionRef}>
                <h3 className="text-[13px] font-semibold opacity-60 mb-2 px-0.5">
                  图片 <span className="tabular-nums">{folderImages.length}</span>
                </h3>
                <VirtualGrid
                  items={folderImages}
                  cols={IMAGE_COLS}
                  rowHeight={imageRowHeight}
                  gap={IMAGE_GAP}
                  scrollTop={scrollTop}
                  viewportH={viewportH}
                  sectionTop={sectionTops.image}
                  getKey={(img) => img.id}
                  renderItem={(img) => (
                    <ImageCard
                      image={img}
                      store={store}
                      blurred={blurredImages.has(img.relPath)}
                      onOpen={() => openViewer(img)}
                      onActions={() => openImageActions(img)}
                    />
                  )}
                />
              </section>
            )}
          </div>
        )}
      </main>

      {/* 导入 FAB */}
      {!importing && !viewerOpen && (
        <button
          className="fixed z-30 w-14 h-14 rounded-full bg-primary text-primary-content shadow-xl shadow-primary/30 flex items-center justify-center active:scale-90 transition-transform"
          style={{ right: 18, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)' }}
          onClick={() => void handleImport()}
          aria-label="导入相册"
        >
          <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {/* 抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[130]">
          <div className="m-drawer-mask absolute inset-0 bg-black/45" onClick={() => closeOverlay('drawer')} />
          <aside className="m-drawer-panel absolute left-0 top-0 bottom-0 w-[84vw] max-w-[340px] bg-base-100 shadow-2xl flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
            <div className="px-4 py-3.5 border-b border-base-300/70 flex items-center gap-2.5 shrink-0">
              <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-500 to-violet-500 flex items-center justify-center text-white text-sm">图</span>
              <span className="text-base font-semibold">全能看图王</span>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain p-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}>
              {rootFolder && (
                <div
                  className={`flex items-center gap-2.5 rounded-xl min-h-[44px] px-3 ${isRoot ? 'bg-primary/15 text-primary' : 'active:bg-base-300/60'}`}
                  onClick={() => {
                    closeOverlay('drawer');
                    if (!isRoot) navigateToFolder(rootFolder.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 10.5L12 3l9 7.5V21H3z" />
                  </svg>
                  <span className="flex-1 text-[15px]">全部相册</span>
                  <span className={`text-xs tabular-nums ${isRoot ? 'text-primary' : 'opacity-50'}`}>{rootFolder.imageCount}</span>
                </div>
              )}
              {snapshot && (
                <MobileFolderTree
                  snapshot={snapshot}
                  folderId={snapshot.rootId}
                  selectedFolderId={currentFolderId}
                  expandedFolders={expandedFolders}
                  onSelect={(folder) => {
                    closeOverlay('drawer');
                    navigateToFolder(folder.id);
                  }}
                  onToggle={toggleFolderExpand}
                  depth={0}
                />
              )}
            </div>
            <div className="shrink-0 border-t border-base-300/70 p-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}>
              <button
                className="w-full flex items-center gap-2.5 rounded-xl min-h-[44px] px-3 active:bg-base-300/60"
                onClick={() => {
                  closeOverlay('drawer');
                  setShowSettings(true);
                  openOverlay('settings');
                }}
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                <span className="text-[15px]">设置</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* 查看器 */}
      {viewerOpen && (
        <MobileViewer
          images={folderImages}
          index={viewerIndex}
          store={store}
          isBlurred={(img) => blurredImages.has(img.relPath)}
          onClose={() => closeOverlay('viewer')}
          onNavigate={(id) => setViewerImageId(id)}
          onShowActions={(img) => openImageActions(img, true)}
        />
      )}

      {/* 整理预览（全屏化桌面组件） */}
      {organizePreview && (
        <div className="m-fullscreen">
          <OrganizePreview
            bindings={organizePreview.bindings}
            organizing={organizing}
            progress={organizeProgress}
            onChange={(bindings) => setOrganizePreview((prev) => (prev ? { ...prev, bindings } : prev))}
            onApply={() => void handleApplyOrganize()}
            onClose={() => closeOverlay('organize')}
          />
        </div>
      )}

      {/* 封面选择（全屏化桌面组件） */}
      {coverPickerFolder && snapshot && (
        <div className="m-fullscreen">
          <CoverPickerModal
            folderId={coverPickerFolder.id}
            snapshot={snapshot}
            store={store}
            pinnedCovers={pinnedCovers}
            currentCoverId={pinnedCovers[coverPickerFolder.id] ?? null}
            onPick={(imageId) => {
              const name = imageId ? snapshot.images[imageId]?.name : undefined;
              pinCover(coverPickerFolder.id, imageId, name);
              closeOverlay('cover');
            }}
            onCancel={() => closeOverlay('cover')}
          />
        </div>
      )}

      {/* 设置 */}
      {showSettings && (
        <MobileSettingsScreen rules={customRules} onChange={handleCustomRulesChange} onBack={() => closeOverlay('settings')} />
      )}

      {/* 动作面板 */}
      {sheet && <MobileActionSheet title={sheet.title} subtitle={sheet.subtitle} actions={sheet.actions} onClose={() => closeOverlay('sheet')} />}

      {/* 删除确认 */}
      {deleteTarget && (
        <MobileConfirmDialog
          title="确认删除"
          body={
            deleteTarget.kind === 'image'
              ? `确定要删除图片「${deleteTarget.image.name}」吗？此操作不可撤销。`
              : `确定要删除相册「${deleteTarget.folder.name}」及其全部子目录吗？此操作不可撤销。`
          }
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => closeOverlay('dialog')}
        />
      )}

      {/* 输入对话框 */}
      {promptState && (
        <MobilePromptDialog
          title={
            promptState.kind === 'rename-image' ? '重命名图片' : promptState.kind === 'rename-folder' ? '重命名相册' : `在「${promptState.folder.name || '全部相册'}」中新建子文件夹`
          }
          label={promptState.kind === 'create-folder' ? '文件夹名称' : '新名称'}
          initialValue={
            promptState.kind === 'rename-image'
              ? promptState.image.name
              : promptState.kind === 'rename-folder'
                ? promptState.folder.name
                : ''
          }
          confirmLabel={promptState.kind === 'create-folder' ? '创建' : '保存'}
          onSubmit={(v) => void handlePromptSubmit(v)}
          onCancel={() => closeOverlay('dialog')}
        />
      )}

      {/* 导入报告 */}
      {showReport && importReport && (
        <div className="m-dialog-mask fixed inset-0 z-[150] flex items-end justify-center">
          <div className="absolute inset-0 bg-black/45" onClick={() => closeOverlay('report')} />
          <div
            className="m-sheet-panel relative bg-base-100 rounded-t-3xl shadow-2xl w-full max-h-[70vh] flex flex-col"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
          >
            <div className="px-5 pt-3 pb-2 border-b border-base-300/60">
              <h3 className="text-base font-semibold">导入报告</h3>
              <p className="text-xs opacity-60 mt-1">
                来源：{importReport.sourceFolderName} · 扫描 {importReport.scannedFileCount} · 复制 {importReport.copiedImageCount} · 跳过 {importReport.skippedCount}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {importReport.skippedFiles.length === 0 && importReport.errors.length === 0 ? (
                <p className="text-sm opacity-70 py-4 text-center">全部成功，没有跳过或失败的文件。</p>
              ) : (
                <>
                  {importReport.skippedFiles.map((f, i) => (
                    <div key={`s-${i}`} className="py-1.5 text-xs flex gap-2">
                      <span className="text-warning shrink-0">跳过</span>
                      <span className="font-mono break-all flex-1">{f.path}</span>
                      <span className="opacity-60 shrink-0">{skippedReasonLabel(f.reason)}</span>
                    </div>
                  ))}
                  {importReport.errors.map((e, i) => (
                    <div key={`e-${i}`} className="py-1.5 text-xs flex gap-2">
                      <span className="text-error shrink-0">失败</span>
                      <span className="font-mono break-all flex-1">{e}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="px-5 pt-2">
              <button className="w-full py-3 rounded-2xl bg-base-200 text-[15px] font-medium active:bg-base-300" onClick={() => closeOverlay('report')}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 整理结果 */}
      {organizeResult && (
        <div className="m-dialog-mask fixed inset-0 z-[150] flex items-center justify-center p-8">
          <div className="absolute inset-0 bg-black/45" onClick={() => setOrganizeResult(null)} />
          <div className="m-dialog relative bg-base-100 rounded-3xl shadow-2xl w-full max-w-sm p-5 max-h-[70vh] flex flex-col">
            <h3 className="text-base font-semibold shrink-0">整理结果</h3>
            <p className="text-sm opacity-75 mt-2 shrink-0">
              已应用 {organizeResult.appliedCount} · 跳过低置信度 {organizeResult.skippedLowConfidenceCount} · 冲突 {organizeResult.conflicts.length}
            </p>
            {organizeResult.conflicts.length > 0 && (
              <div className="flex-1 overflow-y-auto mt-3 min-h-0">
                {organizeResult.conflicts.map((c, i) => (
                  <div key={i} className="py-1.5 text-xs border-b border-base-300/40 last:border-0">
                    <div className="font-mono break-all">{c.name}</div>
                    <div className="opacity-60 mt-0.5">
                      → {c.targetRelPath}（{conflictReasonLabel(c.reason)}）
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button className="w-full py-2.5 rounded-xl bg-base-200 text-[15px] mt-4 shrink-0 active:bg-base-300" onClick={() => setOrganizeResult(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 任务进度 */}
      {importing && (
        <MobileProgressCard
          title="正在导入相册…"
          detail={importProgress ? `已扫描 ${importProgress.scanned} · 已复制 ${importProgress.copied} · 跳过 ${importProgress.skipped}` : undefined}
        />
      )}
      {organizing && organizeProgress && <MobileProgressCard title="正在整理…" done={organizeProgress.done} total={organizeProgress.total} />}
      {exporting && <MobileProgressCard title="正在导出 ZIP…" done={exportProgress?.done} total={exportProgress?.total} />}

      {/* Toast */}
      {toast && !viewerOpen && <MobileToast text={toast.text} kind={toast.kind} />}
    </div>
  );
}
